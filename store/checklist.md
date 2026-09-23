# App Store submission — remote-ai-chat

## Done
- [x] Bundle id `com.yakupkeskin.remoteaichat` registered, Push Notifications capability on
- [x] `Remote AI Chat App Store` distribution profile created
- [x] Build identity restored locally (`app/app.config.js` + gitignored `app/identity.local.json`)
- [x] App icon / splash / adaptive icon / favicon replaced (source: `design/icon.svg`)
- [x] Release archive + signed IPA (1.0.0 build 1)
- [x] `PRIVACY.md`
- [x] `store/localizations.json`, `store/app-infos.json`, `store/review-notes.txt`

## Needs Yakup
- [ ] Create the app record in App Store Connect (API cannot: HTTP 403 on POST /v1/apps)
      bundle `com.yakupkeskin.remoteaichat` · SKU `remoteaichat001` · en-US
- [ ] Decide on the App Review demo: video link (cheap) vs. in-app demo mode (robust)

## Then
- [ ] Upload build, TestFlight internal test (no review needed)
- [ ] `ascelerate apps app-info import` / `apps localizations import`
- [ ] Category: Developer Tools (primary), Productivity (secondary)
- [ ] Age rating 4+ — the only web view is the provider's own sign-in page, so
      not "unrestricted web access"
- [ ] Encryption declaration: `ITSAppUsesNonExemptEncryption = false` is in the
      Info.plist; the app itself performs no encryption
- [ ] App Privacy: Data Not Collected
- [ ] Screenshots 6.9" (1320x2868) — captured from the simulator against an
      isolated demo daemon (`RAC_HOME=/tmp/rac-demo`, port 8795), never his own chats
- [ ] Record the review video from the same demo setup
- [ ] Tear down: `rm -rf /tmp/rac-demo ~/Developer/{storefront,checkout-api,landing}`
