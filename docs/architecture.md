# Architecture

arXivpecker is a local-first reader with two cooperating processes:

- `app/` contains the browser interface and the arXiv metadata route.
- `scripts/codex-bridge.mjs` connects the interface to the locally signed-in Codex app-server. It never requires an OpenAI API key.
- `scripts/paper-vault.mjs` owns the durable paper-folder format, notes, edits, audits, version history, and cross-paper graph.
- `examples/starter-library/` is immutable repository data used only to seed a fresh installation.
- `proofroom-library/` is the user's writable library and is intentionally ignored by Git.

## First run

When the bridge opens an empty library, it copies the three bundled examples into `proofroom-library/`. The starter data contains no reader profile, browser preference, credential, or resumable Codex thread ID. The interface therefore opens its setup dialog on a genuinely new browser profile, then stores that reader's choices locally.

## Paper folder

Each paper folder may contain:

- `paper.json` — bibliographic and source metadata;
- `audit.json` — structured full-paper reading audit;
- `reader.json` — notes, reading marks, and expansion state;
- `editions/working/patches.json` — reversible author/AI edits;
- `attachments/source/` — TeX, figures, and source manifests;
- `updates.json` — version comparisons and migration records; and
- `links.json` — cross-paper logical dependencies.

Source paths saved in versioned starter data are relative. They are hydrated inside each tester's writable library, so clones are portable across operating systems and usernames.

## Trust boundary

The bridge listens only on `127.0.0.1`, accepts only localhost browser origins, and treats uploaded archives as untrusted. Source extraction rejects absolute paths and parent-directory traversal. AI reads run through the user's local Codex sign-in with read-only file access.
