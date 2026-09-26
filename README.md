# arXivpecker

arXivpecker is a local-first mathematics paper reader that preserves the complete author paper while adding interactive structure, editable TeX, proof expansion, citation lookup, notes, version comparison, and theorem-level dependency maps.

By default, AI work uses the tester's existing local Codex/ChatGPT sign-in and no API key. Any OpenAI-compatible model, hosted or local, can be used instead (see [Other AI models](#other-ai-models)).

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

## Other AI models

The bridge can run its AI work on any server that speaks the OpenAI Chat Completions API: a hosted API, or a local model server such as Ollama, LM Studio, or vLLM. Choose it when starting the bridge:

```bash
# A local model with Ollama
PROOFROOM_AI_BACKEND=openai-compatible \
PROOFROOM_AI_BASE_URL=http://localhost:11434/v1 \
PROOFROOM_AI_MODEL=qwen2.5:32b \
npm run app

# A hosted API: also give the key (it stays in the environment, never in the library)
PROOFROOM_AI_API_KEY=... PROOFROOM_AI_BACKEND=openai-compatible PROOFROOM_AI_BASE_URL=https://api.example.com/v1 PROOFROOM_AI_MODEL=... npm run app
```

Such a model cannot open files, so the bridge sends it the paper's expanded TeX with the first message of each conversation, cut at `PROOFROOM_AI_MAX_SOURCE_CHARS` (default 400,000 characters) to fit its context. It reads TeX only: papers available only as PDF, and PDF-to-LaTeX conversion, still need Codex. Audits ask for JSON through the server's structured output when it supports it, and through the prompt otherwise. Settings shows which backend is running.

## Project map

- `app/` — reader interface (`page.tsx`, `components/`, framework-free logic in `lib/`) and arXiv metadata route
- `scripts/` — local bridge (`codex-bridge.mjs`), AI backends (Codex client `codex-app-server.mjs` and OpenAI-compatible `chat-backend.mjs`) and prompts, TeX reader (`tex-source.mjs`), vault, checks, and sharing tools
- `examples/starter-library/` — portable bundled papers
- `docs/architecture.md` — storage, first-run, and trust-boundary design
- `proofroom-library/` — local runtime data, never committed

## Validation

```bash
npm run check        # lint, typecheck, production build, and every test (what CI runs)
npm test             # tests only
npm run test:e2e     # browser tests (after `npx playwright install chromium`)
npm audit --omit=dev
```

## License

arXivpecker's original source code and documentation are licensed under the [MIT License](LICENSE). The bundled paper examples are not relicensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before reusing them outside the local test library.
