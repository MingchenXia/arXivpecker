# Contributing to arXivpecker

arXivpecker is currently in private tester preview.

## Development setup

1. Install Node.js 22.13 or newer and the Codex CLI.
2. Sign in with `codex login` and confirm with `codex login status`.
3. Run `npm install`.
4. Run `npm run app`.

The combined command starts both the reader and its localhost Codex bridge. Use `npm run dev` when you only need the browser interface.

## Before submitting a change

Run:

```bash
npm run lint
npm run build
npm run test:starter
npm run audit-formulas
```

Do not commit `proofroom-library/`, local environment files, credentials, generated builds, or personal reader profiles. Add reusable demo papers only through `examples/starter-library/`, with portable relative source paths and no Codex thread ID.
