# Desktop shell — artboards (1440×900)

| File | What it is for |
|---|---|
| `Shell.dc.html` | The main window. Three columns (260 · flexible · 300), in the idle / turn-finished state. The three modals below sit on top of it. |
| `ChatWorking.dc.html` | The same shell with the middle column mid-turn: the thinking line, four tool cards, a streaming answer, the live strip. |
| `Approval.dc.html` | Shell plus the dangerous-command approval dialog (520px). |
| `NewChat.dc.html` | Shell plus the new-chat modal (680px), in provider→model→effort→permission→folder→advanced order. |
| `Palette.dc.html` | Shell plus the ⌘K command palette (640px), with grouped results. |

## Decisions

- **Background hierarchy:** chrome (`#141311`) < column (`#1A1815`) < inset
  group (`#0F0E0C`). The "dark island inside a surface" pattern from the mobile
  `ModelSheet` carries over unchanged; no card shadows — separation is always a
  1px border.
- **The columns are fixed:** 260 left + 300 right, the middle takes what is left
  (880). Every gap is a multiple of 4; a list row is 56, a tool card 40, a chip
  28, an inspector row 40.
- **State is colour *and* shape:** approval → yellow triangle + `APPROVE`
  badge, running → accent pulse bars, error → red cross and red border, done →
  green tick. No state is told by colour alone.
- **Mono discipline:** paths, commands, tool names, tokens/$/duration and
  shortcut keys are mono; sentences never are. Long paths get an `ellipsis` and
  nothing overflows anywhere.
- **The inspector panel** is the writable form of the chips in the chat header:
  the same four fields (model·effort·permission·folder), shown as changeable
  with a chevron. Not a repetition — two layers, read and edit, of one set of
  data.
- **Stop lives in two places:** greyed out in the inspector when idle; red in
  both the inspector and the live strip while running; and the composer's send
  button turns into a square — so the mode is obvious at a glance.
- **The approval dialog** shows the command as a single line in a mono block,
  with "which chat / which folder / which computer" underneath. "Always allow"
  is left on a neutral surface, and the Face ID note sits directly below it.
- **bypass** turns the segment yellow and opens a warning line — the risky mode
  cannot be chosen quietly.
- **The palette** shows the list on an empty query, with the highlight on "New
  chat" as if arrowed down to; every row carries its shortcut on the right and
  the connection state underneath.
- Every colour comes from `TOKENS.md`; the only additions are rgba derivatives
  of those tokens (diff backgrounds, danger/warning fills).

> Note: `Dashboard/Projects/Settings.dc.html` are not part of this set — they
> came from a different pass and were left alone.
