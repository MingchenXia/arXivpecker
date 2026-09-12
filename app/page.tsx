'use client';

import katex from 'katex';
import { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, memo, startTransition, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type View = 'reader' | 'library' | 'graph' | 'discover' | 'settings';
type ReaderMode = 'source' | 'interactive';
type EditionMode = 'original' | 'working';
type Paper = { id: string; title: string; authors: string; category: string; arxivId: string; abstract: string; state: 'To read' | 'Reading' | 'Read'; tags: string[]; folder?: string; source?: { abstractUrl?: string; pdfUrl?: string; texUrl?: string; analysisFormat?: string; localPdf?: string } };
type Profile = { level: string; areas: string[]; goal: string; model: string; reasoning: string; reasoningConfigured?: boolean };
type Note = { id: string; paperId: string; nodeId: string; anchor: string; text: string; latex: string; createdAt: string };

function normalizeNotes(notes: Note[]) {
  const seen = new Set<string>();
  return notes.filter((note) => { if (note.nodeId === '__paper__') return true; const key = `${note.paperId}:${note.nodeId}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
type ReadingMark = '' | 'understood' | 'question' | 'error';
type Anchor = { label: string; page: number | null; confidence: 'verified' | 'approximate' | 'unverified' };
type CitationReference = { key: string; locator: string; statement: string; definitions?: { notation: string; definition: string; source: string }[]; title: string; authors: string; text: string; url: string; searchUrl: string; doi: string; arxivId: string; direct: boolean };
type NodeKind = 'definition' | 'assumption' | 'notation' | 'lemma' | 'proposition' | 'theorem' | 'corollary' | 'conjecture' | 'proof' | 'equation' | 'remark' | 'example' | 'section' | 'paragraph' | 'figure' | 'table' | 'external-result';
type AuditNode = { id: string; kind: NodeKind; displayName?: string; label: string; title: string; statement: string; proofText: string; citations: CitationReference[]; status: 'verified' | 'needs-verification' | 'unavailable'; anchor: Anchor; role: string; dependencies: string[]; proofSketch: string[]; whyItMatters: string; expandable: boolean };
type WorkingPatch = { id: string; kind: 'replace' | 'delete' | 'add'; nodeId: string; title: string; statement: string; proofText: string; nodeKind: NodeKind | ''; afterNodeId: string; rationale: string; dependencies: string[]; proofSketch: string[]; source: 'manual' | 'ai'; createdAt: string };
type EditorialSuggestion = { hasIssue: boolean; replacement: string; rationale: string; confidence: 'high' | 'medium' | 'low' };
type VersionChange = { label: string; changeType: 'added' | 'removed' | 'strengthened' | 'weakened' | 'corrected' | 'reorganized' | 'wording'; before: string; after: string; significance: 'mathematical' | 'proof-level' | 'expository' | 'uncertain'; dependencyImpact: string };
type VersionComparison = { summary: string; changedUnits: VersionChange[]; proofChanges: string[]; notationChanges: string[]; editorialChanges: string[]; dependencyImpact: string[]; readingRecommendation: string; warnings: string[] };
type UpdateMigrationItem = { type: 'note' | 'edit' | 'mark' | 'reader-context'; label: string; status: 'carried' | 'review' | 'paper-note'; detail: string; fromId: string; toId: string };
type PaperUpdateRecord = { id: string; paperId: string; fromVersion: string; toVersion: string; createdAt: string; status: 'updated' | 'current'; comparison: VersionComparison; migration: { notesCarried: number; notesToPaper: number; marksCarried: number; editsCarried: number; editsReview: number; items: UpdateMigrationItem[]; conflicts: UpdateMigrationItem[] } };
type CrossLink = { id: string; from: { paperId: string; nodeId: string }; to: { paperId: string; nodeId: string }; relation: 'uses' | 'extends' | 'background' | 'contrasts'; note: string; source: 'manual' | 'audit'; createdAt?: string };
type AuditCrossLink = { fromNodeId: string; targetPaperId: string; targetNodeId: string; relation: CrossLink['relation']; rationale: string };
type SourceBlockKind = 'section' | 'paragraph' | 'result' | 'proof' | 'figure' | 'table' | 'bibliography';
type SourceBlock = { id: string; kind: SourceBlockKind; level: number; title: string; content: string; proofText: string; nodeId: string; resultKind: string; citations: CitationReference[]; assetPaths: string[]; caption: string };
type PaperAudit = { threadId: string; generatedAt: string; rawText: string; audit: { sourceStatus: 'full-text-read' | 'partial-text-read' | 'blocked'; sourceSummary: string; centralQuestion: string; mainContribution: string; verificationWarnings: string[] }; nodes: AuditNode[]; sourceBlocks: SourceBlock[]; readingPaths: { goal: string; nodeIds: string[]; reason: string }[]; crossPaperLinks: AuditCrossLink[]; openQuestions: string[]; editorialCorrections?: { nodeId: string; field: 'statement' | 'proofText'; original: string; replacement: string; rationale: string; confidence: 'high' | 'medium' | 'low' }[] };
type AuditJob = { version: number; paperId: string; state: 'preparing' | 'running' | 'paused' | 'completed'; threadId: string; options: { convertPdfToLatex: boolean; correctnessAudit: boolean; detailedAudit: boolean }; attempts: number; startedAt: string; updatedAt: string; message: string };
type GraphNode = { id: string; paperId: string; paperTitle: string; arxivId: string; nodeId: string; label: string; title: string; kind: NodeKind; page: number | null; status: AuditNode['status'] };
type GraphEdge = { id: string; from: string; to: string; relation: CrossLink['relation']; source: 'manual' | 'audit'; note?: string };
type Graph = { version: number; updatedAt: string | null; nodes: GraphNode[]; edges: GraphEdge[] };
type Bridge = { running: boolean; account: { type: string; planType: string | null } | null; models: { id: string; label: string; efforts: string[]; defaultEffort: string | null; isDefault: boolean }[]; lastError: string | null };
type ReaderProcessStatus = 'running' | 'complete' | 'error';
type ReaderProcessUpdate = { id: string; label: string; detail: string; status: ReaderProcessStatus; retryPaperId?: string };
type PaperJobKind = 'audit' | 'update';
type ReferenceTarget = { title: string; url?: string; arxivId?: string; paperId?: string };
type AssistantSize = { width: number; height: number };
type CloudProviderStatus = { id: string; label: string; available: boolean; connectUrl: string; detail: string };
type CloudShareRecord = { id: string; title: string; provider: string; providerLabel: string; fileName: string; location: string; connectUrl: string; paperCount: number; createdAt: string };
type PaperChatMessage = { role: 'user' | 'assistant'; text: string };
type VaultSnapshot = { papers: Paper[]; audits: Record<string, PaperAudit>; notes: Note[]; nodeNotes: Record<string, Record<string, string>>; nodeAnswers: Record<string, Record<string, string>>; expanded: Record<string, Record<string, boolean>>; marks: Record<string, Record<string, Exclude<ReadingMark, ''>>>; patches: Record<string, WorkingPatch[]>; updates: Record<string, PaperUpdateRecord[]>; auditJobs?: Record<string, AuditJob>; profile: Profile | null; links: CrossLink[]; graph: Graph; vault: { paperFolders: { paperId: string; folder: string }[] } };
type ServiceResponse = { error?: string; paper?: Paper; papers?: Paper[]; snapshot?: VaultSnapshot; graph?: Graph; links?: CrossLink[]; patches?: WorkingPatch[]; text?: string; threadId?: string; primarySource?: { kind?: string }; sourceRecord?: Record<string, unknown>; update?: PaperUpdateRecord; saved?: { relativePath?: string }; link?: CrossLink; batchLabel?: string; sources?: { from: string; to: string } };

const bridgeUrl = 'http://127.0.0.1:4318';
const preferenceKey = 'proofroom-reader-preferences-v1';
const onboardingCompleteKey = 'arxivpecker-onboarding-complete-v1';
const paperScaleKey = 'proofroom-paper-scale-v1';
const assistantSizeKey = 'arxivpecker-assistant-size-v1';
const selectedPaperKey = 'arxivpecker-selected-paper-v1';

type PaperPdfRecord = Pick<Paper, 'id' | 'arxivId'> & { source?: Paper['source'] };
function hasOriginalPaper(paper: PaperPdfRecord) { return !paper.arxivId.startsWith('local-') || Boolean(paper.source?.localPdf); }
function originalPaperUrl(paper: PaperPdfRecord, page?: number) {
  const base = paper.arxivId.startsWith('local-') ? `${bridgeUrl}/paper-pdf?paperId=${encodeURIComponent(paper.id)}` : paper.source?.pdfUrl || `https://arxiv.org/pdf/${paper.arxivId}`;
  return `${base}${page ? `#page=${page}` : ''}`;
}
const paperChatAnswerKey = '__paper_chat__';
const reasoningDefaultMigrationKey = 'proofroom-reasoning-default-xhigh-v1';
const defaultReasoning = 'xhigh';
const defaultProfile: Profile = { level: 'Graduate student', areas: ['math.AP'], goal: 'Understand proofs', model: '', reasoning: defaultReasoning };
const mathAreas = [
  ['math.AC', 'Commutative Algebra'], ['math.AG', 'Algebraic Geometry'], ['math.AP', 'Analysis of PDEs'], ['math.AT', 'Algebraic Topology'],
  ['math.CA', 'Classical Analysis and ODEs'], ['math.CO', 'Combinatorics'], ['math.CT', 'Category Theory'], ['math.CV', 'Complex Variables'],
  ['math.DG', 'Differential Geometry'], ['math.DS', 'Dynamical Systems'], ['math.FA', 'Functional Analysis'], ['math.GM', 'General Mathematics'],
  ['math.GN', 'General Topology'], ['math.GR', 'Group Theory'], ['math.GT', 'Geometric Topology'], ['math.HO', 'History and Overview'],
  ['math.IT', 'Information Theory'], ['math.KT', 'K-Theory and Homology'], ['math.LO', 'Logic'], ['math.MG', 'Metric Geometry'],
  ['math.MP', 'Mathematical Physics'], ['math.NA', 'Numerical Analysis'], ['math.NT', 'Number Theory'], ['math.OA', 'Operator Algebras'],
  ['math.OC', 'Optimization and Control'], ['math.PR', 'Probability'], ['math.QA', 'Quantum Algebra'], ['math.RA', 'Rings and Algebras'],
  ['math.RT', 'Representation Theory'], ['math.SG', 'Symplectic Geometry'], ['math.SP', 'Spectral Theory'], ['math.ST', 'Statistics Theory'],
] as const;

function normalizeReaderProfile(value: unknown): Profile {
  const stored = value && typeof value === 'object' ? value as Partial<Profile> & { area?: string } : {};
  const areas = Array.isArray(stored.areas) ? stored.areas.filter((area): area is string => typeof area === 'string' && mathAreas.some(([id]) => id === area)) : typeof stored.area === 'string' ? [stored.area] : defaultProfile.areas;
  return { ...defaultProfile, ...stored, reasoning: stored.reasoningConfigured && typeof stored.reasoning === 'string' && stored.reasoning.trim() ? stored.reasoning : defaultReasoning, areas: areas.length ? areas : defaultProfile.areas };
}

function parsePaperChat(value: string | undefined): PaperChatMessage[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PaperChatMessage => Boolean(item && typeof item === 'object' && ((item as PaperChatMessage).role === 'user' || (item as PaperChatMessage).role === 'assistant') && typeof (item as PaperChatMessage).text === 'string')).slice(-100);
  } catch { return []; }
}
const emptyGraph: Graph = { version: 1, updatedAt: null, nodes: [], edges: [] };
const fallbackDiscoveries: Paper[] = [
  { id: 'd-1', title: 'Stability estimates for degenerate elliptic equations', authors: 'E. Moreno', category: 'math.AP', arxivId: '2608.05192', abstract: 'New stability estimates that extend compactness methods to a degenerate setting.', state: 'To read', tags: ['elliptic PDE', 'stability'] },
  { id: 'd-2', title: 'Geodesic convexity in spaces of probability measures', authors: 'N. Berg · K. Ito', category: 'math.OC', arxivId: '2608.05014', abstract: 'A concise treatment of geodesic convexity and its variational consequences.', state: 'To read', tags: ['optimal transport', 'convexity'] },
];

function reportReaderProcess(update: ReaderProcessUpdate) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ReaderProcessUpdate>('proofroom:process', { detail: update }));
}

function elapsedLabel(startedAt: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const readerKatexMacros = { '\\qed': '\\square', '\\qedsymbol': '\\square', '\\qedhere': '\\square', '\\mbox': '\\text{#1}' };

function unknownMathMacroFallback(command: string) {
  const name = command.slice(1).replace(/[^A-Za-z]/g, '');
  if (!name) return '';
  const letter = name.at(-1) ?? '';
  if (/^(?:bb|Bbb)[A-Z]$/.test(name)) return `\\mathbb{${letter}}`;
  if (/^(?:cal|c)[A-Z]$/.test(name)) return `\\mathcal{${letter}}`;
  if (/^(?:bf|b)[A-Z]$/.test(name)) return `\\mathbf{${letter}}`;
  if (/^[a-z]{1,4}[A-Z]$/.test(name)) return `\\mathrm{${letter}}`;
  if (/^([A-Z])\1$/.test(name)) return `\\mathbb{${letter}}`;
  return `\\operatorname{${name}}`;
}

function renderMath(expression: string, displayMode: boolean) {
  const normalized = expression.replace(/\uE000/g, '\\text{\\$}').replace(/\\eqno\s*\{([^{}]*)\}/g, '\\tag{$1}');
  let candidate = normalized;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try { return katex.renderToString(candidate, { throwOnError: true, strict: 'ignore', displayMode, macros: readerKatexMacros }); }
    catch (error) {
      const command = /Undefined control sequence:\s*(\\[A-Za-z@]+)/.exec(error instanceof Error ? error.message : '')?.[1];
      if (!command) return null;
      candidate = candidate.split(command).join(unknownMathMacroFallback(command));
    }
  }
  return null;
}

function decodeTeXText(value: string) {
  const accents: Record<string, string> = { "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307', u: '\u0306', v: '\u030c', H: '\u030b', c: '\u0327', k: '\u0328', r: '\u030a', b: '\u0331', d: '\u0323' };
  const specials: Record<string, string> = { ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', ss: 'ß', i: 'ı', j: 'ȷ' };
  return value
    .replace(/\{\\(['`^"~=\.uvHckrbd])\s*\{?([A-Za-z])\}?\}/g, (_match, accent, letter) => `${letter}${accents[accent] ?? ''}`.normalize('NFC'))
    .replace(/\\(['`^"~=\.])\s*\{?([A-Za-z])\}?/g, (_match, accent, letter) => `${letter}${accents[accent] ?? ''}`.normalize('NFC'))
    .replace(/\\([uvHckrbd])\s*\{([A-Za-z])\}/g, (_match, accent, letter) => `${letter}${accents[accent] ?? ''}`.normalize('NFC'))
    .replace(/\{\\(ae|AE|oe|OE|aa|AA|o|O|l|L|ss|i|j)\}/g, (_match, name) => specials[name] ?? _match)
    .replace(/\\(ae|AE|oe|OE|aa|AA|o|O|l|L|ss)\b/g, (_match, name) => specials[name] ?? _match);
}

function unwrapTextColorCommands(source: string) {
  let text = source;
  for (let pass = 0; pass < 4; pass += 1) {
    let output = ''; let cursor = 0; let changed = false;
    for (const match of text.matchAll(/\\textcolor\s*\{/g)) {
      const start = match.index ?? 0;
      if (start < cursor) continue;
      const color = readTeXGroup(text, start + match[0].length - 1);
      if (!color) continue;
      let contentStart = color.end;
      while (/\s/.test(text[contentStart] || '')) contentStart += 1;
      const content = readTeXGroup(text, contentStart);
      if (!content) continue;
      const decorativeRule = /^\\rule(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*\{[^{}]*\}\s*$/.test(content.value.trim());
      output += text.slice(cursor, start) + (decorativeRule ? '' : content.value);
      cursor = content.end; changed = true;
    }
    if (!changed) break;
    text = output + text.slice(cursor);
  }
  return text;
}

function normalizeDisplayMathEnvironments(source: string) {
  return source
    .replace(/\\begin\{(equation\*?|displaymath)\}([\s\S]*?)\\end\{\1\}/g, (_match, _environment: string, body: string) => `\\[${body}\\]`)
    .replace(/\\begin\{(align\*?)\}([\s\S]*?)\\end\{\1\}/g, (_match, _environment: string, body: string) => `\\[\\begin{aligned}${body}\\end{aligned}\\]`)
    .replace(/\\begin\{(gather\*?|multline\*?|eqnarray\*?)\}([\s\S]*?)\\end\{\1\}/g, (_match, _environment: string, body: string) => `\\[\\begin{gathered}${body.replace(/&/g, '')}\\end{gathered}\\]`);
}

function cleanTeXProse(value: string) {
  return normalizeDisplayMathEnvironments(unwrapTextColorCommands(decodeTeXText(value)))
    .replace(/\$\\cite\w*\s*(?:\[([^\]]*)\])?\s*(?:\[([^\]]*)\])?\s*\{([^{}]+)\}\$/g, (_match, preNote: string | undefined, postNote: string | undefined, keys: string) => { const locator = [preNote, postNote].map((item) => item?.trim()).filter(Boolean).join('; '); return keys.split(',').map((key) => `[${key.trim()}${locator ? `, ${locator}` : ''}]`).join(' '); })
    .replace(/\\cite\w*\s*(?:\[([^\]]*)\])?\s*(?:\[([^\]]*)\])?\s*\{([^{}]+)\}/g, (_match, preNote: string | undefined, postNote: string | undefined, keys: string) => { const locator = [preNote, postNote].map((item) => item?.trim()).filter(Boolean).join('; '); return keys.split(',').map((key) => `[${key.trim()}${locator ? `, ${locator}` : ''}]`).join(' '); })
    .replace(/\\\[\s*\\(?:textbf|textit|text)\s*\{([^{}]*)\}\s*\\\]/g, '\n\n$1\n\n')
    .replace(/\\\[\s*\\\]/g, '')
    .replace(/\\begin\{thebibliography\}\{[^{}]*\}|\\end\{thebibliography\}/g, '')
    .replace(/\\begin\{(?:verbatim\*?|Verbatim|lstlisting|alltt)\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{(?:verbatim\*?|Verbatim|lstlisting|alltt)\}/g, (_match, content: string) => content.replace(/\$/g, '\uE000'))
    .replace(/\\verb\*?([^A-Za-z0-9\s])([\s\S]*?)\1/g, (_match, _delimiter, content: string) => content.replace(/\$/g, '\uE000'))
    .replace(/\\hyperref\[[^\]]*\]\{([^{}]*)\}/g, '$1')
    .replace(/\\href\{[^{}]*\}\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:url|nolinkurl|path)\{([^{}]*)\}/g, '$1')
    .replace(/\\paragraph\{([^{}]*)\}/g, '$1.')
    .replace(/\\bibitem(?:\[[^\]]*\])?\{[^{}]*\}\s*/g, '')
    .replace(/\\newblock\s*/g, ' ')
    .replace(/\{\\(?:em|it|bf)\s+([^{}]*)\}/g, '$1')
    .replace(/\\(?:emph|textit|textbf|texttt|textsc|textrm|textsf)\{([^{}]*)\}/g, '$1')
    .replace(/\\begin\{tcolorbox\}(?:\[[^\]]*\])?|\\end\{tcolorbox\}/g, '')
    .replace(/\\(?:emph|textit|textbf|texttt|textsc|textrm|textsf)\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:emph|textit|textbf|texttt|textsc|textrm|textsf)\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:em|it|bf)\b\s*/g, '')
    .replace(/\\(?:noindent|quad|qquad)\b/g, ' ')
    .replace(/\\hfil(?:l)?\b/g, '')
    .replace(/\\label\{[^{}]*\}/g, '')
    .replace(/\\(LaTeX|TeX)\b\\?/g, '$1')
    .replace(/\\\$/g, '\uE000')
    .replace(/\\([%&#_])/g, '$1');
}
function cleanBibliographicText(value: string) {
  const parts = cleanTeXProse(value).split(/(\$\$[\s\S]*?\$\$|\$[^$]*?\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g);
  return parts.map((part, index) => index % 2 ? part : part.replace(/[{}]/g, '').replace(/\uE000/g, '$')).join('');
}

function searchablePaperText(value: string) {
  return cleanTeXProse(value || '')
    .replace(/\$+/g, ' ')
    .replace(/\\(?:\(|\)|\[|\])/g, ' ')
    .replace(/\\[A-Za-z@]+\*?/g, ' ')
    .replace(/[{}_^]/g, ' ')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function cleanRenderedTextFragment(value: string) {
  // Braces group letters in TeX/BibTeX; they are not author-facing prose. Keep
  // deliberately escaped braces while removing grouping braces outside math.
  return value
    .replace(/\\\{/g, '\uE001')
    .replace(/\\\}/g, '\uE002')
    .replace(/[{}]/g, '')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/~/g, '\u00a0')
    .replace(/\uE001/g, '{')
    .replace(/\uE002/g, '}')
    .replace(/\uE000/g, '$');
}

function Latex({ value, small = false }: { value: string; small?: boolean }) {
  const expression = value || '\\text{Add a LaTeX formula}';
  const html = useMemo(() => renderMath(expression, true), [expression]);
  if (!html) return <div className={`${small ? 'text-sm' : 'text-base'} latex-source-fallback`} title="This TeX needs correction before it can be typeset.">{value}</div>;
  return <div className={`${small ? 'text-sm' : 'text-base'} overflow-x-auto text-[#284235]`} dangerouslySetInnerHTML={{ __html: html }} />;
}

const MathText = memo(function MathText({ value, block = false, citations = [], explicitOnly = false }: { value: string; block?: boolean; citations?: CitationReference[]; explicitOnly?: boolean }) {
  const parts = useMemo(() => {
    const source = cleanTeXProse(value || '');
    // Audits produced from source TeX are asked to preserve $...$ delimiters. The
    // final alternatives also recover compact TeX-like islands when an older audit
    // omitted them, keeping expressions such as χ|det|^s and L_v(χ_v,s)^{-1}
    // together instead of rendering only their superscripts.
    const pattern = explicitOnly ? /(\[\[cite:[^\]]+\]\]|\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$]+?\$|\\\([\s\S]+?\\\))/g : /(\[\[cite:[^\]]+\]\]|\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$]+?\$|\\\([\s\S]+?\\\)|\([^()$\n\[\]]{0,180}(?:\^|_|\\[A-Za-z]+|\{[^}]*\})[^()$\n\[\]]{0,180}\)|[A-Za-z0-9\u0370-\u03ff\\\[\](){}_^|+*/=<>≤≥∈×−,:-]*(?:\^|_|\\|[|≤≥∈×=])[A-Za-z0-9\u0370-\u03ff\\\[\](){}_^|+*/=<>≤≥∈×−,:-]*|(?:Re|Im|GL|SL|Sp|SO|SU|Spec|Hom|Ext|Tor|dim|ker|coker|rank|det|tr|vol|[A-Z])\([^()\s]{1,180}\)(?:(?:_|\^)(?:\{[^{}\n]{1,80}\}|[A-Za-z0-9\u0370-\u03ff+-]))*|[\u0370-\u03ff])/g;
    const result: { text: string; math: boolean; display: boolean; source?: string; citation?: { key: string; locator: string } }[] = [];
    let cursor = 0;
    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > cursor) result.push({ text: cleanRenderedTextFragment(source.slice(cursor, index)), math: false, display: false });
      const token = match[0];
      if (token.startsWith('[[cite:')) { const [key, locator = ''] = token.slice(7, -2).split('|'); result.push({ text: token, math: false, display: false, citation: { key, locator } }); cursor = index + token.length; continue; }
      const display = token.startsWith('$$') || token.startsWith('\\[');
      const expression = token.startsWith('$$') ? token.slice(2, -2) : token.startsWith('$') ? token.slice(1, -1) : token.startsWith('\\(') || token.startsWith('\\[') ? token.slice(2, -2) : token;
      const rendered = renderMath(expression, display);
      result.push(rendered ? { text: rendered, math: true, display, source: token } : { text: cleanRenderedTextFragment(token), math: false, display: false });
      cursor = index + token.length;
    }
    if (cursor < source.length) result.push({ text: cleanRenderedTextFragment(source.slice(cursor)), math: false, display: false });
    return result;
  }, [value, explicitOnly]);
  const Tag = block ? 'div' : 'span';
  return <Tag className={`math-text ${block ? 'math-text-block' : ''}`}>{parts.map((part, index) => part.citation ? <InlineCitation key={index} mention={part.citation} citations={citations} /> : part.math ? <span key={index} className={part.display ? 'math-display' : 'math-inline'} data-source={part.source} dangerouslySetInnerHTML={{ __html: part.text }} /> : <span key={index}>{part.text}</span>)}</Tag>;
});

type AITextBlock = { kind: 'paragraph' | 'heading' | 'quote' | 'bullet' | 'number' | 'code'; text: string; marker?: string };

function AIRichInline({ value, citations }: { value: string; citations: CitationReference[] }) {
  const parts = value.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).filter(Boolean);
  return <>{parts.map((part, index) => part.startsWith('**') && part.endsWith('**') ? <strong key={index}><MathText value={part.slice(2, -2)} citations={citations} /></strong> : part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : <MathText key={index} value={part} citations={citations} />)}</>;
}

