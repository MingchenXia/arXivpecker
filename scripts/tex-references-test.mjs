import assert from 'node:assert/strict';
import { buildSourceBlocks, extractSourceUnits, readableLatex, resolveLatexReferences } from './tex-source.mjs';

// References must print what the paper's packages print. `refs` resolves a
// document and returns the readable text after "REFS:".
const refs = (tex) => {
  const resolved = resolveLatexReferences(tex, extractSourceUnits(tex));
  return readableLatex(/REFS:([\s\S]*?)(?:\\end\{document\}|$)/.exec(resolved)?.[1] || '').replace(/ /g, ' ');
};
const doc = (preamble, body) => String.raw`\documentclass{article}${preamble}\begin{document}${body}\end{document}`;
const theorems = String.raw`\newtheorem{theorem}{Theorem}[section]\newtheorem{lemma}[theorem]{Lemma}`;
const body = String.raw`\section{Intro}\label{sec:intro}
\begin{theorem}\label{thm:a}A.\end{theorem}
\begin{lemma}\label{lem:b}B.\end{lemma}
\begin{lemma}\label{lem:c}C.\end{lemma}
\begin{lemma}\label{lem:d}D.\end{lemma}
\begin{equation}\label{eq:one}x=1\end{equation}`;

// cleveref: its default names, lowercase and abbreviated; lists grouped by type;
// three or more consecutive numbers as a range; \Cref capitalized.
assert.equal(
  refs(
    doc(
      `\\usepackage{cleveref}${theorems}`,
      String.raw`${body}
REFS: \cref{thm:a}; \Cref{lem:b}; \cref{eq:one}; \Cref{eq:one}; \cref{sec:intro}; \cref{thm:a,lem:b}; \cref{lem:b,lem:c,lem:d}; \cref{lem:b,lem:d}; \crefrange{lem:b}{lem:d}; \labelcref{eq:one,thm:a}; \namecref{lem:b}; \nameCref{lem:b}; \cref{thm:a,missing}`,
    ),
  ),
  'theorem 1.1; Lemma 1.2; eq. (1); Equation (1); section 1; theorem 1.1 and lemma 1.2; lemmas 1.2 to 1.4; lemmas 1.2 and 1.4; lemmas 1.2 to 1.4; (1) and 1.1; lemma; Lemma; theorem 1.1 and ??',
);
// capitalise and noabbrev, \crefname/\Crefname, \crefalias, and \label[type].
assert.equal(
  refs(
    doc(
      String.raw`\usepackage[capitalise,noabbrev]{cleveref}${theorems}\newtheorem{thm}{Theorem}\crefname{lemma}{Lem.}{Lems.}\Crefname{lemma}{Lemma}{Lemmas}`,
      String.raw`${body}\begin{thm}\label{thm:own}E.\end{thm}\begin{equation}\label[lemma]{eq:typed}y\end{equation}
REFS: \cref{thm:a}; \cref{eq:one}; \cref{lem:b}; \Cref{lem:b}; \cref{thm:own}; \cref{eq:typed}`,
    ),
  ),
  'Theorem 1.1; Equation (1); Lem. 1.2; Lemma 1.2; Theorem 1; Lem. 2',
);

// hyperref's \autoref names the counter: a lemma sharing the theorem counter
// prints "Theorem", and sections print "section" unless the author renames it.
assert.equal(
  refs(
    doc(
      `\\usepackage{hyperref}${theorems}`,
      String.raw`${body}REFS: \autoref{thm:a}; \autoref{lem:b}; \autoref{sec:intro}; \autoref{eq:one}`,
    ),
  ),
  'Theorem 1.1; Theorem 1.2; section 1; Equation 1',
);
assert.equal(
  refs(
    doc(
      String.raw`\usepackage{hyperref,aliascnt}\newtheorem{theorem}{Theorem}\newaliascnt{lemma}{theorem}\newtheorem{lemma}[lemma]{Lemma}\newcommand{\lemmaautorefname}{Lemma}\renewcommand{\sectionautorefname}{Section}`,
      String.raw`\section{S}\label{s}\begin{theorem}\label{t}A.\end{theorem}\begin{lemma}\label{l}B.\end{lemma}REFS: \autoref{t}; \autoref{l}; \autoref{s}`,
    ),
  ),
  'Theorem 1; Lemma 2; Section 1',
  'An alias counter shares the numbers of its target but keeps its own \\autoref name.',
);

