import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import katex from 'katex';
import { ar5ivFigureUrl, buildSourceBlocks, expandAuthorMacros, extractSourceUnits, readExpandedTex, readableLatex, resolveLatexReferences, sameExpandedTexSource } from './codex-bridge.mjs';

const source = String.raw`\documentclass{article}
\usepackage{amsmath}
\numberwithin{equation}{section}
\newtheorem{theorem}{Theorem}[section]
\begin{document}
\section{Setup}\label{sec:setup}
\begin{theorem}\label{thm:key}
Equation~\eqref{eq:key} implies the claim.
\end{theorem}
\begin{equation}\label{eq:key}x=1.\end{equation}
\begin{figure}\includegraphics{plot.pdf}\caption{Plot}\label{fig:key}\end{figure}
\begin{longtable}{c}Value\\\label{tab:key}\end{longtable}
See Section~\ref{sec:setup}, Theorem~\ref{thm:key}, Equation~\eqref{eq:key}, Figure~\ref{fig:key}, and Table~\ref{tab:key}.
\begin{verbatim}\ref{thm:key}\end{verbatim}
\end{document}`;

const resolved = resolveLatexReferences(source, extractSourceUnits(source));
assert.match(resolved, /Section~1, Theorem~1\.1, Equation~\(1\.1\), Figure~1, and Table~1/);
assert.ok(resolved.includes(String.raw`\begin{verbatim}\ref{thm:key}\end{verbatim}`), 'Literal TeX examples must not be rewritten.');
const theorem = extractSourceUnits(resolved)[0];
assert.equal(theorem.printedNumber, '1.1');
assert.match(theorem.statement, /Equation\s+\(1\.1\) implies the claim\./);

const sharedSectionSource = String.raw`\newtheorem{claim}[section]{Claim}
\begin{document}
\section{First}
\begin{claim}First claim.\end{claim}
\begin{claim}Second claim.\end{claim}
\section{Second}
\begin{claim}Third claim.\end{claim}
\end{document}`;
assert.deepEqual(extractSourceUnits(sharedSectionSource).map((unit) => unit.printedNumber), ['1', '1', '2'], 'A theorem sharing the section counter must display the current section number without incrementing it.');

const nestedCounterSource = String.raw`\newtheorem{lemma}{Lemma}[subsection]
\begin{document}
\section{Setup}\subsection{First}
\begin{lemma}Nested one.\end{lemma}
\begin{lemma}Nested two.\end{lemma}
\subsection{Second}
\begin{lemma}Nested three.\end{lemma}
\end{document}`;
assert.deepEqual(extractSourceUnits(nestedCounterSource).map((unit) => unit.printedNumber), ['1.1.1', '1.1.2', '1.2.1'], 'Theorem counters scoped to subsections must retain the full structural number.');

const sharedTheoremSource = String.raw`\newtheorem{theorem}{Theorem}[section]
\newtheorem{proposition}[theorem]{Proposition}
\newtheorem*{remark}{Remark}
\section{Setup}
\begin{theorem}First result.\end{theorem}
\begin{proposition}Shared result.\end{proposition}
\begin{remark}Unnumbered note.\end{remark}`;
assert.deepEqual(extractSourceUnits(sharedTheoremSource).map((unit) => unit.printedNumber), ['1.1', '1.2', ''], 'Shared theorem counters and starred unnumbered environments must retain their LaTeX semantics.');

const longSource = `${String.raw`\newtheorem{observation}{Observation}[section]\begin{document}`}${Array.from({ length: 320 }, (_, index) => `${index % 80 === 0 ? `\\section{Part ${index / 80 + 1}}` : ''}\\begin{observation}Long-form source item ${index + 1}.\\end{observation}`).join('')}\\end{document}`;
const longUnits = extractSourceUnits(longSource);
assert.equal(longUnits.length, 320, 'Long papers must retain every extracted result.');
assert.equal(longUnits.at(-1)?.printedNumber, '4.80', 'Long papers must reset section-scoped counters at section boundaries.');