function AIText({ value, citations = [] }: { value: string; citations?: CitationReference[] }) {
  const blocks = useMemo(() => {
    const result: AITextBlock[] = []; let paragraph: string[] = []; let code: string[] = []; let inCode = false;
    const flushParagraph = () => { if (paragraph.length) result.push({ kind: 'paragraph', text: paragraph.join(' ') }); paragraph = []; };
    const flushCode = () => { if (code.length) result.push({ kind: 'code', text: code.join('\n') }); code = []; };
    for (const rawLine of (value || '').replace(/\r/g, '').split('\n')) {
      const line = rawLine.trim();
      if (/^```/.test(line)) { if (inCode) flushCode(); else flushParagraph(); inCode = !inCode; continue; }
      if (inCode) { code.push(rawLine); continue; }
      if (!line) { flushParagraph(); continue; }
      const heading = line.match(/^#{1,4}\s+(.+)$/); const quote = line.match(/^>\s?(.*)$/); const bullet = line.match(/^[-*]\s+(.+)$/); const numbered = line.match(/^(\d+)[.)]\s+(.+)$/);
      if (heading) { flushParagraph(); result.push({ kind: 'heading', text: heading[1] }); }
      else if (quote) { flushParagraph(); result.push({ kind: 'quote', text: quote[1] }); }
      else if (bullet) { flushParagraph(); result.push({ kind: 'bullet', text: bullet[1], marker: '•' }); }
      else if (numbered) { flushParagraph(); result.push({ kind: 'number', text: numbered[2], marker: numbered[1] }); }
      else paragraph.push(line);
    }
    flushParagraph(); flushCode(); return result;
  }, [value]);
  return <div className="ai-rich-text">{blocks.map((block, index) => block.kind === 'heading' ? <h4 key={index}><AIRichInline value={block.text} citations={citations} /></h4> : block.kind === 'quote' ? <blockquote key={index}><AIRichInline value={block.text} citations={citations} /></blockquote> : block.kind === 'bullet' || block.kind === 'number' ? <div key={index} className="ai-rich-list-item"><span>{block.kind === 'number' ? `${block.marker}.` : block.marker}</span><p><AIRichInline value={block.text} citations={citations} /></p></div> : block.kind === 'code' ? <pre key={index}>{block.text}</pre> : <p key={index}><AIRichInline value={block.text} citations={citations} /></p>)}</div>;
}

function InlineCitation({ mention, citations }: { mention: { key: string; locator: string }; citations: CitationReference[] }) {
  const [pinned, setPinned] = useState(false); const [hovered, setHovered] = useState(false); const [copied, setCopied] = useState(false); const rootRef = useRef<HTMLSpanElement>(null); const hoverTimerRef = useRef<number | null>(null);
  useEffect(() => { if (!pinned) return; const closeOutside = (event: globalThis.MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setPinned(false); }; const closeEscape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setPinned(false); }; document.addEventListener('click', closeOutside, true); document.addEventListener('keydown', closeEscape); return () => { document.removeEventListener('click', closeOutside, true); document.removeEventListener('keydown', closeEscape); }; }, [pinned]);
  useEffect(() => () => { if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current); }, []);
  function beginHover() { if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; setHovered(true); }
  function endHover() { if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current); hoverTimerRef.current = window.setTimeout(() => { setHovered(false); hoverTimerRef.current = null; }, 360); }
  const citation = citations.find((item) => item.key === mention.key && item.locator === mention.locator) ?? citations.find((item) => item.key === mention.key);
  const locator = mention.locator || citation?.locator || '';
  const specificResult = /\b(theorem|lemma|proposition|corollary|definition|claim|result|thm\.?|lem\.?|prop\.?)\b/i.test(locator);
  const preview = specificResult && citation?.statement ? citation.statement : citationTitle(citation, mention.key);
  const sourceLabel = `[${citationAlphaLabel(citation, mention.key)}${locator ? `, ${locator}` : ''}]`;
  const copyText = [sourceLabel, citation?.authors, citationTitle(citation, mention.key), specificResult ? preview : '', citation?.url].filter(Boolean).map((item) => cleanBibliographicText(String(item))).join('\n');
  async function copyCitation(event: ReactMouseEvent) { event.stopPropagation(); await navigator.clipboard.writeText(copyText); setCopied(true); window.setTimeout(() => setCopied(false), 1200); }
  return <span ref={rootRef} className={`inline-citation ${pinned ? 'citation-pinned' : ''} ${hovered ? 'citation-hover-active' : ''}`} data-source={sourceLabel} tabIndex={0} onMouseEnter={beginHover} onMouseLeave={endHover} onClick={(event) => { event.stopPropagation(); setPinned(true); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setPinned(true); } }}>{sourceLabel}<span className="citation-hover-card" role={pinned ? 'dialog' : 'tooltip'} aria-label={`Citation ${sourceLabel}`} onMouseEnter={beginHover} onMouseLeave={endHover}><span className="citation-hover-head"><b>{specificResult ? locator : 'Cited paper'}</b>{pinned && <button onClick={(event) => { event.stopPropagation(); setPinned(false); }} aria-label="Close citation preview">×</button>}</span><span className="citation-copyable"><MathText value={preview} /></span>{citation?.authors && <em className="citation-hover-authors">{cleanBibliographicText(citation.authors)}</em>}{pinned && <span className="citation-hover-actions"><button onClick={(event) => void copyCitation(event)}>{copied ? 'Copied' : 'Copy citation'}</button></span>}</span></span>;
}

function citationTitle(citation: CitationReference | undefined, key: string) {
  return cleanBibliographicText(citation?.title && citation.title !== key ? citation.title : `Cited source [${citationAlphaLabel(citation, key)}]`);
}

function citationAlphaLabel(citation: CitationReference | undefined, key: string) {
  const authorText = citation?.authors || '';
  const people = authorText.split(/\s+(?:and|·)\s+/i).map((person) => person.trim()).filter(Boolean);
  const surnames = people.map((person) => {
    const commaName = person.split(',')[0]?.trim() || '';
    const naturalName = person.replace(/[{}]/g, '').split(/\s+/).filter((part) => !/^[A-ZÀ-ÖØ-Þ](?:\.?-[A-ZÀ-ÖØ-Þ])?\.?$/i.test(part)).at(-1) || '';
    return (person.includes(',') ? commaName : naturalName).replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, '');
  }).filter(Boolean);
  const year = /\b(?:19|20)(\d{2})\b/.exec(`${citation?.text || ''} ${key}`)?.[1] || '';
  if (surnames.length === 1) return `${surnames[0].slice(0, 3)}${year}`;
  if (surnames.length > 1) return `${surnames.slice(0, 3).map((name) => name[0]?.toUpperCase()).join('')}${surnames.length > 3 ? '+' : ''}${year}`;
  const beforeYear = key.split(/(?:19|20)\d{2}/)[0];
  const words = beforeYear.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g)?.filter(Boolean) ?? [];
  if (words.length > 1) return `${words.slice(0, 3).map((word) => word[0]?.toUpperCase()).join('')}${words.length > 3 ? '+' : ''}${year}`;
  const stem = (words[0] || beforeYear).replace(/[^A-Za-z]/g, '');
  return `${stem ? `${stem[0]?.toUpperCase()}${stem.slice(1, 3).toLowerCase()}` : 'Ref'}${year}`;
}

function readString(value: unknown, fallback = '') { return typeof value === 'string' ? value : fallback; }
function asArray(value: unknown) { return Array.isArray(value) ? value : []; }
async function readServiceResponse(response: Response): Promise<ServiceResponse> {
  let text = '';
  try { text = await response.text(); }
  catch { return { error: `The service response could not be read (HTTP ${response.status}).` }; }
  if (!text.trim()) return { error: `The service returned an empty response (HTTP ${response.status}).` };
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ServiceResponse : { error: `The service returned an invalid response (HTTP ${response.status}).` };
  } catch {
    return { error: `The service returned an invalid response (HTTP ${response.status}).` };
  }
}
function readCitation(value: unknown): CitationReference {
  const entry = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const title = cleanBibliographicText(readString(entry.title, readString(entry.key, 'Cited source')));
  const searchUrl = readString(entry.searchUrl, `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`);
  return { key: readString(entry.key), locator: cleanBibliographicText(readString(entry.locator)), statement: readString(entry.statement), definitions: asArray(entry.definitions).map((item) => { const definition = item as Record<string, unknown>; return { notation: readString(definition.notation), definition: readString(definition.definition), source: cleanBibliographicText(readString(definition.source)) }; }).filter((item) => item.notation && item.definition), title, authors: cleanBibliographicText(readString(entry.authors)), text: cleanBibliographicText(readString(entry.text, title)), url: readString(entry.url, searchUrl), searchUrl, doi: readString(entry.doi), arxivId: readString(entry.arxivId), direct: Boolean(entry.direct) };
}
function parseAudit(rawText: string, threadId: string): PaperAudit {
  const clean = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = clean.indexOf('{'); const last = clean.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('Codex returned no structured audit. Try again.');
  const data = JSON.parse(clean.slice(first, last + 1)) as Record<string, unknown>;
  const auditData = data.audit as Record<string, unknown> | undefined;
  if (!auditData || !Array.isArray(data.nodes)) throw new Error('Codex returned an incomplete audit. Try again.');
  const kinds = new Set<NodeKind>(['definition', 'assumption', 'notation', 'lemma', 'proposition', 'theorem', 'corollary', 'conjecture', 'proof', 'equation', 'remark', 'example', 'section', 'table', 'external-result']);
  const statuses = new Set<AuditNode['status']>(['verified', 'needs-verification', 'unavailable']);
  const sourceStatus = new Set<PaperAudit['audit']['sourceStatus']>(['full-text-read', 'partial-text-read', 'blocked']);
  const confidence = new Set<Anchor['confidence']>(['verified', 'approximate', 'unverified']);
  return {
    threadId,
    generatedAt: new Date().toISOString(),
    rawText,
    audit: {
      sourceStatus: sourceStatus.has(auditData.sourceStatus as PaperAudit['audit']['sourceStatus']) ? auditData.sourceStatus as PaperAudit['audit']['sourceStatus'] : 'partial-text-read',
      sourceSummary: readString(auditData.sourceSummary, 'No source summary returned.'),
      centralQuestion: readString(auditData.centralQuestion, 'Not established.'),
      mainContribution: readString(auditData.mainContribution, 'Not established.'),
      verificationWarnings: asArray(auditData.verificationWarnings).map(String),
    },
    nodes: data.nodes.map((item, index): AuditNode => {
      const entry = item as Record<string, unknown>; const anchor = entry.anchor as Record<string, unknown> | undefined;
      return { id: readString(entry.id, `unit-${index + 1}`), kind: kinds.has(entry.kind as NodeKind) ? entry.kind as NodeKind : 'section', displayName: readString(entry.displayName) || undefined, label: readString(entry.label, `Unit ${index + 1}`), title: readString(entry.title, readString(entry.label, `Unit ${index + 1}`)), statement: readString(entry.statement), proofText: readString(entry.proofText), citations: asArray(entry.citations).map(readCitation), status: statuses.has(entry.status as AuditNode['status']) ? entry.status as AuditNode['status'] : 'needs-verification', anchor: { label: readString(anchor?.label, 'Source location unavailable'), page: typeof anchor?.page === 'number' ? anchor.page : null, confidence: confidence.has(anchor?.confidence as Anchor['confidence']) ? anchor?.confidence as Anchor['confidence'] : 'unverified' }, role: readString(entry.role), dependencies: asArray(entry.dependencies).map(String), proofSketch: asArray(entry.proofSketch).map(String), whyItMatters: readString(entry.whyItMatters), expandable: Boolean(entry.expandable) };
    }),
    sourceBlocks: asArray(data.sourceBlocks).map((item, index): SourceBlock => { const block = item as Record<string, unknown>; const kind = readString(block.kind) as SourceBlockKind; return { id: readString(block.id, `source-block-${index + 1}`), kind: ['section', 'paragraph', 'result', 'proof', 'figure', 'table', 'bibliography'].includes(kind) ? kind : 'paragraph', level: typeof block.level === 'number' ? block.level : 4, title: readString(block.title), content: readString(block.content), proofText: readString(block.proofText), nodeId: readString(block.nodeId), resultKind: readString(block.resultKind), citations: asArray(block.citations).map(readCitation), assetPaths: asArray(block.assetPaths).map(String), caption: readString(block.caption) }; }),
    readingPaths: asArray(data.readingPaths).map((item) => { const path = item as Record<string, unknown>; return { goal: readString(path.goal, 'Reading path'), nodeIds: asArray(path.nodeIds).map(String), reason: readString(path.reason) }; }),
    crossPaperLinks: asArray(data.crossPaperLinks).map((item) => { const link = item as Record<string, unknown>; const relation = ['uses', 'extends', 'background', 'contrasts'].includes(readString(link.relation)) ? readString(link.relation) as CrossLink['relation'] : 'uses'; return { fromNodeId: readString(link.fromNodeId), targetPaperId: readString(link.targetPaperId), targetNodeId: readString(link.targetNodeId), relation, rationale: readString(link.rationale) }; }).filter((link) => link.fromNodeId && link.targetPaperId && link.targetNodeId),
    openQuestions: asArray(data.openQuestions).map(String),
    editorialCorrections: asArray(data.editorialCorrections).map((item) => { const correction = item as Record<string, unknown>; const field = correction.field === 'proofText' ? 'proofText' as const : 'statement' as const; const confidenceValue = readString(correction.confidence); const correctionConfidence: EditorialSuggestion['confidence'] = confidenceValue === 'high' || confidenceValue === 'medium' ? confidenceValue : 'low'; return { nodeId: readString(correction.nodeId), field, original: readString(correction.original), replacement: readString(correction.replacement), rationale: readString(correction.rationale), confidence: correctionConfidence }; }).filter((correction) => correction.nodeId && correction.replacement),
  };
}
function normalizeAuditCitations(audit: PaperAudit): PaperAudit {
  return { ...audit, nodes: (audit.nodes ?? []).map((node) => ({ ...node, citations: (node.citations ?? []).map(readCitation) })), sourceBlocks: (audit.sourceBlocks ?? []).map((block) => ({ ...block, citations: (block.citations ?? []).map(readCitation) })) };
}

function kindClass(kind: NodeKind) { if (kind === 'theorem' || kind === 'corollary') return 'bg-[#295e49] text-white'; if (kind === 'lemma' || kind === 'proposition' || kind === 'conjecture') return 'bg-[#dceee1] text-[#286448]'; if (kind === 'definition' || kind === 'notation' || kind === 'assumption') return 'bg-[#e5edf7] text-[#3c6390]'; return 'bg-[#f4eee7] text-[#816552]'; }
function displayUnitLabel(unit: { kind: NodeKind; label?: string; title?: string; displayName?: string }) {
  if (unit.displayName) { const number = /\b(?:\d+(?:\.\d+)*|[IVX]+(?:\.[IVX]+)*)\b/i.exec(unit.label || '')?.[0]; return number ? `${unit.displayName} ${number}` : unit.displayName; }
  const printed = /^(Theorem|Lemma|Proposition|Corollary|Conjecture|Definition|Remark|Example|Equation|Section)s?\s+[\dIVX]+(?:\.[\dIVX]+)*/i;
  const explicit = unit.label?.match(printed)?.[0];
  if (explicit) return explicit;
  const fromTitle = unit.title?.match(printed)?.[0];
  if (fromTitle) return fromTitle;
  if (unit.kind === 'external-result') return 'External result';
  if (unit.kind === 'paragraph') return 'Paragraph';
  if (unit.kind === 'figure') return 'Figure';
  if (unit.kind === 'table') return 'Table';
  return unit.kind[0].toUpperCase() + unit.kind.slice(1);
}
function unitId(paperId: string, nodeId: string) { return `${paperId}::${nodeId}`; }
function makeId() { return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `patch-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function arxivBaseId(value: string) { return value.replace(/^arXiv:/i, '').replace(/v\d+$/i, ''); }
function paperSourceLabel(paper: Paper) { return paper.arxivId.startsWith('local-') ? 'Local source' : `arXiv:${paper.arxivId}`; }
function arxivVersionNumber(value: string) { return Number(/v(\d+)$/i.exec(value)?.[1] ?? 0); }
function fileAsBase64(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('The reference file could not be read.')); reader.onload = () => resolve(String(reader.result || '').split(',')[1] || ''); reader.readAsDataURL(file); }); }
function parseJsonObject(rawText: string) {
  const clean = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = clean.indexOf('{'); const last = clean.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('Codex returned no structured suggestion.');
  return JSON.parse(clean.slice(first, last + 1)) as Record<string, unknown>;
}
function patchForNode(patches: WorkingPatch[], nodeId: string) {
  if (nodeId.startsWith('working-')) return patches.find((patch) => patch.kind === 'add' && `working-${patch.id}` === nodeId);
  return patches.findLast((patch) => patch.kind === 'replace' && patch.nodeId === nodeId);
}
function sourceBlockUnitId(block: SourceBlock) { return `source-block:${block.id}`; }
function originalSourceBlockValue(block: SourceBlock) { return block.kind === 'section' ? block.title : block.kind === 'figure' ? block.caption : block.kind === 'proof' ? block.proofText : block.content; }
function sourceBlockValue(block: SourceBlock, patches: WorkingPatch[]) {
  const patch = patchForNode(patches, sourceBlockUnitId(block));
  const original = originalSourceBlockValue(block);
  return patch?.kind === 'replace' ? patch.statement : original;
}
function sourceBlockAsNode(block: SourceBlock, patches: WorkingPatch[]): AuditNode {
  const value = sourceBlockValue(block, patches);
  const kind: NodeKind = block.kind === 'section' ? 'section' : block.kind === 'figure' ? 'figure' : block.kind === 'table' ? 'table' : 'paragraph';
  return { id: sourceBlockUnitId(block), kind, label: kind === 'section' ? value : '', title: kind === 'section' ? value : kind === 'figure' ? value || 'Paper figure' : kind === 'table' ? block.caption || 'Paper table' : 'Author text', statement: value, proofText: '', citations: block.citations ?? [], status: 'verified', anchor: { label: kind === 'section' ? value : kind === 'table' ? 'Author table' : 'Author text', page: null, confidence: 'verified' }, role: kind === 'section' ? 'Section heading and the text that follows it.' : kind === 'figure' ? 'An original figure and its caption.' : kind === 'table' ? 'An original table from the paper.' : 'A paragraph of the original author text.', dependencies: [], proofSketch: [], whyItMatters: '', expandable: false };
}

function parseVersionComparison(rawText: string): VersionComparison {
  const parsed = parseJsonObject(rawText);
  const changeTypes = new Set<VersionChange['changeType']>(['added', 'removed', 'strengthened', 'weakened', 'corrected', 'reorganized', 'wording']);
  const significances = new Set<VersionChange['significance']>(['mathematical', 'proof-level', 'expository', 'uncertain']);
  return {
    summary: readString(parsed.summary),
    changedUnits: asArray(parsed.changedUnits).map((item): VersionChange => { const change = item as Record<string, unknown>; return { label: readString(change.label, 'Changed unit'), changeType: changeTypes.has(change.changeType as VersionChange['changeType']) ? change.changeType as VersionChange['changeType'] : 'wording', before: readString(change.before), after: readString(change.after), significance: significances.has(change.significance as VersionChange['significance']) ? change.significance as VersionChange['significance'] : 'uncertain', dependencyImpact: readString(change.dependencyImpact) }; }),
    proofChanges: asArray(parsed.proofChanges).map(String), notationChanges: asArray(parsed.notationChanges).map(String), editorialChanges: asArray(parsed.editorialChanges).map(String), dependencyImpact: asArray(parsed.dependencyImpact).map(String), readingRecommendation: readString(parsed.readingRecommendation), warnings: asArray(parsed.warnings).map(String),
  };
}

function updateMatchText(value: string) {
  return cleanTeXProse(value || '').toLowerCase().replace(/\\[a-z]+/g, ' ').replace(/[^a-z0-9\u00c0-\u024f\u0370-\u03ff]+/g, ' ').trim();
}
function updateSimilarity(left: string, right: string) {
  const a = new Set(updateMatchText(left).split(/\s+/).filter((token) => token.length > 1)); const b = new Set(updateMatchText(right).split(/\s+/).filter((token) => token.length > 1));
  if (!a.size && !b.size) return 1; if (!a.size || !b.size) return 0;
  let shared = 0; for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}
function updateNodeText(node: AuditNode) { return [node.label, node.title, node.statement, node.proofText.slice(0, 1200)].filter(Boolean).join(' '); }
function updateBlockText(block: SourceBlock) { return [block.title, block.caption, block.content, block.proofText].filter(Boolean).join(' '); }

function buildUpdateUnitMap(previous: PaperAudit, next: PaperAudit) {
  const nodeMap: Record<string, string> = {}; const usedNodes = new Set<string>();
  previous.nodes.forEach((oldNode, oldIndex) => {
    const candidates = next.nodes.map((newNode, newIndex) => {
      if (oldNode.kind !== newNode.kind) return { node: newNode, score: -1 };
      const oldLabel = updateMatchText(oldNode.label); const newLabel = updateMatchText(newNode.label); const oldTitle = updateMatchText(oldNode.title); const newTitle = updateMatchText(newNode.title);
      const labelScore = oldLabel && oldLabel === newLabel ? 0.46 : 0; const titleScore = oldTitle && oldTitle === newTitle ? 0.24 : 0;
      const textScore = updateSimilarity(updateNodeText(oldNode), updateNodeText(newNode)) * 0.55; const positionScore = Math.max(0, 0.08 - Math.abs(oldIndex / Math.max(1, previous.nodes.length) - newIndex / Math.max(1, next.nodes.length)) * 0.08);
      return { node: newNode, score: labelScore + titleScore + textScore + positionScore };
    }).filter((item) => !usedNodes.has(item.node.id)).sort((left, right) => right.score - left.score);
    if (candidates[0] && candidates[0].score >= 0.38) { nodeMap[oldNode.id] = candidates[0].node.id; usedNodes.add(candidates[0].node.id); }
  });
  const blockMap: Record<string, string> = {}; const usedBlocks = new Set<string>();
  previous.sourceBlocks.forEach((oldBlock, oldIndex) => {
    let candidates = next.sourceBlocks.filter((block) => block.kind === oldBlock.kind && !usedBlocks.has(block.id));
    if ((oldBlock.kind === 'result' || oldBlock.kind === 'proof') && oldBlock.nodeId && nodeMap[oldBlock.nodeId]) candidates = candidates.filter((block) => block.nodeId === nodeMap[oldBlock.nodeId]);
    const ranked = candidates.map((newBlock, newIndex) => {
      const exactTitle = updateMatchText(oldBlock.title || oldBlock.caption) && updateMatchText(oldBlock.title || oldBlock.caption) === updateMatchText(newBlock.title || newBlock.caption) ? 0.5 : 0;
      const textScore = updateSimilarity(updateBlockText(oldBlock), updateBlockText(newBlock)) * 0.65; const positionScore = Math.max(0, 0.08 - Math.abs(oldIndex / Math.max(1, previous.sourceBlocks.length) - newIndex / Math.max(1, next.sourceBlocks.length)) * 0.08);
      return { block: newBlock, score: exactTitle + textScore + positionScore };
    }).sort((left, right) => right.score - left.score);
    const threshold = oldBlock.kind === 'result' || oldBlock.kind === 'proof' ? 0.18 : oldBlock.kind === 'paragraph' ? 0.48 : 0.34;
    if (ranked[0] && ranked[0].score >= threshold) { blockMap[oldBlock.id] = ranked[0].block.id; usedBlocks.add(ranked[0].block.id); }
  });
  const unitMap = { ...nodeMap }; for (const [from, to] of Object.entries(blockMap)) unitMap[sourceBlockUnitId(previous.sourceBlocks.find((block) => block.id === from)!)] = sourceBlockUnitId(next.sourceBlocks.find((block) => block.id === to)!);
  return { nodeMap, blockMap, unitMap };
}

function mergeUpdatedField(original: string, edited: string, latest: string) {
  if (edited === original) return { value: latest, conflict: false }; if (latest === original) return { value: edited, conflict: false };
  let prefix = 0; while (prefix < original.length && prefix < edited.length && original[prefix] === edited[prefix]) prefix += 1;
  let suffix = 0; while (suffix < original.length - prefix && suffix < edited.length - prefix && original[original.length - 1 - suffix] === edited[edited.length - 1 - suffix]) suffix += 1;
  const removed = original.slice(prefix, original.length - suffix); const inserted = edited.slice(prefix, edited.length - suffix);
  if (removed && latest.split(removed).length === 2) return { value: latest.replace(removed, inserted), conflict: false };
  if (!removed && prefix <= latest.length && latest.slice(Math.max(0, prefix - 20), prefix) === original.slice(Math.max(0, prefix - 20), prefix)) return { value: `${latest.slice(0, prefix)}${inserted}${latest.slice(prefix)}`, conflict: false };
  return { value: latest, conflict: true };
}

function unitBaseline(audit: PaperAudit, id: string) {
  const node = audit.nodes.find((item) => item.id === id); if (node) return { title: node.title, statement: node.statement, proofText: node.proofText, nodeKind: node.kind };
  const block = audit.sourceBlocks.find((item) => sourceBlockUnitId(item) === id); if (!block) return null;
  return { title: block.title, statement: originalSourceBlockValue(block), proofText: '', nodeKind: block.kind === 'section' ? 'section' as const : block.kind === 'figure' ? 'figure' as const : block.kind === 'table' ? 'table' as const : 'paragraph' as const };
}

function migrateReaderWork({ paper, previous, next, notes, nodeNotes, nodeAnswers, expanded, marks, patches }: { paper: Paper; previous: PaperAudit; next: PaperAudit; notes: Note[]; nodeNotes: Record<string, string>; nodeAnswers: Record<string, string>; expanded: Record<string, boolean>; marks: Record<string, Exclude<ReadingMark, ''>>; patches: WorkingPatch[] }) {
  const maps = buildUpdateUnitMap(previous, next); const items: UpdateMigrationItem[] = []; const conflicts: UpdateMigrationItem[] = [];
  const migratedNotes: Note[] = []; let notesCarried = 0; let notesToPaper = 0;
  for (const note of notes) {
    if (note.nodeId === '__paper__') { migratedNotes.push(note); notesCarried += 1; continue; }
    const target = maps.unitMap[note.nodeId];
    if (target) { migratedNotes.push({ ...note, nodeId: target }); notesCarried += 1; items.push({ type: 'note', label: note.anchor || 'Reader note', status: 'carried', detail: 'Reattached to the matching unit in the latest version.', fromId: note.nodeId, toId: target }); }
    else { const preserved = { ...note, id: makeId(), nodeId: '__paper__', anchor: `From ${paper.arxivId} · ${note.anchor}`, text: `Previous-version note (${note.anchor}):\n\n${note.text}` }; migratedNotes.push(preserved); notesToPaper += 1; const item = { type: 'note' as const, label: note.anchor || 'Reader note', status: 'paper-note' as const, detail: 'The original anchor changed, so this was preserved as a paper-level note.', fromId: note.nodeId, toId: '__paper__' }; items.push(item); conflicts.push(item); }
  }
  const migratedNodeNotes: Record<string, string> = {}; for (const [id, value] of Object.entries(nodeNotes)) { const target = maps.unitMap[id]; if (target) migratedNodeNotes[target] = value; else if (value.trim()) { migratedNotes.push({ id: makeId(), paperId: paper.id, nodeId: '__paper__', anchor: `From ${paper.arxivId}`, text: `Previous-version note:\n\n${value}`, latex: '', createdAt: new Date().toISOString() }); notesToPaper += 1; } }
  // AI answers belong to the old audit thread. They remain in the archived
  // snapshot but are not shown as if they had been checked against new text.
  const migratedAnswers: Record<string, string> = nodeAnswers[paperChatAnswerKey] ? { [paperChatAnswerKey]: nodeAnswers[paperChatAnswerKey] } : {};
  const migratedExpanded: Record<string, boolean> = {}; for (const [id, value] of Object.entries(expanded)) { const target = maps.unitMap[id]; if (target) migratedExpanded[target] = value; }
  const migratedMarks: Record<string, Exclude<ReadingMark, ''>> = {}; let marksCarried = 0; for (const [id, value] of Object.entries(marks)) { const target = maps.blockMap[id] ?? maps.unitMap[id]; if (target) { migratedMarks[target] = value; marksCarried += 1; items.push({ type: 'mark', label: 'Reading mark', status: 'carried', detail: 'Moved to the matching environment.', fromId: id, toId: target }); } }
  const migratedPatches: WorkingPatch[] = []; let editsCarried = 0; let editsReview = 0;
  for (const patch of patches.filter((item) => item.source === 'manual')) {
    if (patch.kind === 'add') { const afterNodeId = maps.unitMap[patch.afterNodeId] ?? next.nodes.at(-1)?.id ?? ''; migratedPatches.push({ ...patch, afterNodeId }); editsCarried += 1; items.push({ type: 'edit', label: patch.title || 'Reader addition', status: 'carried', detail: 'Reader-added content was retained in the working edition.', fromId: patch.afterNodeId, toId: afterNodeId }); continue; }
    const targetId = maps.unitMap[patch.nodeId]; const oldBase = unitBaseline(previous, patch.nodeId); const newBase = targetId ? unitBaseline(next, targetId) : null;
    if (!targetId || !oldBase || !newBase) { editsReview += 1; const item = { type: 'edit' as const, label: patch.title || 'Working edit', status: 'review' as const, detail: 'The edited source unit has no safe match in the latest version. The edit remains in the archived version for review.', fromId: patch.nodeId, toId: '' }; items.push(item); conflicts.push(item); continue; }
    if (patch.kind === 'delete') { migratedPatches.push({ ...patch, nodeId: targetId }); editsCarried += 1; items.push({ type: 'edit', label: patch.title || 'Deleted unit', status: 'carried', detail: 'The reader deletion was applied to the matching latest-version unit.', fromId: patch.nodeId, toId: targetId }); continue; }
    const title = mergeUpdatedField(oldBase.title, patch.title, newBase.title); const statement = mergeUpdatedField(oldBase.statement, patch.statement, newBase.statement); const proofText = mergeUpdatedField(oldBase.proofText, patch.proofText, newBase.proofText);
    if (title.conflict || statement.conflict || proofText.conflict) { editsReview += 1; const item = { type: 'edit' as const, label: patch.title || 'Working edit', status: 'review' as const, detail: 'Both the author and reader changed the same text. The new author text is kept; the archived edit is flagged for review.', fromId: patch.nodeId, toId: targetId }; items.push(item); conflicts.push(item); continue; }
    migratedPatches.push({ ...patch, nodeId: targetId, title: title.value, statement: statement.value, proofText: proofText.value }); editsCarried += 1; items.push({ type: 'edit', label: patch.title || 'Working edit', status: 'carried', detail: 'Merged onto the latest author text with a three-way source comparison.', fromId: patch.nodeId, toId: targetId });
  }
  return { maps, reader: { notes: migratedNotes, nodeNotes: migratedNodeNotes, nodeAnswers: migratedAnswers, expanded: migratedExpanded, marks: migratedMarks }, patches: migratedPatches, migration: { notesCarried, notesToPaper, marksCarried, editsCarried, editsReview, items, conflicts } };
}

function automaticEditorialPatches(audit: PaperAudit, existing: WorkingPatch[]) {
  const manualReplacements = new Set(existing.filter((patch) => patch.kind === 'replace' && patch.source === 'manual').map((patch) => patch.nodeId)); const automatic = new Map<string, WorkingPatch>();
  for (const correction of audit.editorialCorrections ?? []) {
    const sourceNode = audit.nodes.find((item) => item.id === correction.nodeId); if (!sourceNode || correction.confidence !== 'high' || !correction.replacement.trim()) continue;
    const directBlock = audit.sourceBlocks.find((block) => block.nodeId === sourceNode.id && (correction.field !== 'proofText' || block.kind === 'proof'));
    const originalNeedles = [correction.original.trim(), correction.field === 'proofText' ? sourceNode.proofText.trim() : sourceNode.statement.trim()].filter(Boolean);
    const embeddedBlock = directBlock ? undefined : audit.sourceBlocks.find((block) => { const value = originalSourceBlockValue(block); return originalNeedles.some((needle) => value.includes(needle)); });
    if (embeddedBlock) {
      const targetId = sourceBlockUnitId(embeddedBlock); if (manualReplacements.has(targetId)) continue;
      const original = originalSourceBlockValue(embeddedBlock); const current = automatic.get(targetId) ?? { id: makeId(), kind: 'replace' as const, nodeId: targetId, title: embeddedBlock.title || sourceNode.title, statement: original, proofText: '', nodeKind: embeddedBlock.kind === 'section' ? 'section' as const : embeddedBlock.kind === 'figure' ? 'figure' as const : embeddedBlock.kind === 'table' ? 'table' as const : 'paragraph' as const, afterNodeId: '', rationale: '', dependencies: [], proofSketch: [], source: 'ai' as const, createdAt: new Date().toISOString() };
      const needle = originalNeedles.find((candidate) => current.statement.includes(candidate)); if (!needle) continue;
      current.statement = current.statement.replace(needle, correction.replacement.trim()); current.rationale = [current.rationale, correction.rationale].filter(Boolean).join(' '); automatic.set(targetId, current); continue;
    }
    if (manualReplacements.has(sourceNode.id)) continue;
    const current = automatic.get(sourceNode.id) ?? { id: makeId(), kind: 'replace' as const, nodeId: sourceNode.id, title: sourceNode.title, statement: sourceNode.statement, proofText: sourceNode.proofText, nodeKind: sourceNode.kind, afterNodeId: '', rationale: '', dependencies: sourceNode.dependencies, proofSketch: sourceNode.proofSketch, source: 'ai' as const, createdAt: new Date().toISOString() };
    current[correction.field] = correction.replacement.trim(); current.rationale = [current.rationale, correction.rationale].filter(Boolean).join(' '); automatic.set(sourceNode.id, current);
  }
  return [...automatic.values()];
}

function resolveSourceBlockIndex(requestedId: string, requestedNode: AuditNode | undefined, sourceBlocks: SourceBlock[], patches: WorkingPatch[]) {
  const normalize = (value: string) => value.toLowerCase().replace(/\\[a-z]+/gi, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const stopWords = new Set(['about', 'after', 'again', 'against', 'being', 'between', 'could', 'every', 'first', 'from', 'have', 'into', 'other', 'paper', 'result', 'section', 'their', 'theorem', 'these', 'this', 'using', 'where', 'which', 'with']);
  let targetIndex = sourceBlocks.findIndex((block) => block.nodeId === requestedId || sourceBlockAsNode(block, patches).id === requestedId);
  if (targetIndex >= 0 || !requestedNode) return targetIndex;
  const requestedTitle = normalize(requestedNode.title);
  targetIndex = sourceBlocks.findIndex((block) => block.kind === 'section' && requestedTitle && normalize(block.title) === requestedTitle);
  if (targetIndex >= 0) return targetIndex;
  const sectionMatch = requestedNode.anchor.label.match(/^Section\s+(\d+)(?:\.(\d+))?/i);
  if (sectionMatch) {
    const major = Number(sectionMatch[1]); const minor = Number(sectionMatch[2] || 0);
    const majorSections = sourceBlocks.map((block, index) => ({ block, index })).filter(({ block }) => block.kind === 'section' && block.level === 1);
    const majorSection = majorSections[major - 1];
    if (majorSection) {
      if (!minor) return majorSection.index;
      const majorEnd = majorSections[major]?.index ?? sourceBlocks.length;
      const subsections = sourceBlocks.map((block, index) => ({ block, index })).filter(({ block, index }) => index > majorSection.index && index < majorEnd && block.kind === 'section' && block.level === 2);
      return subsections[minor - 1]?.index ?? majorSection.index;
    }
  }
  const queryTokens = new Set(normalize(`${requestedNode.title} ${requestedNode.statement}`).split(' ').filter((word) => word.length >= 4 && !stopWords.has(word)));
  let best = { index: -1, score: 0 };
  sourceBlocks.forEach((block, index) => {
    const candidate = new Set(normalize(`${block.title} ${block.content} ${block.proofText}`).split(' '));
    const score = [...queryTokens].reduce((sum, word) => sum + (candidate.has(word) ? 1 : 0), 0);
    if (score > best.score) best = { index, score };
  });
  return best.score >= 2 ? best.index : -1;
}
function applyWorkingPatches(nodes: AuditNode[], patches: WorkingPatch[]) {
  const deleted = new Set(patches.filter((patch) => patch.kind === 'delete').map((patch) => patch.nodeId));
  const replacements = new Map(patches.filter((patch) => patch.kind === 'replace').map((patch) => [patch.nodeId, patch]));
  const result: AuditNode[] = [];
  for (const node of nodes) {
    if (!deleted.has(node.id)) {
      const replacement = replacements.get(node.id);
      result.push(replacement ? { ...node, kind: replacement.nodeKind || node.kind, title: replacement.title || node.title, statement: replacement.statement || node.statement, proofText: replacement.proofText || node.proofText, dependencies: replacement.dependencies.length ? replacement.dependencies : node.dependencies, proofSketch: replacement.proofSketch.length ? replacement.proofSketch : node.proofSketch, status: 'needs-verification', anchor: { ...node.anchor, confidence: 'approximate' } } : node);
    }
    for (const patch of patches.filter((item) => item.kind === 'add' && item.afterNodeId === node.id)) {
      result.push({ id: `working-${patch.id}`, kind: patch.nodeKind || 'proposition', label: 'Working edition', title: patch.title, statement: patch.statement, proofText: patch.proofText, citations: [], status: 'needs-verification', anchor: { label: 'Working edition — reader addition', page: null, confidence: 'unverified' }, role: patch.rationale || 'Reader-added proposition', dependencies: patch.dependencies, proofSketch: patch.proofSketch, whyItMatters: 'This unit was added in the working edition and is not part of the original source.', expandable: true });
    }
  }
  return result;
}

function dependencyFocus(nodes: AuditNode[], targetId: string) {
  const byId = new Map(nodes.map((node) => [node.id, node])); const visible = new Set<string>();
  function visit(id: string) { if (!id || visible.has(id)) return; visible.add(id); for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency); }
  visit(targetId);
  return nodes.filter((node) => visible.has(node.id)).map((node) => node.id);
}

type ExportSelection = { abstract: boolean; prose: boolean; statements: boolean; proofs: boolean; figures: boolean; citations: boolean; audit: boolean; notes: boolean; focusedOnly: boolean };

function buildPaperExport(paper: Paper, audit: PaperAudit, nodes: AuditNode[], patches: WorkingPatch[], readerNotes: Record<string, string>, notes: Note[], selection: ExportSelection, focusIds: string[]) {
  const visible = new Set(selection.focusedOnly && focusIds.length ? focusIds : nodes.map((node) => node.id)); const byId = new Map(nodes.map((node) => [node.id, node])); const lines = [`# ${paper.title}`, '', paper.authors, '', paperSourceLabel(paper), '']; const references = new Map<string, CitationReference>();
  const addCitations = (citations: CitationReference[] = []) => { for (const citation of citations) references.set(`${citation.key}:${citation.locator}`, citation); };
  if (selection.abstract) lines.push('## Abstract', '', paper.abstract, '');
  for (const block of audit.sourceBlocks ?? []) {
    const workingValue = sourceBlockValue(block, patches);
    if (block.kind === 'section' && selection.prose) lines.push(`${'#'.repeat(Math.min(6, block.level + 2))} ${workingValue}`, '');
    if (block.kind === 'paragraph' && selection.prose) { lines.push(workingValue, ''); addCitations(block.citations); }
    if (block.kind === 'table' && selection.prose) { lines.push(workingValue, ''); if (block.caption) lines.push(`*${block.caption}*`, ''); addCitations(block.citations); }
    if (block.kind === 'figure' && selection.figures) { for (const asset of block.assetPaths) lines.push(`![${workingValue || 'Original figure'}](../attachments/source/${asset})`, ''); if (workingValue) lines.push(`*${workingValue}*`, ''); addCitations(block.citations); }
    if ((block.kind === 'result' || block.kind === 'proof') && block.nodeId && !visible.has(block.nodeId)) continue;
    const node = block.nodeId ? byId.get(block.nodeId) : undefined;
    if (block.kind === 'result' && node && selection.statements) { lines.push(`### ${displayUnitLabel(node)}${node.title ? ` — ${node.title}` : ''}`, '', node.statement || block.content, ''); addCitations(node.citations); }
    if (block.kind === 'proof' && node && selection.proofs) { lines.push(`**Proof of ${displayUnitLabel(node)}.**`, '', node.proofText || block.proofText, ''); addCitations(node.citations); }
  }
  if (selection.audit) lines.push('## AI reading audit', '', `**Central question.** ${audit.audit.centralQuestion}`, '', `**Main contribution.** ${audit.audit.mainContribution}`, '', `**Source status.** ${audit.audit.sourceSummary}`, '');
  if (selection.notes) {
    const selectedNotes = Object.entries(readerNotes).filter(([id, value]) => visible.has(id) && value.trim()); const linkedNotes = notes.filter((note) => note.nodeId === '__paper__' || visible.has(note.nodeId));
    if (selectedNotes.length || linkedNotes.length) lines.push('## Reader notes', '');
    for (const [id, value] of selectedNotes) lines.push(`### ${displayUnitLabel(byId.get(id) ?? { kind: 'section' } as AuditNode)}`, '', value, '');
    for (const note of linkedNotes) lines.push(`### ${note.anchor}`, '', note.text, note.latex ? `$$${note.latex}$$` : '', '');
  }
  if (selection.citations && references.size) { lines.push('## References', ''); for (const citation of references.values()) lines.push(`- [${citationAlphaLabel(citation, citation.key)}] ${citation.authors ? `${citation.authors}. ` : ''}${citationTitle(citation, citation.key)}${citation.url ? ` — ${citation.url}` : ''}`); lines.push(''); }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function RailIcon({ name }: { name: 'reader' | 'library' | 'graph' | 'discover' | 'settings' }) {
  const paths = {
    reader: <><path d="M5 4.5h14v15H5z" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
    library: <><path d="M3.5 5.5c3-1 5.8-.5 8.5 1.3v13c-2.7-1.8-5.5-2.3-8.5-1.3z" /><path d="M20.5 5.5c-3-1-5.8-.5-8.5 1.3v13c2.7-1.8 5.5-2.3 8.5-1.3z" /></>,
    graph: <><circle cx="6" cy="7" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="m8 7 8-1M7.4 8.5l3.5 7.7M16.7 7.7l-3.6 8.5" /></>,
    discover: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z" /></>,
    settings: <><path d="M12.2 3h-.4a1.8 1.8 0 0 0-1.8 1.8v.3a1.8 1.8 0 0 1-.9 1.55l-.35.2a1.8 1.8 0 0 1-1.8 0l-.25-.14a1.8 1.8 0 0 0-2.46.66l-.2.35a1.8 1.8 0 0 0 .66 2.46l.25.14a1.8 1.8 0 0 1 .9 1.56v.4a1.8 1.8 0 0 1-.9 1.56l-.25.14a1.8 1.8 0 0 0-.66 2.46l.2.35a1.8 1.8 0 0 0 2.46.66l.25-.14a1.8 1.8 0 0 1 1.8 0l.35.2a1.8 1.8 0 0 1 .9 1.55v.3a1.8 1.8 0 0 0 1.8 1.8h.4a1.8 1.8 0 0 0 1.8-1.8v-.3a1.8 1.8 0 0 1 .9-1.55l.35-.2a1.8 1.8 0 0 1 1.8 0l.25.14a1.8 1.8 0 0 0 2.46-.66l.2-.35a1.8 1.8 0 0 0-.66-2.46l-.25-.14a1.8 1.8 0 0 1-.9-1.56v-.4a1.8 1.8 0 0 1 .9-1.56l.25-.14a1.8 1.8 0 0 0 .66-2.46l-.2-.35a1.8 1.8 0 0 0-2.46-.66l-.25.14a1.8 1.8 0 0 1-1.8 0l-.35-.2a1.8 1.8 0 0 1-.9-1.55v-.3A1.8 1.8 0 0 0 12.2 3Z" /><circle cx="12" cy="12" r="2.6" /></>,
  }[name];
  return <svg className="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>;
}

function BrandMascot({ busy = false, compact = false }: { busy?: boolean; compact?: boolean }) {
  return <span className={`brand-mascot ${busy ? 'busy' : ''} ${compact ? 'compact' : ''}`} aria-hidden="true"><svg viewBox="0 0 72 54" fill="none">
    <g className="woodpecker-body"><ellipse cx="18" cy="35" rx="11" ry="13" fill="#f8f1e8" stroke="#272522" strokeWidth="2"/><path d="M10 34c-5 4-7 11-7 16 6-1 11-4 14-9" fill="#34443a" stroke="#272522" strokeWidth="2" strokeLinejoin="round"/><path d="M9 40c4 1 8 0 11-3" stroke="#fffefa" strokeWidth="2" strokeLinecap="round"/></g>
    <g className="woodpecker-head"><circle cx="20" cy="20" r="10" fill="#f8f1e8" stroke="#272522" strokeWidth="2"/><path d="M11 15c2-8 9-12 17-8-1 1-1 3 0 5-6-3-11-1-14 5" fill="#b31b1b" stroke="#272522" strokeWidth="2" strokeLinejoin="round"/><path d="M28 19 42 23 28 26Z" fill="#d2c7ba" stroke="#272522" strokeWidth="2" strokeLinejoin="round"/><circle cx="22" cy="18" r="2.3" fill="#272522"/><circle cx="22.7" cy="17.3" r=".7" fill="#fff"/></g>
    <g className="x-card"><path d="M40 7h31v40H40V28l4-4-4-4Z" fill="#fffdf8" stroke="#272522" strokeWidth="1.8" strokeLinejoin="round"/><g transform="translate(20 11) scale(.28)"><path d="M127.98 55.61 95.24 94.46c-1.29 1.37-2.08 3.78-1.36 5.5.75 1.8 2.46 2.91 4.4 2.91 1.09 0 1.99-.38 3.16-1.56l40.19-42.71c1.6-1.69 1.62-4.33.04-6.04Z" fill="#aa142d"/><path d="m127.98 55.61 31.19-38.27c1.49-1.99 2.2-3.03 1.49-4.72-.74-1.77-2.59-3.16-4.48-3.16-1.06 0-1.72.09-3.01 1.11l-38.63 41.76c-1.72 1.84-1.71 4.7.02 6.53l47.79 51.07c1.02 1.05 2.05 1.19 3.14 1.19 1.93 0 3.19-1.14 4.03-2.82.72-1.73-.08-3.44-1.4-5.23Z" fill="#afa497"/><path d="M141.67 52.56 95 2.13S93.29.04 91.48 0s-3.6 1.02-4.34 2.79c-.7 1.69-.2 2.88 1.35 5.1l40.09 48.42Z" fill="#aa142d"/></g></g>
    <g className="peck-spark" stroke="#b31b1b" strokeWidth="1.6" strokeLinecap="round"><path d="m41 17-2-3M44 16v-4"/></g>
  </svg></span>;
}

function ReaderIcon({ name }: { name: 'magnify' | 'fullscreen' | 'reference' | 'print' | 'original' }) {
  const paths = { magnify: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /><path d="M8.1 13.2 10.5 7l2.4 6.2M9 11h3" /></>, fullscreen: <><path d="M8.5 4H4v4.5M15.5 4H20v4.5M8.5 20H4v-4.5M15.5 20H20v-4.5" /></>, reference: <><path d="M5 4.5h10v14H5z" /><path d="M9 7.5h10v12H9" /><path d="M8 8h4M8 11h4" /></>, print: <><path d="M7 9V4h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" /><path d="M7 14h10v7H7zM17.5 12h.01" /></>, original: <><path d="M6 3.5h9l3 3V21H6z" /><path d="M15 3.5V7h3M9 11h6M9 14h6M9 17h4" /></> }[name];
  return <svg className="reader-control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>;
}

export default function Home() {
  const [view, setView] = useState<View>('reader');
  const [papers, setPapers] = useState<Paper[]>([]);
  const [audits, setAudits] = useState<Record<string, PaperAudit>>({});
  const [notes, setNotes] = useState<Note[]>([]);
  const [nodeNotes, setNodeNotes] = useState<Record<string, Record<string, string>>>({});
  const [nodeAnswers, setNodeAnswers] = useState<Record<string, Record<string, string>>>({});
  const [expanded, setExpanded] = useState<Record<string, Record<string, boolean>>>({});
  const [marks, setMarks] = useState<Record<string, Record<string, Exclude<ReadingMark, ''>>>>({});
  const [patches, setPatches] = useState<Record<string, WorkingPatch[]>>({});
  const [updates, setUpdates] = useState<Record<string, PaperUpdateRecord[]>>({});
  const [auditJobs, setAuditJobs] = useState<Record<string, AuditJob>>({});
  const [updatePanel, setUpdatePanel] = useState<PaperUpdateRecord | null>(null);
  const [, setLinks] = useState<CrossLink[]>([]);
  const [graph, setGraph] = useState<Graph>(emptyGraph);
  const [profile, setProfile] = useState<Profile>(defaultProfile);
  const [discoveries, setDiscoveries] = useState<Paper[]>(fallbackDiscoveries);
  const [selectedPaperId, setSelectedPaperId] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [vaultSidebarOpen, setVaultSidebarOpen] = useState(true);
  const [importing, setImporting] = useState(false);
  const [paperJobs, setPaperJobs] = useState<Record<string, PaperJobKind>>({});
  const [askingId, setAskingId] = useState<string | null>(null);
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [vaultReady, setVaultReady] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [loadingDiscoveries, setLoadingDiscoveries] = useState(false);
  const [notice, setNotice] = useState('');

  const paper = papers.find((item) => item.id === selectedPaperId) ?? papers[0];
  const audit = paper ? audits[paper.id] : undefined;
  const auditJob = paper ? auditJobs[paper.id] : undefined;
  const activePaperId = paper?.id ?? '';
  const activePaperNotes = useMemo(() => activePaperId ? notes.filter((item) => item.paperId === activePaperId) : [], [activePaperId, notes]);

  function notify(message: string) { setNotice(message); window.setTimeout(() => setNotice(''), 8500); }
  function rememberAuditThread(paperId: string, threadId: string) {
    if (!threadId) return;
    setAudits((current) => {
      const savedAudit = current[paperId];
      if (!savedAudit || savedAudit.threadId === threadId) return current;
      return { ...current, [paperId]: { ...savedAudit, threadId } };
    });
  }
  function beginPaperJob(paperId: string, kind: PaperJobKind) { setPaperJobs((current) => ({ ...current, [paperId]: kind })); }
  function finishPaperJob(paperId: string, kind: PaperJobKind) { setPaperJobs((current) => { if (current[paperId] !== kind) return current; const next = { ...current }; delete next[paperId]; return next; }); }
  function applySnapshot(snapshot: VaultSnapshot) {
    setPapers(snapshot.papers); setAudits(Object.fromEntries(Object.entries(snapshot.audits).map(([paperId, paperAudit]) => [paperId, normalizeAuditCitations(paperAudit)]))); setNotes(normalizeNotes(snapshot.notes)); setNodeNotes(snapshot.nodeNotes); setNodeAnswers(snapshot.nodeAnswers); setExpanded(snapshot.expanded); setMarks(snapshot.marks ?? {}); setPatches(snapshot.patches ?? {}); setUpdates(snapshot.updates ?? {}); setAuditJobs(snapshot.auditJobs ?? {}); setLinks(snapshot.links); setGraph(snapshot.graph ?? emptyGraph);
    if (snapshot.profile) { const next = normalizeReaderProfile(snapshot.profile); if (!window.localStorage.getItem(reasoningDefaultMigrationKey)) window.localStorage.setItem(reasoningDefaultMigrationKey, 'applied'); setProfile(next); }
    setSelectedPaperId((current) => {
      if (snapshot.papers.some((item) => item.id === current)) return current;
      const saved = window.localStorage.getItem(selectedPaperKey) ?? '';
      return snapshot.papers.some((item) => item.id === saved) ? saved : snapshot.papers[0]?.id ?? '';
    });
  }
  async function refreshBridge() { try { const response = await fetch(`${bridgeUrl}/status`); const data = await response.json() as Bridge; setBridge(data); if (data.models?.length) setProfile((current) => data.models.some((item) => item.id === current.model) ? current : { ...current, model: data.models.find((item) => item.isDefault)?.id ?? '' }); } catch { setBridge(null); } }
  async function loadVault() {
    const locallySaved = localStorage.getItem(preferenceKey); const setupCompleted = localStorage.getItem(onboardingCompleteKey) === 'complete';
    function restoreLocalProfile() {
      if (!locallySaved) return false;
      try { setProfile(normalizeReaderProfile(JSON.parse(locallySaved))); localStorage.setItem(onboardingCompleteKey, 'complete'); return true; }
      catch { return false; }
    }
    try {
      const response = await fetch(`${bridgeUrl}/vault`); if (!response.ok) throw new Error(); const snapshot = await response.json() as VaultSnapshot; applySnapshot(snapshot);
      if (snapshot.profile) localStorage.setItem(onboardingCompleteKey, 'complete');
      else if (!restoreLocalProfile() && !setupCompleted) setOnboardingOpen(true);
    } catch { if (!restoreLocalProfile() && !setupCompleted) setOnboardingOpen(true); }
    finally { setVaultReady(true); }
  }
  function completeOnboarding() {
    const completedProfile = { ...profile, reasoningConfigured: true };
    setProfile(completedProfile); localStorage.setItem(preferenceKey, JSON.stringify(completedProfile)); localStorage.setItem(onboardingCompleteKey, 'complete'); setOnboardingOpen(false);
    void fetch(`${bridgeUrl}/vault/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: completedProfile }) });
  }
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadVault(); void refreshBridge(); }, 0);
    return () => window.clearTimeout(timer);
    // The bridge functions intentionally run once when this local reader mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (!vaultReady || onboardingOpen) return; localStorage.setItem(preferenceKey, JSON.stringify(profile)); void fetch(`${bridgeUrl}/vault/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile }) }); }, [profile, vaultReady, onboardingOpen]);
  useEffect(() => { if (vaultReady && selectedPaperId) window.localStorage.setItem(selectedPaperKey, selectedPaperId); }, [selectedPaperId, vaultReady]);
  useEffect(() => {
    if (!vaultReady || !paper || Boolean(paperJobs[paper.id])) return;
    const timer = window.setTimeout(() => { void fetch(`${bridgeUrl}/vault/reader`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId: paper.id, reader: { notes: notes.filter((item) => item.paperId === paper.id), nodeNotes: nodeNotes[paper.id] ?? {}, nodeAnswers: nodeAnswers[paper.id] ?? {}, expanded: expanded[paper.id] ?? {}, marks: marks[paper.id] ?? {} } }) }); }, 500);
    return () => window.clearTimeout(timer);
  }, [vaultReady, paper, notes, nodeNotes, nodeAnswers, expanded, marks, paperJobs]);

  async function savePaper(incoming: Paper) {
    const response = await fetch(`${bridgeUrl}/vault/paper`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper: incoming }) });
    const data = await readServiceResponse(response); if (!response.ok || !data.paper) throw new Error(data.error || 'Could not create the paper folder.');
    const stored = data.paper;
    setPapers((current) => [stored, ...current.filter((item) => item.id !== stored.id && item.arxivId !== stored.arxivId)]);
    return stored;
  }
  async function updatePaperInfo(incoming: Paper) {
    const response = await fetch(`${bridgeUrl}/vault/paper/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper: incoming }) });
    const data = await readServiceResponse(response); if (!response.ok || !data.paper) throw new Error(data.error || 'Could not update the paper record.');
    const stored = data.paper; setPapers((current) => current.map((item) => item.id === stored.id ? stored : item)); notify('Paper record updated.');
  }
  async function removePaperFromVault(paperId: string) {
    const response = await fetch(`${bridgeUrl}/vault/paper/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId }) });
    const data = await readServiceResponse(response); if (!response.ok || !data.snapshot) throw new Error(data.error || 'Could not remove the paper.');
    applySnapshot(data.snapshot); notify('Paper removed from the library and archived locally for recovery.');
  }
  async function reorderLibrary(next: Paper[]) {
    const previous = papers; setPapers(next);
    try { const response = await fetch(`${bridgeUrl}/vault/paper/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperIds: next.map((item) => item.id) }) }); if (!response.ok) throw new Error(); }
    catch { setPapers(previous); notify('The new library order could not be saved.'); }
  }
  async function analyzePaper(target: Paper, convertPdfToLatex = false, correctnessAudit = true, detailedAudit = true, requestedProcessId?: string) {
    if (paperJobs[target.id]) { notify(`Another ${paperJobs[target.id]} is already running for “${target.title}”.`); return; }
    const checkpoint = auditJobs[target.id];
    if (checkpoint?.state === 'running') { notify(`The saved audit for “${target.title}” is still running. Reload to see its latest status.`); return; }
    const resumeAudit = Boolean(checkpoint);
    const options = checkpoint?.options ?? { convertPdfToLatex, correctnessAudit, detailedAudit };
    const processId = requestedProcessId || `paper-analysis:${target.id}`;
    beginPaperJob(target.id, 'audit');
    setAuditJobs((current) => ({ ...current, [target.id]: { version: 1, paperId: target.id, state: 'running', threadId: checkpoint?.threadId ?? '', options, attempts: (checkpoint?.attempts ?? 0) + 1, startedAt: checkpoint?.startedAt || new Date().toISOString(), updatedAt: new Date().toISOString(), message: resumeAudit ? 'Resuming the saved AI audit.' : 'Preparing the AI audit.' } }));
    reportReaderProcess({ id: processId, label: resumeAudit ? 'Resuming saved AI audit' : 'AI audit in progress', detail: target.title, status: 'running' });
    try {
      const response = await fetch(`${bridgeUrl}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper: target, profile, ...options, resumeAudit }) });
      const data = await readServiceResponse(response); if (!response.ok || !data.paper) throw new Error(data.error || 'Local Codex analysis failed.');
      const stored = data.paper; const next = parseAudit(readString(data.text), readString(data.threadId));
      reportReaderProcess({ id: processId, label: 'Building interactive reader', detail: stored.title, status: 'running' });
      const saved = await fetch(`${bridgeUrl}/vault/audit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper: stored, audit: next }) });
      const snapshot = await readServiceResponse(saved); if (!saved.ok || !snapshot.paper) throw new Error(snapshot.error || 'Could not save the local audit.');
      const manualReplacements = new Set((patches[stored.id] ?? []).filter((patch) => patch.kind === 'replace' && patch.source === 'manual').map((patch) => patch.nodeId)); const automatic = new Map<string, WorkingPatch>();
      for (const correction of next.editorialCorrections ?? []) {
        const sourceNode = next.nodes.find((item) => item.id === correction.nodeId); if (!sourceNode || correction.confidence !== 'high' || !correction.replacement.trim()) continue;
        const directBlock = next.sourceBlocks.find((block) => block.nodeId === sourceNode.id && (correction.field !== 'proofText' || block.kind === 'proof'));
        const originalNeedles = [correction.original.trim(), correction.field === 'proofText' ? sourceNode.proofText.trim() : sourceNode.statement.trim()].filter(Boolean);
        const embeddedBlock = directBlock ? undefined : next.sourceBlocks.find((block) => { const value = originalSourceBlockValue(block); return originalNeedles.some((needle) => value.includes(needle)); });
        if (embeddedBlock) {
          const targetId = sourceBlockUnitId(embeddedBlock); if (manualReplacements.has(targetId)) continue;
          const original = originalSourceBlockValue(embeddedBlock); const current = automatic.get(targetId) ?? { id: makeId(), kind: 'replace' as const, nodeId: targetId, title: embeddedBlock.title || sourceNode.title, statement: original, proofText: '', nodeKind: embeddedBlock.kind === 'section' ? 'section' as const : embeddedBlock.kind === 'figure' ? 'figure' as const : 'paragraph' as const, afterNodeId: '', rationale: '', dependencies: [], proofSketch: [], source: 'ai' as const, createdAt: new Date().toISOString() };
          const needle = originalNeedles.find((candidate) => current.statement.includes(candidate)); if (!needle) continue;
          current.statement = current.statement.replace(needle, correction.replacement.trim()); current.rationale = [current.rationale, correction.rationale].filter(Boolean).join(' '); automatic.set(targetId, current); continue;
        }
        if (manualReplacements.has(sourceNode.id)) continue;
        const current = automatic.get(sourceNode.id) ?? { id: makeId(), kind: 'replace' as const, nodeId: sourceNode.id, title: sourceNode.title, statement: sourceNode.statement, proofText: sourceNode.proofText, nodeKind: sourceNode.kind, afterNodeId: '', rationale: '', dependencies: sourceNode.dependencies, proofSketch: sourceNode.proofSketch, source: 'ai' as const, createdAt: new Date().toISOString() };
        current[correction.field] = correction.replacement.trim(); current.rationale = [current.rationale, correction.rationale].filter(Boolean).join(' '); automatic.set(sourceNode.id, current);
      }
      const prior = (patches[stored.id] ?? []).filter((patch) => !(patch.kind === 'replace' && patch.source === 'ai')); const correctedPatches = [...prior, ...automatic.values()];
      if (automatic.size) { const correctionResponse = await fetch(`${bridgeUrl}/vault/patches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId: stored.id, patches: correctedPatches }) }); const correctionData = await readServiceResponse(correctionResponse); if (!correctionResponse.ok) throw new Error(correctionData.error || 'Could not save audited typo corrections.'); setPatches((current) => ({ ...current, [stored.id]: correctionData.patches ?? [] })); }
      const sourceLabel = data.primarySource?.kind === 'tex' ? 'TeX-first source' : data.primarySource?.kind === 'ai-tex' ? 'AI-converted LaTeX source' : 'PDF fallback';
      const savedPaper = snapshot.paper;
      setPapers((current) => [savedPaper, ...current.filter((item) => item.id !== stored.id && item.arxivId !== stored.arxivId)]); setAudits((current) => ({ ...current, [stored.id]: next })); setAuditJobs((current) => { const nextJobs = { ...current }; delete nextJobs[stored.id]; return nextJobs; }); setGraph(snapshot.graph ?? emptyGraph); setLinks(snapshot.links ?? []); reportReaderProcess({ id: processId, label: 'AI audit complete', detail: stored.title, status: 'complete' }); notify(`“${stored.title}” is ready · ${next.nodes.length} audited units · ${sourceLabel}${automatic.size ? ` · ${automatic.size} verified typo correction${automatic.size === 1 ? '' : 's'} highlighted` : ''}.`); void refreshBridge();
    } catch (error) { const message = error instanceof Error ? error.message : 'Analysis failed.'; setAuditJobs((current) => current[target.id] ? { ...current, [target.id]: { ...current[target.id], state: 'paused', updatedAt: new Date().toISOString(), message } } : current); reportReaderProcess({ id: processId, label: 'AI audit paused', detail: message, status: 'error', retryPaperId: target.id }); notify(`${message} The paper, source, and saved audit thread are preserved; choose Continue audit from the library.`); void loadVault(); void refreshBridge(); }
    finally { finishPaperJob(target.id, 'audit'); }
  }
  async function refreshArxivPaper(target: Paper) {
    const previousAudit = audits[target.id]; if (!previousAudit) { notify('Run the first AI audit before updating this paper.'); return; }
    if (target.arxivId.startsWith('local-')) { notify('Version refresh is available for arXiv papers.'); return; }
    if (paperJobs[target.id]) { notify(`Another ${paperJobs[target.id]} is already running for “${target.title}”.`); return; }
    const processId = `paper-update:${target.id}`; beginPaperJob(target.id, 'update');
    try {
      reportReaderProcess({ id: processId, label: 'Checking latest arXiv version', detail: target.title, status: 'running' });
      const metadataResponse = await fetch(`/api/arxiv?id=${encodeURIComponent(arxivBaseId(target.arxivId))}`); const metadata = await readServiceResponse(metadataResponse);
      if (!metadataResponse.ok || !metadata.papers?.[0]) throw new Error(readString(metadata.error, 'The latest arXiv record could not be read.'));
      const latest = { ...(metadata.papers[0] as Paper), id: target.id, folder: target.folder, state: target.state, tags: target.tags };
      const currentVersion = arxivVersionNumber(target.arxivId); const latestVersion = arxivVersionNumber(latest.arxivId);
      if (arxivBaseId(latest.arxivId) !== arxivBaseId(target.arxivId)) throw new Error('arXiv returned a different paper record. Nothing was changed.');
      if (!latestVersion || latestVersion <= currentVersion) { reportReaderProcess({ id: processId, label: 'Paper is current', detail: `arXiv:${target.arxivId}`, status: 'complete' }); notify(`arXiv:${target.arxivId} is already the latest version.`); return; }

      reportReaderProcess({ id: processId, label: `Comparing v${currentVersion} → v${latestVersion}`, detail: 'Reading both complete source trees with AI.', status: 'running' });
      const readerContext = { notes: notes.filter((item) => item.paperId === target.id).map((item) => ({ anchor: item.anchor, text: item.text.slice(0, 600) })), marks: marks[target.id] ?? {}, edits: (patches[target.id] ?? []).filter((item) => item.source === 'manual').map((item) => ({ kind: item.kind, nodeId: item.nodeId, title: item.title, rationale: item.rationale })) };
      const comparisonResponse = await fetch(`${bridgeUrl}/compare-versions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper: target, profile, fromVersion: target.arxivId, toVersion: latest.arxivId, readerContext, updateMode: true }) });
      const comparisonData = await readServiceResponse(comparisonResponse); if (!comparisonResponse.ok) throw new Error(comparisonData.error || 'AI version comparison failed.');
      const comparison = parseVersionComparison(readString(comparisonData.text));

      reportReaderProcess({ id: processId, label: `Auditing v${latestVersion}`, detail: 'Checking the latest statements, proofs, citations, and dependencies.', status: 'running' });
      const analysisResponse = await fetch(`${bridgeUrl}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper: latest, profile, correctnessAudit: true, detailedAudit: true, updateMode: true, updateContext: { fromVersion: target.arxivId, toVersion: latest.arxivId, comparison, priorAudit: { centralQuestion: previousAudit.audit.centralQuestion, mainContribution: previousAudit.audit.mainContribution, verificationWarnings: previousAudit.audit.verificationWarnings } } }) });
      const analysisData = await readServiceResponse(analysisResponse); if (!analysisResponse.ok) throw new Error(analysisData.error || 'The latest-version AI audit failed.');
      const latestAudit = parseAudit(readString(analysisData.text), readString(analysisData.threadId));

      reportReaderProcess({ id: processId, label: 'Merging reader work', detail: 'Reattaching notes and marks; three-way merging working edits.', status: 'running' });
      const migration = migrateReaderWork({ paper: target, previous: previousAudit, next: latestAudit, notes: notes.filter((item) => item.paperId === target.id), nodeNotes: nodeNotes[target.id] ?? {}, nodeAnswers: nodeAnswers[target.id] ?? {}, expanded: expanded[target.id] ?? {}, marks: marks[target.id] ?? {}, patches: patches[target.id] ?? [] });
      const aiCorrections = automaticEditorialPatches(latestAudit, migration.patches); const nextPatches = [...migration.patches, ...aiCorrections];
      const update: PaperUpdateRecord = { id: makeId(), paperId: target.id, fromVersion: target.arxivId, toVersion: latest.arxivId, createdAt: new Date().toISOString(), status: 'updated', comparison, migration: migration.migration };
      const commitResponse = await fetch(`${bridgeUrl}/vault/paper/update-commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper: latest, audit: latestAudit, reader: migration.reader, patches: nextPatches, update, nodeMap: migration.maps.nodeMap, sourceRecord: analysisData.sourceRecord ?? {} }) });
      const commitData = await readServiceResponse(commitResponse); if (!commitResponse.ok || !commitData.snapshot) throw new Error(commitData.error || 'The latest version could not be committed locally.');
      applySnapshot(commitData.snapshot); setSelectedNodeId((current) => migration.maps.unitMap[current] ?? latestAudit.nodes[0]?.id ?? ''); setUpdatePanel(commitData.update ?? null);
      reportReaderProcess({ id: processId, label: `Updated to v${latestVersion}`, detail: `${comparison.changedUnits.length} source changes · ${migration.migration.notesCarried} notes · ${migration.migration.editsCarried} edits carried`, status: 'complete' });
      notify(`Updated to arXiv:${latest.arxivId}. ${comparison.changedUnits.length} changed unit${comparison.changedUnits.length === 1 ? '' : 's'} found; ${migration.migration.conflicts.length ? `${migration.migration.conflicts.length} reader item${migration.migration.conflicts.length === 1 ? '' : 's'} need review.` : 'all reader work was integrated.'}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The paper update failed.'; reportReaderProcess({ id: processId, label: 'Paper update stopped', detail: `${message} The current version was kept.`, status: 'error' }); notify(`${message} The current paper, notes, and edits were not replaced.`);
    } finally { finishPaperJob(target.id, 'update'); }
  }
  async function importArxiv(raw: string, convertPdfToLatex = false, correctnessAudit = true, detailedAudit = true) {
    const processId = `paper-import:${arxivBaseId(raw) || makeId()}`;
    reportReaderProcess({ id: processId, label: 'Looking up arXiv metadata', detail: raw, status: 'running' });
    try {
      const response = await fetch(`/api/arxiv?id=${encodeURIComponent(raw)}`); const data = await readServiceResponse(response);
      if (!response.ok || !data.papers?.[0]) throw new Error(readString(data.error, 'Paper not found on arXiv.'));
      const incoming = { ...data.papers[0], state: 'Reading' } as Paper;
      const existing = papers.find((item) => item.arxivId.replace(/v\d+$/i, '') === incoming.arxivId.replace(/v\d+$/i, ''));
      const stored = existing ?? await savePaper(incoming);
      setImporting(false); setSelectedPaperId(stored.id); setView('reader');
      await analyzePaper(stored, convertPdfToLatex, correctnessAudit, detailedAudit, processId);
    } catch (error) { const message = error instanceof Error ? error.message : 'Paper import failed.'; reportReaderProcess({ id: processId, label: 'Import stopped', detail: message, status: 'error' }); throw error; }
  }
  async function importLocalSource(file: File, suppliedTitle: string, convertPdfToLatex = false, correctnessAudit = true, detailedAudit = true) {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['pdf', 'tex', 'ltx', 'zip'].includes(extension)) throw new Error('Upload one PDF, TeX file, or ZIP source project.');
    const title = suppliedTitle.trim() || file.name.replace(/\.(pdf|tex|ltx|zip)$/i, '').replace(/[-_]+/g, ' ').trim() || 'Uploaded paper'; const localId = `local-${makeId()}`;
    const incoming: Paper = { id: localId, title, authors: 'Unknown authors', category: 'Local source', arxivId: localId, abstract: '', state: 'Reading', tags: ['local-source'] };
    const processId = `paper-import:${localId}`;
    reportReaderProcess({ id: processId, label: 'Saving uploaded source', detail: title, status: 'running' });
    try { const dataBase64 = await fileAsBase64(file); const response = await fetch(`${bridgeUrl}/vault/source-upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper: incoming, upload: { fileName: file.name, mime: file.type, dataBase64 } }) }); const data = await readServiceResponse(response); if (!response.ok || !data.paper) throw new Error(data.error || 'The local source could not be saved.'); const stored = data.paper; setPapers((current) => [stored, ...current.filter((item) => item.id !== stored.id)]); setImporting(false); setSelectedPaperId(stored.id); setView('reader'); await analyzePaper(stored, convertPdfToLatex, correctnessAudit, detailedAudit, processId); }
    catch (error) { const message = error instanceof Error ? error.message : 'Local source import failed.'; reportReaderProcess({ id: processId, label: 'Import stopped', detail: message, status: 'error' }); throw error; }
  }
  async function saveDiscovery(candidate: Paper) { try { const stored = await savePaper({ ...candidate, state: 'To read' }); setSelectedPaperId(stored.id); notify('Paper saved with its own local folder.'); } catch (error) { notify(error instanceof Error ? error.message : 'Could not save the paper.'); } }
  async function askNode(targetNode: AuditNode, question: string) { if (!audit || !paper || !question.trim()) return; const processId = `node-question:${paper.id}:${targetNode.id}`; reportReaderProcess({ id: processId, label: 'AI question', detail: displayUnitLabel(targetNode), status: 'running' }); setAskingId(targetNode.id); try { const response = await fetch(`${bridgeUrl}/node-question`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper, profile, node: targetNode, question, threadId: audit.threadId }) }); const data = await readServiceResponse(response); if (!response.ok) throw new Error(data.error || 'Codex did not answer this unit.'); rememberAuditThread(paper.id, readString(data.threadId)); setNodeAnswers((current) => ({ ...current, [paper.id]: { ...current[paper.id], [targetNode.id]: readString(data.text) } })); reportReaderProcess({ id: processId, label: 'AI answer ready', detail: displayUnitLabel(targetNode), status: 'complete' }); } catch (error) { const message = error instanceof Error ? error.message : 'The local Codex question failed.'; reportReaderProcess({ id: processId, label: 'AI question stopped', detail: message, status: 'error' }); notify(message); } finally { setAskingId(null); } }
  function saveNote(anchor: string, nodeId: string, text: string, latex: string) { if (!paper || !text.trim()) return; setNotes((current) => { if (nodeId === '__paper__') return [{ id: `n-${Date.now()}`, paperId: paper.id, nodeId, anchor, text: text.trim(), latex, createdAt: 'just now' }, ...current]; const existing = current.find((note) => note.paperId === paper.id && note.nodeId === nodeId); const next = existing ? { ...existing, anchor, text: text.trim(), latex } : { id: `n-${Date.now()}`, paperId: paper.id, nodeId, anchor, text: text.trim(), latex, createdAt: 'just now' }; return [next, ...current.filter((note) => note.id !== existing?.id && !(note.paperId === paper.id && note.nodeId === nodeId))]; }); notify(nodeId === '__paper__' ? 'Paper note saved.' : 'Environment note saved.'); }
  function updateNote(noteId: string, text: string) { if (!text.trim()) return; setNotes((current) => current.map((note) => note.id === noteId ? { ...note, text: text.trim(), latex: '' } : note)); notify('Note updated.'); }
  function deleteNote(noteId: string) { setNotes((current) => current.filter((note) => note.id !== noteId)); notify('Note deleted.'); }
  async function addLink(link: Omit<CrossLink, 'id' | 'source' | 'createdAt'>) { try { const response = await fetch(`${bridgeUrl}/vault/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ link }) }); const data = await readServiceResponse(response); if (!response.ok || !data.link) throw new Error(data.error || 'Could not create the relation.'); const storedLink = data.link; setLinks((current) => current.some((item) => item.id === storedLink.id) ? current : [...current, storedLink]); setGraph(data.graph ?? emptyGraph); notify('Cross-paper relation added to the local graph.'); } catch (error) { notify(error instanceof Error ? error.message : 'Could not create the relation.'); } }
  async function removeLink(linkId: string) { const response = await fetch(`${bridgeUrl}/vault/link/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ linkId }) }); const data = await readServiceResponse(response); if (response.ok) { setLinks((current) => current.filter((item) => item.id !== linkId)); setGraph(data.graph ?? emptyGraph); } }
  async function saveWorkingPatches(paperId: string, nextPatches: WorkingPatch[]) {
    const response = await fetch(`${bridgeUrl}/vault/patches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId, patches: nextPatches }) });
    const data = await readServiceResponse(response); if (!response.ok) throw new Error(data.error || 'Could not save the working edition.');
    setPatches((current) => ({ ...current, [paperId]: data.patches ?? [] })); setGraph(data.graph ?? emptyGraph); notify('Working edition saved locally.');
  }
  async function suggestEditorialFix(targetNode: AuditNode) {
    if (!audit?.threadId || !paper) throw new Error('Run the full-paper audit first.');
    const processId = `editorial-check:${paper.id}:${targetNode.id}`; reportReaderProcess({ id: processId, label: 'Checking source text', detail: displayUnitLabel(targetNode), status: 'running' });
    try { const response = await fetch(`${bridgeUrl}/node-edit/suggest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper, profile, node: targetNode, threadId: audit.threadId }) }); const data = await readServiceResponse(response); if (!response.ok) throw new Error(data.error || 'Codex could not inspect this unit.'); const parsed = parseJsonObject(readString(data.text)); reportReaderProcess({ id: processId, label: 'Source check ready', detail: displayUnitLabel(targetNode), status: 'complete' }); return { hasIssue: Boolean(parsed.hasIssue), replacement: readString(parsed.replacement), rationale: readString(parsed.rationale), confidence: ['high', 'medium', 'low'].includes(readString(parsed.confidence)) ? readString(parsed.confidence) as EditorialSuggestion['confidence'] : 'low' }; }
    catch (error) { const message = error instanceof Error ? error.message : 'Source check failed.'; reportReaderProcess({ id: processId, label: 'Source check stopped', detail: message, status: 'error' }); throw error; }
  }
  async function refreshDiscoveries(area?: string, latestBatch = false) { setLoadingDiscoveries(true); try { const categories = area ? [area] : profile.areas; const response = await fetch(`/api/arxiv?categories=${encodeURIComponent(categories.join(','))}${latestBatch ? '&latest=1' : ''}`); const data = await readServiceResponse(response); if (!response.ok) throw new Error(data.error || 'arXiv is unavailable.'); setDiscoveries(data.papers ?? []); if (latestBatch) notify(`${data.papers?.length ?? 0} paper${data.papers?.length === 1 ? '' : 's'} from arXiv’s latest ${area} update${data.batchLabel ? ` · ${data.batchLabel}` : ''}.`); } catch { notify('arXiv is unavailable right now; the current discovery list was kept.'); } finally { setLoadingDiscoveries(false); } }
  function openUnit(paperId: string, nodeId: string) { setSelectedPaperId(paperId); setSelectedNodeId(nodeId); setView('reader'); }

  return <main className={`app-shell min-h-screen bg-[#f8f8f5] text-[#20251f] lg:grid lg:grid-cols-[54px_235px_minmax(0,1fr)] ${view === 'reader' ? 'app-reader-mode' : ''} ${view === 'discover' ? '' : 'app-no-vault'} ${vaultSidebarOpen ? '' : 'app-vault-collapsed'}`}>
    <nav className="hidden min-h-screen flex-col items-center gap-2 border-r border-[#e0e4dd] bg-[#273b31] py-4 text-[#dfece4] lg:flex"><div className="brand-rail-mark mb-4" title="arXivpecker"><BrandMascot compact /></div>{([['reader', 'Read'], ['library', 'Library'], ['graph', 'Graph'], ['discover', 'Discover'], ['settings', 'Settings']] as const).map(([target, label]) => <button key={target} onClick={() => setView(target)} title={label} aria-label={label} className={`grid h-9 w-9 place-items-center rounded-lg ${view === target ? 'bg-[#476956] text-white' : 'hover:bg-[#3b5b49]'}`}><RailIcon name={target} /></button>)}<div className="flex-1" /><button onClick={() => window.dispatchEvent(new Event('proofroom:toggle-process-tray'))} title="Show or hide AI activity" aria-label="Show or hide AI activity" className={`bridge-status-light mb-2 ${bridge?.account ? 'bridge-ready' : 'bridge-unavailable'}`} /></nav>
    <nav className="mobile-app-nav lg:hidden" aria-label="Main navigation"><div title="arXivpecker"><BrandMascot compact /></div>{([['reader', 'Read'], ['library', 'Library'], ['graph', 'Graph'], ['discover', 'Discover'], ['settings', 'Settings']] as const).map(([target, label]) => <button key={target} onClick={() => setView(target)} aria-label={label} className={view === target ? 'active' : ''}><RailIcon name={target} /><span>{label}</span></button>)}<button onClick={() => window.dispatchEvent(new Event('proofroom:toggle-process-tray'))} aria-label="AI activity" className="mobile-activity-button"><i className={`bridge-status-light ${bridge?.account ? 'bridge-ready' : 'bridge-unavailable'}`} /><span>AI</span></button></nav>
    {view === 'discover' && <aside className={`local-vault-sidebar hidden min-h-screen flex-col border-r border-[#e2e6e0] bg-[#f0f2ed] p-4 lg:flex ${vaultSidebarOpen ? '' : 'collapsed'}`}><div className="flex items-start justify-between"><div><h1 className="text-lg font-bold tracking-[-.04em]">Papers</h1></div><div className="vault-head-actions"><button onClick={() => setVaultSidebarOpen(false)} title="Collapse papers" aria-label="Collapse papers">‹</button><button onClick={() => setImporting(true)} title="Import paper" aria-label="Import paper">+</button></div></div><button onClick={() => setImporting(true)} className="my-4 rounded-md bg-[#deebe1] px-3 py-2 text-left text-[11px] font-bold text-[#2d604b]">+ Import paper</button><div className="mb-2 flex justify-between text-[10px] font-bold text-[#677068]"><span>YOUR LIBRARY</span><span>{papers.length}</span></div><div className="min-h-0 flex-1 space-y-1 overflow-y-auto">{papers.length ? papers.map((item) => <button key={item.id} onClick={() => { setSelectedPaperId(item.id); setView('reader'); }} className="w-full rounded-lg p-2 text-left hover:bg-[#e7ebe6]"><span className="flex items-start gap-2"><i className={`mt-1 h-1.5 w-1.5 flex-none rounded-full ${audits[item.id] ? 'bg-[#499b70]' : 'bg-[#d6b756]'}`} /><span><b className="block text-[11px] leading-[1.35]"><MathText value={item.title} /></b><small className="mt-1 block text-[9px] text-[#788178]">{item.arxivId}</small></span></span></button>) : <p className="rounded-lg border border-dashed border-[#d5ddd5] p-3 text-[11px] leading-5 text-[#788178]">Import a paper to begin.</p>}</div></aside>}{!vaultSidebarOpen && view === 'discover' && <button className="vault-reopen hidden lg:grid" onClick={() => setVaultSidebarOpen(true)} title="Expand papers" aria-label="Expand papers">›</button>}
    <section className="min-w-0"><header className="app-header"><div className="app-header-title">{view === 'reader' && paper ? <><span /><MathText value={paper.title} /></> : view === 'graph' ? 'Local dependency graph' : view[0].toUpperCase() + view.slice(1)}</div><div className="app-header-actions"><ModelControls profile={profile} setProfile={setProfile} bridge={bridge} compact /><button onClick={() => setImporting(true)} className="header-import">+ Import</button></div></header>{notice && <div className="notice-banner">{notice}</div>}
      {view === 'reader' && <Reader paper={paper} audit={audit} openImport={() => setImporting(true)} selectedNodeId={selectedNodeId} setSelectedNodeId={setSelectedNodeId} expanded={paper ? expanded[paper.id] ?? {} : {}} setExpanded={(id, value) => paper && setExpanded((current) => ({ ...current, [paper.id]: { ...current[paper.id], [id]: value } }))} marks={paper ? marks[paper.id] ?? {} : {}} setMark={(id, value) => paper && setMarks((current) => { const paperMarks = { ...(current[paper.id] ?? {}) }; if (value) paperMarks[id] = value; else delete paperMarks[id]; return { ...current, [paper.id]: paperMarks }; })} readerNotes={paper ? nodeNotes[paper.id] ?? {} : {}} notes={activePaperNotes} answers={paper ? nodeAnswers[paper.id] ?? {} : {}} savePaperMessages={(messages) => paper && setNodeAnswers((current) => ({ ...current, [paper.id]: { ...(current[paper.id] ?? {}), [paperChatAnswerKey]: JSON.stringify(messages) } }))} patches={paper ? patches[paper.id] ?? [] : []} savePatches={(next) => paper ? saveWorkingPatches(paper.id, next) : Promise.resolve()} suggestEdit={suggestEditorialFix} graph={graph} analysing={Boolean(paper && (paperJobs[paper.id] || auditJob?.state === 'running'))} auditActionLabel={auditJob?.state === 'paused' || auditJob?.state === 'preparing' ? 'Continue audit' : undefined} askingId={askingId} analyze={() => paper && void analyzePaper(paper)} askNode={askNode} rememberAuditThread={(threadId) => paper && rememberAuditThread(paper.id, threadId)} saveNote={saveNote} updateNote={updateNote} deleteNote={deleteNote} addLink={addLink} removeLink={removeLink} openUnit={openUnit} profile={profile} />}
      {view === 'library' && <Library papers={papers} audits={audits} patches={patches} updates={updates} jobs={paperJobs} auditJobs={auditJobs} analyze={analyzePaper} refreshPaper={refreshArxivPaper} showUpdate={setUpdatePanel} updatePaper={updatePaperInfo} removePaper={removePaperFromVault} reorderPapers={reorderLibrary} openUnit={openUnit} openImport={() => setImporting(true)} />}
      {view === 'graph' && <GraphView graph={graph} papers={papers} openUnit={openUnit} />}
      {view === 'discover' && <Discover papers={discoveries} saved={papers} save={saveDiscovery} refresh={refreshDiscoveries} loading={loadingDiscoveries} selectedAreas={profile.areas} />}
      {view === 'settings' && <Settings profile={profile} setProfile={setProfile} bridge={bridge} />}
    </section>{onboardingOpen && <OnboardingDialog profile={profile} setProfile={setProfile} bridge={bridge} finish={completeOnboarding} />}{importing && <ImportDialog close={() => setImporting(false)} importArxiv={importArxiv} importLocalSource={importLocalSource} profile={profile} setProfile={setProfile} bridge={bridge} />}{updatePanel && <PaperUpdatePanel paper={papers.find((item) => item.id === updatePanel.paperId)} audit={audits[updatePanel.paperId]} update={updatePanel} openUnit={openUnit} close={() => setUpdatePanel(null)} />}<ProcessTray retryAudit={(paperId) => { const target = papers.find((item) => item.id === paperId); if (target && !paperJobs[target.id]) void analyzePaper(target); }} />
  </main>;
}

type ReaderProps = { paper?: Paper; audit?: PaperAudit; openImport: () => void; selectedNodeId: string; setSelectedNodeId: (id: string) => void; expanded: Record<string, boolean>; setExpanded: (id: string, value: boolean) => void; marks: Record<string, Exclude<ReadingMark, ''>>; setMark: (id: string, value: ReadingMark) => void; readerNotes: Record<string, string>; notes: Note[]; answers: Record<string, string>; savePaperMessages: (messages: PaperChatMessage[]) => void; patches: WorkingPatch[]; savePatches: (patches: WorkingPatch[]) => Promise<void>; suggestEdit: (node: AuditNode) => Promise<EditorialSuggestion>; graph: Graph; analysing: boolean; auditActionLabel?: string; askingId: string | null; analyze: () => void; askNode: (node: AuditNode, question: string) => Promise<void>; rememberAuditThread: (threadId: string) => void; saveNote: (anchor: string, nodeId: string, text: string, latex: string) => void; updateNote: (noteId: string, text: string) => void; deleteNote: (noteId: string) => void; addLink: (link: Omit<CrossLink, 'id' | 'source' | 'createdAt'>) => Promise<void>; removeLink: (linkId: string) => Promise<void>; openUnit: (paperId: string, nodeId: string) => void; profile: Profile };

function Reader({ paper, audit, openImport, selectedNodeId, setSelectedNodeId, expanded, setExpanded, marks, setMark, readerNotes, notes, answers, savePaperMessages, patches, savePatches, suggestEdit, graph, analysing, auditActionLabel, askingId, analyze, askNode, rememberAuditThread, saveNote, updateNote, deleteNote, addLink, removeLink, openUnit, profile }: ReaderProps) {
  const [mode, setMode] = useState<ReaderMode>('interactive'); const [edition, setEdition] = useState<EditionMode>('working'); const [focusPath, setFocusPath] = useState(false); const [focusSelection, setFocusSelection] = useState('path:0'); const [question, setQuestion] = useState(''); const [comparisonOpen, setComparisonOpen] = useState(false); const [outlineOpen, setOutlineOpen] = useState(false); const [inspectorOpen, setInspectorOpen] = useState(false); const [assistantSize, setAssistantSize] = useState<AssistantSize | null>(null); const [paperChatOpen, setPaperChatOpen] = useState(false); const [paperQuestion, setPaperQuestion] = useState(''); const [paperAsking, setPaperAsking] = useState(false); const [paperMessages, setPaperMessages] = useState<PaperChatMessage[]>(() => parsePaperChat(answers[paperChatAnswerKey])); const [paperScale, setPaperScale] = useState(1); const [paperScaleReady, setPaperScaleReady] = useState(false); const [fontPanelOpen, setFontPanelOpen] = useState(false); const [printOpen, setPrintOpen] = useState(false); const [referenceOpen, setReferenceOpen] = useState(false); const [referenceTarget, setReferenceTarget] = useState<ReferenceTarget | null>(null); const [markupOpen, setMarkupOpen] = useState(false); const [toolsOpen, setToolsOpen] = useState(false); const [mobileDockOpen, setMobileDockOpen] = useState(false); const [exportOpen, setExportOpen] = useState(false); const [isFullscreen, setIsFullscreen] = useState(false); const [originalPage, setOriginalPage] = useState<number | undefined>();
  const [assistantRequest, setAssistantRequest] = useState<{ view: 'ask' | 'notes' | 'compose-note'; nonce: number } | null>(null);
  const paperMessagesRef = useRef<PaperChatMessage[]>(paperMessages);
  const readerDocumentRef = useRef<HTMLElement>(null);
  const selectedDocumentElementRef = useRef<HTMLElement | null>(null);
  const originalNodes = useMemo(() => audit?.nodes ?? [], [audit]);
  const editionNodes = useMemo(() => edition === 'working' ? applyWorkingPatches(originalNodes, patches) : originalNodes, [edition, originalNodes, patches]);
  const sourceUnits = useMemo(() => (audit?.sourceBlocks ?? []).filter((block) => block.kind === 'section' || block.kind === 'paragraph' || block.kind === 'figure').map((block) => sourceBlockAsNode(block, edition === 'working' ? patches : [])), [audit, edition, patches]);
  const selectedPathIndex = Number(focusSelection.replace('path:', ''));
  const selectedTargetId = focusSelection.startsWith('result:') ? focusSelection.slice(7) : '';
  const selectedTarget = editionNodes.find((item) => item.id === selectedTargetId);
  const activePath = useMemo(() => {
    if (!audit) return undefined;
    return selectedTarget ? { goal: `Focus on ${displayUnitLabel(selectedTarget)}`, nodeIds: dependencyFocus(editionNodes, selectedTarget.id), reason: 'Showing only this result and the parts it depends on; unrelated branches are hidden.' } : audit.readingPaths[selectedPathIndex] ?? audit.readingPaths[0];
  }, [audit, editionNodes, selectedPathIndex, selectedTarget]);
  const units = useMemo(() => focusPath && activePath ? editionNodes.filter((item) => activePath.nodeIds.includes(item.id)) : editionNodes, [activePath, editionNodes, focusPath]);
  const node = editionNodes.find((item) => item.id === selectedNodeId) ?? sourceUnits.find((item) => item.id === selectedNodeId) ?? editionNodes[0] ?? sourceUnits[0];
  const storedPaperChat = answers[paperChatAnswerKey] ?? '';
  useEffect(() => { const frame = window.requestAnimationFrame(() => { const saved = parsePaperChat(storedPaperChat); paperMessagesRef.current = saved; setPaperMessages(saved); setPaperQuestion(''); }); return () => window.cancelAnimationFrame(frame); }, [paper?.id, storedPaperChat]);
  useEffect(() => { if (paper?.id) window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); }, [paper?.id]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuestion(''), 0);
    return () => window.clearTimeout(timer);
  }, [selectedNodeId]);
  useEffect(() => {
    if (!audit || editionNodes.some((item) => item.id === selectedNodeId) || sourceUnits.some((item) => item.id === selectedNodeId)) return;
    const timer = window.setTimeout(() => setSelectedNodeId(editionNodes[0]?.id ?? sourceUnits[0]?.id ?? ''), 0);
    return () => window.clearTimeout(timer);
  }, [audit, editionNodes, selectedNodeId, setSelectedNodeId, sourceUnits]);
  useEffect(() => {
    const previous = selectedDocumentElementRef.current;
    previous?.classList.remove('source-block-selected', 'source-result-selected');
    selectedDocumentElementRef.current = null;
    if (mode !== 'interactive' || !selectedNodeId) return;
    const target = readerDocumentRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(selectedNodeId)}"]`) ?? null;
    if (!target) return;
    target.classList.add(target.classList.contains('source-result') ? 'source-result-selected' : 'source-block-selected');
    selectedDocumentElementRef.current = target;
  }, [audit, edition, expanded, marks, mode, notes, patches, selectedNodeId, units]);
  useEffect(() => { const update = () => setIsFullscreen(Boolean(document.fullscreenElement)); document.addEventListener('fullscreenchange', update); return () => document.removeEventListener('fullscreenchange', update); }, []);
  useEffect(() => { const saved = Number(window.localStorage.getItem(paperScaleKey)); const frame = window.requestAnimationFrame(() => { if (Number.isFinite(saved) && saved >= .8 && saved <= 1.4) setPaperScale(saved); setPaperScaleReady(true); }); return () => window.cancelAnimationFrame(frame); }, []);
  useEffect(() => { if (paperScaleReady) window.localStorage.setItem(paperScaleKey, String(paperScale)); }, [paperScale, paperScaleReady]);
  useEffect(() => {
    function dismissFloatingReaderPanels(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('[data-reader-floating-panel], .reader-floating-panel, .reader-tool-dock')) return;
      // Selecting paper text is the core markup interaction. Keep the toolbar
      // mounted until pointer-up so its active tool can apply immediately.
      if (document.body.dataset.readerMarkupActive === 'true' && target.closest('.reader-document')) return;
      setOutlineOpen(false); setInspectorOpen(false); setPaperChatOpen(false); setReferenceOpen(false); setMarkupOpen(false); setToolsOpen(false); setFontPanelOpen(false); setPrintOpen(false); setMobileDockOpen(false);
    }
    document.addEventListener('pointerdown', dismissFloatingReaderPanels, true);
    return () => document.removeEventListener('pointerdown', dismissFloatingReaderPanels, true);
  }, []);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = JSON.parse(window.localStorage.getItem(assistantSizeKey) ?? 'null') as AssistantSize | null;
        if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) setAssistantSize({ width: Math.max(280, saved.width), height: Math.max(240, saved.height) });
      } catch { /* Use the compact default assistant size. */ }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  function beginAssistantResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault(); event.stopPropagation();
    const panel = event.currentTarget.closest<HTMLElement>('.reader-inspector'); if (!panel) return;
    const start = panel.getBoundingClientRect(); const startX = event.clientX; const startY = event.clientY; let next = { width: start.width, height: start.height };
    const move = (pointer: PointerEvent) => {
      const maximumWidth = window.innerWidth <= 720 ? window.innerWidth - 16 : window.innerWidth - 82;
      next = { width: Math.round(Math.min(maximumWidth, Math.max(280, start.width - (pointer.clientX - startX)))), height: Math.round(Math.min(window.innerHeight - 76, Math.max(240, start.height + (pointer.clientY - startY)))) };
      setAssistantSize(next);
    };
    const finish = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); document.body.classList.remove('assistant-resizing'); window.localStorage.setItem(assistantSizeKey, JSON.stringify(next)); };
    document.body.classList.add('assistant-resizing'); window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish, { once: true });
  }
  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (isFullscreen) setIsFullscreen(false);
    else {
      const page = document.querySelector<HTMLElement>('.reader-page');
      let enteredNative = false;
      if (page?.requestFullscreen) {
        try { await page.requestFullscreen(); enteredNative = Boolean(document.fullscreenElement); } catch { /* Use the embedded-reader fallback below. */ }
      }
      if (!enteredNative) setIsFullscreen(true);
    }
    setToolsOpen(false); setFontPanelOpen(false);
  }
  function showRightPanel(panel: 'outline' | 'chat' | 'assistant' | 'reference' | 'markup' | 'tools' | null) {
    setOutlineOpen(panel === 'outline'); setPaperChatOpen(panel === 'chat'); setInspectorOpen(panel === 'assistant'); setReferenceOpen(panel === 'reference'); setMarkupOpen(panel === 'markup'); setToolsOpen(panel === 'tools'); setMobileDockOpen(false);
  }
  function openOriginalPaper(targetPage?: number) { setOriginalPage(targetPage); setMode('source'); setEdition('original'); showRightPanel(null); setPrintOpen(false); setFontPanelOpen(false); setExportOpen(false); setComparisonOpen(false); }
  function returnToEnhancedPaper() { setMode('interactive'); setEdition('working'); setOriginalPage(undefined); }
  function printOriginalPaper() { const frame = document.querySelector<HTMLIFrameElement>('.reader-pdf'); try { if (frame?.contentWindow) { frame.contentWindow.focus(); frame.contentWindow.print(); return; } } catch { /* Fall through to the browser's native PDF tab. */ } const printable = window.open(pdfUrl, '_blank', 'noopener,noreferrer'); if (printable) window.setTimeout(() => { printable.focus(); printable.print(); }, 650); }
  function jumpToDocumentUnit(nodeId: string) { setSelectedNodeId(nodeId); window.dispatchEvent(new CustomEvent('proofroom:jump-unit', { detail: nodeId })); }
  async function askPaperContext() {
    const prompt = paperQuestion.trim();
    if (!paper || !audit || !prompt || paperAsking) return;
    const processId = `paper-question:${paper.id}`;
    reportReaderProcess({ id: processId, label: 'Full-paper question', detail: paper.title, status: 'running' });
    const userMessages: PaperChatMessage[] = [...paperMessagesRef.current, { role: 'user', text: prompt }]; paperMessagesRef.current = userMessages; setPaperMessages(userMessages); savePaperMessages(userMessages); setPaperQuestion(''); setPaperAsking(true);
    try {
      const response = await fetch(`${bridgeUrl}/paper-question`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper, profile, node, question: prompt, threadId: audit.threadId }) });
      const data = await readServiceResponse(response);
      if (!response.ok) throw new Error(data.error || 'Local Codex could not answer this paper question.');
      rememberAuditThread(readString(data.threadId));
      const completed: PaperChatMessage[] = [...paperMessagesRef.current, { role: 'assistant', text: readString(data.text) }]; paperMessagesRef.current = completed; setPaperMessages(completed); savePaperMessages(completed); reportReaderProcess({ id: processId, label: 'Full-paper answer ready', detail: paper.title, status: 'complete' });
    } catch (error) { const message = error instanceof Error ? error.message : 'The local Codex question failed.'; const failed: PaperChatMessage[] = [...paperMessagesRef.current, { role: 'assistant', text: message }]; paperMessagesRef.current = failed; setPaperMessages(failed); savePaperMessages(failed); reportReaderProcess({ id: processId, label: 'Full-paper question stopped', detail: message, status: 'error' }); }
    finally { setPaperAsking(false); }
  }
  async function attachCitationSource(citation: CitationReference, file: File) {
    if (!paper) throw new Error('No paper is open.');
    const dataBase64 = await fileAsBase64(file);
    const response = await fetch(`${bridgeUrl}/vault/citation-asset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId: paper.id, upload: { citation, fileName: file.name, mime: file.type, dataBase64 } }) });
    const data = await readServiceResponse(response); if (!response.ok) throw new Error(data.error || 'The cited source could not be attached.');
    return readString(data.saved?.relativePath);
  }
  function openReference(citation?: CitationReference) {
    if (citation) setReferenceTarget({ title: citationTitle(citation, citation.key), arxivId: citation.arxivId || undefined, url: citation.arxivId ? `https://arxiv.org/pdf/${citation.arxivId}` : citation.url || citation.searchUrl });
    showRightPanel('reference');
  }
  async function expandProofStep(target: AuditNode, step: string, index: number) {
    if (!paper || !audit?.threadId) throw new Error('Run the full-paper audit first.');
    const visibleLines = indexedVisibleProof(target.id);
    const prompt = `Expand Step ${index + 1} of the AI proof map in complete mathematical detail: “${step}”. Use the complete original proof and the durable full-paper audit as the authority. State every prerequisite used, fill in intermediate equations, explain each implication, and identify exactly where this step occurs using the reader-visible L-numbers below. Cite only line numbers supported by this map. Clearly separate text present in the source from explanatory details you supply. Do not invent a missing argument.\n\nReader-visible proof map:\n${visibleLines || 'No rendered line map is available; do not claim an L-number.'}`;
    const response = await fetch(`${bridgeUrl}/node-question`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper, profile, node: target, question: prompt, threadId: audit.threadId }) });
    const data = await readServiceResponse(response); if (!response.ok) throw new Error(data.error || 'This proof step could not be expanded.');
    return readString(data.text);
  }
  async function expandProofRequest(target: AuditNode, request: string) {
    if (!paper || !audit?.threadId) throw new Error('Run the full-paper audit first.');
    const visibleLines = indexedVisibleProof(target.id);
    const prompt = `The reader is working inside the complete proof of ${displayUnitLabel(target)} and asks: “${request}”. The L-labels refer exactly to the current rendered proof-line map below, including one line for each displayed formula. Give a detailed, source-faithful expansion at exactly the requested scope; include intermediate equations and prerequisites, distinguish author text from explanation, and do not invent missing mathematics.\n\nReader-visible proof map:\n${visibleLines || 'No rendered line map is available; ask the reader to reopen the proof before claiming an L-number.'}`;
    const response = await fetch(`${bridgeUrl}/node-question`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper, profile, node: target, question: prompt, threadId: audit.threadId }) });
    const data = await readServiceResponse(response); if (!response.ok) throw new Error(data.error || 'The proof could not be expanded.');
    return readString(data.text);
  }
  if (!paper) return <EmptyVault onImport={openImport} />;
  const hasOriginalPdf = hasOriginalPaper(paper);
  if (!audit) return <section className="mx-auto max-w-3xl px-6 py-14"><div className="rounded-xl border border-[#d8e4d9] bg-[#f3f8f3] p-7"><h2 className="text-2xl font-bold tracking-[-.04em]">Analyze this paper to begin.</h2><div className="mt-6 flex gap-2"><button onClick={analyze} disabled={analysing} className="rounded-md bg-[#2d654f] px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50">{analysing ? 'Auditing…' : auditActionLabel ?? 'Analyze'}</button>{hasOriginalPdf && <a href={originalPaperUrl(paper)} target="_blank" rel="noreferrer" className="rounded-md border border-[#cddbd0] bg-white px-4 py-2.5 text-xs font-bold text-[#39634c]">Original PDF ↗</a>}</div></div></section>;
  const page = originalPage ?? node?.anchor.page ?? undefined; const pdfUrl = originalPaperUrl(paper, page);
  return <section className={`reader-page ${mode === 'source' ? 'reader-original-mode' : ''} ${analysing ? 'reader-audit-locked' : ''} ${isFullscreen ? 'reader-fullscreen-active' : ''}`}><div className="fullscreen-edge-top" aria-hidden="true" /><div className="reader-titlebar"><h2><MathText value={paper.title} /></h2>{analysing && <span className="reader-edit-lock"><i />Audit running · editing paused</span>}<div className="reader-top-actions">{hasOriginalPdf && <button className={mode === 'source' ? 'active reader-back-to-paper' : ''} onClick={() => mode === 'source' ? returnToEnhancedPaper() : openOriginalPaper(node?.anchor.page ?? undefined)} aria-label={mode === 'source' ? 'Back to enhanced paper' : 'Open original paper'}><ReaderIcon name="original" /><span>{mode === 'source' ? 'Back to paper' : 'Original paper'}</span></button>}<button className={fontPanelOpen ? 'active' : ''} onClick={() => { setFontPanelOpen(!fontPanelOpen); setPrintOpen(false); }} aria-label="Adjust paper text size"><ReaderIcon name="magnify" /><span>Text size</span><output>{Math.round(paperScale * 100)}%</output></button><button className={isFullscreen ? 'active' : ''} onClick={() => void toggleFullscreen()} aria-label={isFullscreen ? 'Exit fullscreen reading' : 'Enter fullscreen reading'}><ReaderIcon name="fullscreen" /><span>{isFullscreen ? 'Exit full screen' : 'Full screen'}</span></button><button className={printOpen ? 'active' : ''} onClick={() => { if (mode === 'source') printOriginalPaper(); else { setPrintOpen(!printOpen); setFontPanelOpen(false); } }} aria-label={mode === 'source' ? 'Print the original paper' : 'Print or save the working paper'}><ReaderIcon name="print" /><span>Print</span></button><button onClick={analyze} disabled={analysing} className="reader-reaudit">{analysing ? 'Auditing…' : auditActionLabel ?? 'Re-audit'}</button></div></div>{activePath && focusPath && mode !== 'source' && <div className="reader-path"><b>{activePath.goal}</b><span>{activePath.reason}</span><button onClick={() => setFocusPath(false)}>Show full paper</button></div>}
    <div className={`reader-grid ${outlineOpen ? 'reader-grid-outline' : ''} ${inspectorOpen ? 'reader-grid-inspector' : ''}`}>{outlineOpen && <aside className="reader-outline reader-drawer" data-reader-floating-panel><div className="drawer-head"><div><span className="reader-kicker">Logical outline</span><b>{units.length} units</b></div><button type="button" onPointerDown={(event) => { event.stopPropagation(); setOutlineOpen(false); }} onClick={(event) => event.stopPropagation()} aria-label="Close outline">×</button></div><div className="space-y-0.5">{units.map((item) => { const changed = patchForNode(patches, item.id); return <button key={item.id} onClick={() => jumpToDocumentUnit(item.id)} className={`outline-unit ${selectedNodeId === item.id ? 'outline-unit-active' : ''}`}><span className={`outline-kind ${kindClass(item.kind)}`}>{item.kind[0].toUpperCase()}</span><span className="min-w-0"><small>{displayUnitLabel(item)}</small><b><MathText value={item.title} /></b></span>{changed && <i className="working-dot" title={changed.kind === 'add' ? 'Added in working edition' : 'Edited in working edition'}>W</i>}{item.status !== 'verified' && !changed && <i className="ml-auto h-1.5 w-1.5 flex-none rounded-full bg-[#b8873c]" />}</button>; })}</div></aside>}
      <main ref={readerDocumentRef} className="reader-document" style={{ zoom: paperScale, width: `${100 / paperScale}%` } as CSSProperties}>{mode === 'source' ? <iframe title={`Original paper: ${paper.title}`} src={pdfUrl} className="reader-pdf" /> : <InteractiveDocument paper={paper} audit={audit} nodes={units} notes={notes} saveNote={saveNote} updateNote={updateNote} deleteNote={deleteNote} setSelectedNodeId={setSelectedNodeId} expanded={expanded} setExpanded={setExpanded} marks={marks} setMark={setMark} patches={patches} savePatches={savePatches} openAssistant={(view = 'ask') => { setAssistantRequest((current) => ({ view, nonce: (current?.nonce ?? 0) + 1 })); showRightPanel('assistant'); }} openReference={openReference} expandCitation={(target, citation) => { const prompt = `Retrieve and expand the cited ${citation.locator || 'result'} from “${citation.title}” (${citation.url}). Show its complete original statement and proof when accessible, then explain how this paper uses it. Clearly identify anything that could not be verified.`; setSelectedNodeId(target.id); setQuestion(prompt); showRightPanel('assistant'); void askNode(target, prompt); }} attachCitation={attachCitationSource} expandProofStep={expandProofStep} expandProofRequest={expandProofRequest} />}</main>
      {inspectorOpen && mode !== 'source' && <aside className="reader-inspector reader-drawer" data-reader-floating-panel style={assistantSize ? { width: assistantSize.width, height: assistantSize.height } : undefined}><div className="drawer-head"><b>Assistant</b><button onClick={() => setInspectorOpen(false)} aria-label="Close assistant">×</button></div>{node ? <NodeInspector key={`${edition}:${node.id}`} paper={paper} node={node} originalNode={audit.nodes.find((item) => item.id === node.id)} plainSource={node.id.startsWith('source-block:')} edition={edition} patches={patches} savePatches={savePatches} suggestEdit={suggestEdit} expanded={expanded[node.id] !== false} setExpanded={(value) => setExpanded(node.id, value)} expandProof={expandProofRequest} notes={notes.filter((item) => item.nodeId === node.id).slice(0, 1)} answer={answers[node.id]} question={question} setQuestion={setQuestion} asking={askingId === node.id} ask={() => void askNode(node, question)} saveNote={saveNote} updateNote={updateNote} deleteNote={deleteNote} graph={graph} addLink={addLink} removeLink={removeLink} openUnit={openUnit} openOriginalPaper={openOriginalPaper} assistantRequest={assistantRequest} clearAssistantRequest={() => setAssistantRequest(null)} /> : <p className="p-4 text-xs text-[#6e6a64]">Select a document unit.</p>}<button className="assistant-resize-handle" onPointerDown={beginAssistantResize} aria-label="Resize assistant panel" title="Drag to resize" /></aside>}</div>
    {mode !== 'source' && <><div className="fullscreen-edge-right" aria-hidden="true" /><nav className={`reader-tool-dock ${mobileDockOpen ? 'mobile-open' : ''}`} aria-label="Paper tools"><button className={outlineOpen ? 'active' : ''} onClick={() => showRightPanel(outlineOpen ? null : 'outline')} aria-label="Toggle logical outline"><b>☰</b><span>Outline</span></button><button className={paperChatOpen ? 'active' : ''} onClick={() => showRightPanel(paperChatOpen ? null : 'chat')} aria-label="Ask AI about the whole paper"><b>?</b><span>Ask paper</span></button><button className={inspectorOpen ? 'active' : ''} onClick={() => showRightPanel(inspectorOpen ? null : 'assistant')} disabled={!node} aria-label="Toggle AI, notes, and editing"><b>AI</b><span>Current text</span></button><button className={referenceOpen ? 'active' : ''} onClick={() => showRightPanel(referenceOpen ? null : 'reference')} aria-label="Open floating reference reader"><ReaderIcon name="reference" /><span>Reference reader</span></button><button className={markupOpen ? 'active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => showRightPanel(markupOpen ? null : 'markup')} aria-label="Open text markup tools"><b className="markup-dock-icon">✎</b><span>Markup</span></button><button className={toolsOpen ? 'active' : ''} onClick={() => showRightPanel(toolsOpen ? null : 'tools')} aria-label="More reader options"><b>•••</b><span>More options</span></button></nav><button className={`reader-mobile-tools-toggle ${mobileDockOpen ? 'active' : ''}`} onClick={() => setMobileDockOpen((open) => !open)} aria-expanded={mobileDockOpen} aria-label={mobileDockOpen ? 'Hide paper tools' : 'Show paper tools'}><span aria-hidden="true">{mobileDockOpen ? '×' : '•••'}</span></button></>}
    {fontPanelOpen && <aside className="paper-size-popover" data-reader-floating-panel aria-label="Paper text size"><header><div><b>Paper text size</b><span>Applies to the complete paper</span></div><button onClick={() => setFontPanelOpen(false)} aria-label="Close text size controls">×</button></header><input aria-label="Paper text size percentage" type="range" min="80" max="140" step="10" value={Math.round(paperScale * 100)} onChange={(event) => setPaperScale(Number(event.target.value) / 100)} /><div className="paper-size-row"><button onClick={() => setPaperScale((value) => Math.max(.8, Number((value - .1).toFixed(1))))} disabled={paperScale <= .8} aria-label="Decrease paper text size">A−</button><output aria-live="polite">{Math.round(paperScale * 100)}%</output><button onClick={() => setPaperScale((value) => Math.min(1.4, Number((value + .1).toFixed(1))))} disabled={paperScale >= 1.4} aria-label="Increase paper text size">A+</button><button onClick={() => setPaperScale(1)}>Reset</button></div></aside>}
    {toolsOpen && <aside className="reader-tool-menu" data-reader-floating-panel><header><b>More reader options</b><button onClick={() => setToolsOpen(false)} aria-label="Close reader options">×</button></header><section><label htmlFor="focus-selection">Focus on</label><select id="focus-selection" value={focusSelection} onChange={(event) => setFocusSelection(event.target.value)}>{audit.readingPaths.length > 0 && <optgroup label="Audited reading goals">{audit.readingPaths.map((path, index) => <option key={`${path.goal}:${index}`} value={`path:${index}`}>{path.goal}</option>)}</optgroup>}<optgroup label="A specific result">{editionNodes.filter((item) => ['theorem', 'lemma', 'proposition', 'corollary', 'conjecture', 'definition'].includes(item.kind)).map((item) => <option key={item.id} value={`result:${item.id}`}>{displayUnitLabel(item)}{item.title ? ` — ${item.title}` : ''}</option>)}</optgroup></select><div className="focus-actions"><button onClick={() => { setFocusPath(true); setMode('interactive'); setToolsOpen(false); }}>Apply focus</button>{focusPath && <button onClick={() => setFocusPath(false)}>Show all</button>}</div></section><footer><button onClick={() => { setExportOpen(true); setToolsOpen(false); }}>Save selected parts</button><button onClick={() => { setComparisonOpen(true); setToolsOpen(false); }}>Compare versions</button></footer></aside>}
    {paperChatOpen && <PaperChatDialog paper={paper} currentNode={node} messages={paperMessages} question={paperQuestion} setQuestion={setPaperQuestion} asking={paperAsking} ask={() => void askPaperContext()} close={() => setPaperChatOpen(false)} />}{printOpen && <PrintPanel paper={paper} audit={audit} workingNodes={applyWorkingPatches(originalNodes, patches)} patches={patches} edition={edition} setEdition={setEdition} mode={mode} setMode={setMode} readerNotes={readerNotes} notes={notes} close={() => setPrintOpen(false)} />}{referenceOpen && <ReferenceReaderPanel paper={paper} graph={graph} target={referenceTarget} setTarget={setReferenceTarget} attach={attachCitationSource} close={() => setReferenceOpen(false)} />}{markupOpen && <AnnotationToolbar close={() => setMarkupOpen(false)} />}{exportOpen && <ExportPaperPanel paper={paper} audit={audit} nodes={editionNodes} patches={patches} focusIds={activePath?.nodeIds ?? []} readerNotes={readerNotes} notes={notes} focusActive={focusPath} close={() => setExportOpen(false)} />}{comparisonOpen && <VersionComparisonPanel paper={paper} profile={profile} audit={audit} openUnit={openUnit} close={() => setComparisonOpen(false)} />}</section>;
}

function completeLatexSource(paper: Paper, audit: PaperAudit, nodes: AuditNode[], patches: WorkingPatch[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const citationKeys = new Map<string, CitationReference>();
  for (const node of nodes) for (const citation of node.citations ?? []) citationKeys.set(citation.key, citation);
  const sourceText = (value: string) => String(value || '').replace(/\[\[cite:([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_match, key, locator) => `\\cite${locator ? `[${locator}]` : ''}{${key}}`);
  const lines = ['\\documentclass[11pt]{article}', '\\usepackage{amsmath,amssymb,amsthm,mathtools,graphicx,xcolor,hyperref}', '\\newtheorem{theorem}{Theorem}[section]', '\\newtheorem{lemma}[theorem]{Lemma}', '\\newtheorem{proposition}[theorem]{Proposition}', '\\newtheorem{corollary}[theorem]{Corollary}', '\\newtheorem{conjecture}[theorem]{Conjecture}', '\\theoremstyle{definition}', '\\newtheorem{definition}[theorem]{Definition}', '\\newtheorem{assumption}[theorem]{Assumption}', '\\newtheorem{remark}[theorem]{Remark}', '\\newtheorem{example}[theorem]{Example}', `\\title{${sourceText(paper.title)}}`, `\\author{${sourceText(paper.authors)}}`, '\\date{}', '\\begin{document}', '\\maketitle', '\\begin{abstract}', sourceText(paper.abstract), '\\end{abstract}', ''];
  const blocks = audit.sourceBlocks?.length ? audit.sourceBlocks : nodes.flatMap((node, index): SourceBlock[] => [{ id: `export-result-${index}`, kind: 'result', level: 4, title: '', content: node.statement, proofText: '', nodeId: node.id, resultKind: node.kind, citations: node.citations ?? [], assetPaths: [], caption: '' }, ...(node.proofText ? [{ id: `export-proof-${index}`, kind: 'proof' as const, level: 4, title: '', content: '', proofText: node.proofText, nodeId: node.id, resultKind: node.kind, citations: node.citations ?? [], assetPaths: [], caption: '' }] : [])]);
  for (const block of blocks) {
    const workingValue = sourceBlockValue(block, patches);
    if (block.kind === 'section') { const command = block.level <= 1 ? 'section' : block.level === 2 ? 'subsection' : 'subsubsection'; lines.push(`\\${command}{${sourceText(workingValue)}}`, ''); continue; }
    if (block.kind === 'paragraph') { lines.push(sourceText(workingValue), ''); continue; }
    if (block.kind === 'figure') { if (block.assetPaths.length) { lines.push('\\begin{figure}[htbp]', '\\centering', ...block.assetPaths.map((asset) => `\\includegraphics[width=\\linewidth]{${asset}}`), ...(workingValue ? [`\\caption{${sourceText(workingValue)}}`] : []), '\\end{figure}', ''); } continue; }
    const node = byId.get(block.nodeId); if (!node) continue;
    if (block.kind === 'proof') { const proof = node.proofText || block.proofText; if (proof.trim()) lines.push('\\begin{proof}', sourceText(proof), '\\end{proof}', ''); continue; }
    const environment = ['theorem', 'lemma', 'proposition', 'corollary', 'conjecture', 'definition', 'assumption', 'remark', 'example'].includes(node.kind) ? node.kind : 'remark';
    lines.push(`\\begin{${environment}}${block.title ? `[${sourceText(block.title)}]` : ''}`, sourceText(node.statement || block.content), `\\end{${environment}}`, '');
  }
  if (citationKeys.size) { lines.push('\\begin{thebibliography}{99}'); for (const citation of citationKeys.values()) lines.push(`\\bibitem{${citation.key}} ${sourceText([citation.authors, citation.title, citation.text].filter(Boolean).join('. '))}`); lines.push('\\end{thebibliography}', ''); }
  lines.push('\\end{document}', ''); return lines.join('\n');
}

function PrintPanel({ paper, audit, workingNodes, patches, edition, setEdition, mode, setMode, readerNotes, notes, close }: { paper: Paper; audit: PaperAudit; workingNodes: AuditNode[]; patches: WorkingPatch[]; edition: EditionMode; setEdition: (value: EditionMode) => void; mode: ReaderMode; setMode: (value: ReaderMode) => void; readerNotes: Record<string, string>; notes: Note[]; close: () => void }) {
  const [annotations, setAnnotations] = useState(false);
  const [proofMaps, setProofMaps] = useState(false);
  const [citations, setCitations] = useState(false);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [error, setError] = useState(''); const [saved, setSaved] = useState(''); const [savingLatex, setSavingLatex] = useState(false);
  const nodes = workingNodes;
  async function buildPrintView() {
    const printWindow = window.open('', '_blank', 'popup,width=980,height=820');
    if (!printWindow) { setError('Allow pop-ups once so the local print view can open.'); return; }
    printWindow.document.write('<title>Preparing print view…</title><p style="font:14px system-ui;padding:24px">Building the print-ready paper locally…</p>');
    const previousEdition = edition; const previousMode = mode;
    setMode('interactive'); setEdition('working');
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
    const source = document.querySelector<HTMLElement>('.source-document');
    if (!source) { printWindow.close(); setError('The paper view was not ready. Please try again.'); setEdition(previousEdition); setMode(previousMode); return; }
    const clone = source.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.tex-edit-hint,.reading-mark-control,.proof-reading-tools,.audit-peek,.source-result > footer,.source-block-actions,.source-section-toggle,.paper-reading-guide,.source-completeness').forEach((element) => element.remove());
    if (!annotations) clone.querySelectorAll('[class*="reading-mark-"],.tex-modified').forEach((element) => { element.className = element.className.replace(/reading-mark-(?:understood|question|error)|tex-modified/g, '').trim(); });
    if (!proofMaps) clone.querySelectorAll('.proof-map').forEach((element) => element.remove());
    if (!citations) clone.querySelectorAll('.citation-sources').forEach((element) => element.remove());
    if (includeNotes) {
      const entries = [...Object.entries(readerNotes).filter(([, value]) => value.trim()).map(([nodeId, value]) => ({ anchor: displayUnitLabel(nodes.find((item) => item.id === nodeId) ?? { kind: 'section', label: 'Paper note' } as AuditNode), value })), ...notes.filter((note) => note.text.trim()).map((note) => ({ anchor: note.anchor, value: `${note.text}${note.latex ? `\n\n${note.latex}` : ''}` }))];
      if (entries.length) { const section = document.createElement('section'); section.className = 'print-reader-notes'; const heading = document.createElement('h2'); heading.textContent = 'Reader notes'; section.appendChild(heading); for (const entry of entries) { const article = document.createElement('article'); article.innerHTML = '<b></b><p></p>'; const label = article.querySelector('b'); const text = article.querySelector('p'); if (label) label.textContent = entry.anchor; if (text) text.textContent = entry.value; section.appendChild(article); } clone.appendChild(section); }
    }
    const styles = [...document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')].map((element) => element.outerHTML).join('\n');
    printWindow.document.open();
    printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${paper.title.replace(/[<>]/g, '')}</title>${styles}<style>body{margin:0;background:#fff}.source-document{width:100%;max-width:none;padding:0}.interactive-lead,.original-source-flow{max-width:760px;margin-inline:auto;border:0;box-shadow:none}.print-reader-notes{max-width:760px;margin:36px auto;padding:24px 0;border-top:1px solid #999}.print-reader-notes h2{font:600 24px Georgia,serif}.print-reader-notes article{margin:16px 0}.print-reader-notes b{font:700 10px system-ui;color:#666}.print-reader-notes p{white-space:pre-wrap;font:14px/1.6 Georgia,serif}@page{margin:18mm}@media print{.source-document{padding:0!important}.source-result,.source-proof{break-inside:avoid-page}.citation-source-popover,.unit-hover-card{display:none!important}}</style></head><body></body></html>`);
    printWindow.document.close(); printWindow.document.body.appendChild(printWindow.document.importNode(clone, true));
    setEdition(previousEdition); setMode(previousMode);
    window.setTimeout(() => { printWindow.focus(); printWindow.print(); }, 500);
  }
  async function saveLatex() { setSavingLatex(true); setError(''); setSaved(''); try { const response = await fetch(`${bridgeUrl}/vault/latex-export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId: paper.id, export: { edition: 'working', content: completeLatexSource(paper, audit, nodes, patches) } }) }); const data = await readServiceResponse(response); if (!response.ok) throw new Error(data.error || 'The complete LaTeX source could not be saved.'); setSaved(readString(data.saved?.relativePath)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The complete LaTeX source could not be saved.'); } finally { setSavingLatex(false); } }
  return <aside className="print-panel reader-floating-panel" aria-label="Print options"><header><div><b>Print or save</b></div><button onClick={close} aria-label="Close print options">×</button></header><div className="print-options"><label><input type="checkbox" checked={annotations} onChange={(event) => setAnnotations(event.target.checked)} /><span>Reading marks and edit highlights</span></label><label><input type="checkbox" checked={includeNotes} onChange={(event) => setIncludeNotes(event.target.checked)} /><span>Reader notes</span></label><label><input type="checkbox" checked={citations} onChange={(event) => setCitations(event.target.checked)} /><span>Cited-source cards</span></label><label><input type="checkbox" checked={proofMaps} onChange={(event) => setProofMaps(event.target.checked)} /><span>AI proof maps</span></label></div>{error && <p className="panel-error">{error}</p>}{saved && <p className="panel-saved">Saved locally: {saved}</p>}<footer><button onClick={() => void saveLatex()} disabled={savingLatex}>{savingLatex ? 'Saving LaTeX…' : 'Save complete LaTeX'}</button><button onClick={() => void buildPrintView()}>Build PDF & print</button></footer></aside>;
}

type MarkupTool = 'highlight' | 'underline' | 'bold' | 'italic' | 'color';

function AnnotationToolbar({ close }: { close: () => void }) {
  const [highlightColor, setHighlightColor] = useState('#ffe58a'); const [textColor, setTextColor] = useState('#8f1d2c'); const [status, setStatus] = useState('Choose a tool, then select paper text.'); const [undoCount, setUndoCount] = useState(0); const [activeTool, setActiveTool] = useState<MarkupTool | 'erase' | null>(null); const undoRef = useRef<HTMLElement[][]>([]); const selectedRangeRef = useRef<Range | null>(null); const activeToolRef = useRef<MarkupTool | 'erase' | null>(null); const autoActionRef = useRef<(tool: MarkupTool | 'erase') => void>(() => undefined);
  useEffect(() => { const remember = () => { const selection = window.getSelection(); const paperRoot = document.querySelector('.reader-document'); if (selection && selection.rangeCount > 0 && !selection.isCollapsed && selection.toString().trim() && paperRoot?.contains(selection.getRangeAt(0).commonAncestorContainer)) selectedRangeRef.current = selection.getRangeAt(0).cloneRange(); }; remember(); document.addEventListener('selectionchange', remember); document.addEventListener('pointerup', remember, true); return () => { document.removeEventListener('selectionchange', remember); document.removeEventListener('pointerup', remember, true); }; }, []);
  function selectedRange() { const selection = window.getSelection(); const paperRoot = document.querySelector('.reader-document'); if (selection && selection.rangeCount > 0 && !selection.isCollapsed && selection.toString().trim() && paperRoot?.contains(selection.getRangeAt(0).commonAncestorContainer)) return selection.getRangeAt(0).cloneRange(); const remembered = selectedRangeRef.current; return remembered && paperRoot?.contains(remembered.commonAncestorContainer) ? remembered.cloneRange() : null; }
  function selectableTextNodes(range: Range) {
    const common = range.commonAncestorContainer; const root = common.nodeType === window.Node.TEXT_NODE ? common.parentNode : common; if (!root) return [] as Text[];
    const nodes: Text[] = []; if (common.nodeType === window.Node.TEXT_NODE) nodes.push(common as Text);
    else { const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT); let current = walker.nextNode(); while (current) { nodes.push(current as Text); current = walker.nextNode(); } }
    return nodes.filter((node) => { const parent = node.parentElement; if (!parent || !node.data.trim() || parent.closest('.reader-tool-dock,.annotation-toolbar,.reader-floating-panel,.editable-tex-source,button,input,textarea,select,.katex,.proof-line-gutter')) return false; try { return range.intersectsNode(node); } catch { return false; } });
  }
  function apply(tool: MarkupTool) {
    const range = selectedRange(); if (!range) { setStatus('Select some paper text first.'); return; }
    const wrappers: HTMLElement[] = [];
    for (const node of selectableTextNodes(range)) {
      const start = node === range.startContainer ? range.startOffset : 0; const end = node === range.endContainer ? range.endOffset : node.data.length; if (end <= start) continue;
      const tail = node.splitText(end); void tail; const selected = node.splitText(start); const wrapper = document.createElement('span'); wrapper.className = `reader-annotation reader-annotation-${tool}`; wrapper.dataset.readerAnnotation = tool;
      if (tool === 'highlight') wrapper.style.backgroundColor = highlightColor; if (tool === 'underline') { wrapper.style.textDecoration = `underline 2px ${textColor}`; wrapper.style.textUnderlineOffset = '3px'; } if (tool === 'bold') wrapper.style.fontWeight = '800'; if (tool === 'italic') wrapper.style.fontStyle = 'italic'; if (tool === 'color') wrapper.style.color = textColor;
      selected.parentNode?.replaceChild(wrapper, selected); wrapper.appendChild(selected); wrappers.push(wrapper);
    }
    window.getSelection()?.removeAllRanges(); selectedRangeRef.current = null; if (!wrappers.length) { setStatus('That selection contains no editable paper text.'); return; } undoRef.current.push(wrappers); setUndoCount(undoRef.current.length); setStatus(`${tool[0].toUpperCase() + tool.slice(1)} applied.`);
  }
  function erase() {
    const range = selectedRange(); if (!range) { setStatus('Select marked text to erase its formatting.'); return; } const marks = [...document.querySelectorAll<HTMLElement>('.reader-document .reader-annotation')].filter((element) => { try { return range.intersectsNode(element); } catch { return false; } });
    for (const mark of marks) mark.replaceWith(...mark.childNodes); window.getSelection()?.removeAllRanges(); selectedRangeRef.current = null; setStatus(marks.length ? 'Formatting erased.' : 'No markup was found in that selection.');
  }
  function undo() { const wrappers = undoRef.current.pop() ?? []; for (const wrapper of wrappers) if (wrapper.isConnected) wrapper.replaceWith(...wrapper.childNodes); setUndoCount(undoRef.current.length); setStatus(wrappers.length ? 'Last markup undone.' : 'Nothing to undo.'); }
  function chooseTool(tool: MarkupTool | 'erase') { setActiveTool(tool); activeToolRef.current = tool; if (selectedRange()) { if (tool === 'erase') erase(); else apply(tool); } else setStatus(`${tool === 'erase' ? 'Eraser' : tool[0].toUpperCase() + tool.slice(1)} active — select text to apply.`); }
  useEffect(() => { autoActionRef.current = (tool) => { if (tool === 'erase') erase(); else apply(tool); }; });
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  useEffect(() => {
    document.body.dataset.readerMarkupActive = 'true';
    return () => { delete document.body.dataset.readerMarkupActive; };
  }, []);
  useEffect(() => {
    let startCaret: Range | null = null; let startPoint: { x: number; y: number } | null = null;
    const caretAt = (x: number, y: number) => {
      const extended = document as Document & { caretRangeFromPoint?: (left: number, top: number) => Range | null; caretPositionFromPoint?: (left: number, top: number) => { offsetNode: Node; offset: number } | null };
      const direct = extended.caretRangeFromPoint?.(x, y); if (direct) return direct;
      const position = extended.caretPositionFromPoint?.(x, y); if (!position) return null;
      const range = document.createRange(); range.setStart(position.offsetNode, position.offset); range.collapse(true); return range;
    };
    const insidePaper = (target: EventTarget | null) => target instanceof Node && Boolean(document.querySelector('.reader-document')?.contains(target)) && !(target instanceof Element && Boolean(target.closest('button,input,textarea,select,.editable-tex-source,.reader-floating-panel,.reader-tool-dock')));
    const beginSelection = (event: PointerEvent) => { if (!activeToolRef.current || !insidePaper(event.target)) return; startCaret = caretAt(event.clientX, event.clientY); startPoint = { x: event.clientX, y: event.clientY }; };
    const applyOnRelease = (event: PointerEvent) => {
      const tool = activeToolRef.current; const paperRoot = document.querySelector('.reader-document');
      if (!tool || !paperRoot?.contains(event.target as Node)) { startCaret = null; startPoint = null; return; }
      const selection = window.getSelection();
      if ((!selection || selection.isCollapsed || !selection.toString().trim()) && startCaret && startPoint && Math.hypot(event.clientX - startPoint.x, event.clientY - startPoint.y) > 3) {
        const endCaret = caretAt(event.clientX, event.clientY);
        if (endCaret && selection) {
          selection.removeAllRanges(); selection.addRange(startCaret); selection.extend(endCaret.startContainer, endCaret.startOffset);
          if (selection.rangeCount && selection.toString().trim()) selectedRangeRef.current = selection.getRangeAt(0).cloneRange();
        }
      }
      startCaret = null; startPoint = null; window.setTimeout(() => autoActionRef.current(tool), 0);
    };
    document.addEventListener('pointerdown', beginSelection, true); document.addEventListener('pointerup', applyOnRelease, true);
    return () => { document.removeEventListener('pointerdown', beginSelection, true); document.removeEventListener('pointerup', applyOnRelease, true); };
  }, []);
  const holdSelection = (event: ReactMouseEvent) => event.preventDefault();
  return <aside className="annotation-toolbar reader-floating-panel" onMouseDown={(event) => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }}><header><div><b>Markup</b><span>{status}</span></div><button onClick={close} aria-label="Close markup tools">×</button></header><div className="annotation-tools"><button className={activeTool === 'highlight' ? 'active' : ''} onMouseDown={holdSelection} onClick={() => chooseTool('highlight')} title="Highlight text as you select it"><i className="annotation-highlighter" style={{ background: highlightColor }} />Highlight</button><label title="Highlight color"><input type="color" value={highlightColor} onChange={(event) => setHighlightColor(event.target.value)} /><span>Highlight color</span></label><button className={activeTool === 'underline' ? 'active' : ''} onMouseDown={holdSelection} onClick={() => chooseTool('underline')}><u>U</u>Underline</button><button className={activeTool === 'bold' ? 'active' : ''} onMouseDown={holdSelection} onClick={() => chooseTool('bold')}><b>B</b>Bold</button><button className={activeTool === 'italic' ? 'active' : ''} onMouseDown={holdSelection} onClick={() => chooseTool('italic')}><i>I</i>Italic</button><button className={activeTool === 'color' ? 'active' : ''} onMouseDown={holdSelection} onClick={() => chooseTool('color')}><span style={{ color: textColor }}>A</span>Text color</button><label title="Text and underline color"><input type="color" value={textColor} onChange={(event) => setTextColor(event.target.value)} /><span>Text color</span></label><button className={activeTool === 'erase' ? 'active' : ''} onMouseDown={holdSelection} onClick={() => chooseTool('erase')}><span>⌫</span>Eraser</button><button onMouseDown={holdSelection} onClick={undo} disabled={!undoCount}><span>↶</span>Undo</button></div></aside>;
}

function ReferenceReaderPanel({ paper, graph, target, setTarget, attach, close }: { paper: Paper; graph: Graph; target: ReferenceTarget | null; setTarget: (value: ReferenceTarget | null) => void; attach: (citation: CitationReference, file: File) => Promise<string>; close: () => void }) {
  const [value, setValue] = useState(''); const [uploading, setUploading] = useState(false); const [uploadStatus, setUploadStatus] = useState('');
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null); const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const papers = useMemo(() => [...new Map(graph.nodes.filter((item) => item.paperId !== paper.id).map((item) => [item.paperId, { id: item.paperId, title: item.paperTitle, arxivId: item.arxivId }])).values()], [graph.nodes, paper.id]);
  function openValue() { const id = (value.match(/(?:abs|pdf)\/([^?#]+)|(?:arxiv:)?\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)/i)?.[1] || value.match(/(?:abs|pdf)\/([^?#]+)|(?:arxiv:)?\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)/i)?.[2] || '').replace(/\.pdf$/i, ''); if (id) setTarget({ title: `arXiv:${id}`, arxivId: id, url: `https://arxiv.org/pdf/${id}` }); else if (/^https?:\/\//i.test(value.trim())) setTarget({ title: value.trim(), url: value.trim() }); }
  async function upload(file: File) { const extension = file.name.split('.').pop()?.toLowerCase() ?? ''; if (!['pdf', 'tex', 'ltx', 'zip'].includes(extension)) { setUploadStatus('Choose one PDF, TeX file, or ZIP project.'); return; } setUploading(true); setUploadStatus(''); try { const citation: CitationReference = { key: `reader-upload-${Date.now()}`, locator: '', statement: '', title: file.name, authors: '', text: '', url: '', searchUrl: '', doi: '', arxivId: '', direct: true }; await attach(citation, file); const previewable = extension !== 'zip'; setTarget({ title: file.name, url: previewable ? URL.createObjectURL(file) : undefined }); setUploadStatus(previewable ? 'Attached locally' : 'ZIP source project attached locally'); } catch (error) { setUploadStatus(error instanceof Error ? error.message : 'Upload failed.'); } finally { setUploading(false); } }
  function beginDrag(event: ReactPointerEvent<HTMLElement>) { if ((event.target as HTMLElement).closest('button,select,input,a')) return; const rect = event.currentTarget.parentElement?.getBoundingClientRect(); if (!rect) return; event.currentTarget.setPointerCapture(event.pointerId); setDrag({ dx: event.clientX - rect.left, dy: event.clientY - rect.top }); setPosition({ x: rect.left, y: rect.top }); }
  function moveDrag(event: ReactPointerEvent<HTMLElement>) { if (!drag) return; const rect = event.currentTarget.parentElement?.getBoundingClientRect(); const width = rect?.width || 660; const height = rect?.height || 720; setPosition({ x: Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - drag.dx)), y: Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - drag.dy)) }); }
  return <aside className="reference-reader reader-floating-panel" style={position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : undefined}><header onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={() => setDrag(null)}><div><b>Reference reader</b>{target?.title && <span>{target.title}</span>}</div><div>{target?.url && <a href={target.url} target="_blank" rel="noreferrer">Browser ↗</a>}<button onClick={close} aria-label="Close reference reader">×</button></div></header><div className="reference-chooser"><select value="" onChange={(event) => { const selected = papers.find((item) => item.id === event.target.value); if (selected) setTarget({ title: selected.title, arxivId: selected.arxivId, paperId: selected.id, url: originalPaperUrl(selected) }); }}><option value="">Open from Library…</option>{papers.filter(hasOriginalPaper).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><div><input value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') openValue(); }} placeholder="arXiv ID or URL" /><button onClick={openValue} disabled={!value.trim()}>Open</button></div><label className="reference-upload"><input type="file" accept=".pdf,.tex,.ltx,.zip,application/pdf,application/zip,text/plain" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }} /><span>{uploading ? 'Attaching…' : 'Upload PDF / TeX / ZIP'}</span><small>ZIP for multiple files</small></label>{uploadStatus && <p className="reference-upload-status">{uploadStatus}</p>}</div>{target?.url ? <iframe title={`Reference: ${target.title}`} src={target.url} /> : <div className="reference-empty"><ReaderIcon name="reference" /><b>{target ? target.title : 'Open a paper'}</b></div>}</aside>;
}

function PaperChatDialog({ paper, currentNode, messages, question, setQuestion, asking, ask, close }: { paper: Paper; currentNode?: AuditNode; messages: { role: 'user' | 'assistant'; text: string }[]; question: string; setQuestion: (value: string) => void; asking: boolean; ask: () => void; close: () => void }) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null); const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  function beginDrag(event: ReactPointerEvent<HTMLElement>) { if ((event.target as HTMLElement).closest('button')) return; const rect = event.currentTarget.parentElement?.getBoundingClientRect(); if (!rect) return; event.currentTarget.setPointerCapture(event.pointerId); setDrag({ dx: event.clientX - rect.left, dy: event.clientY - rect.top }); setPosition({ x: rect.left, y: rect.top }); }
  function moveDrag(event: ReactPointerEvent<HTMLElement>) { if (!drag) return; const rect = event.currentTarget.parentElement?.getBoundingClientRect(); const width = rect?.width || 620; const height = rect?.height || 640; setPosition({ x: Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - drag.dx)), y: Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - drag.dy)) }); }
  function endDrag(event: ReactPointerEvent<HTMLElement>) { if (drag) event.currentTarget.releasePointerCapture(event.pointerId); setDrag(null); }
  return <div className="paper-chat-shell"><section className="paper-chat-dialog" data-reader-floating-panel style={position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : undefined}><header onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}><div><b>Ask AI</b>{currentNode && <small>Near {displayUnitLabel(currentNode)}</small>}</div><button onClick={close} aria-label="Close paper conversation">×</button></header><div className="paper-chat-messages">{messages.length ? messages.map((message, index) => <article key={index} className={`paper-chat-${message.role}`}><b>{message.role === 'user' ? 'You' : 'Local Codex'}</b><MathText value={message.text} block /></article>) : <div className="paper-chat-empty"><b><MathText value={paper.title} /></b></div>}{asking && <div className="paper-chat-thinking"><i /><i /><i /><span>Reading…</span></div>}</div><footer><textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') ask(); }} placeholder="Ask about this paper…" autoFocus /><div><span>⌘ Enter</span><button onClick={ask} disabled={asking || !question.trim()}>{asking ? 'Reading…' : 'Ask'}</button></div></footer></section></div>;
}

