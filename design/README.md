# design

Every screen in this project was drawn before it was built. What survives here
is the part that the code still has to obey: the tokens.

[TOKENS.md](TOKENS.md) is the whole design system — colour, type scale, spacing,
radii, the two icon weights. `app/src/theme.ts` and `web/src/lib/theme.ts`
mirror it, and neither invents a value of its own. If you are adding a screen
and reach for a colour that is not in that table, the answer is one of the ones
that is.

Two rules hold across the interface and are easier to state than to derive from
the tokens:

**Dark, and only dark.** There is no light theme and there is no toggle. The app
is read at night, in bed, one-handed, and a theme switch is a setting nobody
would change twice.

**Nothing moves that was not touched.** A stream arriving, a tool finishing, an
approval appearing — none of those may reflow what is already on screen. The
list grows downward and the eye stays where it was.

For what the screens actually look like, see the screenshots in the
[repository README](../README.md); they are captured from the running app rather
than drawn.
