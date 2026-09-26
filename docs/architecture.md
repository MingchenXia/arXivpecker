# Architecture

arXivpecker is a local-first reader with two cooperating processes:

- `app/` contains the browser interface and the arXiv metadata route:
  - `app/page.tsx` holds the top-level `Home` state (library, reader state, AI jobs) and per-paper reader-state saving;
  - `app/lib/` holds framework-free logic: shared types (`types.ts`), bridge client, storage and defaults (`app.ts`), KaTeX rendering with its cache and TeX prose cleanup (`tex-text.ts`), and audit parsing, working-edition patches, version migration, and exports (`audit.ts`);
  - `app/components/` holds the React views: the reader shell and its panels (`reader.tsx`), the interactive paper and proof line numbering (`document.tsx`), the unit inspector and version panels (`inspector.tsx`), library, discovery, settings and dialogs (`views.tsx`), math rendering (`math.tsx`), and icons.
- `scripts/codex-bridge.mjs` is the localhost HTTP bridge: request routing, source acquisition and uploads, and figure assets. It never requires an OpenAI API key.
- `scripts/codex-app-server.mjs` drives the locally signed-in Codex app-server over JSON-RPC (threads, turns, timeouts, archived-session recovery); `scripts/codex-prompts.mjs` holds the prompts and structured-output schemas it sends.
- `scripts/tex-source.mjs` reads a paper's TeX tree (includes, author macros, references, bibliography) and extracts theorem units and reader blocks. It is pure apart from reading files, so the TeX tests import it directly.
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

The bridge listens only on `127.0.0.1`, accepts only localhost browser origins, and treats uploaded archives as untrusted. Before any vault record is written, source extraction rejects absolute or parent-directory paths (including portable backslash forms), symbolic links and special files, corrupt archives, projects without TeX, more than 2,000 entries, and more than 256 MB of expanded data. Asset and local-PDF reads also verify their resolved filesystem path remains inside the paper source directory. AI reads run through the user's local Codex sign-in with read-only file access.