function ExportPaperPanel({ paper, audit, nodes, patches, focusIds, readerNotes, notes, focusActive, close }: { paper: Paper; audit: PaperAudit; nodes: AuditNode[]; patches: WorkingPatch[]; focusIds: string[]; readerNotes: Record<string, string>; notes: Note[]; focusActive: boolean; close: () => void }) {
  const [selection, setSelection] = useState<ExportSelection>({ abstract: true, prose: true, statements: true, proofs: true, figures: true, citations: true, audit: false, notes: true, focusedOnly: focusActive }); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(''); const [error, setError] = useState('');
  const choices: { key: keyof ExportSelection; label: string; detail: string }[] = [{ key: 'abstract', label: 'Abstract', detail: 'Title, authors, and abstract' }, { key: 'prose', label: 'Paper prose', detail: 'Section headings and author paragraphs' }, { key: 'statements', label: 'Formal statements', detail: 'Definitions, lemmas, propositions, and theorems' }, { key: 'proofs', label: 'Complete proofs', detail: 'Full author proofs, not proof maps' }, { key: 'figures', label: 'Figures', detail: 'Links to original local assets' }, { key: 'citations', label: 'References', detail: 'Resolved alpha-style bibliography' }, { key: 'audit', label: 'AI audit guide', detail: 'Central question and contribution' }, { key: 'notes', label: 'Reader notes', detail: 'Notes linked to included results' }];
  async function save() { setBusy(true); setError(''); setSaved(''); try { const content = buildPaperExport(paper, audit, nodes, patches, readerNotes, notes, selection, focusIds); const fileName = `${paper.arxivId.replace(/[^a-zA-Z0-9.-]+/g, '-')}-${selection.focusedOnly ? 'focused-' : ''}reading-edition.md`; const response = await fetch(`${bridgeUrl}/vault/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId: paper.id, export: { fileName, content, selection } }) }); const data = await readServiceResponse(response); if (!response.ok) throw new Error(data.error || 'The paper selection could not be saved.'); setSaved(readString(data.saved?.relativePath)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The paper selection could not be saved.'); } finally { setBusy(false); } }
  return <aside className="export-paper-panel"><header><div><b>Save a reading edition</b><span>Choose exactly what belongs in this local copy.</span></div><button onClick={close}>×</button></header><label className="export-focus"><input type="checkbox" checked={selection.focusedOnly} disabled={!focusIds.length} onChange={(event) => setSelection({ ...selection, focusedOnly: event.target.checked })} /><span><b>Only the current focus</b><small>{focusIds.length ? `${focusIds.length} result${focusIds.length === 1 ? '' : 's'} and prerequisites` : 'Choose a focus path first'}</small></span></label><div className="export-choices">{choices.map((choice) => <label key={choice.key}><input type="checkbox" checked={selection[choice.key]} onChange={(event) => setSelection({ ...selection, [choice.key]: event.target.checked })} /><span><b>{choice.label}</b><small>{choice.detail}</small></span></label>)}</div>{error && <p className="export-error">{error}</p>}{saved && <p className="export-saved">Saved locally: {saved}</p>}<footer><button onClick={close}>Close</button><button onClick={() => void save()} disabled={busy || !choices.some((choice) => selection[choice.key])}>{busy ? 'Saving…' : 'Save to paper folder'}</button></footer></aside>;
}

function EmptyVault({ onImport }: { onImport: () => void }) { return <section className="mx-auto max-w-3xl px-6 py-14"><div className="rounded-xl border border-dashed border-[#ccd9cd] bg-white p-9 text-center"><h2 className="text-2xl font-bold tracking-[-.04em]">Import a paper to begin.</h2><button onClick={onImport} className="mt-6 rounded-md bg-[#2d654f] px-4 py-2.5 text-xs font-bold text-white">Import paper</button></div></section>; }

function ReadingMarkSelect({ value, onChange, openAssistant, auditNode }: { value: ReadingMark; onChange: (value: ReadingMark) => void; openAssistant?: () => void; auditNode?: AuditNode }) { const symbol = value === 'question' ? '?' : value === 'error' ? '×' : ''; return <div className={`reading-mark-control ${value ? `reading-mark-control-${value}` : ''}`} onClick={(event) => event.stopPropagation()}><span className="reading-mark-status">{symbol ? <button className="reading-mark-symbol" onClick={openAssistant} aria-label={`Open Assistant for this ${value === 'question' ? 'question' : 'possible error'}`}>{symbol}</button> : auditNode ? <AuditPeek node={auditNode} open={() => openAssistant?.()} /> : <span className="reading-mark-symbol reading-mark-symbol-placeholder" aria-hidden="true" />}</span><select className={`reading-mark-select ${value ? `reading-mark-select-${value}` : ''}`} value={value} onChange={(event) => onChange(event.target.value as ReadingMark)} aria-label="Mark your understanding"><option value="">Mark…</option><option value="understood">Understood</option><option value="question">Question</option><option value="error">Possible error</option></select></div>; }

function SourceBlockActions({ unit, select, openAssistant }: { unit: AuditNode; select: () => void; openAssistant: (view?: 'ask' | 'notes' | 'compose-note') => void }) {
  return <div className="source-block-actions" onClick={(event) => event.stopPropagation()}><button onClick={() => { select(); openAssistant('ask'); }}>Ask AI</button><button onClick={() => { select(); openAssistant('compose-note'); }}>Note</button><span>{displayUnitLabel(unit)}</span></div>;
}

type InteractiveDocumentProps = { paper: Paper; audit: PaperAudit; nodes: AuditNode[]; notes: Note[]; saveNote: (anchor: string, nodeId: string, text: string, latex: string) => void; updateNote: (noteId: string, text: string) => void; deleteNote: (noteId: string) => void; setSelectedNodeId: (id: string) => void; expanded: Record<string, boolean>; setExpanded: (id: string, value: boolean) => void; marks: Record<string, Exclude<ReadingMark, ''>>; setMark: (id: string, value: ReadingMark) => void; patches: WorkingPatch[]; savePatches: (patches: WorkingPatch[]) => Promise<void>; openAssistant: (view?: 'ask' | 'notes' | 'compose-note') => void; openReference: (citation?: CitationReference) => void; expandCitation: (node: AuditNode, citation: CitationReference) => void; attachCitation: (citation: CitationReference, file: File) => Promise<string>; expandProofStep: (node: AuditNode, step: string, index: number) => Promise<string>; expandProofRequest: (node: AuditNode, request: string) => Promise<string> };

function InteractiveDocumentComponent({ paper, audit, nodes, notes, saveNote, updateNote, deleteNote, setSelectedNodeId, expanded, setExpanded, marks, setMark, patches, savePatches, openAssistant, openReference, expandCitation, attachCitation, expandProofStep, expandProofRequest }: InteractiveDocumentProps) {
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const documentRootRef = useRef<HTMLElement>(null);
  async function saveInlineTex(node: AuditNode, field: 'statement' | 'proofText', value: string) {
    const currentPatch = patchForNode(patches, node.id);
    if (currentPatch?.kind === 'add') {
      await savePatches(patches.map((patch) => patch.id === currentPatch.id ? { ...patch, [field]: value, source: 'manual' as const, createdAt: new Date().toISOString() } : patch));
      return;
    }
    const sourceNode = audit.nodes.find((item) => item.id === node.id) ?? node;
    const replacement: WorkingPatch = { id: currentPatch?.kind === 'replace' ? currentPatch.id : makeId(), kind: 'replace', nodeId: sourceNode.id, title: node.title, statement: field === 'statement' ? value : node.statement, proofText: field === 'proofText' ? value : node.proofText, nodeKind: node.kind, afterNodeId: '', rationale: `Inline TeX edit to the ${field === 'statement' ? 'statement' : 'proof'}.`, dependencies: node.dependencies, proofSketch: node.proofSketch, source: 'manual', createdAt: new Date().toISOString() };
    await savePatches([...patches.filter((patch) => !(patch.kind === 'replace' && patch.nodeId === sourceNode.id)), replacement]);
  }
  async function saveSourceBlockTex(block: SourceBlock, value: string) {
    const unit = sourceBlockAsNode(block, patches); const currentPatch = patchForNode(patches, unit.id);
    const replacement: WorkingPatch = { id: currentPatch?.kind === 'replace' ? currentPatch.id : makeId(), kind: 'replace', nodeId: unit.id, title: unit.title, statement: value, proofText: '', nodeKind: unit.kind, afterNodeId: '', rationale: `Inline TeX edit to the original ${unit.kind}.`, dependencies: [], proofSketch: [], source: 'manual', createdAt: new Date().toISOString() };
    await savePatches([...patches.filter((patch) => !(patch.kind === 'replace' && patch.nodeId === unit.id)), replacement]);
  }
  async function revertPatch(patch: WorkingPatch) { await savePatches(patches.filter((item) => item.id !== patch.id)); }
  const fallbackBlocks = nodes.flatMap((node, index): SourceBlock[] => [{ id: `fallback-result-${index}`, kind: 'result', level: 4, title: '', content: node.statement, proofText: '', nodeId: node.id, resultKind: node.kind, citations: node.citations ?? [], assetPaths: [], caption: '' }, ...(node.proofText ? [{ id: `fallback-proof-${index}`, kind: 'proof' as const, level: 4, title: '', content: '', proofText: node.proofText, nodeId: node.id, resultKind: node.kind, citations: node.citations ?? [], assetPaths: [], caption: '' }] : [])]);
  const sourceBlocks = audit.sourceBlocks?.length ? audit.sourceBlocks : fallbackBlocks;
  const sectionRanges = useMemo(() => sourceBlocks.map((block, start) => { if (block.kind !== 'section') return null; let end = sourceBlocks.length; for (let index = start + 1; index < sourceBlocks.length; index += 1) { const candidate = sourceBlocks[index]; if (candidate.kind === 'section' && candidate.level <= block.level) { end = index; break; } } return { id: block.id, start, end }; }).filter(Boolean) as { id: string; start: number; end: number }[], [sourceBlocks]);
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const focused = nodes.length < applyWorkingPatches(audit.nodes, patches).length;
  const focusedSourceBlockIndexes = new Set(focused ? nodes.map((item) => resolveSourceBlockIndex(item.id, item, sourceBlocks, patches)).filter((index) => index >= 0) : []);
  const sourceNodeIds = new Set(sourceBlocks.map((block) => block.nodeId).filter(Boolean));
  const additions = nodes.filter((node) => node.id.startsWith('working-') && !sourceNodeIds.has(node.id));
  const visibleAbstract = /^Reader-supplied local source\b/i.test(paper.abstract.trim()) ? '' : paper.abstract.trim();
  useEffect(() => {
    const root = documentRootRef.current;
    if (!root) return;
    let last = '';
    const select = (next: string) => {
      if (!next || next === last) return;
      last = next;
      startTransition(() => setSelectedNodeId(next));
    };
    const observed = Array.from(root.querySelectorAll<HTMLElement>('[data-node-id]'));
    if (typeof IntersectionObserver === 'undefined') {
      let frame = 0;
      const update = () => {
        frame = 0;
        const reader = root.closest<HTMLElement>('.reader-document');
        const x = reader ? reader.getBoundingClientRect().left + reader.getBoundingClientRect().width / 2 : window.innerWidth / 2;
        const target = document.elementFromPoint(x, window.innerHeight / 2)?.closest<HTMLElement>('[data-node-id]');
        if (target && root.contains(target)) select(target.dataset.nodeId || '');
      };
      const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
      document.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule); schedule();
      return () => { document.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); if (frame) window.cancelAnimationFrame(frame); };
    }
    const active = new Set<HTMLElement>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        if (entry.isIntersecting) active.add(element); else active.delete(element);
      }
      const center = window.innerHeight / 2;
      let nearest: HTMLElement | null = null; let distance = Number.POSITIVE_INFINITY;
      for (const element of active) {
        const rect = element.getBoundingClientRect();
        const nextDistance = Math.abs((rect.top + rect.bottom) / 2 - center);
        if (nextDistance < distance) { nearest = element; distance = nextDistance; }
      }
      select(nearest?.dataset.nodeId || '');
    }, { root: null, rootMargin: '-45% 0px -45% 0px', threshold: 0 });
    for (const element of observed) observer.observe(element);
    return () => observer.disconnect();
  }, [collapsedSections, nodes, setSelectedNodeId]);
  useEffect(() => {
    const jump = (event: Event) => {
      const requestedId = (event as CustomEvent<string>).detail;
      const requestedNode = nodes.find((item) => item.id === requestedId) ?? audit.nodes.find((item) => item.id === requestedId);
      const targetIndex = resolveSourceBlockIndex(requestedId, requestedNode, sourceBlocks, patches);
      if (targetIndex < 0) return;
      const targetBlock = sourceBlocks[targetIndex];
      const targetId = targetBlock.nodeId || sourceBlockAsNode(targetBlock, patches).id;
      const parents = sectionRanges.filter((range) => targetIndex > range.start && targetIndex < range.end).map((range) => range.id);
      if (parents.length) setCollapsedSections((current) => { const next = { ...current }; for (const id of parents) delete next[id]; return next; });
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        setSelectedNodeId(targetId);
        document.querySelector<HTMLElement>(`.reader-document [data-node-id="${CSS.escape(targetId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }));
    };
    window.addEventListener('proofroom:jump-unit', jump);
    return () => window.removeEventListener('proofroom:jump-unit', jump);
  }, [audit.nodes, nodes, patches, sectionRanges, setSelectedNodeId, sourceBlocks]);
  return <article ref={documentRootRef} className="interactive-document source-document">
    <header className="interactive-lead">
      <h1><MathText value={paper.title} /></h1><div className="paper-metadata"><p className="paper-authors"><MathText value={paper.authors} /></p><p className="paper-identity">{paperSourceLabel(paper)}{paper.arxivId.startsWith('local-') ? '' : ` · ${paper.category}`}</p></div>
      {visibleAbstract && <section className="paper-abstract"><b>Abstract</b><MathText value={visibleAbstract} block /></section>}
    </header>
    <div className="original-source-flow">{sourceBlocks.map((block, blockIndex) => {
      if (sectionRanges.some((range) => collapsedSections[range.id] && blockIndex > range.start && blockIndex < range.end)) return null;
      if (focused && !focusedSourceBlockIndexes.has(blockIndex) && (block.kind === 'paragraph' || block.kind === 'figure' || block.kind === 'table' || block.kind === 'bibliography' || ((block.kind === 'result' || block.kind === 'proof') && !visibleNodeIds.has(block.nodeId)))) return null;
      if (block.kind === 'section') { const Heading = block.level <= 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4'; const collapsed = Boolean(collapsedSections[block.id]); const unit = sourceBlockAsNode(block, patches); const attachedNotes = notes.filter((item) => item.nodeId === unit.id); const patch = patchForNode(patches, unit.id); return <section key={block.id} data-node-id={unit.id} className="source-section-unit" onClick={() => setSelectedNodeId(unit.id)}><UnitStatusRail noteCount={attachedNotes.length} openNote={() => { setSelectedNodeId(unit.id); openAssistant('compose-note'); }} patch={patch} originalValue={block.title} currentValue={unit.statement} citations={block.citations} revert={() => patch ? revertPatch(patch) : Promise.resolve()} /><Heading className={`source-section-heading source-section-level-${block.level} ${collapsed ? 'source-section-collapsed' : ''}`}><EditableTexBlock label="Section title TeX" value={unit.statement} originalValue={block.title} changeRationale={patch?.rationale} citations={block.citations} emptyText="Untitled section" onSave={(value) => saveSourceBlockTex(block, value)} /><button className="source-section-toggle" onClick={(event) => { event.stopPropagation(); setCollapsedSections((current) => ({ ...current, [block.id]: !current[block.id] })); }} aria-expanded={!collapsed} title={collapsed ? 'Expand section' : 'Collapse section'}><span aria-hidden="true">{collapsed ? '▸' : '▾'}</span><small>{collapsed ? 'Expand' : 'Collapse'}</small></button></Heading><SourceBlockActions unit={unit} select={() => setSelectedNodeId(unit.id)} openAssistant={openAssistant} /></section>; }
      if (block.kind === 'paragraph') { const unit = sourceBlockAsNode(block, patches); const attachedNotes = notes.filter((item) => item.nodeId === unit.id); const patch = patchForNode(patches, unit.id); return <section key={block.id} data-node-id={unit.id} className="source-paragraph source-prose-unit" onClick={() => setSelectedNodeId(unit.id)}><UnitStatusRail noteCount={attachedNotes.length} openNote={() => { setSelectedNodeId(unit.id); openAssistant('compose-note'); }} patch={patch} originalValue={block.content} currentValue={unit.statement} citations={block.citations} revert={() => patch ? revertPatch(patch) : Promise.resolve()} /><EditableTexBlock label="Paragraph TeX" value={unit.statement} originalValue={block.content} changeRationale={patch?.rationale} citations={block.citations} emptyText="Empty paragraph" onSave={(value) => saveSourceBlockTex(block, value)} /><SourceBlockActions unit={unit} select={() => setSelectedNodeId(unit.id)} openAssistant={openAssistant} /></section>; }
      if (block.kind === 'table') { const unit = sourceBlockAsNode(block, patches); const attachedNotes = notes.filter((item) => item.nodeId === unit.id); const patch = patchForNode(patches, unit.id); return <section key={block.id} data-node-id={unit.id} className="source-table-unit" onClick={() => setSelectedNodeId(unit.id)}><UnitStatusRail noteCount={attachedNotes.length} openNote={() => { setSelectedNodeId(unit.id); openAssistant('compose-note'); }} patch={patch} originalValue={block.content} currentValue={unit.statement} citations={block.citations} revert={() => patch ? revertPatch(patch) : Promise.resolve()} /><EditableSourceTable value={unit.statement} caption={block.caption} citations={block.citations} onSave={(value) => saveSourceBlockTex(block, value)} /><SourceBlockActions unit={unit} select={() => setSelectedNodeId(unit.id)} openAssistant={openAssistant} /></section>; }
      if (block.kind === 'figure') { const unit = sourceBlockAsNode(block, patches); const attachedNotes = notes.filter((item) => item.nodeId === unit.id); const patch = patchForNode(patches, unit.id); return <section key={block.id} data-node-id={unit.id} className="source-figure-unit" onClick={() => setSelectedNodeId(unit.id)}><UnitStatusRail noteCount={attachedNotes.length} openNote={() => { setSelectedNodeId(unit.id); openAssistant('compose-note'); }} patch={patch} originalValue={block.caption} currentValue={unit.statement} citations={block.citations} revert={() => patch ? revertPatch(patch) : Promise.resolve()} /><SourceFigure paperId={paper.id} assetPaths={block.assetPaths} caption="" />{(unit.statement || block.caption) && <div className="source-figure-editable-caption"><EditableTexBlock label="Figure caption TeX" value={unit.statement} originalValue={block.caption} changeRationale={patch?.rationale} citations={block.citations} emptyText="No figure caption" onSave={(value) => saveSourceBlockTex(block, value)} /></div>}<SourceBlockActions unit={unit} select={() => setSelectedNodeId(unit.id)} openAssistant={openAssistant} /></section>; }
      if (block.kind === 'bibliography') {
        const unit = sourceBlockAsNode(block, patches);
        return <section key={block.id} data-node-id={unit.id} className="source-bibliography-entry" onClick={() => setSelectedNodeId(unit.id)}><span className="source-bibliography-key">[{block.title}]</span><MathText value={unit.statement} block /></section>;
      }
      const node = nodes.find((item) => item.id === block.nodeId) ?? applyWorkingPatches(audit.nodes, patches).find((item) => item.id === block.nodeId);
      if (!node) { const unit = sourceBlockAsNode({ ...block, kind: 'paragraph' }, patches); const attachedNotes = notes.filter((item) => item.nodeId === unit.id); const patch = patchForNode(patches, unit.id); return block.content ? <section key={block.id} data-node-id={unit.id} className="source-paragraph source-prose-unit" onClick={() => setSelectedNodeId(unit.id)}><UnitStatusRail noteCount={attachedNotes.length} openNote={() => { setSelectedNodeId(unit.id); openAssistant('compose-note'); }} patch={patch} originalValue={block.content} currentValue={unit.statement} citations={block.citations} revert={() => patch ? revertPatch(patch) : Promise.resolve()} /><EditableTexBlock label="Text TeX" value={unit.statement} originalValue={block.content} changeRationale={patch?.rationale} citations={block.citations} emptyText="Empty text block" onSave={(value) => saveSourceBlockTex({ ...block, kind: 'paragraph' }, value)} /><SourceBlockActions unit={unit} select={() => setSelectedNodeId(unit.id)} openAssistant={openAssistant} /></section> : null; }
      const isOpen = expanded[node.id] !== false; const patch = patchForNode(patches, node.id); const sourceNode = audit.nodes.find((item) => item.id === node.id); const citations = node.citations ?? block.citations ?? []; const attachedNotes = notes.filter((item) => item.nodeId === node.id);
      const readingMark = marks[block.id] ?? '';
      if (block.kind === 'proof') {
        const proofValue = node.proofText || block.proofText; const originalProof = sourceNode?.proofText ?? block.proofText;
        const statusRail = <UnitStatusRail noteCount={attachedNotes.length} openNote={() => { setSelectedNodeId(node.id); openAssistant('compose-note'); }} patch={patch} originalValue={originalProof} currentValue={proofValue} citations={citations} revert={() => patch ? revertPatch(patch) : Promise.resolve()} />;
        return isOpen ? <section key={block.id} data-node-id={node.id} className={`source-proof ${readingMark ? `reading-mark-${readingMark}` : ''}`} onClick={() => setSelectedNodeId(node.id)}>{statusRail}<div className="source-proof-label"><button onClick={(event) => { event.stopPropagation(); setExpanded(node.id, false); }} title="Collapse proof">Proof. <span aria-hidden="true">▾</span></button><button className="source-proof-note" onClick={(event) => { event.stopPropagation(); setSelectedNodeId(node.id); openAssistant('compose-note'); }}>Note</button><ReadingMarkSelect value={readingMark} onChange={(value) => setMark(block.id, value)} openAssistant={() => { setSelectedNodeId(node.id); openAssistant('ask'); }} auditNode={node} /></div><EditableTexBlock label="Proof TeX" value={proofValue} originalValue={originalProof} changeRationale={patch?.rationale} citations={citations} emptyText="The source contains no attached proof text." numbered onSave={(value) => saveInlineTex(node, 'proofText', value)} /><ProofReadingTools node={node} citations={citations} expand={expandProofRequest} />{block.assetPaths.length > 0 && <SourceFigure paperId={paper.id} assetPaths={block.assetPaths} caption={block.caption} />}{citations.length > 0 && <CitationSources citations={citations} onExpand={(citation) => expandCitation(node, citation)} onOpen={openReference} onAttach={attachCitation} />}<ProofMap node={node} citations={citations} openNode={setSelectedNodeId} nodes={nodes} expandStep={expandProofStep} /></section> : <section key={block.id} data-node-id={node.id} className={`source-proof source-proof-collapsed ${readingMark ? `reading-mark-${readingMark}` : ''}`}>{statusRail}<div className="source-proof-label"><button onClick={() => { setSelectedNodeId(node.id); setExpanded(node.id, true); }} title="Expand complete proof">Proof. <span aria-hidden="true">▸</span><small>Show complete proof</small></button><button className="source-proof-note" onClick={(event) => { event.stopPropagation(); setSelectedNodeId(node.id); openAssistant('compose-note'); }}>Note</button><ReadingMarkSelect value={readingMark} onChange={(value) => setMark(block.id, value)} openAssistant={() => { setSelectedNodeId(node.id); openAssistant('ask'); }} auditNode={node} /></div></section>;
      }
      return <section key={block.id} data-node-id={node.id} onClick={() => setSelectedNodeId(node.id)} className={`source-result paper-kind-${node.kind} ${readingMark ? `reading-mark-${readingMark}` : ''}`}>
        <UnitStatusRail noteCount={attachedNotes.length} openNote={() => { setSelectedNodeId(node.id); openAssistant('compose-note'); }} patch={patch} originalValue={sourceNode?.statement ?? block.content} currentValue={node.statement || block.content} citations={citations} revert={() => patch ? revertPatch(patch) : Promise.resolve()} />
        <header><b>{displayUnitLabel(node)}.</b>{block.title && <span>(<MathText value={block.title} />)</span>}<ReadingMarkSelect value={readingMark} onChange={(value) => setMark(block.id, value)} openAssistant={() => { setSelectedNodeId(node.id); openAssistant('ask'); }} auditNode={node} /></header>
        <EditableTexBlock label="Statement TeX" value={node.statement || block.content} originalValue={sourceNode?.statement ?? block.content} changeRationale={patch?.rationale} citations={citations} emptyText="No standalone statement was extracted for this unit." onSave={(value) => saveInlineTex(node, 'statement', value)} />
        {block.assetPaths.length > 0 && <SourceFigure paperId={paper.id} assetPaths={block.assetPaths} caption={block.caption} />}
        <footer><button onClick={(event) => { event.stopPropagation(); setSelectedNodeId(node.id); openAssistant('ask'); }}>Ask AI</button><button onClick={(event) => { event.stopPropagation(); setSelectedNodeId(node.id); openAssistant('compose-note'); }}>Note</button>{!node.proofText && node.kind !== 'definition' ? <span className="source-no-proof">No attached proof</span> : null}</footer>
        {node.dependencies.length > 0 && <details className="source-dependencies"><summary>Logical dependencies</summary><div>{node.dependencies.map((dependency) => <UnitPreviewButton key={dependency} target={nodes.find((item) => item.id === dependency)} fallback="Referenced prerequisite" openNode={setSelectedNodeId} />)}</div></details>}
        {!node.proofText && citations.length > 0 && <CitationSources citations={citations} onExpand={(citation) => expandCitation(node, citation)} onOpen={openReference} onAttach={attachCitation} />}
      </section>;
    })}{additions.length > 0 && <section className="working-additions"><h2>Reader additions</h2>{additions.map((node) => <section key={node.id} className="source-result"><header><b>{displayUnitLabel(node)}.</b></header><EditableTexBlock label="Statement TeX" value={node.statement} originalValue="" changeRationale={patchForNode(patches, node.id)?.rationale} citations={node.citations ?? []} emptyText="No statement." onSave={(value) => saveInlineTex(node, 'statement', value)} /></section>)}</section>}<WholePaperNotes notes={notes.filter((note) => note.nodeId === '__paper__')} save={(text) => saveNote('Whole paper', '__paper__', text, '')} update={updateNote} remove={deleteNote} /></div>
  </article>;
}

const InteractiveDocument = memo(InteractiveDocumentComponent, (previous, next) => previous.paper === next.paper && previous.audit === next.audit && previous.nodes === next.nodes && previous.notes === next.notes && previous.expanded === next.expanded && previous.marks === next.marks && previous.patches === next.patches);

function EditableSavedNote({ note, update, remove, autoEdit = false }: { note: Note; update: (noteId: string, text: string) => void; remove: (noteId: string) => void; autoEdit?: boolean }) {
  const [editing, setEditing] = useState(autoEdit); const [draft, setDraft] = useState(note.text);
  function save() { if (!draft.trim()) return; update(note.id, draft); setEditing(false); }
  if (!editing) return <article className="editable-saved-note"><button onClick={() => { setDraft(note.text); setEditing(true); }} title="Click to edit note"><MathText value={note.text} block />{note.latex && <Latex value={note.latex} small />}<small>Click to edit</small></button></article>;
  return <article className="editable-saved-note editing"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus />{draft.trim() && <div className="saved-note-preview"><MathText value={draft} block /></div>}<footer><button className="note-delete" onClick={() => remove(note.id)}>Delete</button><button onClick={() => { setDraft(note.text); setEditing(false); }}>Cancel</button><button onClick={save} disabled={!draft.trim()}>Save</button></footer></article>;
}

function WholePaperNotes({ notes, save, update, remove }: { notes: Note[]; save: (text: string) => void; update: (noteId: string, text: string) => void; remove: (noteId: string) => void }) {
  const [text, setText] = useState('');
  function submit() { if (!text.trim()) return; save(text.trim()); setText(''); }
  return <section className="whole-paper-notes"><header><div><b>Paper notes</b><span>Add as many whole-paper notes as you need.</span></div>{notes.length > 0 && <small>{notes.length} saved</small>}</header>{notes.length > 0 && <div className="whole-paper-note-list">{notes.map((note) => <EditableSavedNote key={note.id} note={note} update={update} remove={remove} />)}</div>}<div className="whole-paper-note-box"><textarea aria-label="Paper note" value={text} onChange={(event) => setText(event.target.value)} placeholder="Write in plain text and LaTeX, for example: The key estimate is $\lVert T f\rVert_2 \leq C\lVert f\rVert_2$." />{text.trim() && <div className="whole-paper-note-preview" aria-label="Typeset note preview"><MathText value={text} block /></div>}<button onClick={submit} disabled={!text.trim()}>Add paper note</button></div></section>;
}

function SourceFigure({ paperId, assetPaths, caption }: { paperId: string; assetPaths: string[]; caption: string }) {
  return <figure className="source-figure"><div>{assetPaths.map((asset, index) => <FigureAsset key={`${asset}:${index}`} paperId={paperId} asset={asset} alt={caption || `Figure ${index + 1}`} />)}</div>{caption && <figcaption><MathText value={caption} block /></figcaption>}</figure>;
}

type ParsedTableCell = { value: string; colSpan: number; literal?: boolean };
type ParsedSourceTable = { alignments: ('left' | 'center' | 'right')[]; rows: ParsedTableCell[][] };

function readTeXGroup(source: string, opening: number) {
  if (source[opening] !== '{') return null;
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === '{' && source[index - 1] !== '\\') depth += 1;
    if (source[index] === '}' && source[index - 1] !== '\\') {
      depth -= 1;
      if (depth === 0) return { value: source.slice(opening + 1, index), end: index + 1 };
    }
  }
  return null;
}