// \nameref, \subref, \thref, and page references (a reflowed paper has no pages,
// so they name their target; "page~\pageref{x}" becomes the target's name).
assert.equal(
  refs(
    doc(
      theorems,
      String.raw`${body}\begin{theorem}[Main estimate]\label{thm:named}E.\end{theorem}
REFS: \nameref{sec:intro}; \nameref{thm:named}; \thref{lem:b}; see page~\pageref{thm:a}; \cpageref{thm:a}; \vref{lem:b}; figure\vpageref{thm:a} here`,
    ),
  ),
  'Intro; Main estimate; Lemma 1.2; see Theorem 1.1; theorem 1.1; lemma 1.2; figure here',
);

// Labels with no number of their own: a starred section and an unnumbered
// theorem are named; a label in an unnumbered display takes the enclosing
// section, as in LaTeX; a footnote label takes the footnote number.
assert.equal(
  refs(
    doc(
      String.raw`\newtheorem*{mainthm}{Main Theorem}`,
      String.raw`\section{One}\section*{Acknowledgements}\label{sec:ack}
\begin{mainthm}\label{thm:main}M.\end{mainthm}
\begin{equation*}\label{eq:star}x\end{equation*}
Text.\footnote{First.}\footnote{Second.\label{fn:two}}\footnote[9]{Fixed.\label{fn:nine}}
REFS: \ref{sec:ack}; \ref{thm:main}; \cref{thm:main}; \eqref{eq:star}; \ref{fn:two}; \ref{fn:nine}; \ref{nowhere}`,
    ),
  ),
  'Acknowledgements; Main Theorem; Main Theorem; (1); 2; 9; ??',
);
assert.doesNotMatch(readableLatex(String.raw`See \cref{nowhere} and \ref{nowhere}.`), /referenced result/);

// Enumerate items: the class default labels and references, enumitem's keys
// and \setlist, enumerate's short form, \newlist, and nested numbering.
const listed = (preamble, list, reference) => {
  const tex = doc(preamble, `${list} REFS: ${reference}`);
  const resolved = resolveLatexReferences(tex, extractSourceUnits(tex));
  return { labels: readableLatex(resolved.split('REFS:')[0].split('\\begin{document}')[1]), refs: refs(tex) };
};
let result = listed(
  '',
  String.raw`\begin{enumerate}\item\label{a}One \item Two\begin{enumerate}\item\label{b}Inner\end{enumerate}\end{enumerate}`,
  String.raw`\ref{a}, \ref{b}`,
);
assert.equal(result.refs, '1, 2a');
assert.match(result.labels, /^1\. One\n\n2\. Two\n\n\(a\) Inner$/);
result = listed(
  '',
  String.raw`\begin{enumerate}[label=(\roman*)]\item\label{a}One\item\label{b}Two\end{enumerate}\begin{enumerate}[resume]\item\label{c}Three\end{enumerate}`,
  String.raw`\ref{a}, \ref{b}, \ref{c}`,
);
assert.equal(result.refs, '(i), (ii), 3', 'enumitem references print like the label; resume continues the count.');
assert.match(result.labels, /^\(i\) One\n\n\(ii\) Two\n\n3\. Three$/);
result = listed(
  '',
  String.raw`\begin{enumerate}[label=\textbf{C\arabic*}, ref=C\arabic*, start=3]\item\label{a}One\end{enumerate}\begin{enumerate}[(a)]\item\label{b}Short\end{enumerate}\begin{enumerate}[wide]\item\label{c}Keyword\end{enumerate}`,
  String.raw`\ref{a}, \ref{b}, \ref{c}`,
);
assert.equal(
  result.refs,
  'C3, (a), 1',
  'ref= and start= apply; [(a)] is the short form; [wide] is a key, not a label.',
);
result = listed(
  String.raw`\usepackage{enumitem}\newlist{conditions}{enumerate}{1}\setlist[conditions]{label=(C\arabic*)}\setlist[enumerate,1]{label=\alph*)}`,
  String.raw`\begin{conditions}\item\label{a}Cond\end{conditions}\begin{enumerate}\item\label{b}Alpha\item[(*)]\label{c}Custom\end{enumerate}`,
  String.raw`\ref{a}, \ref{b}, \ref{c}, \cref{b}`,
);
assert.equal(result.refs, '(C1), a), (*), item a)');
assert.match(result.labels, /^\(C1\) Cond\n\na\) Alpha\n\n\(\*\) Custom$/);
result = listed(
  '',
  String.raw`\begin{itemize}\item Bullet\end{itemize}\begin{description}\item[Term] Meaning\end{description}`,
  '',
);
assert.match(result.labels, /^• Bullet\n\nTerm Meaning$/, 'Description terms show; itemize keeps its bullet.');
// amsart prints "(1)" and refers to "1"; a theorem's own label is not an item's.
const amsart = String.raw`\documentclass{amsart}\newtheorem{theorem}{Theorem}\begin{document}
\begin{theorem}Conditions:\begin{enumerate}\item\label{c1}first\item\label{c2}second\end{enumerate}\end{theorem}
REFS: \ref{c2}\end{document}`;
assert.equal(
  extractSourceUnits(amsart)[0].texLabel,
  '',
  'An item label inside a result must not become the result label.',
);
assert.equal(refs(amsart), '2');
assert.match(readableLatex(resolveLatexReferences(amsart, extractSourceUnits(amsart))), /\(1\) first\n\n\(2\) second/);

