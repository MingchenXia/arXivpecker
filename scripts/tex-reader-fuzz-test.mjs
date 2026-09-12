import assert from 'node:assert/strict';
import katex from 'katex';
import { buildSourceBlocks, expandAuthorMacros, extractSourceUnits, readableLatex, resolveLatexReferences } from './codex-bridge.mjs';

let seed = 0x5eed1234;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
}
function pick(values) { return values[Math.floor(random() * values.length)]; }

const formulaPattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$]+?)\$|\\\(([\s\S]+?)\\\)/g;
const macros = { '\\qed': '\\square', '\\qedsymbol': '\\square', '\\qedhere': '\\square', '\\mbox': '\\text{#1}' };
let formulas = 0;

for (let iteration = 0; iteration < 300; iteration += 1) {
  const documentClass = pick(['article', 'amsart', 'book']);
  const heading = documentClass === 'book'
    ? `${pick(['\\chapter', '\\chapter*'])}{Chapter ${iteration}}\n${pick(['\\section', '\\section*'])}{Layer ${iteration}}`
    : iteration % 5 === 0 ? '' : `${pick(['\\section', '\\section*'])}{Section ${iteration}}`;
  const beginSpacing = pick(['\n', ' ', '\n% document begins below\n']);
  const endSpacing = pick(['\n', ' ', '\n']);
  const argument = pick(['A', 'B_1', '\\mathcal F', '{x+y}']);
  const legacy = pick(['\\bf', '\\it', '\\rm']);
  const source = String.raw`\documentclass{${documentClass}}
% \begin{document}\section{Ghost ${iteration}}
\newtheorem{theorem}{Theorem}[section]
\newcommand{\norm}[1]{\left\lVert#1\right\rVert}
\newcommand{\pair}[2]{\left\langle#1,#2\right\rangle}
\begin{document}${beginSpacing}\title{Repeated title ${iteration}}\author{Repeated author}\maketitle
\begin{abstract}Repeated abstract ${iteration}.\end{abstract}
${heading}
Visible opening ${iteration}.
% \begin{theorem}Ghost result.\end{theorem}
\begin{theorem}[Case ${iteration}]Let $\norm{${argument}} \leq \pair{x}{y}$ and $\mbox{{${legacy} $(\omega,\Omega)$-stable} object}$.\end{theorem}
\begin{proof}Apply $x=x$.\hfil ${pick(['\\hfill', '\\hfil'])} $\Box$\end{proof}
\begin{verbatim}\section{Literal ghost}\hfill $not-math$\end{verbatim}
Final visible sentence.${endSpacing}\end{document}Post-document text must stay hidden.`;

  const expanded = expandAuthorMacros(source);
  assert.doesNotMatch(expanded, /\\lVert[A-Za-z@]/, `Iteration ${iteration} merged a macro argument into a control word.`);
  const preliminary = extractSourceUnits(source);
  assert.equal(preliminary.length, 1, `Iteration ${iteration} must ignore the commented theorem.`);
  const resolved = resolveLatexReferences(source, preliminary);
  const units = extractSourceUnits(resolved);
  const blocks = buildSourceBlocks(resolved, units, new Map());
  const visible = blocks.map((block) => `${block.title}\n${block.content}\n${block.proofText}`).join('\n');
  assert.match(visible, new RegExp(`Visible opening ${iteration}`));
  assert.match(visible, /Final visible sentence/);
  assert.doesNotMatch(visible, /Ghost result|Ghost \d+|Repeated title|Repeated author|Repeated abstract|Post-document text/);
  assert.doesNotMatch(visible, /\\hfill?\b|\\(?:bf|it|rm)\b|\\begin\{document\}|\\end\{document\}/);

  for (const match of visible.matchAll(formulaPattern)) {
    const expression = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    assert.doesNotThrow(() => katex.renderToString(expression, { throwOnError: true, strict: 'ignore', displayMode: Boolean(match[1] || match[2]), macros }), `Iteration ${iteration} produced invalid reader math: ${expression}`);
    formulas += 1;
  }

  assert.doesNotMatch(readableLatex(String.raw`Left\hfill right and left\hfil right.`), /\\hfill?\b/);
}

console.log(`TeX reader fuzz: 300 mixed-format documents and ${formulas} formulas rendered without crashes, leaked layout commands, or lost body text.`);