function stripGroupedTeXCommands(source: string, pattern: RegExp) {
  let output = ''; let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start < cursor) continue;
    const group = readTeXGroup(source, start + match[0].length - 1);
    if (!group) continue;
    output += source.slice(cursor, start); cursor = group.end;
  }
  return `${output}${source.slice(cursor)}`;
}

function tableAlignments(specification: string) {
  const result: ('left' | 'center' | 'right')[] = [];
  for (let index = 0; index < specification.length; index += 1) {
    const token = specification[index];
    if ('@!><'.includes(token) && specification[index + 1] === '{') { const group = readTeXGroup(specification, index + 1); if (group) index = group.end - 1; continue; }
    if ('pmb'.includes(token) && specification[index + 1] === '{') { result.push('left'); const group = readTeXGroup(specification, index + 1); if (group) index = group.end - 1; continue; }
    if (token === 'l' || token === 'X') result.push('left');
    if (token === 'c' || token === 'S') result.push('center');
    if (token === 'r') result.push('right');
  }
  return result;
}

function splitTableRow(source: string) {
  const cells: string[] = []; let cursor = 0; let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '{' && source[index - 1] !== '\\') depth += 1;
    if (source[index] === '}' && source[index - 1] !== '\\') depth = Math.max(0, depth - 1);
    if (source[index] === '&' && source[index - 1] !== '\\' && depth === 0) { cells.push(source.slice(cursor, index)); cursor = index + 1; }
  }
  cells.push(source.slice(cursor));
  return cells;
}

