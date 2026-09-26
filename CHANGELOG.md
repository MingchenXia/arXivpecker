# Changelog

## 1.0.0 — 2026-09-26

The first stable release. Changes since 0.2.0:

### Reading and studying

- A notation glossary in the outline, and hover definitions for the symbols in a formula.
- A reading path to any result, listing the prerequisites to read first.
- Proof practice with the author proof hidden, then compared with your attempt.
- Review cards for understood results, with scheduling and Anki export.
- Lean 4 statement drafts for results and definitions.
- The original PDF beside the paper, following the unit being read.
- One-click import of a cited arXiv paper from its bibliography entry.
- A daily check for new arXiv versions and newly citing papers.
- A resizable assistant panel that wraps its text instead of scrolling sideways.
- Formulas are typeset as they near the viewport, and all of them before printing.

### Audits and AI

- Audits run in the local bridge as background jobs. Reloading or closing the browser does not interrupt them, and a stopped audit continues its saved Codex thread.
- Reader work made while a version update runs is kept.
- OpenAI-compatible backends, such as a local Ollama model or a hosted API, can replace Codex.

### TeX fidelity

- References print the way the paper's packages would print them: cleveref, autoref, nameref, page references, enumerate items, subfigures, footnotes, and unnumbered labels.
- Theorem declarations from thmtools, llncs, and aliascnt are recognized, as is `\newtheorem{claim}[section]`.
- Author macros are expanded, including mathtools paired delimiters and xparse commands. Commands KaTeX lacks, such as siunitx units and the indicator 1, get defaults.
- Packages and classes shipped with the source contribute their theorem, macro, counter, and cleveref declarations. Sources split with `\import` or `\subfile` are read in full.
- biblatex citations and hand-written bibliographies are read. A biblatex shorthand or a `\bibitem[label]` becomes the printed citation label.
- Text-mode symbols and accents display as characters: §, ¶, í, ø, and guillemets.
- A locally uploaded paper takes its title, authors, and abstract from its TeX.

### Reliability

- Library writes are serialized and atomic, and a damaged record is kept for recovery instead of being overwritten.
- Uploads are checked for path traversal, symbolic links, and oversized archives.
- arXiv requests are throttled and cached.
- The TeX reader runs off the main thread, and its reference resolution stays linear in the paper's length.

### Development

- Prettier, ESLint, typechecking, unit suites, and Playwright browser tests run in CI.
- `npm run reindex-audits -- <word>` rebuilds the reader of selected papers from their TeX.
