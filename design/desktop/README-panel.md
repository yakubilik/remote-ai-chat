# Desktop control panel — artboards (1440×900)

Colour and metrics come from `TOKENS.md`; tone and level of detail come from the
mobile artboards in `design/*.dc.html`.

| File | What it is for |
|---|---|
| `Dashboard.dc.html` | The heart of the product: computer cards, the active-session table, the usage/queue/daemon column, the live event strip. |
| `Settings.dc.html` | The section list with **Accounts** open, the add-account flow, and a clipped Security section at the bottom. |
| `Projects.dc.html` | A card grid over `~/projects/*`: git status, last commit, open chats, "New chat here". |
| `Agents.dc.html` | Agents / Skills / Commands / Plugins tabs; an expanded agent card next to the Store panel. |
| `Onboarding.dc.html` | First launch: daemon → Tailscale → pair the phone (QR) → connect an account, on a vertical progress line. |

## Decisions

- **One shell.** The 260px sidebar is identical on every screen: traffic lights
  → computer picker → Chats·Panel·Projects·Agents·Settings → daemon/Tailscale
  summary → account chip. The active item gets an accent-tint background, an
  accent-ring border and an accent dot. The content area is 1180px.
- **State is colour *and* shape.** Running is a filled accent dot, idle is a
  hollow ring, awaiting approval is a warn triangle plus a 2px warn strip,
  offline is a hollow grey dot. Claude is accent, Codex is info.
- **A fixed column grid.** The session table is 176·62·124·52·84·114·44·52·66 =
  774px; duration and cost are mono and right-aligned. Account cards are
  188·112·196·96·184. The project grid is 4×269 + 16px.
- **Nothing is hidden by accident.** The IP reads `100.•••.•••.42`, the pairing
  code `RAC-••••-••••-7QF2`, the OAuth link is masked. Account folders are shown
  in their real form (`claude-759b47`, `codex-110229`). The QR is not real — it
  is a stylised 21×21 module grid with accent corner marks.
- **Scrolling is honest.** In Settings a thin scrollbar and clipped Security
  rows show that there is more. Pure static HTML with inline styles; icons are
  inline `<svg>` at stroke 2.2.
