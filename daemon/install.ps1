# remote-ai-chat — set up the daemon on this Windows PC.
#
#   powershell -ExecutionPolicy Bypass -File .\daemon\install.ps1
#
# Works without administrator rights (Windows PowerShell 5.1 or newer):
#   * venv beside this script + `pip install -e .`
#   * reachability from the phone: `tailscale serve` forwards <tailscale-ip>:8790 to the
#     daemon on 127.0.0.1 (no firewall rule needed). Without the Tailscale CLI it falls
#     back to a firewall rule for the Tailscale range, which does need an elevated shell.
#   * autostart: a Scheduled Task at logon when allowed, else an HKCU Run entry. Both run
#     %USERPROFILE%\.remote-ai-chat\start.ps1, a hidden supervisor that restarts the daemon
#     if it crashes.
#   * prints a pairing link/QR for the phone.
#
# Undo everything:  .venv\Scripts\python.exe -m remote_ai_chat uninstall
$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $env:RAC_HOME) { $env:RAC_HOME = Join-Path $env:USERPROFILE ".remote-ai-chat" }
$Port = if ($env:RAC_PORT) { $env:RAC_PORT } else { "8790" }
$TaskName = "remote-ai-chat"
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"

function Say($m) { Write-Host "-> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!  $m" -ForegroundColor Yellow }
# Run a native command with stderr folded into the output. Under $ErrorActionPreference =
# "Stop", Windows PowerShell 5.1 would otherwise turn any stderr line into a terminating error.
function Quiet([scriptblock]$sb) { $ErrorActionPreference = "Continue"; & $sb 2>&1 }

# --- prerequisites ----------------------------------------------------------
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $py) { throw "python not found. Install Python 3.11-3.13 from python.org and re-run." }
$ver = (Quiet { & $py.Source -c "import sys; print('%d.%d' % sys.version_info[:2])" } | Out-String).Trim()
if ($ver -notmatch '^\d+\.\d+$') { throw "'$($py.Source)' is not a working Python (Microsoft Store alias?). Install Python 3.11-3.13 from python.org." }
if ($ver -notmatch '^3\.(11|12|13)$') { Warn "python $ver - 3.11-3.13 is what this is tested on" }

function Ask($q) {                       # $env:RAC_YES = "1" answers yes
  if ($env:RAC_YES -eq "1") { return $true }
  $a = Read-Host "$q [Y/n]"
  return ($a -eq "" -or $a -match '^[yY]')
}

function Ensure-Node {
  if (Get-Command npm -ErrorAction SilentlyContinue) { return $true }
  Warn "Node.js (npm) not found — it is needed to install the claude/codex CLIs"
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    if (Ask "install Node.js LTS with winget?") {
      winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements | Out-Host
      $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                  [Environment]::GetEnvironmentVariable("Path", "User")
      if (Get-Command npm -ErrorAction SilentlyContinue) { return $true }
      Warn "Node installed, but npm is not on PATH yet — close and reopen PowerShell, then re-run"
      return $false
    }
  }
  Warn "install Node.js yourself (nodejs.org), then re-run this script"
  return $false
}

function Ensure-Cli($bin, $pkg) {
  $existing = Get-Command $bin -ErrorAction SilentlyContinue
  if ($existing) { Say "$bin already installed"; return }
  if (-not (Ensure-Node)) { return }
  if (-not (Ask "install the $bin CLI (npm i -g $pkg)?")) {
    Warn "skipped $bin — those chats will fail until it is installed"; return
  }
  npm install -g $pkg | Out-Host
  if (Get-Command $bin -ErrorAction SilentlyContinue) { Say "$bin installed" }
  else { Warn "$bin installed by npm but not on PATH — the daemon finds it anyway" }
}

if ($env:RAC_NO_CLIS -ne "1") {
  Ensure-Cli "claude" "@anthropic-ai/claude-code"
  Ensure-Cli "codex"  "@openai/codex"
}
$ts = Get-Command tailscale -ErrorAction SilentlyContinue
if ($ts) { $Tailscale = $ts.Source }
elseif (Test-Path "C:\Program Files\Tailscale\tailscale.exe") { $Tailscale = "C:\Program Files\Tailscale\tailscale.exe" }
else { $Tailscale = $null; Warn "Tailscale not found - the phone can only reach this PC over Tailscale" }

# --- venv + package ---------------------------------------------------------
$Venv = Join-Path $Dir ".venv"
$Py = Join-Path $Venv "Scripts\python.exe"
if (-not (Test-Path $Py)) {
  Say "creating venv at $Venv"
  & $py.Source -m venv $Venv
}
Say "installing the daemon"
& $Py -m pip install --quiet --upgrade pip | Out-Host
& $Py -m pip install --quiet -e $Dir | Out-Host
# Always go through `python -m`: the generated remote-ai-chat.exe is an unsigned
# launcher that AppLocker-managed PCs refuse to run.
Quiet { & $Py -c "import remote_ai_chat" } | Out-Null
if ($LASTEXITCODE -ne 0) { throw "install finished but 'import remote_ai_chat' fails" }

