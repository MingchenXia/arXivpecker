# Contributing to arXivpecker

arXivpecker is an open-source, local-first mathematics paper reader.

## Development setup

1. Install Node.js 22.13 or newer and the Codex CLI.
2. Sign in with `codex login` and confirm with `codex login status`.
3. Run `npm install`.
4. Run `npm run app`.

The combined command starts both the reader and its localhost Codex bridge. Use `npm run dev` when you only need the browser interface.

## Before submitting a change

Run:

```bash
npm run check
```

It runs lint, typecheck, the production build, and every test, exactly as CI does. Add new test scripts to the `test` entry in `package.json` so CI picks them up.

Do not commit `proofroom-library/`, local environment files, credentials, generated builds, or personal reader profiles. Add reusable demo papers only through `examples/starter-library/`, with portable relative source paths and no Codex thread ID.