// Subfigures: their captions do not step the figure counter; references print
// the figure number and letter, and \subref the letter.
const figures = String.raw`\begin{figure}
\begin{subfigure}{.4\textwidth}\caption{Left}\label{sub:l}\end{subfigure}
\begin{subfigure}{.4\textwidth}\caption{Right}\label{sub:r}\end{subfigure}
\caption{Pair}\label{fig:pair}\end{figure}
\begin{figure}\subfloat[Top]{\label{sub:t}x}\subcaptionbox{Bottom\label{sub:b}}{y}\caption{Stack}\label{fig:stack}\end{figure}
\begin{figure}\begin{minipage}{.5\textwidth}\subcaption{Loose}\label{sub:loose}\end{minipage}\caption{Minipages}\label{fig:mini}\end{figure}`;
assert.equal(
  refs(
    doc(
      '\\usepackage{cleveref}',
      `${figures} REFS: \\ref{sub:l}, \\ref{sub:r}, \\ref{fig:pair}, \\subref{sub:r}, \\ref{sub:t}, \\ref{sub:b}, \\ref{fig:stack}, \\ref{sub:loose}, \\ref{fig:mini}, \\cref{sub:l}, \\nameref{fig:pair}`,
    ),
  ),
  '1a, 1b, 1, (b), 2a, 2b, 2, 3a, 3, fig. 1a, Pair',
);
const figureBlocks = buildSourceBlocks(
  String.raw`\begin{figure}\begin{subfigure}{.4\textwidth}\includegraphics{a.png}\caption{Left}\end{subfigure}\caption{Whole}\end{figure}`,
  [],
  new Map(),
);
assert.equal(
  figureBlocks.find((block) => block.kind === 'figure')?.caption,
  'Whole',
  'A figure shows its own caption.',
);
assert.doesNotMatch(
  readableLatex(String.raw`\begin{subfigure}[t]{.4\textwidth}Left\end{subfigure}`),
  /subfigure|textwidth/,
  'Subfigure wrappers must not leak into prose.',
);

// Theorem declarations beyond \newtheorem: thmtools, llncs, and aliases.
const numbers = (tex) => extractSourceUnits(tex).map((unit) => `${unit.displayName} ${unit.printedNumber}`.trim());
assert.deepEqual(
  numbers(String.raw`\declaretheorem[numberwithin=section]{theorem}
\declaretheorem[name=Proposition, sibling=theorem]{prop}
\declaretheorem[numbered=no, name=Main Theorem]{main}
\declaretheorem{remark}[sibling=theorem]
\begin{document}\section{S}\begin{theorem}A\end{theorem}\begin{prop}B\end{prop}\begin{main}C\end{main}\begin{remark}D\end{remark}\end{document}`),
  ['Theorem 1.1', 'Proposition 1.2', 'Main Theorem', 'Remark 1.3'],
);
assert.deepEqual(
  numbers(
    String.raw`\documentclass{llncs}\begin{document}\begin{theorem}A\end{theorem}\begin{lemma}B\end{lemma}\begin{lemma}C\end{lemma}\begin{claim}D\end{claim}\end{document}`,
  ),
  ['Theorem 1', 'Lemma 1', 'Lemma 2', 'Claim'],
  'llncs gives each environment its own counter and leaves claims unnumbered.',
);
assert.deepEqual(
  numbers(
    String.raw`\documentclass[envcountsame,envcountsect]{llncs}\spnewtheorem{fact}[theorem]{Fact}{\bfseries}{\itshape}\begin{document}\section{S}\begin{theorem}A\end{theorem}\begin{lemma}B\end{lemma}\begin{fact}C\end{fact}\end{document}`,
  ),
  ['Theorem 1.1', 'Lemma 1.2', 'Fact 1.3'],
);
assert.equal(
  refs(
    doc(
      String.raw`\usepackage{cleveref}\declaretheorem[name=Theorem, refname={thm.,thms.}, Refname={Thm.,Thms.}]{theorem}`,
      String.raw`\begin{theorem}\label{t}A\end{theorem}REFS: \cref{t}; \Cref{t}`,
    ),
  ),
  'thm. 1; Thm. 1',
);

console.log(
  'TeX references: cleveref, autoref, nameref, page references, lists, footnotes, unnumbered labels, subfigures, and theorem packages verified.',
);