const sourceRoot = await mkdtemp(path.join(tmpdir(), 'arxivpecker-reader-'));
try {
  await mkdir(path.join(sourceRoot, 'chapters'));
  await writeFile(path.join(sourceRoot, 'main.tex'), String.raw`\begin{document}
\input{chapters/intro}
% \input{chapters/ignored}
\begin{verbatim}\input{chapters/literal}\end{verbatim}
\end{document}`);
  await writeFile(path.join(sourceRoot, 'chapters/intro.tex'), 'Included chapter text.');
  await writeFile(path.join(sourceRoot, 'chapters/ignored.tex'), 'This commented chapter must stay excluded.');
  await writeFile(path.join(sourceRoot, 'chapters/literal.tex'), 'This literal TeX example must stay excluded.');
  const expanded = await readExpandedTex(path.join(sourceRoot, 'main.tex'), sourceRoot);
  assert.match(expanded, /Included chapter text\./);
  assert.doesNotMatch(expanded, /commented chapter must stay excluded|literal TeX example must stay excluded/);
  assert.match(expanded, /% \\input\{chapters\/ignored\}/, 'Commented input commands must remain source text, not expanded content.');
  assert.match(expanded, /\\begin\{verbatim\}\\input\{chapters\/literal\}/, 'Literal TeX examples must remain source text, not expanded content.');
  const aliasDirectory = path.join(sourceRoot, 'alias');
  await mkdir(aliasDirectory);
  await writeFile(path.join(aliasDirectory, 'main.tex'), await readFile(path.join(sourceRoot, 'main.tex')));
  await mkdir(path.join(aliasDirectory, 'chapters'));
  await writeFile(path.join(aliasDirectory, 'chapters/intro.tex'), 'Included chapter text.');
  assert.equal(await sameExpandedTexSource(
    { kind: 'tex', entryFile: path.join(sourceRoot, 'main.tex'), sourceDirectory: sourceRoot },
    { kind: 'tex', entryFile: path.join(aliasDirectory, 'main.tex'), sourceDirectory: aliasDirectory },
  ), true, 'An unversioned arXiv alias with identical expanded TeX must bypass a needless AI comparison.');
  await writeFile(path.join(aliasDirectory, 'chapters/intro.tex'), 'A genuinely revised chapter.');
  assert.equal(await sameExpandedTexSource(
    { kind: 'tex', entryFile: path.join(sourceRoot, 'main.tex'), sourceDirectory: sourceRoot },
    { kind: 'tex', entryFile: path.join(aliasDirectory, 'main.tex'), sourceDirectory: aliasDirectory },
  ), false, 'A real included-file change must still reach structural AI comparison.');
} finally {
  await rm(sourceRoot, { recursive: true, force: true });
}

const figureUnit = extractSourceUnits(String.raw`\newtheorem{example}{Example}\begin{example}% \includegraphics{discarded.png}
\includegraphics{kept.pdf}\end{example}`)[0];
assert.deepEqual(figureUnit.assetPaths, ['kept.pdf'], 'Commented image commands must never create missing reader figures.');

const commentedBreak = extractSourceUnits(String.raw`\newtheorem{theorem}{Theorem}\begin{theorem}$\begin{aligned}a&=b\\% author comment
c&=d\end{aligned}$\end{theorem}`)[0];
assert.doesNotMatch(commentedBreak.statement, /author comment/);

const delayedProofSource = String.raw`\newtheorem{proposition}{Proposition}\newenvironment{proof1}[1][Proof]{#1}{}\begin{proposition}\label{prop:delayed}Claim.\end{proposition}\begin{proposition}\label{prop:later}Later.\end{proposition}\begin{proof1}[Proof of Proposition~\ref{prop:delayed}]Complete argument.\end{proof1}`;
const delayedPreliminary = extractSourceUnits(delayedProofSource);
const delayedResolved = resolveLatexReferences(delayedProofSource, delayedPreliminary);
const delayedUnits = extractSourceUnits(delayedResolved);
assert.match(delayedUnits[0].proofText, /Complete argument/);
assert.equal(delayedUnits[1].proofText, '', 'A delayed proof must remain attached to its explicitly referenced result.');