function cleanTableCell(source: string): ParsedTableCell {
  let value = source.trim().replace(/^(?:\\(?:hline|toprule|midrule|bottomrule)\s*|\\(?:cline|cmidrule)(?:\([^)]*\))?\s*\{[^}]*\}\s*)+/g, '').trim();
  let colSpan = 1;
  const multi = /^\\multicolumn\s*\{(\d+)\}\s*\{[^}]*\}\s*\{/.exec(value);
  if (multi) { const group = readTeXGroup(value, (multi.index ?? 0) + multi[0].length - 1); if (group) { colSpan = Math.max(1, Number(multi[1]) || 1); value = group.value.trim(); } }
  value = value.replace(/^\\multirow(?:\[[^\]]*\])?\s*\{[^}]*\}\s*\{[^}]*\}\s*\{([\s\S]*)\}$/g, '$1').trim();
  const literal = /\\begin\{(?:verbatim\*?|Verbatim|lstlisting|alltt)\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{(?:verbatim\*?|Verbatim|lstlisting|alltt)\}/.exec(value);
  return { value: literal?.[1]?.trim() || value, colSpan, literal: Boolean(literal) };
}

function parseSourceTable(source: string): ParsedSourceTable {
  const begin = /\\begin\{(tabular\*?|tabularx|longtable)\}(?:\[[^\]]*\])?/.exec(source);
  if (!begin) return { alignments: [], rows: [] };
  let cursor = (begin.index ?? 0) + begin[0].length;
  while (/\s/.test(source[cursor] || '')) cursor += 1;
  let specification = readTeXGroup(source, cursor);
  if ((begin[1] === 'tabular*' || begin[1] === 'tabularx') && specification) { cursor = specification.end; while (/\s/.test(source[cursor] || '')) cursor += 1; specification = readTeXGroup(source, cursor); }
  if (!specification) return { alignments: [], rows: [] };
  const bodyStart = specification.end;
  const end = source.lastIndexOf(`\\end{${begin[1]}}`);
  const rawBody = source.slice(bodyStart, end >= bodyStart ? end : source.length).replace(/%[^\n\r]*/g, '');
  const body = stripGroupedTeXCommands(rawBody, /\\caption(?:\[[^\]]*\])?\s*\{/g)
    .replace(/\\label\s*\{[^}]*\}|\\end(?:firsthead|head|foot|lastfoot)\b/g, '');
  const rawRows: string[] = []; let rowStart = 0; let depth = 0;
  for (let index = 0; index < body.length - 1; index += 1) {
    if (body[index] === '{' && body[index - 1] !== '\\') depth += 1;
    if (body[index] === '}' && body[index - 1] !== '\\') depth = Math.max(0, depth - 1);
    if (depth === 0 && body[index] === '\\' && body[index + 1] === '\\') { rawRows.push(body.slice(rowStart, index)); index += 1; while (/\s/.test(body[index + 1] || '')) index += 1; if (body[index + 1] === '[') { const close = body.indexOf(']', index + 2); if (close >= 0) index = close; } rowStart = index + 1; }
  }
  rawRows.push(body.slice(rowStart));
  const rows = rawRows.map((row) => splitTableRow(row).map(cleanTableCell)).filter((row) => row.some((cell) => cell.value));
  return { alignments: tableAlignments(specification.value), rows };
}

