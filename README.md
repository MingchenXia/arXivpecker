# arXivpecker

arXivpecker is a local-first mathematics paper reader that preserves the complete author paper while adding interactive structure, editable TeX, proof expansion, citation lookup, notes, version comparison, and theorem-level dependency maps.

AI work uses the tester's existing local Codex/ChatGPT sign-in. No OpenAI API key is used.

## Quick start

Requirements:

- Node.js 22.13 or newer;
- the Codex CLI; and
- an active Codex/ChatGPT sign-in (`codex login status`).

```bash
git clone https://github.com/MingchenXia/arXivpecker.git
cd arXivpecker
npm install
npm run app
```

Open the local URL shown in the terminal. A fresh clone opens the first-time reading-profile setup and includes three starter papers:

- *A Sample Mathematics Paper* — an interactive feature tour;
- arXiv:2607.17203 — an unaudited paper for testing the audit flow; and
- arXiv:2608.24719v1 — a fully structured audited paper with TeX source.

`npm run app` builds and starts the optimized web reader together with the local Codex bridge. Contributors who need hot reload can use `npm run app:dev`; for separate terminals, run `npm run codex-bridge` and `npm run dev`.

### After restarting the computer

Open Terminal, return to this checkout, and start the app again:

```bash
cd /path/to/arXivpecker
npm run app
```

Then open <http://localhost:3000>. Papers, audit checkpoints, notes, edits, and reader conversations are stored in the local library and are restored automatically.

## Local data

The repository's reusable examples live in `examples/starter-library/`. On first launch they are copied into the writable `proofroom-library/`, where imported papers, notes, edits, audit results, uploads, exports, and preferences remain local and are ignored by Git.

Set `PROOFROOM_LIBRARY_DIR` to use another writable library. Set `ARXIVPECKER_SKIP_STARTER_LIBRARY=1` when an intentionally empty library is desired.

Long audits are never stopped for taking too long: by default an audit runs until Codex completes or fails, and an interrupted audit can be resumed from its checkpoint. To opt in to a cutoff, set `CODEX_TURN_IDLE_TIMEOUT_MS` (no Codex progress event for that long) and/or `CODEX_TURN_HARD_TIMEOUT_MS` (absolute limit), in milliseconds with a one-minute minimum; the legacy `CODEX_TURN_TIMEOUT_MS` remains an alias for the idle limit.

## Project map

- `app/` — reader interface (`page.tsx`, `components/`, framework-free logic in `lib/`) and arXiv metadata route
- `scripts/` — local Codex bridge (`codex-bridge.mjs`), Codex client and prompts, TeX reader (`tex-source.mjs`), vault, checks, and sharing tools
- `examples/starter-library/` — portable bundled papers
- `docs/architecture.md` — storage, first-run, and trust-boundary design
- `proofroom-library/` — local runtime data, never committed

## Validation

```bash
npm run check        # lint, typecheck, production build, and every test (what CI runs)
npm test             # tests only
npm audit --omit=dev
```

## License

arXivpecker's original source code and documentation are licensed under the [MIT License](LICENSE). The bundled paper examples are not relicensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before reusing them outside the local test library.
