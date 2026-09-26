import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import katex from 'katex';
import { ar5ivFigureUrl } from './codex-bridge.mjs';
import {
  buildSourceBlocks,
  enrichAuditFromTex,
  expandAuthorMacros,
  extractBibliography,
  extractBibliographyTree,
  extractSourceUnits,
  readExpandedTex,
  readableLatex,
  resolveLatexReferences,
  sameExpandedTexSource,
  texFrontMatter,
} from './tex-source.mjs';
import { enrichAuditFromTexOffThread } from './tex-worker.mjs';

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
assert.ok(
  resolved.includes(String.raw`\begin{verbatim}\ref{thm:key}\end{verbatim}`),
  'Literal TeX examples must not be rewritten.',
);
const theorem = extractSourceUnits(resolved)[0];
assert.equal(theorem.printedNumber, '1.1');
assert.match(theorem.statement, /Equation\s+\(1\.1\) implies the claim\./);

const sharedSectionSource = String.raw`\newtheorem{claim}[section]{Claim}
\begin{document}
\section{First}
\begin{claim}First claim.\end{claim}
\begin{claim}Second claim.\end{claim}
\section{Second}\label{sec:second}
\begin{claim}Third claim.\end{claim}
See Section~\ref{sec:second}.
\end{document}`;
assert.deepEqual(
  extractSourceUnits(sharedSectionSource).map((unit) => unit.printedNumber),
  ['2', '3', '5'],
  'A theorem sharing the section counter steps it, as in LaTeX.',
);
assert.match(
  resolveLatexReferences(sharedSectionSource, extractSourceUnits(sharedSectionSource)),
  /See Section~4\./,
  'Sections after a theorem sharing their counter are renumbered, as in LaTeX.',
);

const nestedCounterSource = String.raw`\newtheorem{lemma}{Lemma}[subsection]
\begin{document}
\section{Setup}\subsection{First}
\begin{lemma}Nested one.\end{lemma}
\begin{lemma}Nested two.\end{lemma}
\subsection{Second}
\begin{lemma}Nested three.\end{lemma}
\end{document}`;
assert.deepEqual(
  extractSourceUnits(nestedCounterSource).map((unit) => unit.printedNumber),
  ['1.1.1', '1.1.2', '1.2.1'],
  'Theorem counters scoped to subsections must retain the full structural number.',
);

const sharedTheoremSource = String.raw`\newtheorem{theorem}{Theorem}[section]
\newtheorem{proposition}[theorem]{Proposition}
\newtheorem*{remark}{Remark}
\section{Setup}
\begin{theorem}First result.\end{theorem}
\begin{proposition}Shared result.\end{proposition}
\begin{remark}Unnumbered note.\end{remark}`;
assert.deepEqual(
  extractSourceUnits(sharedTheoremSource).map((unit) => unit.printedNumber),
  ['1.1', '1.2', ''],
  'Shared theorem counters and starred unnumbered environments must retain their LaTeX semantics.',
);

const longSource = `${String.raw`\newtheorem{observation}{Observation}[section]\begin{document}`}${Array.from({ length: 320 }, (_, index) => `${index % 80 === 0 ? `\\section{Part ${index / 80 + 1}}` : ''}\\begin{observation}Long-form source item ${index + 1}.\\end{observation}`).join('')}\\end{document}`;
const longUnits = extractSourceUnits(longSource);
assert.equal(longUnits.length, 320, 'Long papers must retain every extracted result.');
assert.equal(
  longUnits.at(-1)?.printedNumber,
  '4.80',
  'Long papers must reset section-scoped counters at section boundaries.',
);

const standaloneProof = String.raw`\begin{document}
\section{A}
Some prose before.
\begin{proof}Easy.\end{proof}
After text.
\end{document}`;
const standaloneBlocks = buildSourceBlocks(standaloneProof, extractSourceUnits(standaloneProof), new Map());
assert.deepEqual(
  standaloneBlocks.filter((block) => block.kind === 'paragraph').map((block) => block.content.trim()),
  ['Some prose before.', 'After text.'],
  'A standalone proof must consume its whole \\end{proof}, leaving no stray brace.',
);

const macroForms = expandAuthorMacros(String.raw`\newcommand\Rr{\mathbb{R}}
\newcommand*{\Zz}{\mathbb{Z}}
\providecommand{\Nn}{\mathbb{N}}
\providecommand{\Rr}{WRONG}
\DeclareMathOperator\Spec{Spec}
\DeclareMathOperator*{\argmax}{arg\,max}
\begin{document}
$\Rr\to\Zz$, $\Nn$, $\Spec A$, $\argmax_x g$
\end{document}`);
assert.match(
  macroForms,
  /\$\\mathbb\{R\}\\to\\mathbb\{Z\}\$, \$\\mathbb\{N\}\$, \$\\operatorname\{Spec\} A\$, \$\\operatorname\*\{arg\\,max\}_x g\$/,
  'Brace-less, starred, and provided macro definitions must all expand.',
);

assert.equal(
  readableLatex(String.raw`$\csc x$, $\cS\subset\cC$, $\upsilon$`),
  String.raw`$\csc x$, $\cS\subset\cC$, $\upsilon$`,
  'Accent rules must not rewrite control words that merely start with \\c or \\u.',
);
assert.equal(readableLatex(String.raw`Ho\c{s}ten, \c c, \u{a}`), 'Hoşten, ç, ă');