function SourceTable({ value, caption, citations }: { value: string; caption: string; citations: CitationReference[] }) {
  const parsed = useMemo(() => parseSourceTable(value), [value]);
  if (!parsed.rows.length) return <pre className="source-table-fallback">{value}</pre>;
  return <div className="source-table-scroll"><table><tbody>{parsed.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => { const Cell = rowIndex === 0 ? 'th' : 'td'; return <Cell key={cellIndex} colSpan={cell.colSpan} style={{ textAlign: parsed.alignments[cellIndex] || 'left' }}>{cell.literal ? <pre className="source-table-code">{cell.value}</pre> : <MathText value={cell.value} citations={citations} />}</Cell>; })}</tr>)}</tbody></table>{caption && <p className="source-table-caption"><MathText value={caption} citations={citations} /></p>}</div>;
}

function EditableSourceTable({ value, caption, citations, onSave }: { value: string; caption: string; citations: CitationReference[]; onSave: (value: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false); const [draft, setDraft] = useState(value); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  async function save(event: ReactMouseEvent) { event.stopPropagation(); if (!parseSourceTable(draft).rows.length) { setError('This TeX does not contain a readable tabular environment.'); return; } setSaving(true); try { await onSave(draft); setEditing(false); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this table.'); } finally { setSaving(false); } }
  if (!editing) return <div className="source-table-rendered" role="button" tabIndex={0} title="Click to edit table TeX" onClick={(event) => { event.stopPropagation(); if (document.body.dataset.readerMarkupActive !== 'true') { setDraft(value); setError(''); setEditing(true); } }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setDraft(value); setError(''); setEditing(true); } }}><span className="tex-edit-hint">Click to edit</span><SourceTable value={value} caption={caption} citations={citations} /></div>;
  return <div className="editable-tex-source source-table-editor" onClick={(event) => event.stopPropagation()}><header><b>Table TeX</b></header><textarea value={draft} onChange={(event) => { setDraft(event.target.value); setError(''); }} spellCheck={false} autoFocus />{error && <p className="tex-compile-error">{error}</p>}<div className="tex-source-preview"><span>Live preview</span><SourceTable value={draft} caption={caption} citations={citations} /></div><footer><button onClick={(event) => { event.stopPropagation(); setEditing(false); setError(''); }}>Cancel</button><button onClick={(event) => void save(event)} disabled={saving}>{saving ? 'Saving…' : 'Save to working edition'}</button></footer></div>;
}

function FigureAsset({ paperId, asset, alt }: { paperId: string; asset: string; alt: string }) {
  const [failed, setFailed] = useState(false); const url = `${bridgeUrl}/asset?paperId=${encodeURIComponent(paperId)}&file=${encodeURIComponent(asset)}`;
  // Original paper assets are served dynamically by the local bridge, so the
  // framework image optimizer cannot know their dimensions or paths in advance.
  // eslint-disable-next-line @next/next/no-img-element
  return failed ? <div className="source-figure-missing"><b>Figure asset unavailable</b><span>{asset}</span></div> : <a href={url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}><img src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} /></a>;
}

function latexCompileError(value: string) {
  const expressions = [...String(value || '').matchAll(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$]+?)\$|\\\(([\s\S]+?)\\\)/g)];
  for (const match of expressions) {
    const expression = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    try { katex.renderToString(expression, { throwOnError: true, strict: 'ignore', displayMode: Boolean(match[1] || match[2]), macros: readerKatexMacros }); }
    catch (error) { return error instanceof Error ? error.message.replace(/^KaTeX parse error:\s*/i, '') : 'This formula does not compile.'; }
  }
  return '';
}

function proofCoordinateScale(content: HTMLElement) {
  const reader = content.closest<HTMLElement>('.reader-document');
  return reader ? Number(window.getComputedStyle(reader).zoom) || 1 : 1;
}

function visibleProofSourceLines(nodeId: string) {
  if (typeof document === 'undefined') return [];
  const proof = document.querySelector<HTMLElement>(`.source-proof[data-node-id="${CSS.escape(nodeId)}"]:not(.source-proof-collapsed)`);
  const content = proof?.querySelector<HTMLElement>('.proof-line-content');
  const root = content?.querySelector<HTMLElement>(':scope > .math-text');
  if (!proof || !content || !root) return [];
  const lineTops = Array.from(proof.querySelectorAll<HTMLElement>('.proof-line-gutter > span')).map((label) => Number(label.style.top.replace('px', ''))).filter(Number.isFinite);
  if (!lineTops.length) return [];
  const lines = lineTops.map(() => '');
  const origin = content.getBoundingClientRect().top;
  const scale = proofCoordinateScale(content);
  const style = window.getComputedStyle(root);
  const fontSize = Number(style.fontSize.replace('px', '')) || 16;
  const lineHeight = Number(style.lineHeight.replace('px', '')) || fontSize * 1.7;
  const nearestLine = (top: number) => lineTops.reduce((best, candidate, index) => Math.abs(candidate - top) < Math.abs(lineTops[best] - top) ? index : best, 0);
  const append = (line: number, source: string) => { if (source) lines[line] += source; };

  for (const child of Array.from(root.children)) {
    const element = child as HTMLElement;
    const rect = element.getBoundingClientRect();
    if (element.classList.contains('math-display')) {
      const targetTop = (rect.top - origin) / scale + Math.max(0, (rect.height / scale - lineHeight) / 2);
      append(nearestLine(targetTop), element.dataset.source || element.textContent || '');
      continue;
    }
    if (element.classList.contains('math-inline') || element.classList.contains('inline-citation')) {
      append(nearestLine((rect.top - origin) / scale), element.dataset.source || element.textContent || '');
      continue;
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode() as Text | null;
    while (textNode) {
      const source = textNode.data;
      for (const match of source.matchAll(/\S+\s*/g)) {
        const start = match.index ?? 0;
        const range = document.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, start + match[0].length);
        const tokenRect = Array.from(range.getClientRects()).find((item) => item.height > 0 && item.width > 0);
        if (tokenRect) append(nearestLine((tokenRect.top - origin) / scale), match[0]);
      }
      textNode = walker.nextNode() as Text | null;
    }
  }
  return lines.map((line) => line.replace(/[\t ]+/g, ' ').trim());
}

function indexedVisibleProof(nodeId: string) {
  return visibleProofSourceLines(nodeId).map((line, index) => `L${index + 1}: ${line}`).join('\n');
}

// One throttled fallback for all proofs: IntersectionObserver can miss a jump
// into zoomed, content-visibility-skipped content. Only check container bounds;
// expensive text measurement still runs only for nearby proofs that need it.
const proofViewportChecks = new Set<() => void>();
let proofViewportTimer: number | undefined;
function scheduleProofViewportChecks() {
  if (proofViewportTimer !== undefined) return;
  proofViewportTimer = window.setTimeout(() => {
    proofViewportTimer = undefined;
    for (const check of proofViewportChecks) check();
  }, 100);
}
function watchProofViewport(check: () => void) {
  if (!proofViewportChecks.size) {
    window.addEventListener('scroll', scheduleProofViewportChecks, { capture: true, passive: true });
    window.addEventListener('resize', scheduleProofViewportChecks);
  }
  proofViewportChecks.add(check);
  return () => {
    proofViewportChecks.delete(check);
    if (!proofViewportChecks.size) {
      window.removeEventListener('scroll', scheduleProofViewportChecks, true);
      window.removeEventListener('resize', scheduleProofViewportChecks);
      window.clearTimeout(proofViewportTimer);
      proofViewportTimer = undefined;
    }
  };
}

function VisualLineNumbers({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [lineTops, setLineTops] = useState<number[]>([]);
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let frame = 0; let active = false; let measured = false; let resizeObserver: ResizeObserver | null = null;
    const measure = () => {
      frame = 0;
      const origin = content.getBoundingClientRect().top;
      // Client rects already include the reader's CSS zoom; label offsets are
      // local CSS pixels. Otherwise changing text size scales positions twice.
      const scale = proofCoordinateScale(content);
      const root = content.querySelector<HTMLElement>(':scope > .math-text') ?? content;
      const style = window.getComputedStyle(root);
      const fontSize = Number(style.fontSize.replace('px', '')) || 16;
      const lineHeight = Number(style.lineHeight.replace('px', '')) || fontSize * 1.7;
      const proseTops: number[] = [];
      const inlineRects: DOMRect[] = [];
      const displayRects: DOMRect[] = [];
      const proseTolerance = Math.max(3, fontSize * .3);

      // MathText deliberately emits one top-level span per source fragment.
      // Measure only those fragments: descending into KaTeX would count every
      // numerator, denominator, script, and glyph as a separate visible line.
      for (const child of Array.from(root.children)) {
        const element = child as HTMLElement;
        if (element.classList.contains('math-display')) {
          displayRects.push(element.getBoundingClientRect());
          continue;
        }
        if (element.classList.contains('math-inline') || element.classList.contains('inline-citation')) {
          inlineRects.push(element.getBoundingClientRect());
          continue;
        }
        const range = document.createRange();
        range.selectNodeContents(element);
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.height <= 0 || rect.width <= 0) continue;
          const top = (rect.top - origin) / scale;
          if (!proseTops.some((value) => Math.abs(value - top) < proseTolerance)) proseTops.push(top);
        }
      }

      const tops = [...proseTops];
      for (const rect of inlineRects) {
        const top = (rect.top - origin) / scale;
        const bottom = (rect.bottom - origin) / scale;
        const sharesProseLine = tops.some((value) => value < bottom && value + lineHeight > top);
        if (!sharesProseLine) tops.push(top);
      }
      // A displayed equation is one reader-visible line, regardless of the
      // number of rows or nested boxes in KaTeX's internal DOM.
      for (const rect of displayRects) tops.push((rect.top - origin) / scale + Math.max(0, (rect.height / scale - lineHeight) / 2));

      tops.sort((left, right) => left - right);
      const mergeTolerance = Math.max(5, fontSize * .45);
      const merged = tops.filter((top, index) => index === 0 || Math.abs(top - tops[index - 1]) >= mergeTolerance);
      measured = merged.length > 0;
      setLineTops(merged.map((top) => Math.round(top * 2) / 2));
    };
    const schedule = () => { if (!active) return; window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(measure); };
    const activate = () => {
      if (active) return;
      active = true;
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(content);
      schedule();
    };
    const deactivate = () => { active = false; resizeObserver?.disconnect(); resizeObserver = null; window.cancelAnimationFrame(frame); frame = 0; };
    const visibilityTarget = content.closest<HTMLElement>('.source-proof') ?? content;
    const visibilityObserver = 'IntersectionObserver' in window ? new IntersectionObserver(([entry]) => { if (entry.isIntersecting) activate(); else deactivate(); }, { root: null, rootMargin: '900px 0px', threshold: 0 }) : null;
    const checkVisibility = () => {
      const rect = visibilityTarget.getBoundingClientRect();
      if (rect.bottom >= -900 && rect.top <= window.innerHeight + 900) { activate(); if (!measured) schedule(); }
      else deactivate();
    };
    checkVisibility();
    const unwatchViewport = watchProofViewport(checkVisibility);
    visibilityTarget.addEventListener('focusin', checkVisibility);
    if (visibilityObserver) visibilityObserver.observe(visibilityTarget); else activate();
    // A nearby content-visibility container may still be skipped when the
    // intersection callback first fires. Measure again once it is painted.
    visibilityTarget.addEventListener('contentvisibilityautostatechange', schedule);
    document.fonts.addEventListener('loadingdone', schedule);
    window.addEventListener('resize', schedule);
    return () => { visibilityObserver?.disconnect(); unwatchViewport(); deactivate(); visibilityTarget.removeEventListener('focusin', checkVisibility); visibilityTarget.removeEventListener('contentvisibilityautostatechange', schedule); document.fonts.removeEventListener('loadingdone', schedule); window.removeEventListener('resize', schedule); };
  }, [children]);
  return <div className="proof-numbered-text"><div className="proof-line-gutter" aria-hidden="true">{lineTops.map((top, index) => <span key={`${index}:${top}`} style={{ top }}>{`L${index + 1}`}</span>)}</div><div className="proof-line-content" ref={contentRef}>{children}</div></div>;
}

function EditableTexBlock({ label, value, originalValue, changeRationale, citations, emptyText, numbered = false, onSave }: { label: string; value: string; originalValue?: string; changeRationale?: string; citations: CitationReference[]; emptyText: string; numbered?: boolean; onSave: (value: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false); const [draft, setDraft] = useState(value); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  function begin(event: ReactMouseEvent | ReactKeyboardEvent) { event.stopPropagation(); if (document.body.dataset.readerMarkupActive === 'true') return; const selection = window.getSelection(); if (selection && !selection.isCollapsed && selection.toString().trim()) return; setDraft(value); setError(''); setEditing(true); }
  async function save(event: ReactMouseEvent) {
    event.stopPropagation(); const compileError = latexCompileError(draft); if (compileError) { setError(compileError); return; }
    setSaving(true); try { await onSave(draft); setEditing(false); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this TeX edit.'); } finally { setSaving(false); }
  }
  const changed = typeof originalValue === 'string' && originalValue !== value;
  if (!editing) return <div className={`editable-tex-rendered ${changed ? 'tex-modified' : ''}`} role="button" tabIndex={0} title={`Click to edit ${label}`} onClick={begin} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') begin(event); }}><span className="tex-edit-hint">Click to edit</span>{value ? numbered ? <VisualLineNumbers><MathText value={value} block citations={citations} /></VisualLineNumbers> : <MathText value={value} block citations={citations} /> : <p>{emptyText}</p>}{changed && <aside className="tex-original-popover" role="tooltip"><b>Original text</b><MathText value={originalValue || 'This content was added by the reader.'} block citations={citations} />{changeRationale && <small>{changeRationale}</small>}</aside>}</div>;
  return <div className="editable-tex-source" onClick={(event) => event.stopPropagation()}><header><b>{label}</b><span>Expanded, portable LaTeX · original source preserved</span></header><textarea value={draft} onChange={(event) => { setDraft(event.target.value); setError(''); }} spellCheck={false} autoFocus />{error && <p className="tex-compile-error">Formula error: {error}</p>}<div className="tex-source-preview"><span>Live preview</span>{draft ? <MathText value={draft} block citations={citations} /> : <p>{emptyText}</p>}</div><footer><button onClick={(event) => { event.stopPropagation(); setEditing(false); setError(''); }}>Cancel</button><button onClick={(event) => void save(event)} disabled={saving}>{saving ? 'Saving…' : 'Save to working edition'}</button></footer></div>;
}

function AuditPeek({ node, open }: { node: AuditNode; open: () => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipId = useId();
  const [preview, setPreview] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const statusLabel = node.status === 'verified' ? 'Checked' : node.status === 'needs-verification' ? 'Needs review' : 'Not verified';
  function keepOpen() { if (closeTimer.current) clearTimeout(closeTimer.current); setPreview(true); }
  function hideSoon() { if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setPreview(false), 220); }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useLayoutEffect(() => {
    if (!preview) return;
    const place = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      const card = cardRef.current;
      if (!anchor || !card) return;
      const edge = 12; const gap = 8;
      const width = Math.min(390, window.innerWidth - edge * 2);
      const maxHeight = Math.min(480, window.innerHeight - edge * 2);
      const height = Math.min(card.scrollHeight + 2, maxHeight);
      const below = window.innerHeight - anchor.bottom - edge - gap;
      const above = anchor.top - edge - gap;
      const preferredTop = below >= height || below >= above ? anchor.bottom + gap : anchor.top - gap - height;
      setPosition({ width, maxHeight, left: Math.max(edge, Math.min(anchor.right - width, window.innerWidth - width - edge)), top: Math.max(edge, Math.min(preferredTop, window.innerHeight - height - edge)), visibility: 'visible' });
    };
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreview(false); };
    const outside = (event: PointerEvent) => { if (!triggerRef.current?.contains(event.target as Node) && !cardRef.current?.contains(event.target as Node)) setPreview(false); };
    place();
    const observer = new ResizeObserver(place);
    if (cardRef.current) observer.observe(cardRef.current);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', outside);
    return () => { observer.disconnect(); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); document.removeEventListener('keydown', dismiss); document.removeEventListener('pointerdown', outside); };
  }, [preview]);
  return <><button ref={triggerRef} className={`audit-peek audit-peek-${node.status}`} aria-label={`${statusLabel}: preview AI audit for ${displayUnitLabel(node)}`} aria-describedby={preview ? tooltipId : undefined} onMouseEnter={keepOpen} onMouseLeave={hideSoon} onFocus={keepOpen} onBlur={hideSoon} onClick={(event) => { event.stopPropagation(); setPreview(false); open(); }}>
    <span aria-hidden="true">{node.status === 'verified' ? '✓' : node.status === 'needs-verification' ? '!' : '?'}</span>
  </button>{preview && createPortal(<aside ref={cardRef} id={tooltipId} className="audit-hover-portal" role="tooltip" style={position} onMouseEnter={keepOpen} onMouseLeave={hideSoon} onClick={(event) => event.stopPropagation()}><b>AI audit · {statusLabel}</b><strong>{displayUnitLabel(node)}</strong>{node.role && <MathText value={node.role} block />}{node.whyItMatters && <MathText value={node.whyItMatters} block />}</aside>, document.fullscreenElement ?? document.body)}</>;
}

function NoteMarker({ count, open }: { count: number; open: () => void }) {
  return <button className="source-note-marker" onClick={(event) => { event.stopPropagation(); open(); }} aria-label={`Open ${count} saved note${count === 1 ? '' : 's'}`} title={`Open ${count} saved note${count === 1 ? '' : 's'}`}>
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 3.5h8l3 3v10h-11z" /><path d="M12.5 3.5v3h3M7 10h6M7 13h4" /></svg>{count > 1 && <span>{count}</span>}
  </button>;
}

function ModifiedMarker({ patch, originalValue, currentValue, citations, revert }: { patch: WorkingPatch; originalValue: string; currentValue: string; citations: CitationReference[]; revert: () => Promise<void> }) {
  const [restoring, setRestoring] = useState(false); const origin = patch.source === 'ai' ? 'AI typo correction' : patch.kind === 'add' ? 'Reader addition' : 'Reader edit';
  async function restore(event: ReactMouseEvent) { event.stopPropagation(); setRestoring(true); try { await revert(); } finally { setRestoring(false); } }
  return <div className="source-modified-marker" onClick={(event) => event.stopPropagation()}><button className="source-modified-trigger" aria-label={`Modified: ${origin}`} aria-haspopup="true">Modified</button><aside className="source-modified-popover" role="tooltip"><header><b>{origin}</b><span>{patch.source === 'ai' ? 'AI' : 'You'}</span></header><p>{patch.rationale || (patch.source === 'ai' ? 'A high-confidence typo was corrected during the full-paper audit.' : 'This passage differs from the original paper.')}</p><div><b>Before</b><MathText value={originalValue || 'This passage did not exist in the original paper.'} block citations={citations} /></div><div><b>Now</b><MathText value={currentValue || 'Hidden from the working edition.'} block citations={citations} /></div><button className="source-restore-original" onClick={(event) => void restore(event)} disabled={restoring}>{restoring ? 'Restoring…' : 'Restore original'}</button></aside></div>;
}

function UnitStatusRail({ noteCount, openNote, patch, originalValue, currentValue, citations, revert }: { noteCount: number; openNote: () => void; patch?: WorkingPatch; originalValue: string; currentValue: string; citations: CitationReference[]; revert: () => Promise<void> }) {
  const modified = Boolean(patch && (patch.kind === 'add' || originalValue !== currentValue));
  if (!noteCount && !modified) return null;
  return <div className="unit-status-rail">{noteCount > 0 && <div className="unit-status-notes"><NoteMarker count={noteCount} open={openNote} /></div>}{modified && patch && <div className="unit-status-changes"><ModifiedMarker patch={patch} originalValue={originalValue} currentValue={currentValue} citations={citations} revert={revert} /></div>}</div>;
}

