# design — the artboards

Every screen in this project was drawn before it was built, as a standalone HTML
file with inline styles and no build step. Open one in a browser and it is
exactly what the screen should look like, at the size it should look like it.

They are kept here because they are still the argument: when the code and the
artboard disagree about a spacing, a state colour or where a stop button lives,
the artboard is usually the one that thought about it.

```
design/*.dc.html           the phone, 402×874
design/desktop/*.dc.html   the desktop panel and shell, 1440×900
design/canvas.json         the board they were laid out on
design/desktop/README-shell.md, README-panel.md   what each set decided, and why
```

Two things to know before reading them:

**They are in Turkish.** The interface was drawn in the language it was first
used in. The product ships English-first — `app/src/i18n.ts` is the real copy —
so treat the artboards as layout, state and colour, not as wording.

**Every value in them is fake.** Addresses are masked (`100.•••.•••.42`),
pairing codes are masked, the QR codes are stylised 21×21 grids rather than real
ones, and the accounts and folder names are invented. Nothing here was captured
from a running machine.

Colours and metrics are in `design/desktop/TOKENS.md`, which the code mirrors
in `app/src/theme.ts` and `web/src/lib/theme.ts`. Nothing in an artboard
introduces a colour of its own.
