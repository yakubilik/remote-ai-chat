# App Store submission — remote-ai-chat

## Done
- [x] Bundle id `com.yakupkeskin.remoteaichat` registered, Push Notifications capability on
- [x] `Remote AI Chat App Store` distribution profile created
- [x] Build identity restored locally (`app/app.config.js` + gitignored `app/identity.local.json`)
- [x] App icon / splash / adaptive icon / favicon replaced (source: `design/icon.svg`)
- [x] Release archive + signed IPA (1.0.0 build 1)
- [x] `PRIVACY.md`
- [x] `store/localizations.json`, `store/app-infos.json`, `store/review-notes.txt`
- [x] Screenshots 6.9" (1320x2868) in `store/shots/en-US/APP_IPHONE_67/` — captured
      from the simulator against the isolated demo daemon, so no real chat is in them

- [x] App record created (app id 6815430115) — the public API forbids it, so it
      went through the App Store Connect web session (`/iris/v1/apps`)
- [x] Build 1.0.0 (1) uploaded, processed Valid, attached to version 1.0
- [x] TestFlight: internal group with the account holder, build IN_BETA_TESTING
- [x] Description, keywords, subtitle, privacy/support/marketing URLs
- [x] Category: Developer Tools
- [x] Age rating: every answer None/false → 4+
- [x] Export compliance: answered from the Info.plist, build is Valid
- [x] App Privacy: Data Not Collected, published
- [x] Screenshots uploaded, 5/5 processed

## Needs Yakup
- [ ] A contact phone number for App Review Information — required, and the only
      field left before the app can be submitted
- [ ] Say go before the submission itself

## Notes
- No "What's New" on a first release; App Store Connect refuses to set it, and
  ascelerate's preflight counts that as a failure. Ignore it.
- The review notes offer Apple a demo daemon on request rather than a video,
  because the app cannot be driven without a paired computer.

## Tear down when done
- `rm -rf /tmp/rac-demo ~/Developer/{storefront,checkout-api,landing}`