# Claude Code login is per-machine; the SDK ships its own CLI so PATH does not matter.
$ClaudeCli = (& $Py -c "import claude_agent_sdk, pathlib; p = pathlib.Path(claude_agent_sdk.__file__).parent / '_bundled' / 'claude.exe'; print(p if p.is_file() else '')" | Out-String).Trim()
if ($ClaudeCli) {
  $st = Quiet { & $ClaudeCli auth status } | Out-String
  if ($st -notmatch '"loggedIn":\s*true') {
    Warn "Claude Code is not logged in on this PC - Claude chats will fail until you sign in,"
    Warn "either from the phone app (Settings > Account) or here:  & '$ClaudeCli' login"
  }
} else { Warn "bundled claude CLI not found - Claude chats need 'claude' on PATH and logged in" }
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { Warn "'codex' not on PATH - Codex chats will fail until it is" }

# --- reachability from the phone --------------------------------------------
# Preferred: tailscaled owns <tailscale-ip>:$Port and forwards to the daemon on loopback.
# Needs no firewall change and no admin. The daemon then binds 127.0.0.1 only.
$BindArgs = @()
$Reach = ""
if ($Tailscale) {
  Quiet { & $Tailscale serve --bg --tcp $Port "tcp://127.0.0.1:$Port" } | Out-Null
  if ($LASTEXITCODE -eq 0) {
    $BindArgs = @("--bind", "127.0.0.1")
    $Reach = "tailscale serve -> 127.0.0.1:$Port"
    Say "tailscale serve forwards port $Port to the daemon (no firewall rule needed)"
  } else { Warn "tailscale serve failed - falling back to a firewall rule" }
}
if (-not $Reach) {
  $RuleName = "remote-ai-chat (Tailscale only)"
  try {
    Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort $Port -RemoteAddress 100.64.0.0/10 `
      -Profile Any -Description "Lets paired phones reach the remote-ai-chat daemon over Tailscale" | Out-Null
    $Reach = "firewall rule for 100.64.0.0/10"
    Say "firewall rule added for port $Port (Tailscale addresses only)"
  } catch {
    Warn "could not add the firewall rule (needs an elevated PowerShell). Either re-run elevated, or add it by hand:"
    Warn "  New-NetFirewallRule -DisplayName '$RuleName' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -RemoteAddress 100.64.0.0/10"
  }
}

# --- supervisor script ------------------------------------------------------
$Logs = Join-Path $env:RAC_HOME "logs"
New-Item -ItemType Directory -Force -Path $Logs | Out-Null
$Launcher = Join-Path $env:RAC_HOME "start.ps1"
$BindLine = ""
if ($BindArgs.Count -gt 0) { $BindLine = ', "' + ($BindArgs -join '", "') + '"' }
$launcherBody = @"
# remote-ai-chat supervisor - written by install.ps1, runs hidden at logon.
# Starts the daemon and restarts it if it exits; quits if another instance is already healthy.
`$Py   = "$Py"
`$Dir  = "$Dir"
`$Port = "$Port"
`$Logs = "$Logs"
`$env:RAC_HOME = "$($env:RAC_HOME)"
`$env:PYTHONUTF8 = "1"
`$DaemonArgs = @("-m", "remote_ai_chat", "serve"$BindLine)
function Healthy { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:`$Port/health" | Out-Null; `$true } catch { `$false } }
if (Healthy) { exit 0 }
# Cmdlets only (no .NET method calls): corporate PCs run PowerShell in ConstrainedLanguage mode.
while (`$true) {
  Start-Process -FilePath `$Py -ArgumentList `$DaemonArgs -WorkingDirectory `$Dir -WindowStyle Hidden -Wait ``
    -RedirectStandardOutput (Join-Path `$Logs "serve.out.log") -RedirectStandardError (Join-Path `$Logs "serve.err.log")
  Start-Sleep -Seconds 5
  if (Healthy) { exit 0 }   # someone else took over
}
"@
$launcherBody | Set-Content -Path $Launcher -Encoding UTF8
$LaunchCmd = "powershell.exe"
$LaunchArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`""

# --- start with Windows -----------------------------------------------------
$registered = ""
try {
  $action  = New-ScheduledTaskAction -Execute $LaunchCmd -Argument $LaunchArgs -WorkingDirectory $Dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "remote-ai-chat daemon" -ErrorAction Stop | Out-Null
  Remove-ItemProperty -Path $RunKey -Name $TaskName -ErrorAction SilentlyContinue
  $registered = "scheduled task '$TaskName'"
} catch {
  # Group policy often forbids task creation for standard users; a Run entry needs nothing.
  Set-ItemProperty -Path $RunKey -Name $TaskName -Value "$LaunchCmd $LaunchArgs"
  $registered = "HKCU Run entry '$TaskName'"
}
Say "autostart registered: $registered"

# Stop a daemon/supervisor from a previous install so the new bind settings take effect, then start.
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $PID -and $_.Name -match '^(python|powershell)' -and $_.CommandLine -match 'remote_ai_chat serve|\\\.remote-ai-chat\\start\.ps1' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Process -FilePath $LaunchCmd -ArgumentList $LaunchArgs -WindowStyle Hidden

# --- first pairing ----------------------------------------------------------
$up = $false
for ($i = 0; $i -lt 30; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 "http://127.0.0.1:$Port/health" | Out-Null; $up = $true; break }
  catch { Start-Sleep -Seconds 1 }
}
if (-not $up) { Warn "daemon did not answer on 127.0.0.1:$Port - see $Logs\serve.err.log" }
Write-Host ""
Say "reachability: $Reach"
Say "pair your phone (open this link on the phone, or scan the QR):"
Write-Host ""
$env:PYTHONUTF8 = "1"
& $Py -m remote_ai_chat pair --name "$env:COMPUTERNAME phone"
