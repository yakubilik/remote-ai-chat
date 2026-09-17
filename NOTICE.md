# Notices

The MIT licence in [LICENSE](LICENSE) covers the code in this repository. It
does not, and cannot, cover the things below.

## Trademarks

`app/assets/provider-claude.png` and `app/assets/provider-codex.png` are the
marks of **Anthropic** and **OpenAI** respectively. They are included for one
purpose: so that a row in a list of sign-ins can be recognised as the tool it
belongs to. That is nominative use — identifying someone else's product — and it
is not a claim of ownership, an endorsement, or a licence to reuse them.

If you fork this and ship it, those two files are not yours to redistribute
under MIT. Replace them, or satisfy yourself that your use is also nominative.

This project is not affiliated with Anthropic or OpenAI. "Claude", "Claude
Code", "OpenAI" and "Codex" are their marks, not ours.

## Third-party code this project reaches for at runtime

Neither of these is vendored; both are downloaded by the user's own machine when
the user asks for them.

- **`claude` and `codex`** are installed from npm
  (`@anthropic-ai/claude-code`, `@openai/codex`) and run under the user's own
  sign-in. Their licences are their own.
- **The agent store** lists definitions from public GitHub repositories —
  `daemon/remote_ai_chat/agents.py` holds the list of sources. Installing one
  downloads markdown into the tool's agents folder; nothing is executed at
  install time, and the text carries whatever licence its source repository
  gives it. `daemon/remote_ai_chat/agent-store-snapshot.json` is a cached
  *listing* of file paths from those repositories, used so that the store is not
  empty when GitHub's API is rate-limited. It contains no third-party content.