function UnitPreviewButton({ target, fallback, openNode }: { target?: AuditNode; fallback: string; openNode: (id: string) => void }) {
  return <button className="unit-preview-trigger" onClick={(event) => { event.stopPropagation(); if (target) openNode(target.id); }} disabled={!target}>
    <span>{target ? displayUnitLabel(target) : fallback}</span>{target && <span className="unit-hover-card" role="tooltip"><b>{displayUnitLabel(target)}</b>{target.title && <strong><MathText value={target.title} citations={target.citations ?? []} /></strong>}<span><MathText value={target.statement || 'No standalone statement was preserved.'} citations={target.citations ?? []} /></span>{target.role && <em>{target.role}</em>}<small>Click to select this prerequisite.</small></span>}
  </button>;
}

function ProofReadingTools({ node, citations, expand }: { node: AuditNode; citations: CitationReference[]; expand: (node: AuditNode, request: string) => Promise<string> }) {
  const [request, setRequest] = useState(''); const [answer, setAnswer] = useState(''); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  async function run(prompt: string) { if (!prompt.trim() || loading) return; const processId = `proof-expansion:${node.id}`; reportReaderProcess({ id: processId, label: 'Expanding proof', detail: displayUnitLabel(node), status: 'running' }); setLoading(true); setError(''); setAnswer(''); try { setAnswer(await expand(node, prompt)); reportReaderProcess({ id: processId, label: 'Proof expansion ready', detail: displayUnitLabel(node), status: 'complete' }); } catch (cause) { const message = cause instanceof Error ? cause.message : 'The proof could not be expanded.'; setError(message); reportReaderProcess({ id: processId, label: 'Proof expansion stopped', detail: message, status: 'error' }); } finally { setLoading(false); } }
  return <section className="proof-reading-tools" onClick={(event) => event.stopPropagation()}><div><button onClick={() => void run('Expand the entire proof line by line in complete detail.')}>Expand full proof</button><div><input value={request} onChange={(event) => setRequest(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void run(request); }} placeholder="L3, or paste a passage…" /><button onClick={() => void run(request)} disabled={!request.trim() || loading}>Explain</button></div></div>{loading && <div className="proof-ai-progress"><span /><span /><span /><p>Reading the complete proof and its dependencies…</p></div>}{error && <p className="proof-step-error">{error}</p>}{answer && <details open className="proof-expanded-answer"><summary>Detailed expansion</summary><AIText value={answer} citations={citations} /></details>}</section>;
}

function ProofMap({ node, citations, nodes, openNode, expandStep }: { node: AuditNode; citations: CitationReference[]; nodes: AuditNode[]; openNode: (id: string) => void; expandStep: (node: AuditNode, step: string, index: number) => Promise<string> }) {
  const [details, setDetails] = useState<Record<number, string>>({}); const [loading, setLoading] = useState<number | null>(null); const [errors, setErrors] = useState<Record<number, string>>({});
  async function openDetail(index: number, step: string) { if (details[index] || loading === index) return; const processId = `proof-map:${node.id}:${index}`; reportReaderProcess({ id: processId, label: `Expanding proof step ${index + 1}`, detail: displayUnitLabel(node), status: 'running' }); setLoading(index); setErrors((current) => ({ ...current, [index]: '' })); try { const expanded = await expandStep(node, step, index); setDetails((current) => ({ ...current, [index]: expanded })); reportReaderProcess({ id: processId, label: `Proof step ${index + 1} ready`, detail: displayUnitLabel(node), status: 'complete' }); } catch (error) { const message = error instanceof Error ? error.message : 'This step could not be expanded.'; setErrors((current) => ({ ...current, [index]: message })); reportReaderProcess({ id: processId, label: `Proof step ${index + 1} stopped`, detail: message, status: 'error' }); } finally { setLoading(null); } }
  if (node.proofText.trim().length < 520 || node.proofSketch.length < 2) return null;
  return <details className="proof-map"><summary><span>AI proof map</span><small>{node.proofSketch.length} expandable steps</small></summary><div className="proof-map-body">{node.dependencies.length > 0 && <div className="proof-map-inputs"><b>Inputs used</b>{node.dependencies.map((dependency) => <UnitPreviewButton key={dependency} target={nodes.find((item) => item.id === dependency)} fallback="Referenced prerequisite" openNode={openNode} />)}</div>}<ol>{node.proofSketch.map((step, index) => <li key={index}><details className="proof-step" onToggle={(event) => { if (event.currentTarget.open) void openDetail(index, step); }}><summary><span className="proof-step-number"><b>{index + 1}</b><i /></span><span className="proof-step-summary"><MathText value={step} citations={citations} /><small>Open for complete detail</small></span></summary><div className="proof-step-detail">{loading === index && <div className="proof-ai-progress"><span /><span /><span /><p>Expanding this step from the complete proof…</p></div>}{errors[index] && <p className="proof-step-error">{errors[index]} <button onClick={() => void openDetail(index, step)}>Try again</button></p>}{details[index] && <AIText value={details[index]} citations={citations} />}</div></details></li>)}</ol></div></details>;
}

function CitationUploadButton({ citation, onAttach }: { citation: CitationReference; onAttach: (citation: CitationReference, file: File) => Promise<string> }) {
  const [status, setStatus] = useState(''); const [busy, setBusy] = useState(false);
  return <label className="citation-upload" onClick={(event) => event.stopPropagation()}><input type="file" accept=".pdf,.tex,.ltx,.bib,application/pdf,text/plain" disabled={busy} onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; setBusy(true); setStatus(''); try { const saved = await onAttach(citation, file); setStatus(saved ? 'Attached locally' : 'Attached'); } catch (error) { setStatus(error instanceof Error ? error.message : 'Upload failed'); } finally { setBusy(false); event.target.value = ''; } }} /><span>{busy ? 'Saving source…' : status || 'Attach local PDF / TeX'}</span></label>;
}

