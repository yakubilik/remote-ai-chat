# Security

## Reporting

Open a [private security advisory](https://github.com/yakubilik/remote-ai-chat/security/advisories/new)
rather than a public issue. Include what the daemon was doing, what the phone
sent, and the version (`remote-ai-chat status`). You will get an answer; this is
a small project run by one person, so the honest estimate is days, not hours.

Please do not include real tokens, real paths or real transcripts in a report —
a reduced reproduction is more useful anyway.

## The threat model, stated plainly

The daemon runs shell commands on your computer because your phone asked it to.
That is the product. What the design does is bound it.

**What it defends against**

- *Anyone who is not on your tailnet.* The daemon binds the Tailscale address
  and `127.0.0.1`, nothing else. There is no relay and no account, so there is
  no server holding your sessions and nothing to breach but your own machine.
- *A stolen or guessed token.* Tokens are 32 random bytes, stored only as
  sha256, and shown in plaintext exactly once — in the pairing QR. Every device
  has its own; `revoke <id>` cuts one off without touching the others. Five
  failures from one address in ten minutes earns a temporary lockout.
- *An agent wandering out of its folder.* A chat can only open under
  `allowed_roots`, minus `denied_paths` (`~/.ssh`, `~/.aws`, credential stores,
  browser profiles). The check is in the daemon, not the client, so it holds in
  `bypass` permission mode too, and `chat.update` re-checks on every move.
- *A destructive command slipping past a tired thumb.* A pattern list —
  `rm -rf`, `git push --force`, `dd of=/dev/…` and friends — asks for approval
  in every permission mode, and says so in the notification.
- *Secrets leaking into scrollback.* Output is scrubbed for key-shaped strings
  (`sk-ant-`, `ghp_`, `AKIA`, bot tokens…) before it is stored or sent.
- *A phone that leaves your pocket.* Face ID can lock the app, and can be
  required again before a chat enters bypass mode.
- *Uploads being used to read the disk.* `GET /files` serves only out of
  `~/.remote-ai-chat/uploads`, and only with a valid device token.

**What it does not**

- *Someone holding your unlocked phone.* They are you, as far as the daemon is
  concerned.
- *A model that is wrong in a way you approve.* The approval is the boundary.
  Read the command.
- *`bypass` permission mode.* It is exactly what it says. The folder fence and
  the dangerous-command list are all that remain.
- *Your tailnet itself.* If someone else is on it, they can reach port 8790 and
  start guessing tokens — slowly, but they can try.
- *The CLIs it drives.* `claude` and `codex` are installed from npm and run with
  your sign-in. Their security is theirs.
- *Agent definitions you install.* The agent store downloads markdown from
  public GitHub repositories listed in `daemon/remote_ai_chat/agents.py`.
  Nothing is executed at install time, but an agent definition is an instruction
  that later runs with your tools. Read one before you install it.
- *The self-updater.* `auto_update` is on by default: every 15 minutes the
  daemon fast-forwards its own checkout to `origin/main` and restarts. Whoever
  can push to that remote can change what runs on your machine. It will not
  touch a checkout with uncommitted work and will not do anything but a
  fast-forward — but if you did not intend to follow a remote, turn it off.

## If you think you are exposed

```bash
remote-ai-chat devices          # every paired device
remote-ai-chat revoke <id>      # cut one off, immediately
```

Revoking is instant: the token hash is deleted and the open socket is closed.
The chats stay; pair again to get back in.
