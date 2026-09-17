# web — the desktop panel

A control panel that runs in a browser. The daemon serves the built files
itself (`daemon/remote_ai_chat/webui/`); there is no separate server.

```
npm install
npm run dev      # http://localhost:5177 (pairs through public/dev-host.json)
npm run build    # -> daemon/remote_ai_chat/webui/
```

On the computer, `remote-ai-chat web` hands the panel its own device token and
opens the browser. The panel shows up in `devices` and `revoke <id>` cuts it off
like it cuts off a phone.

## How it differs from the phone

The phone connects to one computer at a time. The panel connects to **all of
them at once** — that is the answer to "what is running where". One `RacClient`
per computer, all live, results merged in one place.

## Layers

| File | Job |
|---|---|
| `lib/protocol.ts`, `lib/ws.ts`, `lib/i18n.ts` | **Copied verbatim** from the iOS app. Do not edit here; if the originals under `app/src/` change, copy them again. |
| `lib/fleet.ts` | The computers. `useFleet()` → `{hosts, order, focus, activity}`. Each `hosts[key]`: `{cfg, status, info, catalog, chats, groups, projects, accounts, limits}`. `onAnyEvent(cb)` gives you every event from every computer. `selectRunning(state)` dumps everything that is running. |
| `lib/timeline.ts` | A chat's timeline. `useLogs().open(hostKey, chatId)` loads it and events stream in on their own. `logs[logKey(h,c)]` → `{items, busy, pending}`. |
| `lib/actions.ts` | `send`, `interrupt`, `respond`, `createChat`, `updateChat`, `deleteChat`, `listAgents`, `agentStore`, `installAgent`, `removeAgent`, `toolStatus`, `upload`, `fileUrl`, `parsePairing`. |
| `lib/format.ts` | `tilde`, `tildeAll`, `shortPath`, `cost`, `tokens`, `duration`, `uptime`, `ago`, `until`, `clock`, `windowName`, `toolSummary`. |
| `lib/theme.ts` | `C` (colours), `MONO`, `R` (radii). No colour exists outside this file. |
| `ui/kit.tsx` | `Chip`, `Btn`, `Dot`, `Pulse`, `Spinner`, `Segment`, `Label`, `Empty`, `Icon`+`P` (icon paths). |

## Language

The panel's own copy is English only. `lib/i18n.ts` is still here and still
mirrors the phone's table, but it does one job now: turning the daemon's error
codes into sentences. `main.tsx` pins the language rather than following the
browser.

## The rule

A screen shows only fields the daemon actually sends. If a number is not in the
protocol, it either gets added to the daemon or it does not appear at all —
there are no invented indicators. The artboards live in `design/desktop/`.