const sourceRoot = await mkdtemp(path.join(tmpdir(), 'arxivpecker-reader-'));
try {
  await mkdir(path.join(sourceRoot, 'chapters'));
  await writeFile(
    path.join(sourceRoot, 'main.tex'),
    String.raw`\begin{document}
\input{chapters/intro}
% \input{chapters/ignored}
\begin{verbatim}\input{chapters/literal}\end{verbatim}
\end{document}`,
  );
  await writeFile(path.join(sourceRoot, 'chapters/intro.tex'), 'Included chapter text.');
  await writeFile(path.join(sourceRoot, 'chapters/ignored.tex'), 'This commented chapter must stay excluded.');
  await writeFile(path.join(sourceRoot, 'chapters/literal.tex'), 'This literal TeX example must stay excluded.');
  const expanded = await readExpandedTex(path.join(sourceRoot, 'main.tex'), sourceRoot);
  assert.match(expanded, /Included chapter text\./);
  assert.doesNotMatch(expanded, /commented chapter must stay excluded|literal TeX example must stay excluded/);
  assert.match(
    expanded,
    /% \\input\{chapters\/ignored\}/,
    'Commented input commands must remain source text, not expanded content.',
  );
  assert.match(
    expanded,
    /\\begin\{verbatim\}\\input\{chapters\/literal\}/,
    'Literal TeX examples must remain source text, not expanded content.',
  );
  const aliasDirectory = path.join(sourceRoot, 'alias');
  await mkdir(aliasDirectory);
  await writeFile(path.join(aliasDirectory, 'main.tex'), await readFile(path.join(sourceRoot, 'main.tex')));
  await mkdir(path.join(aliasDirectory, 'chapters'));
  await writeFile(path.join(aliasDirectory, 'chapters/intro.tex'), 'Included chapter text.');
  assert.equal(
    await sameExpandedTexSource(
      { kind: 'tex', entryFile: path.join(sourceRoot, 'main.tex'), sourceDirectory: sourceRoot },
      { kind: 'tex', entryFile: path.join(aliasDirectory, 'main.tex'), sourceDirectory: aliasDirectory },
    ),
    true,
    'An unversioned arXiv alias with identical expanded TeX must bypass a needless AI comparison.',
  );
  await writeFile(path.join(aliasDirectory, 'chapters/intro.tex'), 'A genuinely revised chapter.');
  assert.equal(
    await sameExpandedTexSource(
      { kind: 'tex', entryFile: path.join(sourceRoot, 'main.tex'), sourceDirectory: sourceRoot },
      { kind: 'tex', entryFile: path.join(aliasDirectory, 'main.tex'), sourceDirectory: aliasDirectory },
    ),
    false,
    'A real included-file change must still reach structural AI comparison.',
  );

  // Nested includes resolve against the main file's folder, as TeX does, and a
  // bare \input name is expanded like the braced form.
  const nestedRoot = path.join(sourceRoot, 'nested');
  await mkdir(path.join(nestedRoot, 'sections'), { recursive: true });
  await writeFile(
    path.join(nestedRoot, 'main.tex'),
    String.raw`\input macros
\input{sections/a}`,
  );
  await writeFile(path.join(nestedRoot, 'macros.tex'), 'Macro file text.');
  await writeFile(path.join(nestedRoot, 'sections/a.tex'), String.raw`Section A. \input{sections/b}`);
  await writeFile(path.join(nestedRoot, 'sections/b.tex'), 'Section B.');
  const nested = await readExpandedTex(path.join(nestedRoot, 'main.tex'), nestedRoot);
  assert.match(nested, /Macro file text\./, 'A brace-less \\input must be expanded.');
  assert.match(nested, /Section A\. Section B\./, 'A nested include must resolve against the main document folder.');

  // The import and subfiles packages read files relative to the importing
  // file, and an imported file's own \input resolves beside it.
  const importRoot = path.join(sourceRoot, 'import');
  await mkdir(path.join(importRoot, 'parts/deeper/more'), { recursive: true });
  await mkdir(path.join(importRoot, 'sections'));
  await writeFile(
    path.join(importRoot, 'main.tex'),
    String.raw`\documentclass{article}
\usepackage{import,subfiles}
\begin{document}
\import{parts/}{intro}
\subfile{sections/sub}
\inputfrom{parts/}{from} \includefrom{parts}{includedfrom}
% \import{parts/}{ignored}
\import{parts/}{missing} \import{../}{outside} \import*{parts/}{cycle}
\end{document}`,
  );
  await writeFile(path.join(importRoot, 'detail.tex'), 'WRONG detail beside the main file.');
  await writeFile(
    path.join(importRoot, 'parts/intro.tex'),
    String.raw`Imported intro. \input{detail} \subimport{deeper/}{leaf}`,
  );
  await writeFile(path.join(importRoot, 'parts/detail.tex'), 'Detail beside the imported file.');
  await writeFile(
    path.join(importRoot, 'parts/deeper/leaf.tex'),
    String.raw`Leaf. \subinputfrom{more/}{a} \subincludefrom{more/}{b}`,
  );
  await writeFile(path.join(importRoot, 'parts/deeper/more/a.tex'), 'Sub input from.');
  await writeFile(path.join(importRoot, 'parts/deeper/more/b.tex'), 'Sub include from.');
  await writeFile(path.join(importRoot, 'parts/from.tex'), 'Input from.');
  await writeFile(path.join(importRoot, 'parts/includedfrom.tex'), 'Include from.');
  await writeFile(path.join(importRoot, 'parts/ignored.tex'), 'This commented import must stay excluded.');
  await writeFile(path.join(importRoot, 'parts/cycle.tex'), String.raw`Cycle once. \subimport{./}{cycle}`);
  await writeFile(path.join(sourceRoot, 'outside.tex'), 'OUTSIDE THE PAPER SOURCE');
  await writeFile(
    path.join(importRoot, 'sections/sub.tex'),
    String.raw`\documentclass[../main.tex]{subfiles}
\newcommand{\onlyhere}{SUBFILE PREAMBLE}
\begin{document}
Subfile body. \input{piece}
\end{document}
After the subfile document.`,
  );
  await writeFile(path.join(importRoot, 'sections/piece.tex'), 'Subfile piece.');
  const imported = await readExpandedTex(path.join(importRoot, 'main.tex'), importRoot);
  assert.match(
    imported,
    /Imported intro\. Detail beside the imported file\. Leaf\. Sub input from\. Sub include from\./,
    'An imported file and its nested inputs and subimports must be read relative to their own folders.',
  );
  assert.match(imported, /Subfile body\. Subfile piece\./, 'A subfile must contribute its document body.');
  assert.match(imported, /Input from\. Include from\./);
  assert.equal(imported.match(/Cycle once\./g)?.length, 1, 'A self-importing file must be read once.');
  assert.doesNotMatch(
    imported,
    /WRONG detail|SUBFILE PREAMBLE|main\.tex\]|After the subfile document|commented import must stay excluded|OUTSIDE THE PAPER SOURCE/,
    'Only the subfile body, active imports, and files inside the source may be read.',
  );
  assert.doesNotMatch(
    imported,
    /^[^%\n]*\\(?:sub)?(?:import|inputfrom|includefrom|file)\b/m,
    'No active import command may remain unexpanded.',
  );

  // arXiv sources usually ship only the compiled .bbl for \bibliography{...}.
  const bblRoot = path.join(sourceRoot, 'bbl');
  await mkdir(bblRoot);
  await writeFile(
    path.join(bblRoot, 'paper.tex'),
    String.raw`\begin{document}See \cite{shimura}.\bibliographystyle{plain}\bibliography{refs}\end{document}`,
  );
  await writeFile(
    path.join(bblRoot, 'paper.bbl'),
    String.raw`\begin{thebibliography}{1}
\bibitem{shimura} G.~Shimura. \newblock On Eisenstein series. \newblock {\em Duke Math. J.}, 50:417--476, 1983.
\end{thebibliography}`,
  );
  const compiledBibliography = await extractBibliographyTree(
    await readFile(path.join(bblRoot, 'paper.tex'), 'utf8'),
    bblRoot,
    path.join(bblRoot, 'paper.tex'),
  );
  assert.match(
    compiledBibliography.get('shimura')?.title ?? '',
    /On Eisenstein series/,
    'A compiled .bbl must supply references when no .bib file is present.',
  );

  // An AI audit that skips Lemma 1.1 must still give "Lemma 1.2" its own
  // statement and proof, and keep the skipped lemma as a source node.
  const auditRoot = path.join(sourceRoot, 'audit');
  await mkdir(auditRoot);
  await writeFile(
    path.join(auditRoot, 'main.tex'),
    String.raw`\documentclass{article}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\begin{document}
\section{Results}
\begin{lemma}\label{lem:first}First lemma statement.\end{lemma}
\begin{lemma}\label{lem:second}Second lemma statement.\end{lemma}
\begin{proof}Second lemma proof.\end{proof}
\begin{theorem}\label{thm:main}Main theorem statement.\end{theorem}
\end{document}`,
  );
  const enrichedAudit = JSON.parse(
    await enrichAuditFromTex(
      JSON.stringify({
        nodes: [{ id: 'ai-lemma', kind: 'lemma', label: 'Lemma 1.2', title: 'Second', statement: 'AI paraphrase.' }],
      }),
      { entryFile: path.join(auditRoot, 'main.tex'), sourceDirectory: auditRoot },
    ),
  );
  const aiLemma = enrichedAudit.nodes.find((node) => node.id === 'ai-lemma');
  assert.equal(aiLemma.label, 'Lemma 1.2');
  assert.equal(aiLemma.statement, 'Second lemma statement.');
  assert.equal(aiLemma.proofText, 'Second lemma proof.', 'A numbered AI node must receive its own proof.');
  assert.deepEqual(
    enrichedAudit.nodes
      .filter((node) => node.id.startsWith('source-unit-'))
      .map((node) => [node.label, node.statement, node.proofText]),
    [
      ['Lemma 1.1', 'First lemma statement.', ''],
      ['Theorem 1.3', 'Main theorem statement.', ''],
    ],
    'Results the AI audit skipped must be appended as source nodes.',
  );

  // The bridge enriches on a worker thread; it must return exactly the
  // in-thread result, propagate its errors, and fall back when no worker starts.
  const workerAudit = JSON.stringify({ nodes: [{ id: 'ai-theorem', kind: 'theorem', label: 'Theorem 1.3' }] });
  const workerSource = { kind: 'tex', entryFile: path.join(auditRoot, 'main.tex'), sourceDirectory: auditRoot };
  const inThread = await enrichAuditFromTex(workerAudit, workerSource);
  assert.equal(await enrichAuditFromTexOffThread(workerAudit, workerSource), inThread);
  const missingSource = { ...workerSource, entryFile: path.join(auditRoot, 'missing.tex') };
  const inThreadError = await enrichAuditFromTex(workerAudit, missingSource).then(
    () => assert.fail('A missing entry file must reject.'),
    (error) => error,
  );
  await assert.rejects(enrichAuditFromTexOffThread(workerAudit, missingSource), {
    message: inThreadError.message,
    code: inThreadError.code,
  });
  assert.equal(
    await enrichAuditFromTexOffThread(workerAudit, { ...workerSource, onProgress() {} }),
    inThread,
    'A source record that cannot cross to a worker must be enriched on this thread.',
  );

  // A hand-written list is cited in plain text. Each bracket in prose that names
  // only its keys becomes a citation; math, command arguments, and other
  // brackets stay text.
  const readerAudit = async (name, tex) => {
    const root = path.join(sourceRoot, name);
    await mkdir(root);
    await writeFile(path.join(root, 'main.tex'), tex);
    return JSON.parse(
      await enrichAuditFromTex(JSON.stringify({ nodes: [] }), {
        entryFile: path.join(root, 'main.tex'),
        sourceDirectory: root,
      }),
    );
  };
  const mentionsOf = (citations) => citations.map(({ key, locator }) => (locator ? `${key}|${locator}` : key));
  const paragraphsOf = (audit) => audit.sourceBlocks.filter((block) => block.kind === 'paragraph');
  const plainCited = await readerAudit(
    'plain-cited',
    String.raw`\documentclass{article}
\newtheorem{theorem}{Theorem}
\begin{document}
\section{Introduction}
As in [DP25] and [Buc88, Kob82], see [LT95, 4.3.2], [DP25, Theorem 3.1], [LT95, Remark 1.1.20., (i)], and [Kob82,
Theorem 3]. Math stays: $[DP25]$, \[ f([Kob82]) \], and \begin{equation} x = [Buc88] \end{equation}
Other brackets stay: [Foo99], [DP25, Foo99], [Theorem 2], [1]. % and a commented [DP25].

\begin{itemize}\item[Kob82] An item label stays.\end{itemize}
\begin{theorem}[Kob82]By [Kob82, Theorem 3], every bundle is stable.\end{theorem}

\noindent {\bf References.}

\noindent [Buc88] N. P. Buchdahl --- {\it First} --- Math. Ann. (1988).

\noindent [DP25] S. Dinew, D. Popovici --- {\it Second} --- arXiv:2510.27362v1 [math.DG].

\noindent [Kob82] S. Kobayashi --- {\it Third} --- Proc. Jap. Acad. (1982).

\noindent [LT95] M. L\"ubke, A. Teleman --- {\it Fourth} --- World Scientific, 1995.
\end{document}`,
  );
  const plainCitations = paragraphsOf(plainCited).flatMap((block) => block.citations);
  assert.deepEqual(
    mentionsOf(plainCitations),
    ['DP25', 'Buc88', 'Kob82', 'LT95|4.3.2', 'DP25|Theorem 3.1', 'LT95|Remark 1.1.20., (i)', 'Kob82|Theorem 3'],
    'Plain-text citations of a hand-written list must become citations in prose.',
  );
  assert.equal(plainCitations[0].arxivId, '2510.27362');
  const plainText = paragraphsOf(plainCited)
    .map((block) => block.content)
    .join('\n');
  for (const kept of ['$[DP25]$', '\\[ f([Kob82]) \\]', 'x = [Buc88]', '[Foo99], [DP25, Foo99], [Theorem 2], [1].'])
    assert.ok(plainText.includes(kept), `${kept} must stay as written.`);
  assert.doesNotMatch(plainText, /commented|\[\[cite:[^\]]*\]\] An item/);
  const plainTheorem = plainCited.nodes.find((node) => node.id === 'source-unit-1');
  assert.equal(plainTheorem.title, 'Kob82', 'A theorem note in brackets must stay its title.');
  assert.deepEqual(mentionsOf(plainTheorem.citations), ['Kob82|Theorem 3']);
  assert.deepEqual(
    plainCited.sourceBlocks.filter((block) => block.kind === 'bibliography').map((block) => block.title),
    ['Buc88', 'DP25', 'Kob82', 'LT95'],
    'The entries of the list itself must not become citations.',
  );

  const numberCited = await readerAudit(
    'number-cited',
    String.raw`\begin{document}
\section{Introduction}
By [1] and [2, Theorem 4], and by [1, 2]. Math stays: $[1,2]$ and \[ [1] \].
Other brackets stay: [0, 1], [1, 2.5], [3], and [1-2].
\section*{References}
[1] A. Author, {\it One}, J. (2001).

[2] B. Author, {\it Two}, J. (2002).
\end{document}`,
  );
  const numberParagraph = paragraphsOf(numberCited)[0];
  assert.deepEqual(mentionsOf(numberParagraph.citations), ['1', '2|Theorem 4', '1', '2']);
  for (const kept of ['$[1,2]$', '\\[ [1] \\]', '[0, 1], [1, 2.5], [3], and [1-2].'])
    assert.ok(numberParagraph.content.includes(kept), `${kept} must stay as written.`);
  const mixedCited = await readerAudit(
    'mixed-cited',
    String.raw`\begin{document}
\section{Introduction}
By [Kob82] but not [7].
\section*{References}
[Kob82] S. Kobayashi, {\it Third}, Proc. Jap. Acad. (1982).

[7] A numbered entry in a list keyed by names.
\end{document}`,
  );
  assert.deepEqual(
    mentionsOf(paragraphsOf(mixedCited)[0].citations),
    ['Kob82'],
    'A bracketed number is a citation only when the whole list is numbered.',
  );

  // A symbolic link inside the source tree must not pull in a file outside it.
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'arxivpecker-outside-'));
  try {
    await writeFile(path.join(outsideRoot, 'secret.tex'), 'PRIVATE KEY MATERIAL');
    const linkedRoot = path.join(sourceRoot, 'linked');
    await mkdir(linkedRoot);
    await symlink(path.join(outsideRoot, 'secret.tex'), path.join(linkedRoot, 'secret.tex'));
    await writeFile(
      path.join(linkedRoot, 'main.tex'),
      String.raw`Before. \input{secret} \subimport{./}{secret} After.`,
    );
    const linked = await readExpandedTex(path.join(linkedRoot, 'main.tex'), linkedRoot);
    assert.doesNotMatch(linked, /PRIVATE KEY MATERIAL/, 'A symlinked include must not escape the paper source folder.');
    assert.match(linked, /Before\. .*After\./s);
  } finally {
    await rm(outsideRoot, { recursive: true, force: true });
  }
} finally {
  await rm(sourceRoot, { recursive: true, force: true });
}

