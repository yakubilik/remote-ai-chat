# Privacy Policy — Remote AI Chat

_Last updated: 23 September 2026_

Remote AI Chat is a client for a daemon you run yourself. There is no account
to create, no server operated by the developer, and no analytics.

## What the app collects

Nothing. The developer receives no data from this app — not your messages, not
your files, not your identifiers, not crash reports, not usage statistics.

## Where your data goes

The app talks to one thing: the `remote-ai-chat` daemon running on a computer
you own, over your local network or your own private network (for example a
Tailscale tailnet). Everything you type, record or attach goes there and only
there. Chats, transcripts and attachments are stored on that computer, under
your account, and are deleted when you delete them there.

Two exceptions, both of which happen on your computer and not in the app:

- **The coding agent.** The daemon drives a command-line agent (for example
  `claude` or `codex`) that you installed and signed into yourself. Your
  messages reach that vendor's service under your own agreement with them, in
  exactly the way they would if you typed at your own keyboard. Their privacy
  policy applies to that traffic.
- **Voice messages.** If you record one, the daemon transcribes it. Depending
  on how you configured the daemon, that happens locally or through the
  transcription service you chose.

## Push notifications

If you turn on notifications, iOS gives the app a push token. The app sends
that token to your own daemon so it can notify you when a command is waiting
for approval or a turn has finished. The daemon delivers the notification
through Expo's push service, which relays it to Apple. The notification text
is the one your daemon composed. No token or message is sent to the developer.

## Permissions

The camera is used once, to scan the pairing QR code. The microphone is used
only while you hold the record button. Photo access is used only for the
picture you pick. Face ID / Touch ID, if you enable it, unlocks the app and
confirms dangerous actions; the biometric data never leaves your device and is
never seen by the app.

## Children

The app is not directed at children and collects no data from anyone.

## Changes

Any change to this policy will be published in this file in the public
repository, with the date above updated.

## Contact

Open an issue at <https://github.com/yakubilik/remote-ai-chat/issues>.