function CitationSources({ citations, onExpand, onOpen, onAttach }: { citations: CitationReference[]; onExpand?: (citation: CitationReference) => void; onOpen?: (citation: CitationReference) => void; onAttach?: (citation: CitationReference, file: File) => Promise<string> }) {
  return <section className="citation-sources"><b>Cited sources <small>Hover or focus to preview</small></b><div>{citations.map((citation) => <article className="citation-source-row" tabIndex={0} key={`${citation.key}:${citation.locator}`}>
    <div className="citation-source-trigger"><span>[{citationAlphaLabel(citation, citation.key)}]{citation.locator ? ` · ${citation.locator}` : ''}</span><strong><MathText value={citationTitle(citation, citation.key)} /></strong></div>
    <div className="citation-source-popover" role="tooltip"><div><span>[{citationAlphaLabel(citation, citation.key)}]{citation.locator ? ` · ${citation.locator}` : ''}</span></div><h5><MathText value={citationTitle(citation, citation.key)} /></h5>{citation.authors && <p className="citation-authors">{cleanBibliographicText(citation.authors)}</p>}{citation.text && !citation.text.startsWith('Bibliography entry ') && <div className="citation-source-text"><MathText value={cleanBibliographicText(citation.text)} block /></div>}{citation.statement && <div className="citation-result-statement"><b>{citation.locator || 'Cited result'}</b><MathText value={cleanBibliographicText(citation.statement)} block />{Boolean(citation.definitions?.length) && <dl className="citation-notation"><dt>Notation used in this result</dt>{citation.definitions?.map((item, index) => <div key={`${item.notation}:${index}`}><dd><MathText value={item.notation} /></dd><dd><MathText value={item.definition} citations={[]} />{item.source && <small>{cleanBibliographicText(item.source)}</small>}</dd></div>)}</dl>}</div>}<footer>{onOpen && <button onClick={(event) => { event.stopPropagation(); onOpen(citation); }}>Open in reference reader</button>}{onExpand && <button onClick={(event) => { event.stopPropagation(); onExpand(citation); }}>Retrieve original proof with AI</button>}<a href={citation.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{citation.direct ? 'Open in browser ↗' : 'Find in browser ↗'}</a>{citation.searchUrl !== citation.url && <a href={citation.searchUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>Search exact title ↗</a>}{onAttach && <CitationUploadButton citation={citation} onAttach={onAttach} />}</footer></div>
  </article>)}</div></section>;
}

function VersionComparisonPanel({ paper, profile, audit, openUnit, close }: { paper: Paper; profile: Profile; audit: PaperAudit; openUnit: (paperId: string, nodeId: string) => void; close: () => void }) {
  const baseId = paper.arxivId.replace(/v\d+$/i, '');
  const [fromVersion, setFromVersion] = useState(`${baseId}v1`); const [toVersion, setToVersion] = useState(paper.arxivId.match(/v\d+$/i) ? paper.arxivId : baseId); const [result, setResult] = useState<VersionComparison | null>(null); const [sources, setSources] = useState<{ from: string; to: string } | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function compare() {
    if (!fromVersion.trim() || !toVersion.trim()) return;
    const processId = `version-comparison:${paper.id}`; reportReaderProcess({ id: processId, label: 'Comparing paper versions', detail: `${fromVersion} → ${toVersion}`, status: 'running' }); setBusy(true); setError(''); setResult(null);
    try {
      const response = await fetch(`${bridgeUrl}/compare-versions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper, profile, fromVersion, toVersion }) });
      const data = await readServiceResponse(response); if (!response.ok) throw new Error(data.error || 'Version comparison failed.');
      setResult(parseVersionComparison(readString(data.text)));
      setSources(data.sources ?? null); reportReaderProcess({ id: processId, label: 'Version comparison ready', detail: `${fromVersion} → ${toVersion}`, status: 'complete' });
    } catch (cause) { const message = cause instanceof Error ? cause.message : 'Version comparison failed.'; setError(message); reportReaderProcess({ id: processId, label: 'Version comparison stopped', detail: message, status: 'error' }); } finally { setBusy(false); }
  }
  function matchingNode(change: VersionChange) { const needle = change.label.toLowerCase(); return audit.nodes.find((node) => node.label.toLowerCase() === needle || node.title.toLowerCase().includes(needle) || needle.includes(node.label.toLowerCase())); }
  return <div className="edition-overlay" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) close(); }}><section className="version-panel"><header><div><h3>Compare arXiv versions</h3></div><button onClick={close} disabled={busy} aria-label="Close version comparison">×</button></header><div className="version-picker"><label><span>Version A</span><input value={fromVersion} onChange={(event) => setFromVersion(event.target.value)} placeholder={`${baseId}v1`} /></label><span>→</span><label><span>Version B</span><input value={toVersion} onChange={(event) => setToVersion(event.target.value)} placeholder={baseId} /></label><button onClick={() => void compare()} disabled={busy || !fromVersion.trim() || !toVersion.trim()}>{busy ? 'Reading both sources…' : 'Compare with AI'}</button></div>{error && <p className="version-error">{error}</p>}{busy && <div className="version-loading"><b>Comparing both versions…</b></div>}
    {result && <div className="version-results"><section className="version-summary"><div className="flex items-center justify-between gap-3"><p className="reader-kicker">Executive difference</p>{sources && <span>{sources.from.toUpperCase()} → {sources.to.toUpperCase()}</span>}</div><h4>{result.summary}</h4><p>{result.readingRecommendation}</p></section><section><div className="version-section-head"><b>Changed mathematical units</b><span>{result.changedUnits.length}</span></div><div className="version-changes">{result.changedUnits.map((change, index) => { const match = matchingNode(change); return <article key={`${change.label}-${index}`}><div><span className={`version-change-type version-${change.changeType}`}>{change.changeType}</span><span>{change.significance}</span>{match && <button onClick={() => { openUnit(paper.id, match.id); close(); }}>Open {match.label}</button>}</div><h5>{change.label}</h5><div className="version-before-after"><div><b>Before</b><p>{change.before || 'Not present.'}</p></div><div><b>After</b><p>{change.after || 'Removed.'}</p></div></div><footer><b>Dependency impact</b><p>{change.dependencyImpact || 'No verified dependency impact.'}</p></footer></article>; })}</div></section><div className="version-detail-grid"><ComparisonList title="Proof changes" items={result.proofChanges} /><ComparisonList title="Dependency changes" items={result.dependencyImpact} /><ComparisonList title="Notation changes" items={result.notationChanges} /><ComparisonList title="Editorial changes" items={result.editorialChanges} /></div>{result.warnings.length > 0 && <ComparisonList title="Verification warnings" items={result.warnings} warning />}</div>}
  </section></div>;
}

function PaperUpdatePanel({ paper, audit, update, openUnit, close }: { paper?: Paper; audit?: PaperAudit; update: PaperUpdateRecord; openUnit: (paperId: string, nodeId: string) => void; close: () => void }) {
  const [tab, setTab] = useState<'changes' | 'reader-work'>('changes'); const comparison = update.comparison; const migration = update.migration;
  function matchingNode(change: VersionChange) { const needle = updateMatchText(change.label); return audit?.nodes.find((node) => updateMatchText(node.label) === needle || updateMatchText(node.title).includes(needle) || needle.includes(updateMatchText(node.label))); }
  return <div className="edition-overlay" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}><section className="paper-update-panel" role="dialog" aria-modal="true" aria-label="Latest arXiv version changes"><header><div><span>arXiv:{update.fromVersion} → arXiv:{update.toVersion}</span><h3>Latest version ready</h3><p>{paper?.title}</p></div><button onClick={close} aria-label="Close update details">×</button></header><nav><button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>Source changes <span>{comparison.changedUnits.length}</span></button><button className={tab === 'reader-work' ? 'active' : ''} onClick={() => setTab('reader-work')}>Your work <span>{migration.conflicts.length ? `${migration.conflicts.length} review` : 'merged'}</span></button></nav>
    {tab === 'changes' ? <div className="paper-update-body"><section className="paper-update-summary"><b>What changed</b><h4><MathText value={comparison.summary} explicitOnly /></h4><p><MathText value={comparison.readingRecommendation} explicitOnly /></p></section>{comparison.changedUnits.length ? <div className="paper-update-changes">{comparison.changedUnits.map((change, index) => { const match = matchingNode(change); return <article key={`${change.label}:${index}`} className={`update-significance-${change.significance}`}><header><span className={`version-change-type version-${change.changeType}`}>{change.changeType}</span><small>{change.significance}</small>{match && paper && <button onClick={() => { openUnit(paper.id, match.id); close(); }}>Open in paper</button>}</header><h5><MathText value={change.label} explicitOnly /></h5><div><section><b>Previous</b><MathText value={change.before || 'Not present.'} block explicitOnly /></section><span aria-hidden="true">→</span><section><b>Latest</b><MathText value={change.after || 'Removed.'} block explicitOnly /></section></div>{change.dependencyImpact && <footer><b>Logical impact</b><MathText value={change.dependencyImpact} explicitOnly /></footer>}</article>; })}</div> : <div className="paper-update-empty">AI found no material source changes.</div>}<div className="version-detail-grid"><ComparisonList title="Proof changes" items={comparison.proofChanges} /><ComparisonList title="Dependency changes" items={comparison.dependencyImpact} /><ComparisonList title="Notation changes" items={comparison.notationChanges} /><ComparisonList title="Editorial changes" items={comparison.editorialChanges} /></div>{comparison.warnings.length > 0 && <ComparisonList title="Verification warnings" items={comparison.warnings} warning />}</div>
      : <div className="paper-update-body"><section className="migration-overview"><div><b>{migration.notesCarried}</b><span>notes carried</span></div><div><b>{migration.marksCarried}</b><span>marks carried</span></div><div><b>{migration.editsCarried}</b><span>edits merged</span></div><div className={migration.conflicts.length ? 'needs-review' : ''}><b>{migration.conflicts.length}</b><span>need review</span></div></section>{migration.conflicts.length > 0 && <section className="migration-conflicts"><header><b>Needs your review</b><span>The latest author text was kept.</span></header>{migration.conflicts.map((item, index) => <article key={`${item.type}:${item.fromId}:${index}`}><span>{item.type}</span><div><b>{item.label}</b><p>{item.detail}</p></div></article>)}</section>}<section className="migration-list"><header><b>Integration record</b><span>{migration.items.length}</span></header>{migration.items.length ? migration.items.map((item, index) => <article key={`${item.type}:${item.fromId}:${index}`}><i className={`migration-status-${item.status}`}>{item.status === 'carried' ? '✓' : item.status === 'paper-note' ? 'N' : '!'}</i><div><b>{item.label}</b><p>{item.detail}</p></div></article>) : <p>No reader notes, marks, or manual edits were attached to the previous version.</p>}</section><p className="migration-archive-note">The complete previous paper, audit, notes, and working edition remain archived in this paper’s local folder.</p></div>}
  </section></div>;
}

function ComparisonList({ title, items, warning = false }: { title: string; items: string[]; warning?: boolean }) { return <section className={`comparison-list ${warning ? 'comparison-warning' : ''}`}><div><b>{title}</b><span>{items.length}</span></div>{items.length ? <ul>{items.map((item, index) => <li key={index}><MathText value={item} explicitOnly /></li>)}</ul> : <p>No material change identified.</p>}</section>; }

function WorkingEditionEditor({ node, originalNode, edition, patches, savePatches, suggestEdit }: { node: AuditNode; originalNode?: AuditNode; edition: EditionMode; patches: WorkingPatch[]; savePatches: (patches: WorkingPatch[]) => Promise<void>; suggestEdit: (node: AuditNode) => Promise<EditorialSuggestion> }) {
  const currentPatch = patchForNode(patches, node.id);
  const [mode, setMode] = useState<'idle' | 'edit' | 'add'>('idle');
  const [title, setTitle] = useState(node.title);
  const [statement, setStatement] = useState(node.statement);
  const [proofText, setProofText] = useState(node.proofText);
  const [nodeKind, setNodeKind] = useState<NodeKind>(node.kind);
  const [dependencies, setDependencies] = useState(node.dependencies.join('\n'));
  const [proofSketch, setProofSketch] = useState(node.proofSketch.join('\n'));
  const [rationale, setRationale] = useState(currentPatch?.rationale ?? '');
  const [suggestion, setSuggestion] = useState<EditorialSuggestion | null>(null);
  const [busy, setBusy] = useState('');
  const nodeKinds: NodeKind[] = ['definition', 'assumption', 'notation', 'lemma', 'proposition', 'theorem', 'corollary', 'conjecture', 'proof', 'equation', 'remark', 'example', 'section', 'external-result'];
  const lines = (value: string) => value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  function beginEdit() { setMode('edit'); setTitle(node.title); setStatement(node.statement); setProofText(node.proofText); setNodeKind(node.kind); setDependencies(node.dependencies.join('\n')); setProofSketch(node.proofSketch.join('\n')); setRationale(currentPatch?.rationale ?? ''); }
  function beginAdd() { setMode('add'); setTitle(''); setStatement(''); setProofText(''); setNodeKind('proposition'); setDependencies(node.id); setProofSketch(''); setRationale('Reader-added result.'); }
  async function saveEditor() {
    if (!title.trim() || !statement.trim()) return;
    setBusy('save');
    const timestamp = new Date().toISOString();
    const shared = { title: title.trim(), statement: statement.trim(), proofText: proofText.trim(), nodeKind, rationale: rationale.trim(), dependencies: lines(dependencies), proofSketch: lines(proofSketch), source: 'manual' as const, createdAt: timestamp };
    try {
      if (mode === 'add') {
        const anchor = currentPatch?.kind === 'add' ? currentPatch.afterNodeId : originalNode?.id ?? node.id;
        const addition: WorkingPatch = { id: makeId(), kind: 'add', nodeId: '', afterNodeId: anchor, ...shared };
        await savePatches([...patches, addition]);
      } else if (currentPatch?.kind === 'add') {
        await savePatches(patches.map((patch) => patch.id === currentPatch.id ? { ...patch, ...shared } : patch));
      } else {
        const replacement: WorkingPatch = { id: currentPatch?.id ?? makeId(), kind: 'replace', nodeId: originalNode?.id ?? node.id, afterNodeId: '', ...shared };
        await savePatches([...patches.filter((patch) => !(patch.kind === 'replace' && patch.nodeId === replacement.nodeId)), replacement]);
      }
      setMode('idle');
    } finally { setBusy(''); }
  }
  async function hideUnit() {
    setBusy('hide');
    try {
      if (currentPatch?.kind === 'add') await savePatches(patches.filter((patch) => patch.id !== currentPatch.id));
      else {
        const sourceId = originalNode?.id ?? node.id;
        const hidden: WorkingPatch = { id: makeId(), kind: 'delete', nodeId: sourceId, title: node.title, statement: '', proofText: '', nodeKind: '', afterNodeId: '', rationale: 'Hidden from the working edition.', dependencies: [], proofSketch: [], source: 'manual', createdAt: new Date().toISOString() };
        await savePatches([...patches.filter((patch) => !(patch.nodeId === sourceId && (patch.kind === 'replace' || patch.kind === 'delete'))), hidden]);
      }
    } finally { setBusy(''); }
  }
  async function revertUnit() {
    setBusy('revert');
    try {
      if (currentPatch?.kind === 'add') await savePatches(patches.filter((patch) => patch.id !== currentPatch.id));
      else { const sourceId = originalNode?.id ?? node.id; await savePatches(patches.filter((patch) => patch.nodeId !== sourceId || (patch.kind !== 'replace' && patch.kind !== 'delete'))); }
    } finally { setBusy(''); }
  }
  async function inspectSource() {
    if (!originalNode) return;
    setBusy('ai'); setSuggestion(null);
    try { setSuggestion(await suggestEdit(originalNode)); } finally { setBusy(''); }
  }
  async function applySuggestion() {
    if (!originalNode || !suggestion?.hasIssue || !suggestion.replacement.trim()) return;
    setBusy('apply');
    const replacement: WorkingPatch = { id: currentPatch?.kind === 'replace' ? currentPatch.id : makeId(), kind: 'replace', nodeId: originalNode.id, title: node.title, statement: suggestion.replacement.trim(), proofText: node.proofText, nodeKind: node.kind, afterNodeId: '', rationale: suggestion.rationale, dependencies: node.dependencies, proofSketch: node.proofSketch, source: 'ai', createdAt: new Date().toISOString() };
    try { await savePatches([...patches.filter((patch) => !(patch.kind === 'replace' && patch.nodeId === originalNode.id)), replacement]); setSuggestion(null); } finally { setBusy(''); }
  }
  return <section className="inspector-section working-editor"><div className="working-editor-head"><span>{edition === 'original' ? 'Edits are saved separately from the author source.' : currentPatch ? 'Hover the highlighted text to compare with the original.' : 'The author source is unchanged.'}</span>{currentPatch && <span className="working-badge">Edited</span>}</div>
    <div className="working-editor-actions"><button onClick={beginEdit}>Edit unit</button><button onClick={beginAdd}>Add after</button><button onClick={() => void inspectSource()} disabled={!originalNode || Boolean(busy)}>{busy === 'ai' ? 'Proofreading…' : 'AI proofread'}</button><button onClick={() => void hideUnit()} disabled={Boolean(busy)}>{currentPatch?.kind === 'add' ? 'Remove addition' : 'Hide unit'}</button>{currentPatch && <button onClick={() => void revertUnit()} disabled={Boolean(busy)}>Revert</button>}</div>
    {mode !== 'idle' && <div className="working-editor-form"><label><span>Unit type</span><select value={nodeKind} onChange={(event) => setNodeKind(event.target.value as NodeKind)}>{nodeKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label><label><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label><span>Statement (LaTeX allowed)</span><textarea value={statement} onChange={(event) => setStatement(event.target.value)} /></label><label><span>Full proof (LaTeX allowed)</span><textarea value={proofText} onChange={(event) => setProofText(event.target.value)} /></label><label><span>Dependencies — internal IDs, one per line</span><textarea value={dependencies} onChange={(event) => setDependencies(event.target.value)} /></label><label><span>AI proof route — one step per line</span><textarea value={proofSketch} onChange={(event) => setProofSketch(event.target.value)} /></label><label><span>Editorial rationale</span><input value={rationale} onChange={(event) => setRationale(event.target.value)} /></label><div><button className="working-editor-save" onClick={() => void saveEditor()} disabled={busy === 'save' || !title.trim() || !statement.trim()}>{busy === 'save' ? 'Saving…' : mode === 'add' ? 'Add to working edition' : 'Save working edit'}</button><button onClick={() => setMode('idle')}>Cancel</button></div></div>}
    {suggestion && <div className={`editorial-suggestion ${suggestion.hasIssue ? '' : 'editorial-clear'}`}><div><b>{suggestion.hasIssue ? 'Possible source issue' : 'No source issue found'}</b><span>{suggestion.confidence} confidence</span></div><p>{suggestion.rationale}</p>{suggestion.hasIssue && <><blockquote>{suggestion.replacement}</blockquote><button onClick={() => void applySuggestion()} disabled={busy === 'apply'}>{busy === 'apply' ? 'Applying…' : 'Apply AI correction'}</button></>}</div>}
  </section>;
}

function AssistantProofExpander({ node, expand }: { node: AuditNode; expand: (node: AuditNode, request: string) => Promise<string> }) {
  const formal = ['theorem', 'lemma', 'proposition', 'corollary'].includes(node.kind);
  const [lineCount, setLineCount] = useState(1); const [start, setStart] = useState(1); const [end, setEnd] = useState(1); const [answer, setAnswer] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { const timer = window.setTimeout(() => { const count = document.querySelectorAll(`.source-proof[data-node-id="${CSS.escape(node.id)}"] .proof-line-gutter > span`).length || Math.max(1, node.proofText.split(/\n+/).filter((line) => line.trim()).length); setLineCount(count); setStart(1); setEnd(count); }, 80); return () => window.clearTimeout(timer); }, [node.id, node.proofText]);
  if (!formal || !node.proofText.trim()) return null;
  async function run() { const from = Math.max(1, Math.min(start, lineCount)); const to = Math.max(from, Math.min(end, lineCount)); const processId = `proof-range:${node.id}:${from}-${to}`; reportReaderProcess({ id: processId, label: `Expanding proof L${from}–L${to}`, detail: displayUnitLabel(node), status: 'running' }); setBusy(true); setError(''); setAnswer(''); try { setAnswer(await expand(node, `Expand the author proof from visible line L${from} through L${to} in complete detail. The visible line range is the reader's requested scope; include every intermediate implication and equation needed to understand that range.`)); reportReaderProcess({ id: processId, label: `Proof L${from}–L${to} ready`, detail: displayUnitLabel(node), status: 'complete' }); } catch (cause) { const message = cause instanceof Error ? cause.message : 'The proof range could not be expanded.'; setError(message); reportReaderProcess({ id: processId, label: `Proof L${from}–L${to} stopped`, detail: message, status: 'error' }); } finally { setBusy(false); } }
  return <section className="assistant-proof-expander"><header><b>Expand proof</b><span>{lineCount} visible lines</span></header><div><label>From <span className="proof-line-prefix">L</span><input type="number" min="1" max={lineCount} value={start} onChange={(event) => setStart(Number(event.target.value))} /></label><label>to <span className="proof-line-prefix">L</span><input type="number" min="1" max={lineCount} value={end} onChange={(event) => setEnd(Number(event.target.value))} /></label><button onClick={() => void run()} disabled={busy}>{busy ? 'Expanding…' : 'Expand'}</button></div>{busy && <div className="proof-ai-progress"><span /><span /><span /><p>Reading the selected proof lines…</p></div>}{error && <p className="proof-step-error">{error}</p>}{answer && <details open><summary>Detailed expansion · L{start}–L{end}</summary><AIText value={answer} citations={node.citations ?? []} /></details>}</section>;
}

type InspectorProps = { paper: Paper; node: AuditNode; originalNode?: AuditNode; plainSource?: boolean; edition: EditionMode; patches: WorkingPatch[]; savePatches: (patches: WorkingPatch[]) => Promise<void>; suggestEdit: (node: AuditNode) => Promise<EditorialSuggestion>; expanded: boolean; setExpanded: (value: boolean) => void; expandProof: (node: AuditNode, request: string) => Promise<string>; notes: Note[]; answer?: string; question: string; setQuestion: (value: string) => void; asking: boolean; ask: () => void; saveNote: (anchor: string, nodeId: string, text: string, latex: string) => void; updateNote: (noteId: string, text: string) => void; deleteNote: (noteId: string) => void; graph: Graph; addLink: (link: Omit<CrossLink, 'id' | 'source' | 'createdAt'>) => Promise<void>; removeLink: (linkId: string) => Promise<void>; openUnit: (paperId: string, nodeId: string) => void; openOriginalPaper: (page?: number) => void; assistantRequest: { view: 'ask' | 'notes' | 'compose-note'; nonce: number } | null; clearAssistantRequest: () => void };

function NodeInspector({ paper, node, originalNode, plainSource = false, edition, patches, savePatches, suggestEdit, expanded, setExpanded, expandProof, notes, answer, question, setQuestion, asking, ask, saveNote, updateNote, deleteNote, graph, addLink, removeLink, openUnit, openOriginalPaper, assistantRequest, clearAssistantRequest }: InspectorProps) {
  const [noteText, setNoteText] = useState(''); const [noteEditNonce, setNoteEditNonce] = useState(0); const [target, setTarget] = useState(''); const [relation, setRelation] = useState<CrossLink['relation']>('uses'); const [linkNote, setLinkNote] = useState(''); const [advancedOpen, setAdvancedOpen] = useState(false); const [toolView, setToolView] = useState<'edit' | 'context'>('edit');
  const notesRef = useRef<HTMLElement>(null); const noteComposerRef = useRef<HTMLTextAreaElement>(null); const askInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!assistantRequest) return;
    const frame = window.requestAnimationFrame(() => {
      if (assistantRequest.view === 'ask') askInputRef.current?.focus();
      if (assistantRequest.view === 'notes' || assistantRequest.view === 'compose-note') notesRef.current?.scrollIntoView({ block: 'nearest' });
      if (assistantRequest.view === 'compose-note' && notes.length > 0) setNoteEditNonce((value) => value + 1);
      else if (assistantRequest.view === 'compose-note') noteComposerRef.current?.focus();
      clearAssistantRequest();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [assistantRequest, clearAssistantRequest, notes.length]);
  const sourceId = unitId(paper.id, node.id); const candidates = graph.nodes.filter((item) => item.paperId !== paper.id); const edges = graph.edges.filter((edge) => edge.from === sourceId || edge.to === sourceId); const nodeById = new Map(graph.nodes.map((item) => [item.id, item]));
  const prerequisiteNodes = edges.filter((edge) => edge.from === sourceId && edge.relation === 'uses').map((edge) => nodeById.get(edge.to)).filter(Boolean) as GraphNode[];
  const dependentNodes = edges.filter((edge) => edge.to === sourceId && edge.relation === 'uses').map((edge) => nodeById.get(edge.from)).filter(Boolean) as GraphNode[];
  function saveLinkedNote() { saveNote(`${displayUnitLabel(node)} · p.${node.anchor.page ?? '—'}`, node.id, noteText, ''); setNoteText(''); }
  function createLink() { const selected = graph.nodes.find((item) => item.id === target); if (!selected) return; void addLink({ from: { paperId: paper.id, nodeId: node.id }, to: { paperId: selected.paperId, nodeId: selected.nodeId }, relation, note: linkNote }); setTarget(''); setLinkNote(''); }
  return <div className={`inspector-stack inspector-minimal assistant-view-${toolView} ${advancedOpen ? 'advanced' : ''}`}><div className="assistant-unit-head"><div><span className={kindClass(node.kind)}>{node.kind}</span>{!plainSource && !paper.arxivId.startsWith('local-') && <button className="assistant-source-page" onClick={() => openOriginalPaper(node.anchor.page ?? undefined)} aria-label={`Open the original paper at page ${node.anchor.page ?? 1}`}>p.{node.anchor.page ?? '—'}</button>}</div><p>{displayUnitLabel(node)}</p><h3><MathText value={node.title} citations={node.citations ?? []} /></h3></div><section className={`assistant-ask ${asking ? 'assistant-asking' : ''}`}><div><input ref={askInputRef} aria-label={`Ask about ${displayUnitLabel(node)}`} value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') ask(); }} placeholder={`Ask about this ${displayUnitLabel(node).toLowerCase()}…`} /><button onClick={ask} disabled={asking || !question.trim()}>{asking ? 'Working' : 'Ask'}</button></div>{asking && <div className="assistant-thinking"><i /><i /><i /><span>Checking the paper and dependencies…</span></div>}{answer && <div className="assistant-answer"><MathText value={answer} block /></div>}</section><section ref={notesRef} className="assistant-notes"><header><b>Note</b>{notes.length > 0 && <span>Saved locally</span>}</header>{notes.length > 0 ? <div className="assistant-saved-notes">{notes.map((note) => <EditableSavedNote key={`${note.id}:${noteEditNonce}`} note={note} update={updateNote} remove={deleteNote} autoEdit={noteEditNonce > 0} />)}</div> : <div className="assistant-note-composer"><textarea ref={noteComposerRef} aria-label={`Note for ${displayUnitLabel(node)}`} value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder={`Write one note for this ${displayUnitLabel(node).toLowerCase()}. LaTeX: $inline$ or $$display math$$`} />{noteText.trim() && <div className="assistant-note-preview"><MathText value={noteText} block /></div>}<button onClick={saveLinkedNote} disabled={!noteText.trim()}>Save note</button></div>}</section>{!plainSource && <><AssistantProofExpander node={node} expand={expandProof} /><button className="assistant-more" onClick={() => setAdvancedOpen(!advancedOpen)}>{advancedOpen ? 'Hide edit and context' : 'Edit and context'} <span>{advancedOpen ? '−' : '+'}</span></button></>}{!plainSource && advancedOpen && <><nav className="assistant-tool-tabs">{(['edit', 'context'] as const).map((view) => <button key={view} className={toolView === view ? 'active' : ''} onClick={() => setToolView(view)}>{view[0].toUpperCase() + view.slice(1)}</button>)}</nav><WorkingEditionEditor node={node} originalNode={originalNode} edition={edition} patches={patches} savePatches={savePatches} suggestEdit={suggestEdit} /><section className="assistant-source-context context-tool"><MathText value={node.statement || 'No standalone statement was preserved by the audit.'} block citations={node.citations ?? []} /><Info label="Role" text={node.role || 'Not classified.'} /><Info label="Why it matters" text={node.whyItMatters || 'Not classified.'} /></section>
    <section className="inspector-section logical-neighborhood context-tool"><div className="flex items-center justify-between"><p className="mini-label">Logical neighborhood</p><span>{prerequisiteNodes.length} in · {dependentNodes.length} out</span></div><div className="logical-flow"><div><b>Depends on</b>{prerequisiteNodes.length ? prerequisiteNodes.map((item) => <button key={item.id} onClick={() => openUnit(item.paperId, item.nodeId)}><small>{item.kind}</small><span>{displayUnitLabel(item)} · {item.title}</span></button>) : <p>No audited prerequisites.</p>}</div><i>→</i><div className="logical-current"><small>{node.kind}</small><b>{displayUnitLabel(node)}</b></div><i>→</i><div><b>Used by</b>{dependentNodes.length ? dependentNodes.map((item) => <button key={item.id} onClick={() => openUnit(item.paperId, item.nodeId)}><small>{item.kind}</small><span>{displayUnitLabel(item)} · {item.title}</span></button>) : <p>No audited dependents.</p>}</div></div></section>
    <section className="inspector-section context-tool"><button onClick={() => setExpanded(!expanded)} className="inspector-toggle"><span>Proof & dependencies</span><span>{expanded ? '−' : '+'}</span></button>{expanded && <div className="mt-3"><p className="mini-label">Prerequisites</p><div className="mt-1 flex flex-wrap gap-1">{node.dependencies.length ? node.dependencies.map((dependency) => { const targetNode = graph.nodes.find((item) => item.paperId === paper.id && item.nodeId === dependency); return <span key={dependency} className="ref-chip">{targetNode ? displayUnitLabel(targetNode) : 'Referenced result'}</span>; }) : <span className="text-[11px] text-[#758075]">No audited prerequisites.</span>}</div>{node.proofText && <><p className="mini-label mt-3">Source proof</p><div className="mt-2 text-[11px] leading-5 text-[#56504c]"><MathText value={node.proofText} block citations={node.citations ?? []} /></div></>}{node.proofSketch.length > 0 && <><p className="mini-label mt-3">AI proof route</p><ol className="mt-2 space-y-2">{node.proofSketch.map((step, index) => <li key={index} className="flex gap-2 text-[11px] leading-5 text-[#56504c]"><span className="grid h-4 w-4 flex-none place-items-center rounded-full bg-white text-[9px] font-bold text-[#8f1d2c]">{index + 1}</span><MathText value={step} citations={node.citations ?? []} /></li>)}</ol></>}</div>}</section>
    <section className="inspector-section context-tool"><div className="flex justify-between"><p className="mini-label">Cross-paper relations</p><span className="text-[10px] text-[#7d877d]">{edges.length}</span></div>{edges.length ? <div className="mt-2 space-y-1.5">{edges.map((edge) => { const otherId = edge.from === sourceId ? edge.to : edge.from; const other = nodeById.get(otherId); const manual = edge.source === 'manual'; const manualId = manual ? edge.id.replace('manual:', '') : ''; return <div key={edge.id} className="cross-edge"><button onClick={() => other && openUnit(other.paperId, other.nodeId)} className="min-w-0 flex-1 text-left"><b>{edge.relation}</b><span>{other ? `${other.paperTitle} · ${displayUnitLabel(other)}` : 'Referenced result'}</span></button>{manual && <button onClick={() => void removeLink(manualId)} title="Remove relation" className="text-[#899189]">×</button>}</div>; })}</div> : <p className="mt-2 text-[11px] leading-5 text-[#758075]">No local cross-paper relation yet.</p>}{candidates.length > 0 && <div className="mt-3 border-t border-[#e2e7df] pt-3"><select value={target} onChange={(event) => setTarget(event.target.value)} className="w-full rounded border border-[#d5ddd4] bg-white px-2 py-1.5 text-[10px] outline-none"><option value="">Link to another audited unit…</option>{candidates.map((item) => <option key={item.id} value={item.id}>{item.paperTitle} · {displayUnitLabel(item)}</option>)}</select><div className="mt-1.5 flex gap-1.5"><select value={relation} onChange={(event) => setRelation(event.target.value as CrossLink['relation'])} className="rounded border border-[#d5ddd4] bg-white px-1.5 py-1 text-[10px]"><option value="uses">uses</option><option value="extends">extends</option><option value="background">background</option><option value="contrasts">contrasts</option></select><button onClick={createLink} disabled={!target} className="rounded border border-[#cbdacb] px-2 py-1 text-[10px] font-bold text-[#35624b] disabled:opacity-50">Add relation</button></div><input value={linkNote} onChange={(event) => setLinkNote(event.target.value)} placeholder="Optional rationale" className="mt-1.5 w-full rounded border border-[#d5ddd4] px-2 py-1.5 text-[10px] outline-none" /></div>}</section>
    </>}
  </div>;
}

function Info({ label, text }: { label: string; text: string }) { return <div className="rounded border border-[#e3ddd5] bg-[#fbfaf7] p-2.5"><p className="mini-label">{label}</p><div className="mt-1 text-[11px] leading-5 text-[#58514d]"><MathText value={text} block /></div></div>; }

function CloudSharing({ papers }: { papers: Paper[] }) {
  const [open, setOpen] = useState(false); const [providers, setProviders] = useState<CloudProviderStatus[]>([]); const [provider, setProvider] = useState(''); const [selected, setSelected] = useState<string[]>([]); const [title, setTitle] = useState('My arXivpecker library'); const [parts, setParts] = useState({ source: true, audit: true, notes: true, edits: true, references: true, preferences: true }); const [gitRemote, setGitRemote] = useState(''); const [gitBranch, setGitBranch] = useState('main'); const [recent, setRecent] = useState<CloudShareRecord[]>([]); const [loading, setLoading] = useState(false); const [sharing, setSharing] = useState(false); const [error, setError] = useState(''); const [saved, setSaved] = useState<CloudShareRecord | null>(null); const [copied, setCopied] = useState(false);
  const currentProvider = providers.find((item) => item.id === provider);
  async function refresh() { setLoading(true); setError(''); try { const response = await fetch(`${bridgeUrl}/cloud/status`); const data = await response.json() as { providers?: CloudProviderStatus[]; recent?: CloudShareRecord[]; error?: string }; if (!response.ok) throw new Error(data.error || 'Cloud connections could not be checked.'); const available = data.providers ?? []; setProviders(available); setRecent(data.recent ?? []); setProvider((current) => current || available.find((item) => item.available)?.id || available[0]?.id || 'icloud'); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Cloud connections could not be checked.'); } finally { setLoading(false); } }
  function toggleOpen() { const next = !open; setOpen(next); if (next) { if (!selected.length) setSelected(papers.map((paper) => paper.id)); void refresh(); } }
  function togglePaper(id: string) { setSelected((current) => current.includes(id) ? current.filter((paperId) => paperId !== id) : [...current, id]); }
  async function createShare() {
    if (!selected.length || !provider) return;
    const processId = `cloud-share:${Date.now()}`; reportReaderProcess({ id: processId, label: 'Saving cloud share', detail: `${selected.length} paper${selected.length === 1 ? '' : 's'}`, status: 'running' }); setSharing(true); setError(''); setSaved(null);
    try {
      const localJson = (key: string) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
      const uiPreferences = { readerProfile: localJson(preferenceKey), paperScale: Number(localStorage.getItem(paperScaleKey) || 1), assistantSize: localJson(assistantSizeKey) };
      const response = await fetch(`${bridgeUrl}/cloud/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, paperIds: selected, title, selection: parts, gitRemote, gitBranch, uiPreferences }) });
      const data = await response.json() as { share?: CloudShareRecord; error?: string }; if (!response.ok || !data.share) throw new Error(data.error || 'The cloud copy could not be created.'); setSaved(data.share); setRecent((current) => [data.share as CloudShareRecord, ...current.filter((item) => item.id !== data.share?.id)].slice(0, 20)); reportReaderProcess({ id: processId, label: 'Cloud share saved', detail: data.share.location, status: 'complete' });
    } catch (cause) { const message = cause instanceof Error ? cause.message : 'The cloud copy could not be created.'; setError(message); reportReaderProcess({ id: processId, label: 'Cloud share stopped', detail: message, status: 'error' }); } finally { setSharing(false); }
  }
  async function copyLocation() { if (!saved) return; await navigator.clipboard.writeText(saved.location); setCopied(true); window.setTimeout(() => setCopied(false), 1200); }
  const partChoices: [keyof typeof parts, string][] = [['source', 'Original source'], ['audit', 'AI audit'], ['notes', 'Notes & marks'], ['edits', 'Working changes'], ['references', 'References'], ['preferences', 'Reader preferences']];
  return <section className={`cloud-sharing ${open ? 'open' : ''}`}><button className="cloud-sharing-disclosure" onClick={toggleOpen} aria-expanded={open}><span><b>Cloud sharing</b><small>{open ? 'Choose papers, reading data, and a destination.' : 'Save selected papers, notes, edits, and preferences.'}</small></span><span>{open ? '−' : '+'}</span></button>{open && <div className="cloud-sharing-body"><div className="cloud-provider-row" aria-label="Cloud destination">{providers.map((item) => <button key={item.id} className={provider === item.id ? 'active' : ''} onClick={() => { setProvider(item.id); setSaved(null); setError(''); }}><i className={item.available ? 'connected' : ''} /><span>{item.label}</span></button>)}{loading && <span className="cloud-provider-loading"><i />Checking…</span>}</div>{currentProvider && <div className="cloud-connection"><span><i className={currentProvider.available ? 'connected' : ''} />{currentProvider.detail}</span><div>{currentProvider.connectUrl && <a href={currentProvider.connectUrl} target="_blank" rel="noreferrer">{currentProvider.available ? 'Open cloud' : 'Sign in'}</a>}<button onClick={() => void refresh()} disabled={loading}>Refresh</button></div></div>}{provider === 'git' && <div className="cloud-git-fields"><label><span>Remote repository</span><input value={gitRemote} onChange={(event) => setGitRemote(event.target.value)} placeholder="git@github.com:you/reading-library.git" /></label><label><span>Branch</span><input value={gitBranch} onChange={(event) => setGitBranch(event.target.value)} /></label><p>Uses your existing SSH key or system Git credentials. <a href="https://github.com/login" target="_blank" rel="noreferrer">GitHub</a> · <a href="https://gitlab.com/users/sign_in" target="_blank" rel="noreferrer">GitLab</a> · <a href="https://bitbucket.org/account/signin/" target="_blank" rel="noreferrer">Bitbucket</a></p></div>}<div className="cloud-share-columns"><section><header><b>Papers</b><div><button onClick={() => setSelected(papers.map((paper) => paper.id))}>All</button><button onClick={() => setSelected([])}>None</button></div></header><div className="cloud-paper-list">{papers.map((paper) => <label key={paper.id}><input type="checkbox" checked={selected.includes(paper.id)} onChange={() => togglePaper(paper.id)} /><span><b><MathText value={paper.title} /></b><small>{paperSourceLabel(paper)}</small></span></label>)}</div></section><section><header><b>Include</b><small>Paper records are always included.</small></header><div className="cloud-part-list">{partChoices.map(([key, label]) => <label key={key}><input type="checkbox" checked={parts[key]} onChange={(event) => setParts({ ...parts, [key]: event.target.checked })} /><span>{label}</span></label>)}</div><label className="cloud-share-title"><span>Share name</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} /></label></section></div>{error && <p className="cloud-share-error">{error}</p>}{saved && <div className="cloud-share-saved"><div><b>Cloud copy saved</b><span>{saved.location}</span></div><button onClick={() => void copyLocation()}>{copied ? 'Copied' : 'Copy location'}</button>{saved.connectUrl && <a href={saved.connectUrl} target="_blank" rel="noreferrer">Open cloud</a>}</div>}<footer className="cloud-share-footer"><span>{selected.length} paper{selected.length === 1 ? '' : 's'} selected</span><button onClick={() => void createShare()} disabled={sharing || !selected.length || !currentProvider?.available || (provider === 'git' && !gitRemote.trim())}>{sharing ? <><i />Saving…</> : 'Create cloud copy'}</button></footer>{recent.length > 0 && <details className="cloud-share-history"><summary>Recent cloud copies <span>{recent.length}</span></summary><div>{recent.slice(0, 6).map((item) => <article key={item.id}><div><b>{item.title}</b><span>{item.providerLabel} · {item.paperCount} paper{item.paperCount === 1 ? '' : 's'}</span></div><small>{new Date(item.createdAt).toLocaleString()}</small></article>)}</div></details>}</div>}</section>;
}

function Library({ papers, audits, patches, updates, jobs, auditJobs, analyze, refreshPaper, showUpdate, updatePaper, removePaper, reorderPapers, openUnit, openImport }: { papers: Paper[]; audits: Record<string, PaperAudit>; patches: Record<string, WorkingPatch[]>; updates: Record<string, PaperUpdateRecord[]>; jobs: Record<string, PaperJobKind>; auditJobs: Record<string, AuditJob>; analyze: (paper: Paper) => Promise<void>; refreshPaper: (paper: Paper) => Promise<void>; showUpdate: (update: PaperUpdateRecord) => void; updatePaper: (paper: Paper) => Promise<void>; removePaper: (paperId: string) => Promise<void>; reorderPapers: (papers: Paper[]) => Promise<void>; openUnit: (paperId: string, nodeId: string) => void; openImport: () => void }) {
  const [query, setQuery] = useState(''); const [editing, setEditing] = useState<Paper | null>(null); const [confirming, setConfirming] = useState(''); const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [draggingId, setDraggingId] = useState(''); const [dropId, setDropId] = useState('');
  const visible = useMemo(() => { const needle = searchablePaperText(query); if (!needle) return papers; return papers.filter((paper) => searchablePaperText([paper.title, paper.authors, paper.arxivId, paper.category, paper.state, ...paper.tags].join(' ')).includes(needle)); }, [papers, query]);
  async function saveEdit() { if (!editing?.title.trim()) return; setSaving(true); setError(''); try { await updatePaper(editing); setEditing(null); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update this paper.'); } finally { setSaving(false); } }
  async function remove(id: string) { setSaving(true); setError(''); try { await removePaper(id); setConfirming(''); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove this paper.'); } finally { setSaving(false); } }
  function finishDrop(targetId: string) { if (!draggingId || draggingId === targetId) { setDraggingId(''); setDropId(''); return; } const from = papers.findIndex((item) => item.id === draggingId); const to = papers.findIndex((item) => item.id === targetId); if (from < 0 || to < 0) return; const next = [...papers]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); setDraggingId(''); setDropId(''); void reorderPapers(next); }
  return <div className="mx-auto max-w-6xl p-6 sm:p-10"><div className="flex flex-wrap items-end justify-between gap-3"><h2 className="text-3xl font-bold tracking-[-.055em]">Library</h2><button onClick={openImport} className="rounded-md bg-[#2d654f] px-3 py-2 text-xs font-bold text-white">+ Import paper</button></div>
    <CloudSharing papers={papers} />
    <div className="library-search"><span>⌕</span><input aria-label="Search papers" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search papers…" /><b>{visible.length} of {papers.length}</b></div>{error && <p className="library-error">{error}</p>}
    <div className="library-grid">{visible.map((paper) => { const latestUpdate = updates[paper.id]?.[0]; const job = jobs[paper.id]; const checkpoint = auditJobs[paper.id]; const remoteRunning = checkpoint?.state === 'running'; const resumable = Boolean(checkpoint && !remoteRunning); const busy = Boolean(job) || remoteRunning; const updating = job === 'update'; return <article key={paper.id} draggable={!busy} aria-busy={busy} onDragStart={(event) => { setDraggingId(paper.id); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropId(paper.id); }} onDragLeave={() => setDropId((current) => current === paper.id ? '' : current)} onDrop={(event) => { event.preventDefault(); finishDrop(paper.id); }} onDragEnd={() => { setDraggingId(''); setDropId(''); }} className={`library-paper ${draggingId === paper.id ? 'library-paper-dragging' : ''} ${dropId === paper.id && draggingId !== paper.id ? 'library-paper-drop' : ''} ${busy ? 'library-paper-auditing' : ''}`}><button className="library-drag-handle" aria-label={`Drag to reorder ${paper.title}`} title="Drag to reorder" disabled={busy}>⠿</button><div className="library-paper-top"><div className="flex flex-wrap gap-1"><span>{paper.category}</span>{(patches[paper.id]?.length ?? 0) > 0 && <span>{patches[paper.id].length} working change{patches[paper.id].length === 1 ? '' : 's'}</span>}{latestUpdate && <button className="library-version-chip" onClick={() => showUpdate(latestUpdate)} disabled={busy}>{latestUpdate.fromVersion.replace(arxivBaseId(latestUpdate.fromVersion), '') || latestUpdate.fromVersion} → {latestUpdate.toVersion.replace(arxivBaseId(latestUpdate.toVersion), '') || latestUpdate.toVersion}</button>}</div><span className={busy ? 'library-auditing' : resumable ? 'library-pending' : audits[paper.id] ? 'library-audited' : 'library-pending'}>{busy ? <><i /><b>{updating ? 'Updating' : 'Auditing'}</b></> : resumable ? 'Audit paused' : audits[paper.id] ? 'Audited' : 'Not audited'}</span></div><h3><MathText value={paper.title} /></h3><p><MathText value={paper.authors} /></p><small>{paperSourceLabel(paper)}</small><div className="library-tags">{paper.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><div className="library-paper-actions"><div className="library-primary-actions"><button onClick={() => openUnit(paper.id, audits[paper.id]?.nodes[0]?.id ?? '')} disabled={busy} aria-label={`Open ${paper.title} in the reader`} title="Open in reader">Open</button>{!paper.arxivId.startsWith('local-') && <button className="library-update" onClick={() => void refreshPaper(paper)} disabled={busy} aria-label={`Check arXiv for a newer version of ${paper.title}`} title="Check for a newer arXiv version">{updating ? 'Update…' : 'Update'}</button>}<button onClick={() => void analyze(paper)} disabled={busy} aria-label={`${resumable ? 'Continue audit' : audits[paper.id] ? 'Re-audit' : 'Analyze'} ${paper.title}`} title={resumable ? 'Continue the saved AI audit thread' : audits[paper.id] ? 'Run the AI audit again' : 'Analyze with AI'}>{busy && !updating ? 'Audit…' : resumable ? 'Continue audit' : 'Audit'}</button>{latestUpdate && <button onClick={() => showUpdate(latestUpdate)} disabled={busy} aria-label={`View version changes for ${paper.title}`} title="View version changes">Changes</button>}</div><div className="library-record-actions"><button onClick={() => { setEditing({ ...paper }); setError(''); }} disabled={busy} aria-label={`Edit the library record for ${paper.title}`} title="Edit library record">Edit</button>{confirming !== paper.id && <button className="library-remove" onClick={() => setConfirming(paper.id)} disabled={busy} aria-label={`Remove ${paper.title} from the Library`} title="Remove from Library">Remove</button>}</div></div>{confirming === paper.id && <div className="library-delete-confirmation" role="alert"><b>Remove this paper?</b><p>Its local notes, reading marks, edits, AI audit, update history, uploaded references, and saved links will be removed with it.</p><div><button onClick={() => setConfirming('')} disabled={saving}>Cancel</button><button className="library-confirm-delete" onClick={() => void remove(paper.id)} disabled={saving}>{saving ? 'Removing…' : 'Remove paper and local data'}</button></div></div>}</article>; })}</div>
    {!visible.length && <div className="library-empty">No matches.</div>}
    {editing && <div className="edition-overlay" onMouseDown={(event) => { if (event.currentTarget === event.target) setEditing(null); }}><section className="paper-record-editor"><header><h3>Edit paper</h3><button onClick={() => setEditing(null)}>×</button></header><div className="paper-record-fields"><label><span>Title</span><input value={editing.title} onChange={(event) => setEditing({ ...editing, title: event.target.value })} /></label><label><span>Authors</span><input value={editing.authors} onChange={(event) => setEditing({ ...editing, authors: event.target.value })} /></label><div className="paper-record-row"><label><span>Field</span><input value={editing.category} onChange={(event) => setEditing({ ...editing, category: event.target.value })} /></label><label><span>Reading state</span><select value={editing.state} onChange={(event) => setEditing({ ...editing, state: event.target.value as Paper['state'] })}><option>To read</option><option>Reading</option><option>Read</option></select></label></div><label><span>Tags</span><input value={editing.tags.join(', ')} onChange={(event) => setEditing({ ...editing, tags: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label><label><span>Abstract</span><textarea value={editing.abstract} onChange={(event) => setEditing({ ...editing, abstract: event.target.value })} /></label></div><footer><button onClick={() => setEditing(null)}>Cancel</button><button className="paper-record-save" onClick={() => void saveEdit()} disabled={saving || !editing.title.trim()}>{saving ? 'Saving…' : 'Save'}</button></footer></section></div>}
  </div>;
}

function GraphView({ graph, papers, openUnit }: { graph: Graph; papers: Paper[]; openUnit: (paperId: string, nodeId: string) => void }) { const nodeById = new Map(graph.nodes.map((item) => [item.id, item])); const cross = graph.edges.filter((edge) => nodeById.get(edge.from)?.paperId !== nodeById.get(edge.to)?.paperId); return <div className="mx-auto max-w-6xl p-6 sm:p-10"><div><p className="reader-kicker">Local dependency graph</p><h2 className="mt-1 text-3xl font-bold tracking-[-.055em]">Results that travel between papers</h2><p className="mt-2 text-sm text-[#707970]">Audited units are nodes. Arrows are proof dependencies or explicit relations you add while reading.</p></div>{graph.nodes.length === 0 ? <div className="mt-8 rounded-xl border border-dashed border-[#d8dfd7] p-8 text-sm text-[#7a837a]">Audit at least one paper to build its local graph.</div> : <><div className="graph-canvas mt-8">{papers.filter((paper) => graph.nodes.some((node) => node.paperId === paper.id)).map((paper) => <section key={paper.id} className="graph-paper"><div className="flex items-center justify-between"><b>{paper.title}</b><span>{graph.nodes.filter((node) => node.paperId === paper.id).length} units</span></div><div className="mt-3 flex flex-wrap gap-2">{graph.nodes.filter((node) => node.paperId === paper.id).map((node) => <button key={node.id} onClick={() => openUnit(node.paperId, node.nodeId)} className={`graph-node ${kindClass(node.kind)}`}>{displayUnitLabel(node)}</button>)}</div></section>)}</div><section className="mt-7 rounded-xl border border-[#e0e6df] bg-white p-4"><div className="flex justify-between"><div><p className="reader-kicker">Cross-paper arrows</p><h3 className="mt-1 text-lg font-bold">{cross.length} relation{cross.length === 1 ? '' : 's'}</h3></div><span className="text-[10px] text-[#7c857c]">Add relations from a unit inspector</span></div><div className="mt-4 space-y-2">{cross.length ? cross.map((edge) => { const from = nodeById.get(edge.from); const to = nodeById.get(edge.to); return <div key={edge.id} className="graph-edge"><button onClick={() => from && openUnit(from.paperId, from.nodeId)}>{from ? `${from.paperTitle} · ${displayUnitLabel(from)}` : 'Referenced result'}</button><span>— {edge.relation} →</span><button onClick={() => to && openUnit(to.paperId, to.nodeId)}>{to ? `${to.paperTitle} · ${displayUnitLabel(to)}` : 'Referenced result'}</button>{edge.note && <small>{edge.note}</small>}</div>; }) : <p className="text-sm text-[#788178]">No cross-paper arrows yet. Link a theorem, definition, or external result from the right-hand reader inspector.</p>}</div></section></>}</div>; }

function Discover({ papers, saved, save, refresh, loading, selectedAreas }: { papers: Paper[]; saved: Paper[]; save: (paper: Paper) => Promise<void>; refresh: (area?: string, latestBatch?: boolean) => Promise<void>; loading: boolean; selectedAreas: string[] }) {
  const [area, setArea] = useState(selectedAreas[0] || 'math.AG');
  return <div className="mx-auto max-w-5xl p-6 sm:p-10"><div className="flex flex-wrap items-end justify-between gap-3"><h2 className="text-3xl font-bold tracking-[-.055em]">Latest arXiv</h2><div className="discovery-actions"><button onClick={() => void refresh()}>{loading ? 'Loading…' : 'My areas'}</button><label><span>Category</span><select value={area} onChange={(event) => setArea(event.target.value)}>{mathAreas.map(([id, label]) => <option key={id} value={id}>{id} · {label}</option>)}</select></label><button className="discovery-all" onClick={() => void refresh(area, true)} disabled={loading}>{loading ? 'Loading…' : 'Load latest'}</button></div></div><div className="mt-8 space-y-3">{papers.length ? papers.map((paper) => {
    const inVault = saved.some((item) => item.arxivId.replace(/v\d+$/i, '') === paper.arxivId.replace(/v\d+$/i, ''));
    return <article key={paper.arxivId} className="rounded-xl border border-[#e1e6df] bg-white p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 max-w-2xl"><span className="rounded bg-[#edf4ee] px-2 py-1 text-[10px] font-bold text-[#46705a]">{paper.category}</span><h3 className="mt-3 text-lg font-bold"><MathText value={paper.title} /></h3><p className="mt-1 text-xs text-[#737c73]"><MathText value={paper.authors} /> · arXiv:{paper.arxivId}</p>{paper.abstract && <div className="mt-3 text-sm leading-6 text-[#606a60]"><MathText value={paper.abstract} block /></div>}</div><button disabled={inVault} onClick={() => void save(paper)} className={`rounded-md px-3 py-2 text-xs font-bold ${inVault ? 'bg-[#edf0ec] text-[#869086]' : 'bg-[#2d654f] text-white'}`}>{inVault ? 'Saved' : '+ Save'}</button></div></article>;
  }) : <div className="library-empty">No papers found.</div>}</div></div>;
}

function OnboardingDialog({ profile, setProfile, bridge, finish }: { profile: Profile; setProfile: (value: Profile | ((old: Profile) => Profile)) => void; bridge: Bridge | null; finish: () => void }) { const update = (key: 'level' | 'goal' | 'model' | 'reasoning', value: string) => setProfile((current) => ({ ...current, [key]: value, ...(key === 'reasoning' ? { reasoningConfigured: true } : {}) })); const model = bridge?.models.find((item) => item.id === profile.model); const efforts = model?.efforts.length ? model.efforts : ['low', 'medium', 'high', 'xhigh']; return <div className="onboarding-shell"><section className="onboarding-dialog"><header><span>First-time setup</span><h2>Set your reading profile.</h2></header><div className="onboarding-fields"><Select label="Background" value={profile.level} options={['Undergraduate', 'Graduate student', 'Researcher']} onChange={(value) => update('level', value)} /><Select label="Reading goal" value={profile.goal} options={['Survey new work', 'Understand proofs', 'Apply a result', 'Reproduce a proof']} onChange={(value) => update('goal', value)} /><AreaMultiSelect value={profile.areas} onChange={(areas) => setProfile((current) => ({ ...current, areas }))} /><Select label="Codex model" value={profile.model} options={(bridge?.models ?? []).map((item) => item.id)} labels={(bridge?.models ?? []).reduce<Record<string, string>>((result, item) => ({ ...result, [item.id]: item.label }), {})} onChange={(value) => update('model', value)} emptyLabel="Codex default" /><Select label="Reasoning effort" value={profile.reasoning} options={efforts} onChange={(value) => update('reasoning', value)} /></div><footer><button onClick={finish} disabled={!profile.areas.length}>Start reading</button></footer></section></div>; }

function Settings({ profile, setProfile, bridge }: { profile: Profile; setProfile: (value: Profile | ((old: Profile) => Profile)) => void; bridge: Bridge | null }) { const update = (key: 'level' | 'goal' | 'model' | 'reasoning', value: string) => setProfile((current) => ({ ...current, [key]: value })); const model = bridge?.models.find((item) => item.id === profile.model); const efforts = model?.efforts.length ? model.efforts : ['low', 'medium', 'high', 'xhigh']; return <div className="mx-auto max-w-3xl p-6 sm:p-10"><h2 className="text-3xl font-bold tracking-[-.055em]">Settings</h2><div className="mt-8 grid gap-4 sm:grid-cols-2"><Select label="Background" value={profile.level} options={['Undergraduate', 'Graduate student', 'Researcher']} onChange={(value) => update('level', value)} /><Select label="Reading goal" value={profile.goal} options={['Survey new work', 'Understand proofs', 'Apply a result', 'Reproduce a proof']} onChange={(value) => update('goal', value)} /><AreaMultiSelect value={profile.areas} onChange={(areas) => setProfile((current) => ({ ...current, areas }))} /><Select label="Codex model" value={profile.model} options={(bridge?.models ?? []).map((item) => item.id)} labels={(bridge?.models ?? []).reduce<Record<string, string>>((result, item) => ({ ...result, [item.id]: item.label }), {})} onChange={(value) => update('model', value)} emptyLabel="Codex default" /><Select label="Reasoning effort" value={profile.reasoning} options={efforts} onChange={(value) => update('reasoning', value)} /></div></div>; }

function AreaMultiSelect({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const [open, setOpen] = useState(false); const [query, setQuery] = useState('');
  const visible = mathAreas.filter(([id, label]) => `${id} ${label}`.toLowerCase().includes(query.toLowerCase()));
  function toggle(id: string) { onChange(value.includes(id) ? value.length === 1 ? value : value.filter((area) => area !== id) : [...value, id]); }
  return <div className="area-multiselect"><div className="area-multiselect-head"><span>Mathematical areas</span><small>{value.length} selected</small></div><button className="area-multiselect-trigger" onClick={() => setOpen(!open)} aria-expanded={open}><span>{value.slice(0, 3).join(' · ')}{value.length > 3 ? ` +${value.length - 3}` : ''}</span><b>{open ? '−' : '+'}</b></button>{open && <div className="area-multiselect-menu"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter all arXiv math areas…" autoFocus /><div>{visible.map(([id, label]) => <label key={id}><input type="checkbox" checked={value.includes(id)} onChange={() => toggle(id)} /><span><b>{id}</b><small>{label}</small></span></label>)}</div><footer><button onClick={() => onChange(mathAreas.map(([id]) => id))}>Select all</button><button onClick={() => { onChange([defaultProfile.areas[0]]); setOpen(false); }}>Reset</button><button onClick={() => setOpen(false)}>Done</button></footer></div>}</div>;
}

function Select({ label, value, options, labels = {}, onChange, emptyLabel }: { label: string; value: string; options: string[]; labels?: Record<string, string>; onChange: (value: string) => void; emptyLabel?: string }) { return <label className="rounded-xl border border-[#e1e6df] bg-white p-4"><span className="text-xs font-bold">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="mt-3 block w-full rounded-md border border-[#dce3da] bg-[#fbfcf9] px-2.5 py-2 text-xs text-[#415c4b] outline-none"><option value="">{emptyLabel ?? 'Codex default'}</option>{options.map((option) => <option key={option} value={option}>{labels[option] ?? option}</option>)}</select></label>; }

function ModelControls({ profile, setProfile, bridge, compact = false }: { profile: Profile; setProfile: (value: Profile | ((old: Profile) => Profile)) => void; bridge: Bridge | null; compact?: boolean }) {
  const selected = bridge?.models.find((item) => item.id === profile.model);
  const efforts = selected?.efforts.length ? selected.efforts : ['low', 'medium', 'high', 'xhigh'];
  function chooseModel(modelId: string) {
    const model = bridge?.models.find((item) => item.id === modelId);
    setProfile((current) => ({ ...current, model: modelId, reasoning: model?.efforts.includes(current.reasoning) ? current.reasoning : model?.efforts.includes(defaultReasoning) ? defaultReasoning : model?.defaultEffort ?? model?.efforts[0] ?? defaultReasoning }));
  }
  return <div className={`model-controls ${compact ? 'model-controls-compact' : ''}`}><label><span>Model</span><select aria-label="AI model" value={profile.model} onChange={(event) => chooseModel(event.target.value)} disabled={!bridge?.models.length}><option value="">Codex default</option>{(bridge?.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label><label><span>Reasoning</span><select aria-label="Reasoning effort" value={profile.reasoning} onChange={(event) => setProfile((current) => ({ ...current, reasoning: event.target.value, reasoningConfigured: true }))}>{efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label></div>;
}

type ReaderProcessEntry = ReaderProcessUpdate & { startedAt: number; updatedAt: number };

function ProcessMascot({ busy = false }: { busy?: boolean }) {
  return <span className={`process-mascot ${busy ? 'busy' : ''}`} aria-hidden="true"><BrandMascot busy={busy} compact /></span>;
}

function ProcessTray({ retryAudit }: { retryAudit: (paperId: string) => void }) {
  // Activity is deliberately session-only. A fresh app launch begins with an
  // empty tray instead of resurfacing stale completed or interrupted work.
  const [entries, setEntries] = useState<ReaderProcessEntry[]>([]); const [collapsed, setCollapsed] = useState(true); const [now, setNow] = useState(0);
  useEffect(() => {
    const receive = (event: Event) => {
      const update = (event as CustomEvent<ReaderProcessUpdate>).detail; const timestamp = Date.now(); setCollapsed(false);
      setEntries((current) => { const previous = current.find((item) => item.id === update.id); return [{ ...update, startedAt: previous?.status === 'running' ? previous.startedAt : timestamp, updatedAt: timestamp }, ...current.filter((item) => item.id !== update.id)].slice(0, 14); });
    };
    const toggle = () => setCollapsed((current) => !current);
    window.addEventListener('proofroom:process', receive); window.addEventListener('proofroom:toggle-process-tray', toggle); return () => { window.removeEventListener('proofroom:process', receive); window.removeEventListener('proofroom:toggle-process-tray', toggle); };
  }, []);
  const visibleEntries = entries;
  useEffect(() => {
    if (!entries.some((item) => item.status === 'running')) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer);
  }, [entries]);
  const running = visibleEntries.filter((item) => item.status === 'running').length;
  const hasError = visibleEntries.some((item) => item.status === 'error');
  useEffect(() => { document.documentElement.classList.toggle('ai-process-running', running > 0); document.documentElement.classList.toggle('ai-process-error', hasError); return () => { document.documentElement.classList.remove('ai-process-running'); document.documentElement.classList.remove('ai-process-error'); }; }, [hasError, running]);
  const trayCollapsed = collapsed;
  if (trayCollapsed) return <button className={`process-tray-collapsed ${running ? 'running' : 'finished'} ${visibleEntries.length ? '' : 'process-tray-idle'}`} onClick={() => setCollapsed(false)} aria-label={visibleEntries.length ? `Open activity tray · ${running || visibleEntries.length} ${running ? 'running' : 'recorded'} process${(running || visibleEntries.length) === 1 ? '' : 'es'}` : 'Open AI activity tray'}><ProcessMascot busy={running > 0} />{visibleEntries.length > 0 && <span>{running || visibleEntries.length}</span>}</button>;
  return <aside className="process-tray" aria-live="polite"><header><ProcessMascot busy={running > 0} /><div><b>AI activity</b><span>{running ? `${running} running` : 'All finished'}</span></div><button onClick={() => setCollapsed(true)} aria-label="Collapse activity tray">⌄</button></header><div>{visibleEntries.length ? visibleEntries.map((item) => <article key={item.id} className={`process-entry process-${item.status}`} data-detail={item.detail} tabIndex={0}><i>{item.status === 'complete' ? '✓' : item.status === 'error' ? '!' : ''}</i><div><b>{item.label}</b><span>{item.detail}</span></div><div className="process-entry-tail"><time>{item.status === 'running' ? elapsedLabel(item.startedAt, now) : item.status === 'complete' ? 'Done' : 'Stopped'}</time>{item.status === 'error' && item.retryPaperId && <button onClick={() => retryAudit(item.retryPaperId as string)} aria-label="Retry AI audit" title="Retry audit">↻</button>}</div></article>) : <p className="process-empty">No activity.</p>}</div></aside>;
}

function ImportDialog({ close, importArxiv, importLocalSource, profile, setProfile, bridge }: { close: () => void; importArxiv: (value: string, convertPdfToLatex?: boolean, correctnessAudit?: boolean, detailedAudit?: boolean) => Promise<void>; importLocalSource: (file: File, title: string, convertPdfToLatex?: boolean, correctnessAudit?: boolean, detailedAudit?: boolean) => Promise<void>; profile: Profile; setProfile: (value: Profile | ((old: Profile) => Profile)) => void; bridge: Bridge | null }) {
  const [value, setValue] = useState(''); const [file, setFile] = useState<File | null>(null); const [localTitle, setLocalTitle] = useState(''); const [convertPdf, setConvertPdf] = useState(true); const [correctnessAudit, setCorrectnessAudit] = useState(true); const [detailedAudit, setDetailedAudit] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent) { event.preventDefault(); if (!value.trim() && !file) return; setBusy(true); setError(''); try { if (file) await importLocalSource(file, localTitle, convertPdf, correctnessAudit, detailedAudit); else await importArxiv(value, convertPdf, correctnessAudit, detailedAudit); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The paper could not be imported.'); } finally { setBusy(false); } }
  return <div className="import-overlay" onMouseDown={(event) => { if (!busy && event.currentTarget === event.target) close(); }}><form onSubmit={submit} className="import-dialog"><header><div><h2>Import & audit a paper</h2></div><button type="button" onClick={close} disabled={busy}>×</button></header><p className="import-explainer">Upload the author’s TeX when possible; use one ZIP for multiple files. You can also enter an arXiv ID or URL.</p><label className="import-source"><span>arXiv ID or URL</span><input autoFocus value={value} disabled={Boolean(file)} onChange={(event) => setValue(event.target.value)} placeholder="https://arxiv.org/abs/2608.24719" /></label><div className="import-divider"><span>or upload source</span></div><label className="import-file"><input type="file" accept=".tex,.ltx,.zip,.pdf,application/pdf,application/zip,text/plain" onChange={(event) => { const selected = event.target.files?.[0] ?? null; setFile(selected); if (selected && !localTitle) setLocalTitle(selected.name.replace(/\.(pdf|tex|ltx|zip)$/i, '').replace(/[-_]+/g, ' ')); }} /><span><b>{file ? file.name : 'Choose TeX, ZIP, or PDF'}</b><small>ZIP for multiple files</small></span></label>{file && <label className="import-source import-local-title"><span>Paper title</span><input value={localTitle} onChange={(event) => setLocalTitle(event.target.value)} placeholder="Paper title" /></label>}<div className="import-options"><label className="import-depth"><span><b>Audit depth</b></span><select value={detailedAudit ? 'detailed' : 'standard'} onChange={(event) => setDetailedAudit(event.target.value === 'detailed')}><option value="detailed">Detailed</option><option value="standard">Standard</option></select></label><label className="import-convert"><input type="checkbox" checked={convertPdf} onChange={(event) => setConvertPdf(event.target.checked)} /><span><b>Convert PDF-only papers to LaTeX first</b></span></label><label className="import-convert"><input type="checkbox" checked={correctnessAudit} onChange={(event) => setCorrectnessAudit(event.target.checked)} /><span><b>Audit mathematical correctness</b></span></label></div><section className="import-ai"><div><b>AI for this audit</b></div><ModelControls profile={profile} setProfile={setProfile} bridge={bridge} /></section>{error && <p className="import-error">{error}</p>}<footer><button type="button" onClick={close} disabled={busy}>Cancel</button><button className="import-submit" disabled={busy || (!value.trim() && !file) || !bridge?.account}>{busy ? <><i /> Preparing source…</> : 'Import & analyze'}</button></footer></form></div>;
}