// The bundled m-positive paper writes its references by hand and cites them
// in plain text, as [DP25] and [Kob87, Corollary 7.1.15].
const mPositiveSource = path.resolve(
  import.meta.dirname,
  '../examples/starter-library/arxiv-2607.17203--m-positive-stability-of-holomorphic-vector-bundles-and-m/attachments/source',
);
const mPositive = JSON.parse(
  await enrichAuditFromTex(JSON.stringify({ nodes: [] }), {
    entryFile: path.join(mPositiveSource, 'm-pos-stability.tex'),
    sourceDirectory: mPositiveSource,
  }),
);
const mPositiveCitations = mPositive.sourceBlocks
  .filter((block) => block.kind !== 'bibliography')
  .flatMap((block) => block.citations);
assert.equal(mPositiveCitations.find((citation) => citation.key === 'DP25')?.arxivId, '2510.27362');
assert.ok(mPositiveCitations.some((citation) => citation.key === 'Kob87' && citation.locator === 'Corollary 7.1.15'));
assert.ok(
  mPositiveCitations.some((citation) => citation.key === 'Dem97' && citation.locator === 'V-§14'),
  'A locator written as [Dem97, V-$\\S14$] must read as printed.',
);
assert.equal(mPositive.sourceBlocks.filter((block) => block.kind === 'bibliography').length, 12);

const figureUnit =
  extractSourceUnits(String.raw`\newtheorem{example}{Example}\begin{example}% \includegraphics{discarded.png}
\includegraphics{kept.pdf}\end{example}`)[0];
assert.deepEqual(
  figureUnit.assetPaths,
  ['kept.pdf'],
  'Commented image commands must never create missing reader figures.',
);

const commentedBreak =
  extractSourceUnits(String.raw`\newtheorem{theorem}{Theorem}\begin{theorem}$\begin{aligned}a&=b\\% author comment
c&=d\end{aligned}$\end{theorem}`)[0];
assert.doesNotMatch(commentedBreak.statement, /author comment/);

const delayedProofSource = String.raw`\newtheorem{proposition}{Proposition}\newenvironment{proof1}[1][Proof]{#1}{}\begin{proposition}\label{prop:delayed}Claim.\end{proposition}\begin{proposition}\label{prop:later}Later.\end{proposition}\begin{proof1}[Proof of Proposition~\ref{prop:delayed}]Complete argument.\end{proof1}`;
const delayedPreliminary = extractSourceUnits(delayedProofSource);
const delayedResolved = resolveLatexReferences(delayedProofSource, delayedPreliminary);
const delayedUnits = extractSourceUnits(delayedResolved);
assert.match(delayedUnits[0].proofText, /Complete argument/);
assert.equal(
  delayedUnits[1].proofText,
  '',
  'A delayed proof must remain attached to its explicitly referenced result.',
);

// Resolving references turns "the proof of Theorem~\ref{main}" into "the proof
// of Theorem~1.2"; the delayed proof must still find its theorem.
const proseProofSource = String.raw`\newtheorem{theorem}{Theorem}[section]\newtheorem{lemma}[theorem]{Lemma}
\begin{document}\section{Results}
\begin{lemma}\label{lem:aux}Auxiliary.\end{lemma}
\begin{proof}Auxiliary argument.\end{proof}
\begin{theorem}\label{main}Main claim.\end{theorem}
\begin{lemma}\label{lem:late}Late lemma.\end{lemma}
\begin{proof}Late lemma argument.\end{proof}
We now complete the proof of Theorem~\ref{main} using Lemma~\ref{lem:aux}.
\begin{proof}Main argument.\end{proof}
\end{document}`;
const proseProofResolved = resolveLatexReferences(proseProofSource, extractSourceUnits(proseProofSource));
assert.match(proseProofResolved, /the proof of Theorem~1\.2 using Lemma~1\.1/);
const proseProofUnits = extractSourceUnits(proseProofResolved);
assert.deepEqual(
  proseProofUnits.map((unit) => [unit.printedNumber, unit.proofText]),
  [
    ['1.1', 'Auxiliary argument.'],
    ['1.2', 'Main argument.'],
    ['1.3', 'Late lemma argument.'],
  ],
  'A proof introduced in prose by a resolved printed number must stay linked to that result.',
);

