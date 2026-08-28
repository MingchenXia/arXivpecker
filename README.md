# Proofroom

Proofroom is a local-first mathematics paper reader designed around how mathematicians actually read.

It imports papers directly from arXiv, asks the user's existing local Codex subscription to audit the full paper, and turns the result into an interactive reading layer with:

- a theorem/definition/proof outline;
- source-page anchors and an embedded original PDF;
- expandable proof details and dependency-aware reading paths;
- full-paper context for questions about a specific result;
- linked LaTeX notes;
- one stable local folder per paper; and
- a reusable dependency graph across papers.

No OpenAI API key is used. AI work runs through the local `codex app-server` and the user's signed-in Codex subscription.

## Run locally

Use Node.js 22 or newer.

```bash
npm install
npm run codex-bridge
```

In another terminal:

```bash
npm run dev
```

Open the local URL printed by the development server. The Codex bridge listens on `http://127.0.0.1:4318` by default.

## Local data

Paper data is stored under `proofroom-library/` unless `PROOFROOM_LIBRARY_DIR` points elsewhere. Each paper folder contains its metadata, audit, reader state, links, attachments, exports, and reversible working-edition patches. The generated library is intentionally ignored by Git.
