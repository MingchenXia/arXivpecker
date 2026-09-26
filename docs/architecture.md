# Architecture

arXivpecker is a local-first reader with two cooperating processes:

- `app/` contains the browser interface and two server routes: arXiv metadata (`app/api/arxiv`, throttled and cached, with a batched `ids=` lookup for the library's update watch) and papers citing a library paper (`app/api/citations`, from OpenAlex, cached for six hours):
  - `app/page.tsx` holds the top-level `Home` state (library, reader state, AI jobs) and per-paper reader-state saving;
  - `app/lib/` holds framework-free logic: shared types (`types.ts`), bridge client, storage and defaults (`app.ts`), KaTeX rendering with its cache and TeX prose cleanup (`tex-text.ts`), audit parsing, working-edition patches, version migration, and exports (`audit.ts`), study aids such as reading paths and practice records (`study.ts`), and the notation glossary read off defining sentences (`glossary.ts`);
  - `app/components/` holds the React views: the reader shell and its panels (`reader.tsx`), the interactive paper and proof line numbering (`document.tsx`), the unit inspector and version panels (`inspector.tsx`), the study tools inside it (`study-tools.tsx`), library, discovery, settings and dialogs (`views.tsx`), math rendering (`math.tsx`), and icons.
- `scripts/codex-bridge.mjs` is the localhost HTTP bridge: request routing, source acquisition and uploads, and figure assets. It never requires an OpenAI API key.
- `scripts/codex-app-server.mjs` drives the locally signed-in Codex app-server over JSON-RPC (threads, turns, timeouts, archived-session recovery); `scripts/codex-prompts.mjs` holds the prompts and structured-output schemas it sends.
- `scripts/tex-source.mjs` reads a paper's TeX tree (includes, author macros, references, bibliography), numbers results, equations, sections, and floats as LaTeX would, and extracts theorem units and reader blocks. It is pure apart from reading files, so the TeX tests import it directly. The bridge runs it on a worker thread (`scripts/tex-worker.mjs`) so a long paper never stalls other requests; enrichment is linear in document size (about 1.2 s for 1.75 MB of TeX).
  - A full LaTeX parser (unified-latex) was evaluated as a replacement and rejected: it parsed 20–80× slower (23 s and 3.5 GB for 1.75 MB), does not expand `\def`, `\DeclareMathOperator`, or `\let`, and would still leave numbering, references, proofs, and bibliography to this module.
- `scripts/paper-vault.mjs` owns the durable paper-folder format, notes, edits, audits, version history, and cross-paper graph. Besides the audit's own dependencies and the reader's manual links, the graph links a unit to the exact result of another library paper it cites with a locator such as `\cite[Theorem 2.1]{key}` (`scripts/citation-links.mjs`).
- `examples/starter-library/` is immutable repository data used only to seed a fresh installation.
- `proofroom-library/` is the user's writable library and is intentionally ignored by Git.

## First run

When the bridge opens an empty library, it copies the three bundled examples into `proofroom-library/`. The starter data contains no reader profile, browser preference, credential, or resumable Codex thread ID. The interface therefore opens its setup dialog on a genuinely new browser profile, then stores that reader's choices locally.

## Audits

An AI audit runs as a background job owned by the bridge, not by the page that started it. `POST /analyze` answers `202` at once; the bridge records the job in `audit-progress.json`, streams its state and Codex progress to every open reader over `GET /events` (server-sent events), and stores the finished result in `audit-result.json` before announcing it as `ready`. A reader that is open, reloaded, or started later fetches `GET /analyze/result`, builds the interactive reader from it, and saves it through `/vault/audit`, which completes the job and removes the stored result. `POST /analyze/cancel` interrupts the Codex turn; the job pauses with its thread kept, so Continue audit resumes it. Tests use a scripted stand-in for the Codex CLI in `e2e/fixtures/bin/codex`.

## Paper folder

Each paper folder may contain:

- `paper.json` — bibliographic and source metadata;
- `audit.json` — structured full-paper reading audit;
- `audit-progress.json` and `audit-result.json` — the running or last audit job, and a finished result not yet built into the reader;
- `reader.json` — notes, reading marks, and expansion state;
- `editions/working/patches.json` — reversible author/AI edits;
- `attachments/source/` — TeX, figures, and source manifests;
- `updates.json` — version comparisons and migration records; and
- `links.json` — cross-paper logical dependencies.

Source paths saved in versioned starter data are relative. They are hydrated inside each tester's writable library, so clones are portable across operating systems and usernames.

## Trust boundary

The bridge listens only on `127.0.0.1`, accepts only localhost browser origins, and treats uploaded archives as untrusted. Before any vault record is written, source extraction rejects absolute or parent-directory paths (including portable backslash forms), symbolic links and special files, corrupt archives, projects without TeX, more than 2,000 entries, and more than 256 MB of expanded data. Asset and local-PDF reads also verify their resolved filesystem path remains inside the paper source directory. AI reads run through the user's local Codex sign-in with read-only file access.