const delayedProofBlocks = buildSourceBlocks(delayedResolved, delayedUnits, new Map());
assert.ok(
  delayedProofBlocks.some((block) => block.kind === 'proof' && /Complete argument/.test(block.proofText)),
  'A delayed proof must remain visible at its original source location.',
);
assert.equal(
  delayedProofBlocks.filter((block) => block.kind === 'proof' && /Complete argument/.test(block.proofText)).length,
  1,
  'A delayed proof must be rendered once, not duplicated beside its earlier theorem.',
);

const standaloneProofBlocks = buildSourceBlocks(
  String.raw`\begin{document}\section{A standalone proof}\begin{proof}This proof is not linked to a theorem node.\end{proof}\end{document}`,
  [],
  new Map(),
);
assert.ok(
  standaloneProofBlocks.some((block) => block.kind === 'proof' && /not linked to a theorem node/.test(block.proofText)),
  'An unlinked proof environment must remain visible in the source reader.',
);

const bodyDeclarationBlocks = buildSourceBlocks(
  String.raw`\begin{document}
\mathchardef\mhyphen="2D
\newtheorem{The}{Theorem}[section]
\newcommand{\C}{\mathbb{C}}
\newcommand\rank{\operatorname{rank}}
Readable opening text.
\section{Content}
The body remains visible.
\end{document}`,
  [],
  new Map(),
);
const bodyDeclarationText = bodyDeclarationBlocks.map((block) => `${block.title} ${block.content}`).join('\n');
assert.doesNotMatch(
  bodyDeclarationText,
  /mathchardef|newtheorem|newcommand/,
  'Document declarations placed after \\begin{document} must not appear as reader prose.',
);
assert.match(
  bodyDeclarationText,
  /Readable opening text[.]|The body remains visible[.]/,
  'Filtering document declarations must preserve adjacent paper prose.',
);

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
const localDeclarationBlocks = buildSourceBlocks(
  localDeclarationSource,
  extractSourceUnits(localDeclarationSource),
  new Map(),
);
const localDeclarationText = localDeclarationBlocks.map((block) => `${block.content} ${block.proofText}`).join('\n');
assert.doesNotMatch(
  localDeclarationText,
  /newcommand|#1/,
  'A balanced multi-line declaration inside a proof must not leak into reader text.',
);
assert.match(
  localDeclarationText,
  /\\lVert\s*A/,
  'Removing a local declaration must preserve and expand its later macro uses.',
);

const manualFrontMatterBlocks = buildSourceBlocks(
  String.raw`\begin{document}
\begin{center}{\Large Duplicate title}\end{center}
\begin{center}Duplicate author\end{center}
\noindent{\bf Abstract.} Duplicate abstract.
\section{Introduction}
Actual introduction.
\end{document}`,
  [],
  new Map(),
);
const manualFrontMatterText = manualFrontMatterBlocks.map((block) => `${block.title} ${block.content}`).join('\n');
assert.equal(
  manualFrontMatterBlocks[0]?.kind,
  'section',
  'The source flow must begin at the first section after the separately rendered reader header.',
);
assert.doesNotMatch(
  manualFrontMatterText,
  /Duplicate title|Duplicate author|Duplicate abstract/,
  'Manual title, author, and abstract front matter must not be rendered twice.',
);
assert.match(manualFrontMatterText, /Introduction|Actual introduction[.]/);

const bookBlocks = buildSourceBlocks(
  String.raw`\documentclass{book}\begin{document}
\title{Repeated book title}\author{Repeated book author}\maketitle
\chapter*{Preface}Preface text.
\chapter{Foundations}Chapter text.
\section{First layer}Section text.
\subsection*{A starred layer}Starred subsection text.
\end{document}`,
  [],
  new Map(),
);
const bookSections = bookBlocks.filter((block) => block.kind === 'section');
assert.deepEqual(
  bookSections.map((block) => [block.title, block.level]),
  [
    ['Preface', 1],
    ['Foundations', 1],
    ['First layer', 2],
    ['A starred layer', 3],
  ],
  'Book-style chapter hierarchy, including starred headings, must remain structured and nested.',
);
assert.doesNotMatch(
  bookBlocks.map((block) => `${block.title} ${block.content}`).join('\n'),
  /Repeated book title|Repeated book author|\\chapter/,
  'Book headings and front matter must not leak as raw TeX prose.',
);

const bookReferenceSource = String.raw`\newtheorem{theorem}{Theorem}[section]\numberwithin{equation}{section}\begin{document}\chapter{Foundations}\label{chap:foundations}\section{Setup}\label{sec:setup}\begin{theorem}\label{thm:book}Book result.\end{theorem}\begin{equation}\label{eq:book}x=x.\end{equation}See Chapter~\ref{chap:foundations}, Section~\ref{sec:setup}, Theorem~\ref{thm:book}, and Equation~\eqref{eq:book}.\end{document}`;
const bookReferenceUnits = extractSourceUnits(bookReferenceSource);
assert.equal(bookReferenceUnits[0]?.printedNumber, '1.1.1');
assert.match(
  resolveLatexReferences(bookReferenceSource, bookReferenceUnits),
  /Chapter~1, Section~1\.1, Theorem~1\.1\.1, and Equation~\(1\.1\.1\)/,
  'Book-style chapter, section, theorem, and equation references must retain their full structural number.',
);

// \ref and \eqref must print what LaTeX prints. `resolvedRefs` returns the
// resolution of everything after "REFS:".
const resolvedRefs = (tex) =>
  /REFS:([\s\S]*?)(?:\\end\{document\}|$)/.exec(resolveLatexReferences(tex, extractSourceUnits(tex)))?.[1].trim();

assert.equal(
  resolvedRefs(String.raw`\documentclass{article}\begin{document}
\begin{equation}\label{eq:one} x=1 \end{equation}
\begin{align}
  a &= b \label{eq:two} \\
  c &= \begin{cases} 1 & x>0 \\ 0 & x\le 0 \end{cases} \\
  d &= \begin{aligned} e \\ f \end{aligned} \label{eq:four}
\end{align}
\begin{align}
  g &= h \nonumber \\
  i &= j \tag{T} \label{eq:tagged} \\
  k &= l \notag \\
  m &= n \label{eq:five} % \label{eq:ghost} \\
\end{align}
\begin{align*} p &= q \\ r &= s \tag{S}\label{eq:star-tag} \end{align*}
\begin{gather} u \\ v \label{eq:seven} \end{gather}
\begin{multline} w \\ x \\ y \label{eq:multline} \end{multline}
\begin{equation} z \nonumber \end{equation}
\begin{equation} z \tag{Z}\label{eq:z} \end{equation}
\begin{flalign} a \\ b \label{eq:ten} \end{flalign}
\begin{alignat}{2} a &= b \label{eq:eleven} \end{alignat}
\begin{eqnarray} \label{eq:carried}\nonumber a &=& b \\ c &=& d \end{eqnarray}
\begin{equation}\label{eq:last} q \end{equation}
REFS: \eqref{eq:one} \eqref{eq:two} \eqref{eq:four} \eqref{eq:tagged} \eqref{eq:five} \ref{eq:ghost} \eqref{eq:star-tag} \eqref{eq:seven} \eqref{eq:multline} \eqref{eq:z} \eqref{eq:ten} \eqref{eq:eleven} \eqref{eq:carried} \eqref{eq:last}
\end{document}`),
  String.raw`(1) (2) (4) (T) (5) \ref{eq:ghost} (S) (7) (8) (Z) (10) (11) (12) (13)`,
  'Every top-level row of an alignment is numbered unless it is starred, \\nonumber, \\notag, or \\tag; nested rows are not.',
);
assert.equal(
  resolvedRefs(
    String.raw`\begin{align} a \label{row:1} \\ b \\ c \label{row:3} \end{align} REFS: \eqref{row:1} \eqref{row:3}`,
  ),
  '(1) (3)',
  'An unlabelled numbered row must still advance the equation counter.',
);
assert.equal(
  resolvedRefs(String.raw`\begin{equation}\label{eq:before}x\end{equation}
\begin{subequations}\label{eq:group}
\begin{equation}\label{eq:sub-a}a\end{equation}
\begin{align} b \label{eq:sub-b} \\ c \label{eq:sub-c} \end{align}
\end{subequations}
\begin{equation}\label{eq:after}y\end{equation}
REFS: \eqref{eq:before} \eqref{eq:group} \eqref{eq:sub-a} \eqref{eq:sub-b} \eqref{eq:sub-c} \eqref{eq:after}`),
  '(1) (2) (2a) (2b) (2c) (3)',
  'Subequations number their equations 2a, 2b, ... and a label directly inside names the group.',
);