const delayedProofBlocks = buildSourceBlocks(delayedResolved, delayedUnits, new Map());
assert.ok(delayedProofBlocks.some((block) => block.kind === 'proof' && /Complete argument/.test(block.proofText)), 'A delayed proof must remain visible at its original source location.');
assert.equal(delayedProofBlocks.filter((block) => block.kind === 'proof' && /Complete argument/.test(block.proofText)).length, 1, 'A delayed proof must be rendered once, not duplicated beside its earlier theorem.');

const standaloneProofBlocks = buildSourceBlocks(String.raw`\begin{document}\section{A standalone proof}\begin{proof}This proof is not linked to a theorem node.\end{proof}\end{document}`, [], new Map());
assert.ok(standaloneProofBlocks.some((block) => block.kind === 'proof' && /not linked to a theorem node/.test(block.proofText)), 'An unlinked proof environment must remain visible in the source reader.');

const bodyDeclarationBlocks = buildSourceBlocks(String.raw`\begin{document}
\mathchardef\mhyphen="2D
\newtheorem{The}{Theorem}[section]
\newcommand{\C}{\mathbb{C}}
\newcommand\rank{\operatorname{rank}}
Readable opening text.
\section{Content}
The body remains visible.
\end{document}`, [], new Map());
const bodyDeclarationText = bodyDeclarationBlocks.map((block) => `${block.title} ${block.content}`).join('\n');
assert.doesNotMatch(bodyDeclarationText, /mathchardef|newtheorem|newcommand/, 'Document declarations placed after \\begin{document} must not appear as reader prose.');
assert.match(bodyDeclarationText, /Readable opening text[.]|The body remains visible[.]/, 'Filtering document declarations must preserve adjacent paper prose.');

