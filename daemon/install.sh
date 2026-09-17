#!/usr/bin/env bash
# remote-ai-chat — set up the daemon on this computer.
#
#   curl -fsSL <repo>/daemon/install.sh | bash      (or: ./install.sh)
#
# Installs into a venv next to this script, registers a login service
# (launchd on macOS, systemd --user on Linux) and prints a pairing link.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="remote-ai-chat"
PORT="${RAC_PORT:-8790}"
export RAC_HOME="${RAC_HOME:-$HOME/.remote-ai-chat}"

say() { printf "\033[1m→\033[0m %s\n" "$*"; }
die() { printf "\033[31m✗\033[0m %s\n" "$*" >&2; exit 1; }

# ── prerequisites ─────────────────────────────────────────────────────────────
command -v python3 >/dev/null || die "python3 not found"
PYV=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
case "$PYV" in 3.1[1-3]) ;; *) say "warning: python $PYV — 3.11-3.13 is what this is tested on";; esac
ask() {                      # ask() "question" -> 0 yes, 1 no. RAC_YES=1 answers yes.
  [ "${RAC_YES:-}" = "1" ] && return 0
  [ -t 0 ] || return 1       # non-interactive: never assume yes
  printf "\033[1m?\033[0m %s [Y/n] " "$1" >&2
  read -r a </dev/tty || return 1
  case "$a" in [nN]*) return 1;; *) return 0;; esac
}

ensure_node() {
  command -v npm >/dev/null && return 0
  say "Node.js (npm) not found — it is needed to install the claude/codex CLIs"
  if command -v brew >/dev/null; then
    ask "install Node.js with Homebrew?" && brew install node && return 0
  elif command -v apt-get >/dev/null; then
    ask "install Node.js with apt (sudo)?" && sudo apt-get update -qq && sudo apt-get install -y nodejs npm && return 0
  elif command -v dnf >/dev/null; then
    ask "install Node.js with dnf (sudo)?" && sudo dnf install -y nodejs npm && return 0
  fi
  say "install Node.js yourself (nodejs.org), then re-run this script"
  return 1
}

ensure_cli() {               # ensure_cli <binary> <npm package>
  if command -v "$1" >/dev/null; then
    say "$1 already installed ($("$1" --version 2>&1 | head -1))"
    return 0
  fi
  ensure_node || return 1
  ask "install the $1 CLI (npm i -g $2)?" || { say "skipped $1 — those chats will fail until it is installed"; return 1; }
  npm install -g "$2" && say "$1 installed ($("$1" --version 2>&1 | head -1))"
}

if [ "${RAC_NO_CLIS:-}" != "1" ]; then
  ensure_cli claude @anthropic-ai/claude-code || true
  ensure_cli codex  @openai/codex || true
fi
command -v tailscale >/dev/null || [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] \
  || say "warning: Tailscale not found — the daemon only listens on the Tailscale address"

# ── venv + package ────────────────────────────────────────────────────────────
VENV="$DIR/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  say "creating venv at $VENV"
  if command -v uv >/dev/null; then uv --no-config venv -p 3.12 "$VENV" >/dev/null
  else python3 -m venv "$VENV"; fi
fi
say "installing the daemon"
if command -v uv >/dev/null; then
  VIRTUAL_ENV="$VENV" uv --no-config pip install -q -e "$DIR"
else
  "$VENV/bin/pip" install -q -e "$DIR"
fi

# ── service ───────────────────────────────────────────────────────────────────
BIN="$VENV/bin/remote-ai-chat"
case "$(uname -s)" in
  Darwin)
    LABEL="com.$(id -un).remote-ai-chat"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    mkdir -p "$HOME/Library/LaunchAgents" "$RAC_HOME/logs"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>RAC_HOME</key><string>$RAC_HOME</string>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$RAC_HOME/logs/stdout.log</string>
  <key>StandardErrorPath</key><string>$RAC_HOME/logs/stderr.log</string>
</dict></plist>
PLIST_EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    say "service registered: $LABEL"
    ;;
  Linux)
    if ! command -v systemctl >/dev/null; then
      say "no systemd here — start it yourself with: $BIN serve   (or add it to your init system)"
      SKIP_SERVICE=1
    fi
    UNIT="$HOME/.config/systemd/user/$NAME.service"
    mkdir -p "$(dirname "$UNIT")" "$RAC_HOME/logs"
    cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=remote-ai-chat daemon
After=network-online.target

[Service]
ExecStart=$BIN serve
Environment=RAC_HOME=$RAC_HOME
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT_EOF
    if [ "${SKIP_SERVICE:-}" = "1" ]; then
      "$BIN" serve >"$RAC_HOME/logs/daemon.log" 2>&1 &
      say "started in the background (pid $!)"
    else
    systemctl --user daemon-reload
    systemctl --user enable --now "$NAME.service"
    loginctl enable-linger "$(id -un)" 2>/dev/null || say "note: run 'sudo loginctl enable-linger $(id -un)' to keep it running after logout"
    say "service registered: $NAME.service"
    fi
    ;;
  *) die "unsupported OS: $(uname -s)";;
esac

# ── first pairing ─────────────────────────────────────────────────────────────
for _ in $(seq 1 20); do
  curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
echo
say "pair your phone (open this link on the phone, or scan the QR):"
echo
"$BIN" pair --name "$(hostname -s) phone"