const appendixSource = String.raw`\documentclass{article}
\newtheorem{theorem}{Theorem}[section]
\numberwithin{equation}{section}
\begin{document}
\section{Intro}\label{sec:intro}
\begin{theorem}\label{thm:intro}Intro.\end{theorem}
\begin{equation}\label{eq:intro}x\end{equation}
\appendix
\section{Proofs}\label{sec:proofs}
\subsection{Details}\label{sec:details}
\begin{theorem}\label{thm:appendix}Appendix.\end{theorem}
\begin{equation}\label{eq:appendix}y\end{equation}
\section{More}\label{sec:more}
\begin{theorem}\label{thm:more}More.\end{theorem}
REFS: \ref{sec:intro} \ref{thm:intro} \eqref{eq:intro} \ref{sec:proofs} \ref{sec:details} \ref{thm:appendix} \eqref{eq:appendix} \ref{sec:more} \ref{thm:more}
\end{document}`;
assert.equal(resolvedRefs(appendixSource), '1 1.1 (1.1) A A.1 A.1 (A.1) B B.1');
assert.deepEqual(
  extractSourceUnits(appendixSource).map((unit) => unit.printedNumber),
  ['1.1', 'A.1', 'B.1'],
  'Sections after \\appendix are lettered, and results numbered within them use the letter.',
);

assert.equal(
  resolvedRefs(String.raw`\documentclass{article}
% \numberwithin{equation}{section}
\counterwithin{equation}{subsection}
\begin{document}
\section{A}\subsection{B}\begin{equation}\label{eq:ab}x\end{equation}\begin{equation}\label{eq:ab2}x\end{equation}
\subsection{C}\begin{equation}\label{eq:ac}x\end{equation}
\section{D}\subsection{E}\begin{equation}\label{eq:de}x\end{equation}
REFS: \eqref{eq:ab} \eqref{eq:ab2} \eqref{eq:ac} \eqref{eq:de}
\end{document}`),
  '(1.1.1) (1.1.2) (1.2.1) (2.1.1)',
  'Equations numbered within subsections must reset at every subsection and section.',
);
assert.equal(
  resolvedRefs(String.raw`\documentclass{article}
% \numberwithin{equation}{section}
\begin{document}
\section{A}\begin{equation}\label{eq:plain}x\end{equation}
\section{B}\begin{equation}\label{eq:plain2}x\end{equation}
REFS: \eqref{eq:plain} \eqref{eq:plain2}
\end{document}`),
  '(1) (2)',
  'A commented-out \\numberwithin must not change equation numbers.',
);
assert.equal(
  resolvedRefs(String.raw`\documentclass{book}
\begin{document}
\chapter{One}\label{ch:one}
\begin{equation}\label{eq:c1}x\end{equation}
\begin{figure}\caption{F}\label{fig:c1}\end{figure}
\chapter{Two}
\section{S}\label{sec:two}
\begin{equation}\label{eq:c2}x\end{equation}
\begin{table}\caption{T}\label{tab:c2}\end{table}
\appendix
\chapter{Extra}\label{ch:extra}
\section{Extra section}\label{sec:extra}
\begin{equation}\label{eq:extra}x\end{equation}
REFS: \ref{ch:one} \eqref{eq:c1} \ref{fig:c1} \ref{sec:two} \eqref{eq:c2} \ref{tab:c2} \ref{ch:extra} \ref{sec:extra} \eqref{eq:extra}
\end{document}`),
  '1 (1.1) 1.1 2.1 (2.1) 2.1 A A.1 (A.1)',
  'Book classes number equations, figures, and tables by chapter, and \\appendix letters chapters.',
);

const sharedEquationSource = String.raw`\documentclass{amsart}
\newtheorem{theorem}[equation]{Theorem}
\newtheorem{lemma}[theorem]{Lemma}
\numberwithin{equation}{section}
\begin{document}
\section{A}
\begin{equation}\label{eq:first}x\end{equation}
\begin{theorem}\label{thm:shared}T.\end{theorem}
\begin{equation}\label{eq:second}y\end{equation}
\begin{lemma}\label{lem:shared}L.\end{lemma}
REFS: \eqref{eq:first} \ref{thm:shared} \eqref{eq:second} \ref{lem:shared}
\end{document}`;
assert.equal(resolvedRefs(sharedEquationSource), '(1.1) 1.2 (1.3) 1.4');
assert.deepEqual(
  extractSourceUnits(sharedEquationSource).map((unit) => unit.printedNumber),
  ['1.2', '1.4'],
  'A theorem declared with [equation] must share the equation counter.',
);

const letteredSource = String.raw`\documentclass{amsart}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{maintheorem}{Theorem}
\renewcommand{\themaintheorem}{\Alph{maintheorem}}
\makeatletter
\@addtoreset{equation}{section}
\renewcommand\theequation{\thesection.\arabic{equation}}
\makeatother
\begin{document}
\begin{maintheorem}\label{thm:A}A.\end{maintheorem}
\begin{maintheorem}\label{thm:B}B.\end{maintheorem}
\section{S}
\begin{theorem}\label{thm:s}S.\end{theorem}
\begin{equation}\label{eq:s}x\end{equation}
\section{T}
\begin{equation}\label{eq:t}x\end{equation}
REFS: \ref{thm:A} \ref{thm:B} \ref{thm:s} \eqref{eq:s} \eqref{eq:t}
\end{document}`;
assert.equal(resolvedRefs(letteredSource), 'A B 1.1 (1.1) (2.1)');
assert.deepEqual(
  extractSourceUnits(letteredSource).map((unit) => unit.printedNumber),
  ['A', 'B', '1.1'],
  'Preamble \\the<counter> redefinitions and \\@addtoreset must shape printed numbers.',
);
assert.equal(
  resolvedRefs(String.raw`\begin{figure}\includegraphics{a}\end{figure}
\begin{figure}\caption{First}\label{fig:first}\end{figure}
\begin{figure}\begin{minipage}{.5\textwidth}\caption{Left}\label{fig:left}\end{minipage}\begin{minipage}{.5\textwidth}\caption{Right}\label{fig:right}\end{minipage}\end{figure}
\begin{table}\label{tab:early}\caption{Tab}\end{table}
REFS: \ref{fig:first} \ref{fig:left} \ref{fig:right} \ref{tab:early}`),
  '1 2 3 1',
  'Floats step their counter at each \\caption, not at \\begin.',
);

const unsectionedBlocks = buildSourceBlocks(
  String.raw`\documentclass{article}\begin{document}\begin{abstract}Header abstract.\end{abstract}Unsectioned opening paragraph.

A second paragraph.\end{document}`,
  [],
  new Map(),
);
assert.deepEqual(
  unsectionedBlocks.filter((block) => block.kind === 'paragraph').map((block) => block.content),
  ['Unsectioned opening paragraph.', 'A second paragraph.'],
  'An unsectioned paper must retain all body prose after its separately rendered abstract.',
);

const commentedStructureBlocks = buildSourceBlocks(
  String.raw`\documentclass{article}
% \begin{document}\section{Ghost heading}
% \chapter{Ghost chapter}
\begin{document}% \section{Also ghost}
Visible opening.
% \section{Still ghost}
\section{Real heading}Visible body.
% \end{document}
\end{document}Trailing material must be ignored.`,
  [],
  new Map(),
);
assert.deepEqual(
  commentedStructureBlocks.filter((block) => block.kind === 'section').map((block) => [block.title, block.level]),
  [['Real heading', 1]],
  'Commented document markers and headings must never create or shift reader structure.',
);
assert.doesNotMatch(
  commentedStructureBlocks.map((block) => `${block.title} ${block.content}`).join('\n'),
  /Ghost heading|Also ghost|Still ghost|Trailing material/,
  'Commented or post-document material must not leak into reader content.',
);

const commentedLiteralMarkers = String.raw`\begin{document}
% \begin{verbatim}
\begin{theorem}A real result between commented literal markers.\end{theorem}
% \end{verbatim}
\end{document}`;
assert.equal(
  extractSourceUnits(commentedLiteralMarkers).length,
  1,
  'Commented literal-environment markers must not hide real document structure on later lines.',
);
assert.match(
  readableLatex(String.raw`\begin{verbatim}100% literal source\end{verbatim}`),
  /100% literal source/,
  'Percent signs inside a real literal source environment must remain visible.',
);
assert.equal(
  readableLatex(
    String.raw`Visible before.\begin{comment}Hidden prose.\begin{theorem}Hidden result.\end{theorem}\end{comment}Visible after.`,
  ),
  'Visible before.Visible after.',
  'The comment environment and all of its contents must be invisible to the reader.',
);

const literalMetadataNoise = extractSourceUnits(String.raw`\newtheorem{theorem}{Theorem}\begin{document}\begin{theorem}
Real citation \cite[Thm. 2]{real} and real figure \includegraphics{real-figure}.
% Fake citation \cite{commented} and \includegraphics{commented-figure}.
\begin{verbatim}\cite{literal}\includegraphics{literal-figure}\end{verbatim}
\end{theorem}\end{document}`)[0];
assert.deepEqual(
  literalMetadataNoise.citationMentions,
  [{ key: 'real', locator: 'Thm. 2' }],
  'Commented and literal citation examples must not become live reader citations.',
);
assert.deepEqual(
  literalMetadataNoise.assetPaths,
  ['real-figure'],
  'Commented and literal image examples must not become live paper assets.',
);

