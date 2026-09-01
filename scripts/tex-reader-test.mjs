import assert from 'node:assert/strict';
import { ar5ivFigureUrl, extractSourceUnits, readableLatex, resolveLatexReferences } from './codex-bridge.mjs';

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
assert.match(theorem.statement, /Equation \(1\.1\) implies the claim\./);

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

const decorative = readableLatex(String.raw`\textcolor{meta-color}{\textbf{Subset}}: Common Crawl \textcolor{wkblue}{\rule{\linewidth}{0.4pt}}`);
assert.equal(decorative, 'Subset: Common Crawl', 'Decorative TeX color and rule commands must not leak into reader prose.');

assert.equal(ar5ivFigureUrl('math/0702066v2', 'figures/famcurv.eps'), 'https://ar5iv.labs.arxiv.org/html/math/0702066/assets/famcurv.png');
assert.equal(ar5ivFigureUrl('local-upload', 'famcurv.eps'), '', 'Uploaded papers must never trigger a guessed remote asset URL.');

console.log('TeX reader: references resolved, literal source preserved, decorative commands removed, arXiv figure fallback normalized.');