const localDeclarationSource = String.raw`\newtheorem{prop}{Proposition}
\begin{document}
\begin{prop}A local declaration in the proof must remain invisible.
\begin{proof}
\newcommand{\localnorm}[1]{
  \left\lVert #1 \right\rVert
}
The value $\localnorm{A}$ is finite.
\end{proof}
\end{prop}
\end{document}`;
const localDeclarationBlocks = buildSourceBlocks(localDeclarationSource, extractSourceUnits(localDeclarationSource), new Map());
const localDeclarationText = localDeclarationBlocks.map((block) => `${block.content} ${block.proofText}`).join('\n');
assert.doesNotMatch(localDeclarationText, /newcommand|#1/, 'A balanced multi-line declaration inside a proof must not leak into reader text.');
assert.match(localDeclarationText, /\\lVert\s*A/, 'Removing a local declaration must preserve and expand its later macro uses.');

const manualFrontMatterBlocks = buildSourceBlocks(String.raw`\begin{document}
\begin{center}{\Large Duplicate title}\end{center}
\begin{center}Duplicate author\end{center}
\noindent{\bf Abstract.} Duplicate abstract.
\section{Introduction}
Actual introduction.
\end{document}`, [], new Map());
const manualFrontMatterText = manualFrontMatterBlocks.map((block) => `${block.title} ${block.content}`).join('\n');
assert.equal(manualFrontMatterBlocks[0]?.kind, 'section', 'The source flow must begin at the first section after the separately rendered reader header.');
assert.doesNotMatch(manualFrontMatterText, /Duplicate title|Duplicate author|Duplicate abstract/, 'Manual title, author, and abstract front matter must not be rendered twice.');
assert.match(manualFrontMatterText, /Introduction|Actual introduction[.]/);

const bookBlocks = buildSourceBlocks(String.raw`\documentclass{book}\begin{document}
\title{Repeated book title}\author{Repeated book author}\maketitle
\chapter*{Preface}Preface text.
\chapter{Foundations}Chapter text.
\section{First layer}Section text.
\subsection*{A starred layer}Starred subsection text.
\end{document}`, [], new Map());
const bookSections = bookBlocks.filter((block) => block.kind === 'section');
assert.deepEqual(bookSections.map((block) => [block.title, block.level]), [['Preface', 1], ['Foundations', 1], ['First layer', 2], ['A starred layer', 3]], 'Book-style chapter hierarchy, including starred headings, must remain structured and nested.');
assert.doesNotMatch(bookBlocks.map((block) => `${block.title} ${block.content}`).join('\n'), /Repeated book title|Repeated book author|\\chapter/, 'Book headings and front matter must not leak as raw TeX prose.');

const bookReferenceSource = String.raw`\newtheorem{theorem}{Theorem}[section]\numberwithin{equation}{section}\begin{document}\chapter{Foundations}\label{chap:foundations}\section{Setup}\label{sec:setup}\begin{theorem}\label{thm:book}Book result.\end{theorem}\begin{equation}\label{eq:book}x=x.\end{equation}See Chapter~\ref{chap:foundations}, Section~\ref{sec:setup}, Theorem~\ref{thm:book}, and Equation~\eqref{eq:book}.\end{document}`;
const bookReferenceUnits = extractSourceUnits(bookReferenceSource);
assert.equal(bookReferenceUnits[0]?.printedNumber, '1.1.1');
assert.match(resolveLatexReferences(bookReferenceSource, bookReferenceUnits), /Chapter~1, Section~1\.1, Theorem~1\.1\.1, and Equation~\(1\.1\.1\)/, 'Book-style chapter, section, theorem, and equation references must retain their full structural number.');

const unsectionedBlocks = buildSourceBlocks(String.raw`\documentclass{article}\begin{document}\begin{abstract}Header abstract.\end{abstract}Unsectioned opening paragraph.

A second paragraph.\end{document}`, [], new Map());
assert.deepEqual(unsectionedBlocks.filter((block) => block.kind === 'paragraph').map((block) => block.content), ['Unsectioned opening paragraph.', 'A second paragraph.'], 'An unsectioned paper must retain all body prose after its separately rendered abstract.');

const commentedStructureBlocks = buildSourceBlocks(String.raw`\documentclass{article}
% \begin{document}\section{Ghost heading}
% \chapter{Ghost chapter}
\begin{document}% \section{Also ghost}
Visible opening.
% \section{Still ghost}
\section{Real heading}Visible body.
% \end{document}
\end{document}Trailing material must be ignored.`, [], new Map());
assert.deepEqual(commentedStructureBlocks.filter((block) => block.kind === 'section').map((block) => [block.title, block.level]), [['Real heading', 1]], 'Commented document markers and headings must never create or shift reader structure.');
assert.doesNotMatch(commentedStructureBlocks.map((block) => `${block.title} ${block.content}`).join('\n'), /Ghost heading|Also ghost|Still ghost|Trailing material/, 'Commented or post-document material must not leak into reader content.');

const commentedLiteralMarkers = String.raw`\begin{document}
% \begin{verbatim}
\begin{theorem}A real result between commented literal markers.\end{theorem}
% \end{verbatim}
\end{document}`;
assert.equal(extractSourceUnits(commentedLiteralMarkers).length, 1, 'Commented literal-environment markers must not hide real document structure on later lines.');
assert.match(readableLatex(String.raw`\begin{verbatim}100% literal source\end{verbatim}`), /100% literal source/, 'Percent signs inside a real literal source environment must remain visible.');
assert.equal(readableLatex(String.raw`Visible before.\begin{comment}Hidden prose.\begin{theorem}Hidden result.\end{theorem}\end{comment}Visible after.`), 'Visible before.Visible after.', 'The comment environment and all of its contents must be invisible to the reader.');

const literalMetadataNoise = extractSourceUnits(String.raw`\newtheorem{theorem}{Theorem}\begin{document}\begin{theorem}
Real citation \cite[Thm. 2]{real} and real figure \includegraphics{real-figure}.
% Fake citation \cite{commented} and \includegraphics{commented-figure}.
\begin{verbatim}\cite{literal}\includegraphics{literal-figure}\end{verbatim}
\end{theorem}\end{document}`)[0];
assert.deepEqual(literalMetadataNoise.citationMentions, [{ key: 'real', locator: 'Thm. 2' }], 'Commented and literal citation examples must not become live reader citations.');
assert.deepEqual(literalMetadataNoise.assetPaths, ['real-figure'], 'Commented and literal image examples must not become live paper assets.');

const bibliographyBlocks = buildSourceBlocks(String.raw`\begin{document}\begin{thebibliography}{9}\bibitem{alpha} A. Author. \newblock \emph{First reference.}\bibitem[Beta]{beta} B. Author. \newblock \textit{Second reference.}\end{thebibliography}\end{document}`, [], new Map());
const bibliographyEntries = bibliographyBlocks.filter((block) => block.kind === 'bibliography');
assert.deepEqual(bibliographyEntries.map((block) => block.title), ['alpha', 'beta'], 'Bibliography entries must be preserved as separate source blocks.');
assert.ok(bibliographyEntries.every((block) => !/\\bibitem/.test(block.content)), 'Rendered bibliography entries must not leak their TeX item commands.');
assert.ok(bibliographyBlocks.some((block) => block.kind === 'section' && block.title === 'References'), 'An inline bibliography must receive a readable references heading.');

const decorative = readableLatex(String.raw`\textcolor{meta-color}{\textbf{Subset}}: Common Crawl \textcolor{wkblue}{\rule{\linewidth}{0.4pt}}`);
assert.equal(decorative, 'Subset: Common Crawl', 'Decorative TeX color and rule commands must not leak into reader prose.');
assert.equal(readableLatex(String.raw`P\u{a}un, B\l ocki, Musta\c{t}`), 'Păun, Błocki, Mustaţ', 'Common author-name accents must render cleanly in bibliography entries.');
assert.doesNotMatch(readableLatex(String.raw`Reference \nolinkurl{doi:10.1000/example}`), /\\nolinkurl/, 'Bibliographic nolinkurl wrappers must never leak into reader prose.');
assert.equal(readableLatex(String.raw`$\left(\lambda + \Lambda\right)$`), String.raw`$\left(\lambda + \Lambda\right)$`, 'Polish letter conversion must not alter longer math commands that begin with \\l or \\L.');

const legacyMathText = readableLatex(String.raw`\mbox{{\bf $(\omega,\,\Omega)$-Hermite-Einstein} metric on}`);
assert.doesNotMatch(legacyMathText, /\\bf\b/, 'Legacy font declarations inside math text must not leak into the reader.');
assert.doesNotThrow(() => katex.renderToString(legacyMathText, { throwOnError: true, strict: 'ignore' }), 'Math text containing legacy font declarations must remain valid KaTeX.');

const expandedNormMacro = expandAuthorMacros(String.raw`\newcommand{\norm}[1]{\left\lVert#1\right\rVert}\begin{document}$\norm{A}$\end{document}`);
assert.match(expandedNormMacro, /\\left\\lVert A\\right\\rVert/, 'Macro substitution must preserve a TeX control-word boundary before a letter argument.');

const literalMacroExample = expandAuthorMacros(String.raw`\newcommand{\R}{\mathbb R}\begin{document}\begin{verbatim}\newcommand{\R}{wrong}\R\end{verbatim}Live $\R$.\end{document}`);
assert.match(literalMacroExample, /\\begin\{verbatim\}\\newcommand\{\\R\}\{wrong\}\\R\\end\{verbatim\}/, 'Macro examples in literal source environments must remain byte-for-byte readable.');
assert.match(literalMacroExample, /Live \$\\mathbb R\$[.]/, 'A real author macro must still expand outside literal source examples.');

const horizontalFill = readableLatex(String.raw`Conclusion.\hfil Middle.\hfill $\Box$`);
assert.doesNotMatch(horizontalFill, /\\hfill?\b/, 'Horizontal fill commands are layout glue and must not appear in reader content.');
assert.match(horizontalFill, /Conclusion[.]\s+Middle[.]\s+\$\\Box\$/, 'Removing horizontal fill must preserve adjacent prose and math.');
assert.equal(readableLatex(String.raw`Saal~[BHHS-24]`), 'Saal\u00a0[BHHS-24]', 'TeX nonbreaking spaces must retain their no-wrap semantics in parsed paper text.');

assert.equal(ar5ivFigureUrl('math/0702066v2', 'figures/famcurv.eps'), 'https://ar5iv.labs.arxiv.org/html/math/0702066/assets/famcurv.png');
assert.equal(ar5ivFigureUrl('local-upload', 'famcurv.eps'), '', 'Uploaded papers must never trigger a guessed remote asset URL.');

console.log('TeX reader: references resolved, literal source preserved, decorative commands removed, arXiv figure fallback normalized.');