// biblatex's citation commands, their starred forms, and its multicites are
// citations like \cite, in theorem statements and in prose; \nocite prints nothing.
const biblatexCitations = String.raw`By \parencite{a}, \Parencite[p. 3]{b}, \textcite{c}, \Textcite*{d},
\autocite[see][ch. 2]{e}, \Autocite{f}, \footcite{g}, \footcitetext{h}, \smartcite{i}, \supercite{j},
\fullcite{k}, \Cite{l}, \cite*{m}, \citeauthor*{n}, \textcites[pre][post]{o}[post2]{p,q},
\cites(Global)(end)[x]{r}{s}, \parencites{t}{u}, and \cite{v}{\em also \cite{w}}.\nocite{z}`;
const biblatexMentions = [
  ...['a', ['b', 'p. 3'], 'c', 'd', ['e', 'see; ch. 2'], 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'],
  ...[['o', 'pre; post'], ['p', 'post2'], ['q', 'post2'], ['r', 'Global; x'], ['s', 'end'], 't', 'u', 'v', 'w'],
].map((mention) => (Array.isArray(mention) ? { key: mention[0], locator: mention[1] } : { key: mention, locator: '' }));
assert.deepEqual(
  extractSourceUnits(String.raw`\newtheorem{theorem}{Theorem}\begin{theorem}${biblatexCitations}\end{theorem}`)[0]
    .citationMentions,
  biblatexMentions,
  'biblatex citation commands must be read as citations in a result.',
);
const biblatexParagraph = buildSourceBlocks(
  String.raw`\begin{document}${biblatexCitations}\end{document}`,
  [],
  new Map(),
).find((block) => block.kind === 'paragraph');
assert.deepEqual(
  biblatexParagraph.citations.map(({ key, locator }) => ({ key, locator })),
  biblatexMentions,
  'biblatex citation commands must become citation markers in prose.',
);
assert.doesNotMatch(
  biblatexParagraph.content,
  /\\\w*cite|\(Global\)|\[post2\]|\{u\}/i,
  'No part of a biblatex citation may leak into prose.',
);

const bibliographyBlocks = buildSourceBlocks(
  String.raw`\begin{document}\begin{thebibliography}{9}\bibitem{alpha} A. Author. \newblock \emph{First reference.}\bibitem[Beta]{beta} B. Author. \newblock \textit{Second reference.}\end{thebibliography}\end{document}`,
  [],
  new Map(),
);
const bibliographyEntries = bibliographyBlocks.filter((block) => block.kind === 'bibliography');
assert.deepEqual(
  bibliographyEntries.map((block) => block.title),
  ['alpha', 'beta'],
  'Bibliography entries must be preserved as separate source blocks.',
);
assert.ok(
  bibliographyEntries.every((block) => !/\\bibitem/.test(block.content)),
  'Rendered bibliography entries must not leak their TeX item commands.',
);
assert.ok(
  bibliographyBlocks.some((block) => block.kind === 'section' && block.title === 'References'),
  'An inline bibliography must receive a readable references heading.',
);

// Some authors write the reference list by hand: a References heading, then
// entries that open with a bracketed key instead of \bibitem.
const handWrittenSource = String.raw`\documentclass{article}\begin{document}
\section{Introduction}
Body text.

\vspace{6ex}

\noindent {\bf References.} \\

\noindent [Buc88]\, N. P. Buchdahl --- {\it Hermitian-Einstein Connections} --- Math. Ann. {\bf 280} (1988), 625-648.

\vspace{1ex}

%\noindent [Old25]\, A. Withdrawn --- {\it Withdrawn} --- arXiv:2501.00001.

\noindent [DP25]\, S. Dinew, D. Popovici --- {\it $m$-Pseudo-effectivity} --- arXiv:2510.27362v1 [math.DG].

\noindent [Web]\, A. Author, \emph{Online notes}, \url{https://example.org/notes.pdf}, doi:10.1000/xyz123.

\vspace{6ex}

\noindent Institut de Math\'ematiques, Toulouse
\end{document}`;
const handWritten = extractBibliography(handWrittenSource);
const referenceFields = (reference) =>
  reference && {
    title: reference.title,
    authors: reference.authors,
    arxivId: reference.arxivId,
    doi: reference.doi,
    url: reference.url,
  };
assert.deepEqual([...handWritten.keys()], ['Buc88', 'DP25', 'Web'], 'A hand-written list must be the bibliography.');
assert.deepEqual(referenceFields(handWritten.get('DP25')), {
  title: '$m$-Pseudo-effectivity',
  authors: 'S. Dinew, D. Popovici',
  arxivId: '2510.27362',
  doi: '',
  url: 'https://arxiv.org/abs/2510.27362',
});
assert.deepEqual(referenceFields(handWritten.get('Web')), {
  title: 'Online notes',
  authors: 'A. Author',
  arxivId: '',
  doi: '10.1000/xyz123',
  url: 'https://example.org/notes.pdf',
});
assert.match(
  handWritten.get('Buc88').text,
  /^N\. P\. Buchdahl --- Hermitian-Einstein Connections --- Math\. Ann\. 280/,
);
const handWrittenBlocks = buildSourceBlocks(handWrittenSource, [], handWritten);
assert.deepEqual(
  handWrittenBlocks.map((block) => [block.kind, block.title]).slice(-5),
  [
    ['section', 'References'],
    ['bibliography', 'Buc88'],
    ['bibliography', 'DP25'],
    ['bibliography', 'Web'],
    ['paragraph', ''],
  ],
  'A hand-written list must render as one references heading and one block per entry.',
);
assert.equal(handWrittenBlocks.find((block) => block.title === 'DP25').citations[0].arxivId, '2510.27362');
assert.match(handWrittenBlocks.at(-1).content, /^Institut de Mathématiques, Toulouse$/);
assert.doesNotMatch(
  handWrittenBlocks.map((block) => block.content).join('\n'),
  /References\.|\[Buc88\]|Withdrawn|\\,/,
  'The heading, keys, and commented entries of a hand-written list must not leak into the reader.',
);
for (const [heading, list, keys] of [
  [
    String.raw`\section*{References}`,
    String.raw`[1] A. Author, {\em First title}, J. One (2001).

[2] B. Author, {\em Second title}, J. Two (2002).`,
    ['1', '2'],
  ],
  [
    String.raw`\textbf{References}`,
    String.raw`\begin{description}
\item[AB01] A. Author, \textit{First title}, J. One (2001).
\item [CD02] B. Author, \textit{Second title}, J. Two (2002).
\end{description}`,
    ['AB01', 'CD02'],
  ],
  [
    'References',
    String.raw`[AB01] A. Author, {\it First title}, J. One (2001).\\
[CD02] B. Author, {\it Second title}, J. Two (2002).`,
    ['AB01', 'CD02'],
  ],
  [
    String.raw`\noindent{\bf Bibliography}\medskip`,
    String.raw`\noindent[1] A. Author, {\it First title}, J. One (2001).

\noindent[2] B. Author, {\it Second title}, J. Two (2002).`,
    ['1', '2'],
  ],
]) {
  const source = String.raw`\begin{document}\section{Body}Text.

${heading}
${list}
\end{document}`;
  const references = extractBibliography(source);
  assert.deepEqual([...references.keys()], keys, `A list under ${heading} must be the bibliography.`);
  assert.deepEqual(
    [...references.values()].map((reference) => [reference.authors, reference.title]),
    [
      ['A. Author', 'First title'],
      ['B. Author', 'Second title'],
    ],
  );
  assert.deepEqual(
    buildSourceBlocks(source, [], references).map((block) => [block.kind, block.title]),
    [['section', 'Body'], ['paragraph', ''], ['section', 'References'], ...keys.map((key) => ['bibliography', key])],
    `A list under ${heading} must render as entries after one references heading.`,
  );
}
assert.equal(
  extractBibliography(String.raw`\begin{document}
References

We thank the referee.

[1] is not an entry after prose.
\end{document}`).size,
  0,
  'Prose between the heading and a bracket must not make a hand-written list.',
);

const decorative = readableLatex(
  String.raw`\textcolor{meta-color}{\textbf{Subset}}: Common Crawl \textcolor{wkblue}{\rule{\linewidth}{0.4pt}}`,
);
assert.equal(
  decorative,
  'Subset: Common Crawl',
  'Decorative TeX color and rule commands must not leak into reader prose.',
);
assert.equal(
  readableLatex(String.raw`P\u{a}un, B\l ocki, Musta\c{t}`),
  'Păun, Błocki, Mustaţ',
  'Common author-name accents must render cleanly in bibliography entries.',
);
assert.doesNotMatch(
  readableLatex(String.raw`Reference \nolinkurl{doi:10.1000/example}`),
  /\\nolinkurl/,
  'Bibliographic nolinkurl wrappers must never leak into reader prose.',
);
assert.equal(
  readableLatex(String.raw`$\left(\lambda + \Lambda\right)$`),
  String.raw`$\left(\lambda + \Lambda\right)$`,
  'Polish letter conversion must not alter longer math commands that begin with \\l or \\L.',
);

const legacyMathText = readableLatex(String.raw`\mbox{{\bf $(\omega,\,\Omega)$-Hermite-Einstein} metric on}`);
assert.doesNotMatch(
  legacyMathText,
  /\\bf\b/,
  'Legacy font declarations inside math text must not leak into the reader.',
);
assert.doesNotThrow(
  () => katex.renderToString(legacyMathText, { throwOnError: true, strict: 'ignore' }),
  'Math text containing legacy font declarations must remain valid KaTeX.',
);

const expandedNormMacro = expandAuthorMacros(
  String.raw`\newcommand{\norm}[1]{\left\lVert#1\right\rVert}\begin{document}$\norm{A}$\end{document}`,
);
assert.match(
  expandedNormMacro,
  /\\left\\lVert A\\right\\rVert/,
  'Macro substitution must preserve a TeX control-word boundary before a letter argument.',
);

// Arguments are taken unexpanded, as TeX takes them: a nested use of the same
// macro and a macro passed as an argument both expand cleanly.
assert.match(
  expandAuthorMacros(
    String.raw`\newcommand{\abs}[1]{|#1|}\newcommand{\FF}{\mathbb F}\newcommand{\ol}[1]{\overline{#1}}\begin{document}$\abs{\abs{x}} + \ol\FF$\end{document}`,
  ),
  /\$\|\|x\|\| \+ \\overline\{\\mathbb F\}\$/,
);
// A recursive definition must not grow the document without bound.
const recursiveSource = String.raw`\def\a{\a\a\a\a\a\a\a\a}\begin{document}${'$\\a$ '.repeat(20000)}\end{document}`;
assert.ok(
  expandAuthorMacros(recursiveSource).length <= recursiveSource.length + 2 * 1024 * 1024,
  'Recursive macro expansion must stay within its growth budget.',
);

const literalMacroExample = expandAuthorMacros(
  String.raw`\newcommand{\R}{\mathbb R}\begin{document}\begin{verbatim}\newcommand{\R}{wrong}\R\end{verbatim}Live $\R$.\end{document}`,
);
assert.match(
  literalMacroExample,
  /\\begin\{verbatim\}\\newcommand\{\\R\}\{wrong\}\\R\\end\{verbatim\}/,
  'Macro examples in literal source environments must remain byte-for-byte readable.',
);
assert.match(
  literalMacroExample,
  /Live \$\\mathbb R\$[.]/,
  'A real author macro must still expand outside literal source examples.',
);

const expandedFormulas = (preamble, body) =>
  [...expandAuthorMacros(`${preamble}\\begin{document}${body}\\end{document}`).matchAll(/\$([^$]*)\$/g)].map(
    (match) => match[1],
  );
const assertTypesets = (formulas) => {
  for (const formula of formulas)
    assert.doesNotThrow(() => katex.renderToString(formula, { throwOnError: true, strict: 'ignore' }), formula);
};
assert.deepEqual(
  expandedFormulas(String.raw`\newcommand{\norm}[1]{\left\lVert#1\right\rVert}`, String.raw`$\norm{x}y$`),
  [String.raw`\left\lVert x\right\rVert y`],
  'A replacement ending in a control word must not absorb the letter after the use.',
);
// Without these declarations, KaTeX shows an undefined \abs{x} as "abs x".
const pairedDelimiters = expandedFormulas(
  String.raw`\DeclarePairedDelimiter\abs{\lvert}{\rvert}
\DeclarePairedDelimiter{\ceil}{\lceil}{\rceil}
\DeclarePairedDelimiter\paren()
\DeclarePairedDelimiterX\inner[2]{\langle}{\rangle}{#1,#2}
\DeclarePairedDelimiterX\set[1]\lbrace\rbrace{\def\given{\;\delimsize\vert\;}#1}
\DeclarePairedDelimiterX{\cond}[2]{(}{)}{#1\delimsize|#2}
\DeclarePairedDelimiterXPP\Prob[1]{\mathbb{P}}(){}{#1}`,
  String.raw`$\abs{x}$ $\abs*{\frac12}$ $\abs[\big]{x}$ $\abs[\Big]{x}$ $\abs[\bigg]{x}$ $\abs[\Bigg]{x}$ $\ceil{x}$
$\paren{x}y$ $\inner{a}{b}$ $\inner[\big]{a}{b}$ $\set{x\given x>0}$ $\cond{A}{B}$ $\cond[\Big]{A}{B}$ $\Prob{A}$`,
);
// As in mathtools: the plain form keeps the normal size, the starred form scales.
assert.deepEqual(pairedDelimiters, [
  String.raw`\mathopen\lvert x\mathclose\rvert`,
  String.raw`\left\lvert\frac12\right\rvert`,
  String.raw`\bigl\lvert x\bigr\rvert`,
  String.raw`\Bigl\lvert x\Bigr\rvert`,
  String.raw`\biggl\lvert x\biggr\rvert`,
  String.raw`\Biggl\lvert x\Biggr\rvert`,
  String.raw`\mathopen\lceil x\mathclose\rceil`,
  String.raw`\mathopen(x\mathclose)y`,
  String.raw`\mathopen\langle a,b\mathclose\rangle`,
  String.raw`\bigl\langle a,b\bigr\rangle`,
  String.raw`\mathopen\lbrace x\;\vert\; x>0\mathclose\rbrace`,
  String.raw`\mathopen(A|B\mathclose)`,
  String.raw`\Bigl(A\Big|B\Bigr)`,
  String.raw`\mathbb{P}\mathopen(A\mathclose)`,
]);
assertTypesets(pairedDelimiters);

const documentCommands = expandedFormulas(
  String.raw`\NewDocumentCommand\nrm{m}{\lVert #1\rVert}
\NewDocumentCommand{\Norm}{s O{} m}{\IfBooleanTF{#1}{\left\lVert #3\right\rVert}{\lVert #3\rVert}_{#2}}
\DeclareDocumentCommand\opt{o +m}{\IfNoValueTF{#1}{f(#2)}{f_{#1}(#2)}}
\NewDocumentCommand\sub{m o}{#1\IfValueT{#2}{_{#2}}}
\ProvideDocumentCommand\nrm{m}{WRONG}
\NewDocumentCommand\verbatimArgument{v}{#1}
\NewDocumentCommand\blank{m}{\IfBlankTF{#1}{a}{b}}`,
  String.raw`$\nrm{x}y$ $\Norm{x}$ $\Norm*[2]{x}$ $\opt{x}$ $\opt [n] {x}$ $\sub{x}$ $\sub{x}[i]$
$\verbatimArgument|x|$ $\blank{x}$`,
);
assert.deepEqual(documentCommands, [
  String.raw`\lVert x\rVert y`,
  String.raw`\lVert x\rVert_{}`,
  String.raw`\left\lVert x\right\rVert_{2}`,
  'f(x)',
  'f_{n}(x)',
  'x',
  'x_{i}',
  // Argument types and tests the reader cannot follow stay undefined, never
  // half-expanded.
  String.raw`\verbatimArgument|x|`,
  String.raw`\blank{x}`,
]);
assertTypesets(documentCommands.slice(0, 7));
assert.equal(
  readableLatex(
    String.raw`\DeclarePairedDelimiter\paren() \DeclarePairedDelimiterX\inner[2]{\langle}{\rangle}{#1,#2} \NewDocumentCommand{\nrm}{m}{\lVert #1\rVert} Text.`,
  ),
  'Text.',
  'Paired-delimiter and document-command declarations must not leak into reader text.',
);

// KaTeX has no siunitx, so \SI{3}{\meter} would read as "SI 3 meter".
const quantities = readableLatex(
  String.raw`A speed of \SI{3}{\meter\per\second} and $v = \qty{3}{\meter}$, \si{\kilogram\per\meter\per\second\squared}, \si{\per\second}, \num{1e3}, \num{-1.5e-3}, \ang{30}, $\ang{1;2;3}$, \qty{9.81}{m/s^2}, \SI{30}{\degree}.\sisetup{per-mode=symbol}`,
);
assert.equal(
  quantities,
  String.raw`A speed of $3\,\mathrm{m/s}$ and $v = 3\,\mathrm{m}$, $\mathrm{kg/(m\,s^{2})}$, $\mathrm{s^{-1}}$, $1\times 10^{3}$, $-1.5\times 10^{-3}$, $30^{\circ}$, $1^{\circ}2'3''$, $9.81\,\mathrm{m/s^2}$, $30\mathrm{{}^{\circ}}$.`,
);
const units = readableLatex(
  String.raw`$\si{\kilo\meter} \si{\milli\gram} \si{\micro\second} \si{\nano\meter} \si{\centi\metre} \si{\mega\hertz} \si{\giga\watt} \si{\newton\meter} \si{\joule\per\kelvin\per\mole} \si{\volt\ampere} \si{\pascal} \si{\meter\cubed}$`,
);
assert.equal(
  units,
  String.raw`$\mathrm{km} \mathrm{mg} \mathrm{\mu s} \mathrm{nm} \mathrm{cm} \mathrm{MHz} \mathrm{GW} \mathrm{N\,m} \mathrm{J/(K\,mol)} \mathrm{V\,A} \mathrm{Pa} \mathrm{m^{3}}$`,
);
assertTypesets([...`${quantities} ${units}`.matchAll(/\$([^$]*)\$/g)].map((match) => match[1]));
assert.equal(
  readableLatex(String.raw`$\qty{x}$ and $\qty(y)$ \begin{verbatim}\SI{3}{\meter}\end{verbatim}`),
  String.raw`$\qty{x}$ and $\qty(y)$ \begin{verbatim}\SI{3}{\meter}\end{verbatim}`,
  "The physics package's \\qty and literal source examples must stay as written.",
);

const horizontalFill = readableLatex(String.raw`Conclusion.\hfil Middle.\hfill $\Box$`);
assert.doesNotMatch(
  horizontalFill,
  /\\hfill?\b/,
  'Horizontal fill commands are layout glue and must not appear in reader content.',
);
assert.match(
  horizontalFill,
  /Conclusion[.]\s+Middle[.]\s+\$\\Box\$/,
  'Removing horizontal fill must preserve adjacent prose and math.',
);
assert.equal(
  readableLatex(String.raw`Saal~[BHHS-24]`),
  'Saal\u00a0[BHHS-24]',
  'TeX nonbreaking spaces must retain their no-wrap semantics in parsed paper text.',
);

assert.equal(
  ar5ivFigureUrl('math/0702066v2', 'figures/famcurv.eps'),
  'https://ar5iv.labs.arxiv.org/html/math/0702066/assets/famcurv.png',
);
assert.equal(
  ar5ivFigureUrl('local-upload', 'famcurv.eps'),
  '',
  'Uploaded papers must never trigger a guessed remote asset URL.',
);

// A package shipped with the source declares theorems, counters, and macros; its
// print-only code (a redefined \section, @-commands, notes after \endinput) is ignored.
{
  const packageRoot = await mkdtemp(path.join(tmpdir(), 'arxivpecker-package-'));
  try {
    await writeFile(
      path.join(packageRoot, 'main.tex'),
      String.raw`\documentclass{article}
\usepackage{amsmath,notes}
\newtheorem{maincorollary}[maintheorem]{Corollary}
\begin{document}
\section{Introduction}
\begin{maintheorem}\label{main}Every $u\in\PSH$ is usc.\end{maintheorem}
\begin{maincorollary}\label{cor}It follows.\end{maincorollary}
\begin{theorem}[{$=$ \cref{main}}]\label{restated}Again.\end{theorem}
By \cref{main,cor} and \cref{restated}.
\end{document}`,
    );
    await writeFile(
      path.join(packageRoot, 'notes.sty'),
      String.raw`\ProvidesPackage{notes}
\RequirePackage[nameinlink,capitalize]{cleveref}
\RequirePackage{inner}
\newtheorem{maintheorem}{Theorem}[part]
\renewcommand\themaintheorem{\Alph{maintheorem}}
\newcommand{\PSH}{\mathrm{PSH}}
\renewcommand\section{\@startsection{section}{1}{\z@}{-3ex}{2ex}{\bfseries}}
\def\@internal#1{#1}
\endinput
\newcommand{\PSH}{\mathrm{WRONG}}`,
    );
    await writeFile(path.join(packageRoot, 'inner.sty'), String.raw`\newtheorem{theorem}{Theorem}[section]`);
    const expanded = await readExpandedTex(path.join(packageRoot, 'main.tex'), packageRoot);
    assert.doesNotMatch(
      expanded,
      /WRONG|@startsection|@internal/,
      'Only reader-relevant package declarations are read.',
    );
    const packaged = resolveLatexReferences(expanded, extractSourceUnits(expanded));
    const units = extractSourceUnits(packaged);
    assert.deepEqual(
      units.map((unit) => [unit.environment, unit.printedNumber, unit.title]),
      [
        ['maintheorem', 'A', ''],
        ['maincorollary', 'B', ''],
        ['theorem', '1.1', '$=$ Theorem A'],
      ],
      'Theorems from a local package are numbered as it declares them, and a braced title loses only its braces.',
    );
    assert.match(units[0].statement, /\\mathrm\{PSH\}|\\PSH/);
    assert.match(packaged, /By Theorem A and Corollary B and Theorem 1\.1\./, "The package's cleveref options apply.");
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
}

// Text-mode TeX with a character of its own reads as that character; mathematics is untouched.
assert.equal(
  readableLatex(String.raw`See \S 1, \S\S 4--5 and \cite[\S5.2]{BJ22}; resp.\ in $\S 3$.`),
  'See §1, §§4--5 and [[cite:BJ22|§5.2]]; resp. in $\\S 3$.',
);
assert.equal(
  readableLatex(
    String.raw`\begin{enumerate}\item \textup{\cite[Lemma~1.6]{BJ}} holds \textup(always\textup).\end{enumerate}`,
  ),
  '• [[cite:BJ|Lemma\u00a01.6]] holds (always).',
  'An unwrapped \\textup{\\cite...} after \\item is a citation, not the item label.',
);
assert.equal(readableLatex(String.raw`This completes the proof.\qed`), 'This completes the proof.$\\qed$');
assert.equal(readableLatex(String.raw`\appendix`), '', '\\appendix is structure, not text.');
assert.equal(
  readableLatex(
    String.raw`T\o nnesen, Ruadha\'{\i}, topolog\'\i a, B{\l}ocki, \AA hag, \guillemotleft x\guillemotright`,
  ),
  'Tønnesen, Ruadhaí, topología, B{ł}ocki, Åhag, «x»',
);

// BibTeX accents are decoded before their braces go; a shorthand is the printed label.
{
  const bibRoot = await mkdtemp(path.join(tmpdir(), 'arxivpecker-bib-'));
  try {
    await writeFile(
      path.join(bibRoot, 'main.tex'),
      String.raw`\documentclass{article}\begin{document}\cite{Stacks,JM12}\bibliography{refs}\end{document}`,
    );
    await writeFile(
      path.join(bibRoot, 'refs.bib'),
      String.raw`@misc{Stacks, author = {{The Stacks Project Authors}}, title = {Stacks Project},
  howpublished = {\url{https://stacks.math.columbia.edu}}, year = {2020}, shorthand = {Stacks}}
@article{JM12, author = {Jonsson, Mattias and Musta\c{t}\u{a}, Mircea and W{\l}odarczyk, J.},
  title = {Fine topology, \v{S}ilov boundary, and {$(dd^c)^n$}}, year = {2012}}`,
    );
    const source = await readExpandedTex(path.join(bibRoot, 'main.tex'), bibRoot);
    const references = await extractBibliographyTree(source, bibRoot, path.join(bibRoot, 'main.tex'));
    assert.equal(references.get('Stacks').label, 'Stacks');
    assert.equal(references.get('Stacks').url, 'https://stacks.math.columbia.edu');
    assert.equal(references.get('JM12').authors, 'Jonsson, Mattias · Mustaţă, Mircea · Włodarczyk, J.');
    assert.equal(references.get('JM12').title, 'Fine topology, Šilov boundary, and $(dd^c)^n$');
    assert.equal(references.get('JM12').label, undefined);
  } finally {
    await rm(bibRoot, { recursive: true, force: true });
  }
}
assert.equal(
  extractBibliography(
    String.raw`\begin{thebibliography}{9}\bibitem[BJ22]{bj}S. Boucksom.\bibitem[{Smith(2020)}]{sm}J. Smith.\end{thebibliography}`,
  ).get('bj').label,
  'BJ22',
  '\\bibitem[BJ22] prints its label; a natbib label is not one.',
);

// A paper's own title, authors, and abstract.
assert.deepEqual(
  texFrontMatter(String.raw`\documentclass{amsart}
\title[Short]{A long title\\ on two lines\thanks{Funded.}}
\author{Alice B. Smith}\address{Univ}\email{a@b.c}
\author{Carl D\'iaz$^{1}$}
\begin{document}\begin{abstract}We prove $x=1$ \cite{K}.\end{abstract}\maketitle\end{document}`),
  { title: 'A long title on two lines', authors: 'Alice B. Smith, Carl Díaz', abstract: 'We prove $x=1$ [K].' },
);
assert.equal(
  texFrontMatter(String.raw`\author{Ann One\inst{1} \and Bob Two\\ University of X}`).authors,
  'Ann One, Bob Two',
);

console.log(
  'TeX reader: references resolved, literal source preserved, decorative commands removed, arXiv figure fallback normalized.',
);
