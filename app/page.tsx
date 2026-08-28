'use client';

import katex from 'katex';
import { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useState } from 'react';

type View = 'reader' | 'library' | 'graph' | 'discover' | 'settings';
type ReaderMode = 'source' | 'interactive';
type EditionMode = 'original' | 'working';
type Paper = { id: string; title: string; authors: string; category: string; arxivId: string; abstract: string; state: 'To read' | 'Reading' | 'Read'; tags: string[]; folder?: string };
type Profile = { level: string; areas: string[]; goal: string; model: string; reasoning: string };
type Note = { id: string; paperId: string; nodeId: string; anchor: string; text: string; latex: string; createdAt: string };
type ReadingMark = '' | 'understood' | 'question' | 'error';
type Anchor = { label: string; page: number | null; confidence: 'verified' | 'approximate' | 'unverified' };
type CitationReference = { key: string; locator: string; statement: string; definitions?: { notation: string; definition: string; source: string }[]; title: string; authors: string; text: string; url: string; searchUrl: string; doi: string; arxivId: string; direct: boolean };
type NodeKind = 'definition' | 'assumption' | 'notation' | 'lemma' | 'proposition' | 'theorem' | 'corollary' | 'proof' | 'equation' | 'remark' | 'example' | 'section' | 'external-result';
type AuditNode = { id: string; kind: NodeKind; label: string; title: string; statement: string; proofText: string; citations: CitationReference[]; status: 'verified' | 'needs-verification' | 'unavailable'; anchor: Anchor; role: string; dependencies: string[]; proofSketch: string[]; whyItMatters: string; expandable: boolean };
type WorkingPatch = { id: string; kind: 'replace' | 'delete' | 'add'; nodeId: string; title: string; statement: string; proofText: string; nodeKind: NodeKind | ''; afterNodeId: string; rationale: string; dependencies: string[]; proofSketch: string[]; source: 'manual' | 'ai'; createdAt: string };
type EditorialSuggestion = { hasIssue: boolean; replacement: string; rationale: string; confidence: 'high' | 'medium' | 'low' };
type VersionChange = { label: string; changeType: 'added' | 'removed' | 'strengthened' | 'weakened' | 'corrected' | 'reorganized' | 'wording'; before: string; after: string; significance: 'mathematical' | 'proof-level' | 'expository' | 'uncertain'; dependencyImpact: string };
type VersionComparison = { summary: string; changedUnits: VersionChange[]; proofChanges: string[]; notationChanges: string[]; editorialChanges: string[]; dependencyImpact: string[]; readingRecommendation: string; warnings: string[] };
type CrossLink = { id: string; from: { paperId: string; nodeId: string }; to: { paperId: string; nodeId: string }; relation: 'uses' | 'extends' | 'background' | 'contrasts'; note: string; source: 'manual' | 'audit'; createdAt?: string };
type AuditCrossLink = { fromNodeId: string; targetPaperId: string; targetNodeId: string; relation: CrossLink['relation']; rationale: string };
type SourceBlockKind = 'section' | 'paragraph' | 'result' | 'proof' | 'figure';
type SourceBlock = { id: string; kind: SourceBlockKind; level: number; title: string; content: string; proofText: string; nodeId: string; resultKind: string; citations: CitationReference[]; assetPaths: string[]; caption: string };
type PaperAudit = { threadId: string; generatedAt: string; rawText: string; audit: { sourceStatus: 'full-text-read' | 'partial-text-read' | 'blocked'; sourceSummary: string; centralQuestion: string; mainContribution: string; verificationWarnings: string[] }; nodes: AuditNode[]; sourceBlocks: SourceBlock[]; readingPaths: { goal: string; nodeIds: string[]; reason: string }[]; crossPaperLinks: AuditCrossLink[]; openQuestions: string[]; editorialCorrections?: { nodeId: string; field: 'statement' | 'proofText'; original: string; replacement: string; rationale: string; confidence: 'high' | 'medium' | 'low' }[] };
type GraphNode = { id: string; paperId: string; paperTitle: string; arxivId: string; nodeId: string; label: string; title: string; kind: NodeKind; page: number | null; status: AuditNode['status'] };
type GraphEdge = { id: string; from: string; to: string; relation: CrossLink['relation']; source: 'manual' | 'audit'; note?: string };
type Graph = { version: number; updatedAt: string | null; nodes: GraphNode[]; edges: GraphEdge[] };
type Bridge = { running: boolean; account: { type: string; planType: string | null } | null; models: { id: string; label: string; efforts: string[]; defaultEffort: string | null; isDefault: boolean }[]; lastError: string | null };
type AnalysisProgress = { title: string; arxivId: string; phase: 'metadata' | 'analyzing' | 'saving'; startedAt: number };
type VaultSnapshot = { papers: Paper[]; audits: Record<string, PaperAudit>; notes: Note[]; nodeNotes: Record<string, Record<string, string>>; nodeAnswers: Record<string, Record<string, string>>; expanded: Record<string, Record<string, boolean>>; marks: Record<string, Record<string, Exclude<ReadingMark, ''>>>; patches: Record<string, WorkingPatch[]>; profile: Profile | null; links: CrossLink[]; graph: Graph; vault: { paperFolders: { paperId: string; folder: string }[] } };

const bridgeUrl = 'http://127.0.0.1:4318';
const preferenceKey = 'proofroom-reader-preferences-v1';
const defaultProfile: Profile = { level: 'Graduate student', areas: ['math.AP'], goal: 'Understand proofs', model: '', reasoning: 'xhigh' };
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
  return { ...defaultProfile, ...stored, areas: areas.length ? areas : defaultProfile.areas };
}
const emptyGraph: Graph = { version: 1, updatedAt: null, nodes: [], edges: [] };
const fallbackDiscoveries: Paper[] = [
  { id: 'd-1', title: 'Stability estimates for degenerate elliptic equations', authors: 'E. Moreno', category: 'math.AP', arxivId: '2608.05192', abstract: 'New stability estimates that extend compactness methods to a degenerate setting.', state: 'To read', tags: ['elliptic PDE', 'stability'] },
  { id: 'd-2', title: 'Geodesic convexity in spaces of probability measures', authors: 'N. Berg · K. Ito', category: 'math.OC', arxivId: '2608.05014', abstract: 'A concise treatment of geodesic convexity and its variational consequences.', state: 'To read', tags: ['optimal transport', 'convexity'] },
];

function renderMath(expression: string, displayMode: boolean) {
  try { return katex.renderToString(expression, { throwOnError: true, strict: 'ignore', displayMode }); }
  catch { return null; }
}

function cleanTeXProse(value: string) {
  return value
    .replace(/\\begin\{thebibliography\}\{[^{}]*\}|\\end\{thebibliography\}/g, '')
    .replace(/\\hyperref\[[^\]]*\]\{([^{}]*)\}/g, '$1')
    .replace(/\\paragraph\{([^{}]*)\}/g, '$1.')
    .replace(/\\bibitem(?:\[[^\]]*\])?\{[^{}]*\}\s*/g, '')
    .replace(/\\newblock\s*/g, ' ')
    .replace(/\{\\(?:em|it|bf)\s+([^{}]*)\}/g, '$1')
    .replace(/\\(?:emph|textit|textbf)\{([^{}]*)\}/g, '$1')
    .replace(/\{\\oe\}|\\oe\b/g, 'œ')
    .replace(/\{\\`e\}/g, 'è').replace(/\{\\'e\}/g, 'é').replace(/\{\\"o\}/g, 'ö')
    .replace(/\\label\{[^{}]*\}/g, '')
    .replace(/\\&/g, '&');
}

function Latex({ value, small = false }: { value: string; small?: boolean }) {
  const expression = value || '\\text{Add a LaTeX formula}';
  const html = useMemo(() => renderMath(expression, true), [expression]);
  if (!html) return <div className={`${small ? 'text-sm' : 'text-base'} latex-source-fallback`} title="This TeX needs correction before it can be typeset.">{value}</div>;
  return <div className={`${small ? 'text-sm' : 'text-base'} overflow-x-auto text-[#284235]`} dangerouslySetInnerHTML={{ __html: html }} />;
}

function MathText({ value, block = false, citations = [] }: { value: string; block?: boolean; citations?: CitationReference[] }) {
  const parts = useMemo(() => {
    const source = cleanTeXProse(value || '');
    // Audits produced from source TeX are asked to preserve $...$ delimiters. The
    // final alternatives also recover compact TeX-like islands when an older audit
    // omitted them, keeping expressions such as χ|det|^s and L_v(χ_v,s)^{-1}
    // together instead of rendering only their superscripts.
    const pattern = /(\[\[cite:[^\]]+\]\]|\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$]+?\$|\\\([\s\S]+?\\\)|\([^()$\n]{0,180}(?:\^|_|\\[A-Za-z]+|\{[^}]*\})[^()$\n]{0,180}\)|[A-Za-z0-9\u0370-\u03ff\\\[\](){}_^|+*/=<>≤≥∈×−,:-]*(?:\^|_|\\|[|≤≥∈×=])[A-Za-z0-9\u0370-\u03ff\\\[\](){}_^|+*/=<>≤≥∈×−,:-]*|(?:Re|Im|GL|SL|Sp|SO|SU|Spec|Hom|Ext|Tor|dim|ker|coker|rank|det|tr|vol|[A-Z])\([^()\s]{1,180}\)(?:(?:_|\^)(?:\{[^{}\n]{1,80}\}|[A-Za-z0-9\u0370-\u03ff+-]))*|[\u0370-\u03ff])/g;
    const result: { text: string; math: boolean; display: boolean; citation?: { key: string; locator: string } }[] = [];
    let cursor = 0;
    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > cursor) result.push({ text: source.slice(cursor, index), math: false, display: false });
      const token = match[0];
      if (token.startsWith('[[cite:')) { const [key, locator = ''] = token.slice(7, -2).split('|'); result.push({ text: token, math: false, display: false, citation: { key, locator } }); cursor = index + token.length; continue; }
      const display = token.startsWith('$$') || token.startsWith('\\[');
      const expression = token.startsWith('$$') ? token.slice(2, -2) : token.startsWith('$') ? token.slice(1, -1) : token.startsWith('\\(') || token.startsWith('\\[') ? token.slice(2, -2) : token;
      const rendered = renderMath(expression, display);
      result.push(rendered ? { text: rendered, math: true, display } : { text: token, math: false, display: false });
      cursor = index + token.length;
    }
    if (cursor < source.length) result.push({ text: source.slice(cursor), math: false, display: false });
    return result;
  }, [value]);
  const Tag = block ? 'div' : 'span';
  return <Tag className={`math-text ${block ? 'math-text-block' : ''}`}>{parts.map((part, index) => part.citation ? <InlineCitation key={index} mention={part.citation} citations={citations} /> : part.math ? <span key={index} className={part.display ? 'math-display' : 'math-inline'} dangerouslySetInnerHTML={{ __html: part.text }} /> : <span key={index}>{part.text}</span>)}</Tag>;
}

function InlineCitation({ mention, citations }: { mention: { key: string; locator: string }; citations: CitationReference[] }) {
  const citation = citations.find((item) => item.key === mention.key && item.locator === mention.locator) ?? citations.find((item) => item.key === mention.key);
  const locator = mention.locator || citation?.locator || '';
  const specificResult = /\b(theorem|lemma|proposition|corollary|definition|claim|result|thm\.?|lem\.?|prop\.?)\b/i.test(locator);
  const preview = specificResult && citation?.statement ? citation.statement : citationTitle(citation, mention.key);
  return <span className="inline-citation" tabIndex={0}>[{citationAlphaLabel(citation, mention.key)}{locator ? `, ${locator}` : ''}]<span className="citation-hover-card" role="tooltip"><b>{specificResult ? locator : 'Cited paper'}</b><span>{preview}</span>{specificResult && !citation?.statement && <em>Verified theorem statement is not cached yet; open the cited source below.</em>}</span></span>;
}

function citationTitle(citation: CitationReference | undefined, key: string) {
  return citation?.title && citation.title !== key ? citation.title : 'Bibliographic record not cached yet';
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
function readCitation(value: unknown): CitationReference {
  const entry = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const title = readString(entry.title, readString(entry.key, 'Cited source'));
  const searchUrl = readString(entry.searchUrl, `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`);
  return { key: readString(entry.key), locator: readString(entry.locator), statement: readString(entry.statement), definitions: asArray(entry.definitions).map((item) => { const definition = item as Record<string, unknown>; return { notation: readString(definition.notation), definition: readString(definition.definition), source: readString(definition.source) }; }).filter((item) => item.notation && item.definition), title, authors: readString(entry.authors), text: readString(entry.text, title), url: readString(entry.url, searchUrl), searchUrl, doi: readString(entry.doi), arxivId: readString(entry.arxivId), direct: Boolean(entry.direct) };
}
function parseAudit(rawText: string, threadId: string): PaperAudit {
  const clean = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = clean.indexOf('{'); const last = clean.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('Codex returned no structured audit. Try again.');
  const data = JSON.parse(clean.slice(first, last + 1)) as Record<string, unknown>;
  const auditData = data.audit as Record<string, unknown> | undefined;
  if (!auditData || !Array.isArray(data.nodes)) throw new Error('Codex returned an incomplete audit. Try again.');
  const kinds = new Set<NodeKind>(['definition', 'assumption', 'notation', 'lemma', 'proposition', 'theorem', 'corollary', 'proof', 'equation', 'remark', 'example', 'section', 'external-result']);
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
      return { id: readString(entry.id, `unit-${index + 1}`), kind: kinds.has(entry.kind as NodeKind) ? entry.kind as NodeKind : 'section', label: readString(entry.label, `Unit ${index + 1}`), title: readString(entry.title, readString(entry.label, `Unit ${index + 1}`)), statement: readString(entry.statement), proofText: readString(entry.proofText), citations: asArray(entry.citations).map(readCitation), status: statuses.has(entry.status as AuditNode['status']) ? entry.status as AuditNode['status'] : 'needs-verification', anchor: { label: readString(anchor?.label, 'Source location unavailable'), page: typeof anchor?.page === 'number' ? anchor.page : null, confidence: confidence.has(anchor?.confidence as Anchor['confidence']) ? anchor?.confidence as Anchor['confidence'] : 'unverified' }, role: readString(entry.role), dependencies: asArray(entry.dependencies).map(String), proofSketch: asArray(entry.proofSketch).map(String), whyItMatters: readString(entry.whyItMatters), expandable: Boolean(entry.expandable) };
    }),
    sourceBlocks: asArray(data.sourceBlocks).map((item, index): SourceBlock => { const block = item as Record<string, unknown>; const kind = readString(block.kind) as SourceBlockKind; return { id: readString(block.id, `source-block-${index + 1}`), kind: ['section', 'paragraph', 'result', 'proof', 'figure'].includes(kind) ? kind : 'paragraph', level: typeof block.level === 'number' ? block.level : 4, title: readString(block.title), content: readString(block.content), proofText: readString(block.proofText), nodeId: readString(block.nodeId), resultKind: readString(block.resultKind), citations: asArray(block.citations).map(readCitation), assetPaths: asArray(block.assetPaths).map(String), caption: readString(block.caption) }; }),
    readingPaths: asArray(data.readingPaths).map((item) => { const path = item as Record<string, unknown>; return { goal: readString(path.goal, 'Reading path'), nodeIds: asArray(path.nodeIds).map(String), reason: readString(path.reason) }; }),
    crossPaperLinks: asArray(data.crossPaperLinks).map((item) => { const link = item as Record<string, unknown>; const relation = ['uses', 'extends', 'background', 'contrasts'].includes(readString(link.relation)) ? readString(link.relation) as CrossLink['relation'] : 'uses'; return { fromNodeId: readString(link.fromNodeId), targetPaperId: readString(link.targetPaperId), targetNodeId: readString(link.targetNodeId), relation, rationale: readString(link.rationale) }; }).filter((link) => link.fromNodeId && link.targetPaperId && link.targetNodeId),
    openQuestions: asArray(data.openQuestions).map(String),
    editorialCorrections: asArray(data.editorialCorrections).map((item) => { const correction = item as Record<string, unknown>; const field = correction.field === 'proofText' ? 'proofText' as const : 'statement' as const; const confidenceValue = readString(correction.confidence); const correctionConfidence = confidenceValue === 'high' || confidenceValue === 'medium' ? confidenceValue : 'low'; return { nodeId: readString(correction.nodeId), field, original: readString(correction.original), replacement: readString(correction.replacement), rationale: readString(correction.rationale), confidence: correctionConfidence }; }).filter((correction) => correction.nodeId && correction.replacement),
  };
}

function kindClass(kind: NodeKind) { if (kind === 'theorem' || kind === 'corollary') return 'bg-[#295e49] text-white'; if (kind === 'lemma' || kind === 'proposition') return 'bg-[#dceee1] text-[#286448]'; if (kind === 'definition' || kind === 'notation' || kind === 'assumption') return 'bg-[#e5edf7] text-[#3c6390]'; return 'bg-[#f4eee7] text-[#816552]'; }
function displayUnitLabel(unit: Pick<AuditNode, 'kind' | 'label' | 'title'> | Pick<GraphNode, 'kind' | 'label' | 'title'>) {
  const printed = /^(Theorem|Lemma|Proposition|Corollary|Definition|Remark|Example|Equation|Section)s?\s+[\dIVX]+(?:\.[\dIVX]+)*/i;
  const explicit = unit.label.match(printed)?.[0];
  if (explicit) return explicit;
  const fromTitle = unit.title.match(printed)?.[0];
  if (fromTitle) return fromTitle;
  return unit.kind === 'external-result' ? 'External result' : unit.kind[0].toUpperCase() + unit.kind.slice(1);
}
function unitId(paperId: string, nodeId: string) { return `${paperId}::${nodeId}`; }
function makeId() { return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `patch-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
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

function buildPaperExport(paper: Paper, audit: PaperAudit, nodes: AuditNode[], readerNotes: Record<string, string>, notes: Note[], selection: ExportSelection, focusIds: string[]) {
  const visible = new Set(selection.focusedOnly && focusIds.length ? focusIds : nodes.map((node) => node.id)); const byId = new Map(nodes.map((node) => [node.id, node])); const lines = [`# ${paper.title}`, '', paper.authors, '', `arXiv:${paper.arxivId}`, '']; const references = new Map<string, CitationReference>();
  const addCitations = (citations: CitationReference[] = []) => { for (const citation of citations) references.set(`${citation.key}:${citation.locator}`, citation); };
  if (selection.abstract) lines.push('## Abstract', '', paper.abstract, '');
  for (const block of audit.sourceBlocks ?? []) {
    if (block.kind === 'section' && selection.prose) lines.push(`${'#'.repeat(Math.min(6, block.level + 2))} ${block.title}`, '');
    if (block.kind === 'paragraph' && selection.prose) { lines.push(block.content, ''); addCitations(block.citations); }
    if (block.kind === 'figure' && selection.figures) { for (const asset of block.assetPaths) lines.push(`![${block.caption || 'Original figure'}](../attachments/source/${asset})`, ''); if (block.caption) lines.push(`*${block.caption}*`, ''); addCitations(block.citations); }
    if ((block.kind === 'result' || block.kind === 'proof') && block.nodeId && !visible.has(block.nodeId)) continue;
    const node = block.nodeId ? byId.get(block.nodeId) : undefined;
    if (block.kind === 'result' && node && selection.statements) { lines.push(`### ${displayUnitLabel(node)}${node.title ? ` — ${node.title}` : ''}`, '', node.statement || block.content, ''); addCitations(node.citations); }
    if (block.kind === 'proof' && node && selection.proofs) { lines.push(`**Proof of ${displayUnitLabel(node)}.**`, '', node.proofText || block.proofText, ''); addCitations(node.citations); }
  }
  if (selection.audit) lines.push('## AI reading audit', '', `**Central question.** ${audit.audit.centralQuestion}`, '', `**Main contribution.** ${audit.audit.mainContribution}`, '', `**Source status.** ${audit.audit.sourceSummary}`, '');
  if (selection.notes) {
    const selectedNotes = Object.entries(readerNotes).filter(([id, value]) => visible.has(id) && value.trim()); const linkedNotes = notes.filter((note) => visible.has(note.nodeId));
    if (selectedNotes.length || linkedNotes.length) lines.push('## Reader notes', '');
    for (const [id, value] of selectedNotes) lines.push(`### ${displayUnitLabel(byId.get(id) ?? { kind: 'section' } as AuditNode)}`, '', value, '');
    for (const note of linkedNotes) lines.push(`### ${note.anchor}`, '', note.text, note.latex ? `$$${note.latex}$$` : '', '');
  }
  if (selection.citations && references.size) { lines.push('## References', ''); for (const citation of references.values()) lines.push(`- [${citationAlphaLabel(citation, citation.key)}] ${citation.authors ? `${citation.authors}. ` : ''}${citationTitle(citation, citation.key)}${citation.url ? ` — ${citation.url}` : ''}`); lines.push(''); }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function RailIcon({ name }: { name: 'reader' | 'library' | 'discover' | 'settings' }) {
  const paths = { reader: <><path d="M5 4.5h14v15H5z" /><path d="M8 8h8M8 12h8M8 16h5" /></>, library: <><path d="M3.5 5.5c3-1 5.8-.5 8.5 1.3v13c-2.7-1.8-5.5-2.3-8.5-1.3z" /><path d="M20.5 5.5c-3-1-5.8-.5-8.5 1.3v13c2.7-1.8 5.5-2.3 8.5-1.3z" /></>, discover: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z" /></>, settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" /></> }[name];
  return <svg className="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>;
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
  const [, setLinks] = useState<CrossLink[]>([]);
  const [graph, setGraph] = useState<Graph>(emptyGraph);
  const [profile, setProfile] = useState<Profile>(defaultProfile);
  const [discoveries, setDiscoveries] = useState<Paper[]>(fallbackDiscoveries);
  const [selectedPaperId, setSelectedPaperId] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [vaultSidebarOpen, setVaultSidebarOpen] = useState(true);
  const [importing, setImporting] = useState(false);
  const [analysingId, setAnalysingId] = useState<string | null>(null);
  const [askingId, setAskingId] = useState<string | null>(null);
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [vaultReady, setVaultReady] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [loadingDiscoveries, setLoadingDiscoveries] = useState(false);
  const [notice, setNotice] = useState('');
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress | null>(null);

  const paper = papers.find((item) => item.id === selectedPaperId) ?? papers[0];
  const audit = paper ? audits[paper.id] : undefined;

  function notify(message: string) { setNotice(message); window.setTimeout(() => setNotice(''), 8500); }
  function applySnapshot(snapshot: VaultSnapshot) {
    setPapers(snapshot.papers); setAudits(snapshot.audits); setNotes(snapshot.notes); setNodeNotes(snapshot.nodeNotes); setNodeAnswers(snapshot.nodeAnswers); setExpanded(snapshot.expanded); setMarks(snapshot.marks ?? {}); setPatches(snapshot.patches ?? {}); setLinks(snapshot.links); setGraph(snapshot.graph ?? emptyGraph);
    if (snapshot.profile) setProfile(normalizeReaderProfile(snapshot.profile));
    setSelectedPaperId((current) => snapshot.papers.some((item) => item.id === current) ? current : snapshot.papers[0]?.id ?? '');
  }
  async function refreshBridge() { try { const response = await fetch(`${bridgeUrl}/status`); const data = await response.json() as Bridge; setBridge(data); if (data.models?.length) setProfile((current) => data.models.some((item) => item.id === current.model) ? current : { ...current, model: data.models.find((item) => item.isDefault)?.id ?? '' }); } catch { setBridge(null); } }
  async function loadVault() { const locallySaved = localStorage.getItem(preferenceKey); try { const response = await fetch(`${bridgeUrl}/vault`); if (!response.ok) throw new Error(); const snapshot = await response.json() as VaultSnapshot; applySnapshot(snapshot); if (!snapshot.profile && locallySaved) { try { setProfile(normalizeReaderProfile(JSON.parse(locallySaved))); } catch { setOnboardingOpen(true); } } else if (!snapshot.profile && !locallySaved) setOnboardingOpen(true); } catch { if (locallySaved) { try { setProfile(normalizeReaderProfile(JSON.parse(locallySaved))); } catch { setOnboardingOpen(true); } } else setOnboardingOpen(true); } finally { setVaultReady(true); } }
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadVault(); void refreshBridge(); }, 0);
    return () => window.clearTimeout(timer);
    // The bridge functions intentionally run once when this local reader mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (!vaultReady || onboardingOpen) return; localStorage.setItem(preferenceKey, JSON.stringify(profile)); void fetch(`${bridgeUrl}/vault/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile }) }); }, [profile, vaultReady, onboardingOpen]);
  useEffect(() => {
    if (!vaultReady || !paper) return;
    const timer = window.setTimeout(() => { void fetch(`${bridgeUrl}/vault/reader`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId: paper.id, reader: { notes: notes.filter((item) => item.paperId === paper.id), nodeNotes: nodeNotes[paper.id] ?? {}, nodeAnswers: nodeAnswers[paper.id] ?? {}, expanded: expanded[paper.id] ?? {}, marks: marks[paper.id] ?? {} } }) }); }, 500);
    return () => window.clearTimeout(timer);
  }, [vaultReady, paper, notes, nodeNotes, nodeAnswers, expanded, marks]);

  async function savePaper(incoming: Paper) {
    const response = await fetch(`${bridgeUrl}/vault/paper`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper: incoming }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not create the paper folder.');
    const stored = data.paper as Paper;
    setPapers((current) => [stored, ...current.filter((item) => item.id !== stored.id && item.arxivId !== stored.arxivId)]);
    return stored;
  }
  async function updatePaperInfo(incoming: Paper) {
    const response = await fetch(`${bridgeUrl}/vault/paper/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper: incoming }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not update the paper record.');
    const stored = data.paper as Paper; setPapers((current) => current.map((item) => item.id === stored.id ? stored : item)); notify('Paper record updated.');
  }
  async function removePaperFromVault(paperId: string) {
    const response = await fetch(`${bridgeUrl}/vault/paper/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not remove the paper.');
    applySnapshot(data.snapshot as VaultSnapshot); notify('Paper removed from the library and archived locally for recovery.');
  }
  async function analyzePaper(target: Paper, convertPdfToLatex = false) {
    setAnalysingId(target.id);
    setAnalysisProgress((current) => ({ title: target.title, arxivId: target.arxivId, phase: 'analyzing', startedAt: current?.startedAt ?? Date.now() }));
    try {
      const response = await fetch(`${bridgeUrl}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper: target, profile, convertPdfToLatex }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Local Codex analysis failed.');
      const stored = data.paper as Paper; const next = parseAudit(readString(data.text), readString(data.threadId));
      setAnalysisProgress((current) => ({ title: stored.title, arxivId: stored.arxivId, phase: 'saving', startedAt: current?.startedAt ?? Date.now() }));
      const saved = await fetch(`${bridgeUrl}/vault/audit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper: stored, audit: next }) });
      const snapshot = await saved.json(); if (!saved.ok) throw new Error(snapshot.error || 'Could not save the local audit.');
      const manualReplacements = new Set((patches[stored.id] ?? []).filter((patch) => patch.kind === 'replace' && patch.source === 'manual').map((patch) => patch.nodeId)); const automatic = new Map<string, WorkingPatch>();
      for (const correction of next.editorialCorrections ?? []) { const sourceNode = next.nodes.find((item) => item.id === correction.nodeId); if (!sourceNode || correction.confidence !== 'high' || !correction.replacement.trim() || manualReplacements.has(sourceNode.id)) continue; const current = automatic.get(sourceNode.id) ?? { id: makeId(), kind: 'replace' as const, nodeId: sourceNode.id, title: sourceNode.title, statement: sourceNode.statement, proofText: sourceNode.proofText, nodeKind: sourceNode.kind, afterNodeId: '', rationale: '', dependencies: sourceNode.dependencies, proofSketch: sourceNode.proofSketch, source: 'ai' as const, createdAt: new Date().toISOString() }; current[correction.field] = correction.replacement.trim(); current.rationale = [current.rationale, correction.rationale].filter(Boolean).join(' '); automatic.set(sourceNode.id, current); }
      const prior = (patches[stored.id] ?? []).filter((patch) => !(patch.kind === 'replace' && patch.source === 'ai')); const correctedPatches = [...prior, ...automatic.values()];
      if (automatic.size) { const correctionResponse = await fetch(`${bridgeUrl}/vault/patches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId: stored.id, patches: correctedPatches }) }); const correctionData = await correctionResponse.json(); if (!correctionResponse.ok) throw new Error(correctionData.error || 'Could not save audited typo corrections.'); setPatches((current) => ({ ...current, [stored.id]: correctionData.patches as WorkingPatch[] })); }
      const sourceLabel = data.primarySource?.kind === 'tex' ? 'TeX-first source' : data.primarySource?.kind === 'ai-tex' ? 'AI-converted LaTeX source' : 'PDF fallback';
      setPapers((current) => [snapshot.paper as Paper, ...current.filter((item) => item.id !== stored.id && item.arxivId !== stored.arxivId)]); setAudits((current) => ({ ...current, [stored.id]: next })); setGraph(snapshot.graph ?? emptyGraph); setLinks(snapshot.links ?? []); setSelectedPaperId(stored.id); setSelectedNodeId(next.nodes[0]?.id ?? ''); setView('reader'); notify(`${next.nodes.length} audited document units are ready · ${sourceLabel}${automatic.size ? ` · ${automatic.size} verified typo correction${automatic.size === 1 ? '' : 's'} highlighted` : ''}.`); void refreshBridge();
    } catch (error) { const message = error instanceof Error ? error.message : 'Analysis failed.'; notify(message.includes('wait limit') ? `${message} The paper and TeX source are preserved; retry from the library with a faster model or lower effort.` : `${message} Check the local Codex connection and try again.`); void refreshBridge(); }
    finally { setAnalysingId(null); setAnalysisProgress(null); }
  }
  async function importArxiv(raw: string, convertPdfToLatex = false) {
    setAnalysisProgress({ title: 'Looking up arXiv metadata', arxivId: raw, phase: 'metadata', startedAt: Date.now() });
    try {
      const response = await fetch(`/api/arxiv?id=${encodeURIComponent(raw)}`); const data = await response.json();
      if (!response.ok || !data.papers?.[0]) throw new Error('Paper not found on arXiv.');
      const incoming = { ...data.papers[0], state: 'Reading' } as Paper; const existing = papers.find((item) => item.arxivId === incoming.arxivId); setImporting(false); setSelectedPaperId((existing ?? incoming).id); setView('reader'); await analyzePaper(existing ?? incoming, convertPdfToLatex);
    } catch (error) { setAnalysisProgress(null); throw error; }
  }
  async function saveDiscovery(candidate: Paper) { try { const stored = await savePaper({ ...candidate, state: 'To read' }); setSelectedPaperId(stored.id); notify('Paper saved with its own local folder.'); } catch (error) { notify(error instanceof Error ? error.message : 'Could not save the paper.'); } }
  async function askNode(targetNode: AuditNode, question: string) { if (!audit?.threadId || !paper || !question.trim()) return; setAskingId(targetNode.id); try { const response = await fetch(`${bridgeUrl}/node-question`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper, profile, node: targetNode, question, threadId: audit.threadId }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Codex did not answer this unit.'); setNodeAnswers((current) => ({ ...current, [paper.id]: { ...current[paper.id], [targetNode.id]: readString(data.text) } })); } catch (error) { notify(error instanceof Error ? error.message : 'The local Codex question failed.'); } finally { setAskingId(null); } }
  function saveNote(anchor: string, nodeId: string, text: string, latex: string) { if (!paper || !text.trim()) return; setNotes((current) => [{ id: `n-${Date.now()}`, paperId: paper.id, nodeId, anchor, text, latex, createdAt: 'just now' }, ...current]); notify('Linked note saved in this paper folder.'); }
  async function addLink(link: Omit<CrossLink, 'id' | 'source' | 'createdAt'>) { try { const response = await fetch(`${bridgeUrl}/vault/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ link }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not create the relation.'); setLinks((current) => current.some((item) => item.id === data.link.id) ? current : [...current, data.link]); setGraph(data.graph ?? emptyGraph); notify('Cross-paper relation added to the local graph.'); } catch (error) { notify(error instanceof Error ? error.message : 'Could not create the relation.'); } }
  async function removeLink(linkId: string) { const response = await fetch(`${bridgeUrl}/vault/link/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ linkId }) }); const data = await response.json(); if (response.ok) { setLinks((current) => current.filter((item) => item.id !== linkId)); setGraph(data.graph ?? emptyGraph); } }
  async function saveWorkingPatches(paperId: string, nextPatches: WorkingPatch[]) {
    const response = await fetch(`${bridgeUrl}/vault/patches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId, patches: nextPatches }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not save the working edition.');
    setPatches((current) => ({ ...current, [paperId]: data.patches as WorkingPatch[] })); setGraph(data.graph ?? emptyGraph); notify('Working edition saved locally.');
  }
  async function suggestEditorialFix(targetNode: AuditNode) {
    if (!audit?.threadId || !paper) throw new Error('Run the full-paper audit first.');
    const response = await fetch(`${bridgeUrl}/node-edit/suggest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper, profile, node: targetNode, threadId: audit.threadId }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Codex could not inspect this unit.');
    const parsed = parseJsonObject(readString(data.text));
    return { hasIssue: Boolean(parsed.hasIssue), replacement: readString(parsed.replacement), rationale: readString(parsed.rationale), confidence: ['high', 'medium', 'low'].includes(readString(parsed.confidence)) ? readString(parsed.confidence) as EditorialSuggestion['confidence'] : 'low' };
  }
  async function refreshDiscoveries(area?: string, allToday = false) { setLoadingDiscoveries(true); try { const categories = area ? [area] : profile.areas; const response = await fetch(`/api/arxiv?categories=${encodeURIComponent(categories.join(','))}${allToday ? '&allToday=1' : ''}`); const data = await response.json(); if (!response.ok) throw new Error(); setDiscoveries(Array.isArray(data.papers) ? data.papers : []); if (allToday) notify(`${data.papers?.length ?? 0} paper${data.papers?.length === 1 ? '' : 's'} found in ${area} today.`); } catch { notify('arXiv is unavailable right now; the current discovery list was kept.'); } finally { setLoadingDiscoveries(false); } }
  function openUnit(paperId: string, nodeId: string) { setSelectedPaperId(paperId); setSelectedNodeId(nodeId); setView('reader'); }

  return <main className={`min-h-screen bg-[#f8f8f5] text-[#20251f] lg:grid lg:grid-cols-[54px_235px_minmax(0,1fr)] ${view === 'reader' ? 'app-reader-mode' : ''} ${view === 'discover' ? '' : 'app-no-vault'} ${vaultSidebarOpen ? '' : 'app-vault-collapsed'}`}>
    <nav className="hidden min-h-screen flex-col items-center gap-2 border-r border-[#e0e4dd] bg-[#273b31] py-4 text-[#dfece4] lg:flex"><div className="mb-4 grid h-8 w-8 place-items-center rounded-lg bg-[#5b806d] text-[10px] font-black">PR</div>{([['reader', 'Read'], ['library', 'Library'], ['discover', 'Discover'], ['settings', 'Settings']] as const).map(([target, label]) => <button key={target} onClick={() => setView(target)} title={label} aria-label={label} className={`grid h-9 w-9 place-items-center rounded-lg ${view === target ? 'bg-[#476956] text-white' : 'hover:bg-[#3b5b49]'}`}><RailIcon name={target} /></button>)}<div className="flex-1" /><span title={bridge?.account ? 'Local Codex ready' : 'Local Codex unavailable'} className={`mb-2 h-2 w-2 rounded-full ${bridge?.account ? 'bg-[#75ca94]' : 'bg-[#d9b159]'}`} /></nav>
    {view === 'discover' && <aside className={`local-vault-sidebar hidden min-h-screen flex-col border-r border-[#e2e6e0] bg-[#f0f2ed] p-4 lg:flex ${vaultSidebarOpen ? '' : 'collapsed'}`}><div className="flex items-start justify-between"><div><h1 className="text-lg font-bold tracking-[-.04em]">Papers</h1></div><div className="vault-head-actions"><button onClick={() => setVaultSidebarOpen(false)} title="Collapse papers">‹</button><button onClick={() => setImporting(true)} title="Import paper">+</button></div></div><button onClick={() => setImporting(true)} className="my-4 rounded-md bg-[#deebe1] px-3 py-2 text-left text-[11px] font-bold text-[#2d604b]">+ Import & audit arXiv paper</button><div className="mb-2 flex justify-between text-[10px] font-bold text-[#677068]"><span>YOUR LIBRARY</span><span>{papers.length}</span></div><div className="min-h-0 flex-1 space-y-1 overflow-y-auto">{papers.length ? papers.map((item) => <button key={item.id} onClick={() => { setSelectedPaperId(item.id); setView('reader'); }} className="w-full rounded-lg p-2 text-left hover:bg-[#e7ebe6]"><span className="flex items-start gap-2"><i className={`mt-1 h-1.5 w-1.5 flex-none rounded-full ${audits[item.id] ? 'bg-[#499b70]' : 'bg-[#d6b756]'}`} /><span><b className="block text-[11px] leading-[1.35]">{item.title}</b><small className="mt-1 block text-[9px] text-[#788178]">{item.arxivId}</small></span></span></button>) : <p className="rounded-lg border border-dashed border-[#d5ddd5] p-3 text-[11px] leading-5 text-[#788178]">Import an arXiv paper to begin.</p>}</div></aside>}{!vaultSidebarOpen && view === 'discover' && <button className="vault-reopen hidden lg:grid" onClick={() => setVaultSidebarOpen(true)} title="Expand papers">›</button>}
    <section className="min-w-0"><header className="app-header"><div className="app-header-title">{view === 'reader' && paper ? <><span />{paper.title}</> : view === 'graph' ? 'Local dependency graph' : view[0].toUpperCase() + view.slice(1)}</div><div className="app-header-actions"><ModelControls profile={profile} setProfile={setProfile} bridge={bridge} compact /><button onClick={() => setImporting(true)} className="header-import">+ Import</button></div></header>{notice && <div className="notice-banner">{notice}</div>}
      {view === 'reader' && <Reader paper={paper} audit={audit} openImport={() => setImporting(true)} selectedNodeId={selectedNodeId} setSelectedNodeId={setSelectedNodeId} expanded={paper ? expanded[paper.id] ?? {} : {}} setExpanded={(id, value) => paper && setExpanded((current) => ({ ...current, [paper.id]: { ...current[paper.id], [id]: value } }))} marks={paper ? marks[paper.id] ?? {} : {}} setMark={(id, value) => paper && setMarks((current) => { const paperMarks = { ...(current[paper.id] ?? {}) }; if (value) paperMarks[id] = value; else delete paperMarks[id]; return { ...current, [paper.id]: paperMarks }; })} readerNotes={paper ? nodeNotes[paper.id] ?? {} : {}} setReaderNote={(id, value) => paper && setNodeNotes((current) => ({ ...current, [paper.id]: { ...current[paper.id], [id]: value } }))} notes={paper ? notes.filter((item) => item.paperId === paper.id) : []} answers={paper ? nodeAnswers[paper.id] ?? {} : {}} patches={paper ? patches[paper.id] ?? [] : []} savePatches={(next) => paper ? saveWorkingPatches(paper.id, next) : Promise.resolve()} suggestEdit={suggestEditorialFix} graph={graph} analysing={analysingId === paper?.id} askingId={askingId} analyze={() => paper && void analyzePaper(paper)} askNode={askNode} saveNote={saveNote} addLink={addLink} removeLink={removeLink} openUnit={openUnit} profile={profile} />}
      {view === 'library' && <Library papers={papers} audits={audits} patches={patches} busyId={analysingId} analyze={analyzePaper} updatePaper={updatePaperInfo} removePaper={removePaperFromVault} openUnit={openUnit} openImport={() => setImporting(true)} />}
      {view === 'graph' && <GraphView graph={graph} papers={papers} openUnit={openUnit} />}
      {view === 'discover' && <Discover papers={discoveries} saved={papers} save={saveDiscovery} refresh={refreshDiscoveries} loading={loadingDiscoveries} selectedAreas={profile.areas} />}
      {view === 'settings' && <Settings profile={profile} setProfile={setProfile} bridge={bridge} />}
    </section>{onboardingOpen && <OnboardingDialog profile={profile} setProfile={setProfile} bridge={bridge} finish={() => setOnboardingOpen(false)} />}{importing && <ImportDialog close={() => setImporting(false)} importArxiv={importArxiv} profile={profile} setProfile={setProfile} bridge={bridge} />}{analysisProgress && <AnalysisProgressCard progress={analysisProgress} profile={profile} bridge={bridge} />}
  </main>;
}

type ReaderProps = { paper?: Paper; audit?: PaperAudit; openImport: () => void; selectedNodeId: string; setSelectedNodeId: (id: string) => void; expanded: Record<string, boolean>; setExpanded: (id: string, value: boolean) => void; marks: Record<string, Exclude<ReadingMark, ''>>; setMark: (id: string, value: ReadingMark) => void; readerNotes: Record<string, string>; setReaderNote: (id: string, value: string) => void; notes: Note[]; answers: Record<string, string>; patches: WorkingPatch[]; savePatches: (patches: WorkingPatch[]) => Promise<void>; suggestEdit: (node: AuditNode) => Promise<EditorialSuggestion>; graph: Graph; analysing: boolean; askingId: string | null; analyze: () => void; askNode: (node: AuditNode, question: string) => Promise<void>; saveNote: (anchor: string, nodeId: string, text: string, latex: string) => void; addLink: (link: Omit<CrossLink, 'id' | 'source' | 'createdAt'>) => Promise<void>; removeLink: (linkId: string) => Promise<void>; openUnit: (paperId: string, nodeId: string) => void; profile: Profile };

function Reader({ paper, audit, openImport, selectedNodeId, setSelectedNodeId, expanded, setExpanded, marks, setMark, readerNotes, setReaderNote, notes, answers, patches, savePatches, suggestEdit, graph, analysing, askingId, analyze, askNode, saveNote, addLink, removeLink, openUnit, profile }: ReaderProps) {
  const [mode, setMode] = useState<ReaderMode>('interactive'); const [edition, setEdition] = useState<EditionMode>('working'); const [focusPath, setFocusPath] = useState(false); const [focusSelection, setFocusSelection] = useState('path:0'); const [question, setQuestion] = useState(''); const [comparisonOpen, setComparisonOpen] = useState(false); const [outlineOpen, setOutlineOpen] = useState(false); const [inspectorOpen, setInspectorOpen] = useState(false); const [paperChatOpen, setPaperChatOpen] = useState(false); const [paperQuestion, setPaperQuestion] = useState(''); const [paperAsking, setPaperAsking] = useState(false); const [paperMessages, setPaperMessages] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]); const [paperScale, setPaperScale] = useState(1); const [toolsOpen, setToolsOpen] = useState(false); const [exportOpen, setExportOpen] = useState(false); const [isFullscreen, setIsFullscreen] = useState(false);
  const originalNodes = useMemo(() => audit?.nodes ?? [], [audit]);
  const editionNodes = useMemo(() => edition === 'working' ? applyWorkingPatches(originalNodes, patches) : originalNodes, [edition, originalNodes, patches]);
  const node = editionNodes.find((item) => item.id === selectedNodeId) ?? editionNodes[0];
  useEffect(() => {
    const timer = window.setTimeout(() => setQuestion(''), 0);
    return () => window.clearTimeout(timer);
  }, [selectedNodeId]);
  useEffect(() => {
    if (!audit || editionNodes.some((item) => item.id === selectedNodeId)) return;
    const timer = window.setTimeout(() => setSelectedNodeId(editionNodes[0]?.id ?? ''), 0);
    return () => window.clearTimeout(timer);
  }, [audit, editionNodes, selectedNodeId, setSelectedNodeId]);
  useEffect(() => { const update = () => setIsFullscreen(Boolean(document.fullscreenElement)); document.addEventListener('fullscreenchange', update); return () => document.removeEventListener('fullscreenchange', update); }, []);
  async function toggleFullscreen() { if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector<HTMLElement>('.reader-page')?.requestFullscreen(); setToolsOpen(false); }
  async function askPaperContext() {
    const prompt = paperQuestion.trim();
    if (!paper || !audit?.threadId || !prompt || paperAsking) return;
    setPaperMessages((current) => [...current, { role: 'user', text: prompt }]); setPaperQuestion(''); setPaperAsking(true);
    try {
      const response = await fetch(`${bridgeUrl}/paper-question`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper, profile, node, question: prompt, threadId: audit.threadId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Local Codex could not answer this paper question.');
      setPaperMessages((current) => [...current, { role: 'assistant', text: readString(data.text) }]);
    } catch (error) { setPaperMessages((current) => [...current, { role: 'assistant', text: error instanceof Error ? error.message : 'The local Codex question failed.' }]); }
    finally { setPaperAsking(false); }
  }
  async function attachCitationSource(citation: CitationReference, file: File) {
    if (!paper) throw new Error('No paper is open.');
    const dataBase64 = await fileAsBase64(file);
    const response = await fetch(`${bridgeUrl}/vault/citation-asset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId: paper.id, upload: { citation, fileName: file.name, mime: file.type, dataBase64 } }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'The cited source could not be attached.');
    return readString(data.saved?.relativePath);
  }
  async function expandProofStep(target: AuditNode, step: string, index: number) {
    if (!paper || !audit?.threadId) throw new Error('Run the full-paper audit first.');
    const prompt = `Expand Step ${index + 1} of the AI proof map in complete mathematical detail: “${step}”. Use the complete original proof and the durable full-paper audit as the authority. State every prerequisite used, fill in intermediate equations, explain each implication, and identify exactly where this step occurs in the author proof. Clearly separate text present in the source from explanatory details you supply. Do not invent a missing argument.`;
    const response = await fetch(`${bridgeUrl}/node-question`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper, profile, node: target, question: prompt, threadId: audit.threadId }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'This proof step could not be expanded.');
    return readString(data.text);
  }
  async function expandProofRequest(target: AuditNode, request: string) {
    if (!paper || !audit?.threadId) throw new Error('Run the full-paper audit first.');
    const prompt = `The reader is working inside the complete proof of ${displayUnitLabel(target)} and asks: “${request}”. Use the author proof and its paragraph anchors L1, L2, … in displayed order. Give a detailed, source-faithful expansion at exactly the requested scope; include intermediate equations and prerequisites, distinguish author text from explanation, and do not invent missing mathematics.`;
    const response = await fetch(`${bridgeUrl}/node-question`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper, profile, node: target, question: prompt, threadId: audit.threadId }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'The proof could not be expanded.');
    return readString(data.text);
  }
  if (!paper) return <EmptyVault onImport={openImport} />;
  if (!audit) return <section className="mx-auto max-w-3xl px-6 py-14"><div className="rounded-xl border border-[#d8e4d9] bg-[#f3f8f3] p-7"><p className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#52705e]">PAPER FOLDER READY</p><h2 className="mt-2 text-2xl font-bold tracking-[-.04em]">Audit the source before reading interactively.</h2><p className="mt-3 max-w-xl text-sm leading-6 text-[#627064]">Proofroom has created a stable local folder for this paper. Analyze it once to add source anchors, an outline, proof dependencies, and reusable links to your local graph.</p><div className="mt-6 flex gap-2"><button onClick={analyze} disabled={analysing} className="rounded-md bg-[#2d654f] px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50">{analysing ? 'Auditing full paper…' : 'Analyze with local Codex'}</button><a href={`https://arxiv.org/pdf/${paper.arxivId}`} target="_blank" rel="noreferrer" className="rounded-md border border-[#cddbd0] bg-white px-4 py-2.5 text-xs font-bold text-[#39634c]">Original PDF ↗</a></div></div></section>;
  const selectedPathIndex = Number(focusSelection.replace('path:', '')); const selectedTargetId = focusSelection.startsWith('result:') ? focusSelection.slice(7) : '';
  const selectedTarget = editionNodes.find((item) => item.id === selectedTargetId);
  const activePath = selectedTarget ? { goal: `Focus on ${displayUnitLabel(selectedTarget)}`, nodeIds: dependencyFocus(editionNodes, selectedTarget.id), reason: `Showing this result and its ${Math.max(0, dependencyFocus(editionNodes, selectedTarget.id).length - 1)} logical prerequisite${dependencyFocus(editionNodes, selectedTarget.id).length === 2 ? '' : 's'}; unrelated branches are hidden.` } : audit.readingPaths[selectedPathIndex] ?? audit.readingPaths[0];
  const units = focusPath && activePath ? editionNodes.filter((item) => activePath.nodeIds.includes(item.id)) : editionNodes;
  const page = node?.anchor.page; const pdfUrl = `https://arxiv.org/pdf/${paper.arxivId}${page ? `#page=${page}` : ''}`;
  return <section className="reader-page"><div className="fullscreen-edge-top" aria-hidden="true" /><div className="reader-titlebar"><h2>{paper.title}</h2><button onClick={analyze} disabled={analysing} className="reader-reaudit">{analysing ? 'Auditing…' : 'Re-audit'}</button></div>{activePath && focusPath && <div className="reader-path"><b>{activePath.goal}</b><span>{activePath.reason}</span><button onClick={() => setFocusPath(false)}>Show full paper</button></div>}
    <div className={`reader-grid ${outlineOpen ? 'reader-grid-outline' : ''} ${inspectorOpen ? 'reader-grid-inspector' : ''}`}>{outlineOpen && <aside className="reader-outline reader-drawer"><div className="drawer-head"><div><span className="reader-kicker">Logical outline</span><b>{units.length} units</b></div><button onClick={() => setOutlineOpen(false)} aria-label="Close outline">×</button></div><div className="space-y-0.5">{units.map((item) => { const changed = patchForNode(patches, item.id); return <button key={item.id} onClick={() => setSelectedNodeId(item.id)} className={`outline-unit ${selectedNodeId === item.id ? 'outline-unit-active' : ''}`}><span className={`outline-kind ${kindClass(item.kind)}`}>{item.kind[0].toUpperCase()}</span><span className="min-w-0"><small>{displayUnitLabel(item)}</small><b><MathText value={item.title} /></b></span>{changed && <i className="working-dot" title={changed.kind === 'add' ? 'Added in working edition' : 'Edited in working edition'}>W</i>}{item.status !== 'verified' && !changed && <i className="ml-auto h-1.5 w-1.5 flex-none rounded-full bg-[#b8873c]" />}</button>; })}</div></aside>}
      <main className="reader-document" style={{ zoom: paperScale, width: `${100 / paperScale}%` } as CSSProperties}>{mode === 'source' ? <iframe title={`Original paper: ${paper.title}`} src={pdfUrl} className="reader-pdf" /> : <InteractiveDocument paper={paper} audit={audit} nodes={units} selectedNodeId={node?.id ?? ''} setSelectedNodeId={setSelectedNodeId} expanded={expanded} setExpanded={setExpanded} marks={marks} setMark={setMark} patches={patches} savePatches={savePatches} openAssistant={(prompt = '') => { if (prompt) setQuestion(prompt); setInspectorOpen(true); setOutlineOpen(false); }} expandCitation={(target, citation) => { const prompt = `Retrieve and expand the cited ${citation.locator || 'result'} from “${citation.title}” (${citation.url}). Show its complete original statement and proof when accessible, then explain how this paper uses it. Clearly identify anything that could not be verified.`; setSelectedNodeId(target.id); setQuestion(prompt); setInspectorOpen(true); setOutlineOpen(false); void askNode(target, prompt); }} attachCitation={attachCitationSource} expandProofStep={expandProofStep} expandProofRequest={expandProofRequest} />}</main>
      {inspectorOpen && <aside className="reader-inspector reader-drawer"><div className="drawer-head"><b>Assistant</b><button onClick={() => setInspectorOpen(false)} aria-label="Close assistant">×</button></div>{node ? <NodeInspector key={`${edition}:${node.id}`} paper={paper} node={node} originalNode={audit.nodes.find((item) => item.id === node.id)} edition={edition} patches={patches} savePatches={savePatches} suggestEdit={suggestEdit} expanded={expanded[node.id] !== false} setExpanded={(value) => setExpanded(node.id, value)} readerNote={readerNotes[node.id] ?? ''} setReaderNote={(value) => setReaderNote(node.id, value)} answer={answers[node.id]} question={question} setQuestion={setQuestion} asking={askingId === node.id} ask={() => void askNode(node, question)} saveNote={saveNote} graph={graph} addLink={addLink} removeLink={removeLink} openUnit={openUnit} /> : <p className="p-4 text-xs text-[#6e6a64]">Select a document unit.</p>}</aside>}</div>
    <div className="fullscreen-edge-right" aria-hidden="true" /><nav className="reader-tool-dock" aria-label="Paper tools"><button className={paperChatOpen ? 'active' : ''} onClick={() => setPaperChatOpen(true)} aria-label="Ask AI about the whole paper"><b>?</b><span>Ask paper</span></button><button className={outlineOpen ? 'active' : ''} onClick={() => { setOutlineOpen(!outlineOpen); if (!outlineOpen) setInspectorOpen(false); }} aria-label="Toggle logical outline"><b>☰</b><span>Outline</span></button><button className={inspectorOpen ? 'active' : ''} onClick={() => { setInspectorOpen(!inspectorOpen); if (!inspectorOpen) setOutlineOpen(false); }} disabled={!node} aria-label="Toggle AI, notes, and editing"><b>AI</b><span>Selected result</span></button><button className={mode === 'source' ? 'active' : ''} onClick={() => { const showingOriginal = mode === 'source'; setMode(showingOriginal ? 'interactive' : 'source'); setEdition(showingOriginal ? 'working' : 'original'); }} aria-label={mode === 'source' ? 'Return to enhanced paper' : 'Open original paper'}><b>{mode === 'source' ? '✦' : 'PDF'}</b><span>{mode === 'source' ? 'Enhanced paper' : 'Original paper'}</span></button><button className={toolsOpen ? 'active' : ''} onClick={() => setToolsOpen(!toolsOpen)} aria-label="More reading controls"><b>•••</b><span>Reading controls</span></button></nav>
    {toolsOpen && <aside className="reader-tool-menu"><header><b>Reading controls</b><button onClick={() => setToolsOpen(false)} aria-label="Close reading controls">×</button></header><section><label>Paper size</label><div className="paper-size-row"><button onClick={() => setPaperScale((value) => Math.max(.8, Number((value - .1).toFixed(1))))} disabled={paperScale <= .8}>−</button><output>{Math.round(paperScale * 100)}%</output><button onClick={() => setPaperScale((value) => Math.min(1.4, Number((value + .1).toFixed(1))))} disabled={paperScale >= 1.4}>+</button><button onClick={() => setPaperScale(1)}>Reset</button></div></section><section><label htmlFor="focus-selection">Focus on</label><select id="focus-selection" value={focusSelection} onChange={(event) => setFocusSelection(event.target.value)}>{audit.readingPaths.length > 0 && <optgroup label="Audited reading goals">{audit.readingPaths.map((path, index) => <option key={`${path.goal}:${index}`} value={`path:${index}`}>{path.goal}</option>)}</optgroup>}<optgroup label="A specific result">{editionNodes.filter((item) => ['theorem', 'lemma', 'proposition', 'corollary', 'definition'].includes(item.kind)).map((item) => <option key={item.id} value={`result:${item.id}`}>{displayUnitLabel(item)}{item.title ? ` — ${item.title}` : ''}</option>)}</optgroup></select><div className="focus-actions"><button onClick={() => { setFocusPath(true); setMode('interactive'); setToolsOpen(false); }}>Apply focus</button>{focusPath && <button onClick={() => setFocusPath(false)}>Show all</button>}</div></section><footer><button onClick={() => { setExportOpen(true); setToolsOpen(false); }}>Save selected parts</button><button onClick={() => { setComparisonOpen(true); setToolsOpen(false); }}>Compare versions</button><button onClick={() => void toggleFullscreen()}>{isFullscreen ? 'Exit fullscreen' : 'Fullscreen reading'}</button></footer></aside>}
    {paperChatOpen && <PaperChatDialog paper={paper} currentNode={node} messages={paperMessages} question={paperQuestion} setQuestion={setPaperQuestion} asking={paperAsking} ask={() => void askPaperContext()} close={() => setPaperChatOpen(false)} />}{exportOpen && <ExportPaperPanel paper={paper} audit={audit} nodes={editionNodes} focusIds={activePath?.nodeIds ?? []} readerNotes={readerNotes} notes={notes} focusActive={focusPath} close={() => setExportOpen(false)} />}{comparisonOpen && <VersionComparisonPanel paper={paper} profile={profile} audit={audit} openUnit={openUnit} close={() => setComparisonOpen(false)} />}</section>;
}

function PaperChatDialog({ paper, currentNode, messages, question, setQuestion, asking, ask, close }: { paper: Paper; currentNode?: AuditNode; messages: { role: 'user' | 'assistant'; text: string }[]; question: string; setQuestion: (value: string) => void; asking: boolean; ask: () => void; close: () => void }) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null); const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  function beginDrag(event: ReactPointerEvent<HTMLElement>) { if ((event.target as HTMLElement).closest('button')) return; const rect = event.currentTarget.parentElement?.getBoundingClientRect(); if (!rect) return; event.currentTarget.setPointerCapture(event.pointerId); setDrag({ dx: event.clientX - rect.left, dy: event.clientY - rect.top }); setPosition({ x: rect.left, y: rect.top }); }
  function moveDrag(event: ReactPointerEvent<HTMLElement>) { if (!drag) return; const rect = event.currentTarget.parentElement?.getBoundingClientRect(); const width = rect?.width || 620; const height = rect?.height || 640; setPosition({ x: Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - drag.dx)), y: Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - drag.dy)) }); }
  function endDrag(event: ReactPointerEvent<HTMLElement>) { if (drag) event.currentTarget.releasePointerCapture(event.pointerId); setDrag(null); }
  return <div className="paper-chat-shell"><section className="paper-chat-dialog" style={position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : undefined}><header onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}><div><span>Full-paper conversation</span><b>Ask about any definition, proof, idea, or citation</b></div><button onClick={close} aria-label="Close paper conversation">×</button></header><div className="paper-chat-context"><b>In context</b><span>The complete author source + durable AI audit</span>{currentNode && <em>Current location: {displayUnitLabel(currentNode)}</em>}</div><div className="paper-chat-messages">{messages.length ? messages.map((message, index) => <article key={index} className={`paper-chat-${message.role}`}><b>{message.role === 'user' ? 'You' : 'Local Codex'}</b><MathText value={message.text} block /></article>) : <div className="paper-chat-empty"><b>{paper.title}</b><p>Ask for a proof expansion, the role of a definition, a dependency path, a comparison of two results, or clarification of notation. The answer will use the paper itself as context.</p></div>}{asking && <div className="paper-chat-thinking">Reading the paper and its audit…</div>}</div><footer><textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') ask(); }} placeholder="Ask anything about this paper…" autoFocus /><div><span>⌘ Enter to send · local Codex subscription</span><button onClick={ask} disabled={asking || !question.trim()}>{asking ? 'Reading…' : 'Ask with paper context'}</button></div></footer></section></div>;
}

function ExportPaperPanel({ paper, audit, nodes, focusIds, readerNotes, notes, focusActive, close }: { paper: Paper; audit: PaperAudit; nodes: AuditNode[]; focusIds: string[]; readerNotes: Record<string, string>; notes: Note[]; focusActive: boolean; close: () => void }) {
  const [selection, setSelection] = useState<ExportSelection>({ abstract: true, prose: true, statements: true, proofs: true, figures: true, citations: true, audit: false, notes: true, focusedOnly: focusActive }); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(''); const [error, setError] = useState('');
  const choices: { key: keyof ExportSelection; label: string; detail: string }[] = [{ key: 'abstract', label: 'Abstract', detail: 'Title, authors, and abstract' }, { key: 'prose', label: 'Paper prose', detail: 'Section headings and author paragraphs' }, { key: 'statements', label: 'Formal statements', detail: 'Definitions, lemmas, propositions, and theorems' }, { key: 'proofs', label: 'Complete proofs', detail: 'Full author proofs, not proof maps' }, { key: 'figures', label: 'Figures', detail: 'Links to original local assets' }, { key: 'citations', label: 'References', detail: 'Resolved alpha-style bibliography' }, { key: 'audit', label: 'AI audit guide', detail: 'Central question and contribution' }, { key: 'notes', label: 'Reader notes', detail: 'Notes linked to included results' }];
  async function save() { setBusy(true); setError(''); setSaved(''); try { const content = buildPaperExport(paper, audit, nodes, readerNotes, notes, selection, focusIds); const fileName = `${paper.arxivId.replace(/[^a-zA-Z0-9.-]+/g, '-')}-${selection.focusedOnly ? 'focused-' : ''}reading-edition.md`; const response = await fetch(`${bridgeUrl}/vault/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId: paper.id, export: { fileName, content, selection } }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'The paper selection could not be saved.'); setSaved(readString(data.saved?.relativePath)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The paper selection could not be saved.'); } finally { setBusy(false); } }
  return <aside className="export-paper-panel"><header><div><b>Save a reading edition</b><span>Choose exactly what belongs in this local copy.</span></div><button onClick={close}>×</button></header><label className="export-focus"><input type="checkbox" checked={selection.focusedOnly} disabled={!focusIds.length} onChange={(event) => setSelection({ ...selection, focusedOnly: event.target.checked })} /><span><b>Only the current focus</b><small>{focusIds.length ? `${focusIds.length} result${focusIds.length === 1 ? '' : 's'} and prerequisites` : 'Choose a focus path first'}</small></span></label><div className="export-choices">{choices.map((choice) => <label key={choice.key}><input type="checkbox" checked={selection[choice.key]} onChange={(event) => setSelection({ ...selection, [choice.key]: event.target.checked })} /><span><b>{choice.label}</b><small>{choice.detail}</small></span></label>)}</div>{error && <p className="export-error">{error}</p>}{saved && <p className="export-saved">Saved locally: {saved}</p>}<footer><button onClick={close}>Close</button><button onClick={() => void save()} disabled={busy || !choices.some((choice) => selection[choice.key])}>{busy ? 'Saving…' : 'Save to paper folder'}</button></footer></aside>;
}

function EmptyVault({ onImport }: { onImport: () => void }) { return <section className="mx-auto max-w-3xl px-6 py-14"><div className="rounded-xl border border-dashed border-[#ccd9cd] bg-white p-9 text-center"><p className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#617463]">LOCAL RESEARCH VAULT</p><h2 className="mt-2 text-2xl font-bold tracking-[-.04em]">Start with a paper, then let its ideas accumulate.</h2><p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[#6b756c]">Each imported paper gets its own named folder, audit, reader notes, attachments, and links into the shared dependency graph.</p><button onClick={onImport} className="mt-6 rounded-md bg-[#2d654f] px-4 py-2.5 text-xs font-bold text-white">Import an arXiv paper</button></div></section>; }

function ReadingMarkSelect({ value, onChange }: { value: ReadingMark; onChange: (value: ReadingMark) => void }) { return <select className={`reading-mark-select ${value ? `reading-mark-select-${value}` : ''}`} value={value} onClick={(event) => event.stopPropagation()} onChange={(event) => onChange(event.target.value as ReadingMark)} aria-label="Mark your understanding"><option value="">Mark…</option><option value="understood">Understood</option><option value="question">Question</option><option value="error">Possible error</option></select>; }

function InteractiveDocument({ paper, audit, nodes, selectedNodeId, setSelectedNodeId, expanded, setExpanded, marks, setMark, patches, savePatches, openAssistant, expandCitation, attachCitation, expandProofStep, expandProofRequest }: { paper: Paper; audit: PaperAudit; nodes: AuditNode[]; selectedNodeId: string; setSelectedNodeId: (id: string) => void; expanded: Record<string, boolean>; setExpanded: (id: string, value: boolean) => void; marks: Record<string, Exclude<ReadingMark, ''>>; setMark: (id: string, value: ReadingMark) => void; patches: WorkingPatch[]; savePatches: (patches: WorkingPatch[]) => Promise<void>; openAssistant: (prompt?: string) => void; expandCitation: (node: AuditNode, citation: CitationReference) => void; attachCitation: (citation: CitationReference, file: File) => Promise<string>; expandProofStep: (node: AuditNode, step: string, index: number) => Promise<string>; expandProofRequest: (node: AuditNode, request: string) => Promise<string> }) {
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
  const fallbackBlocks = nodes.flatMap((node, index): SourceBlock[] => [{ id: `fallback-result-${index}`, kind: 'result', level: 4, title: '', content: node.statement, proofText: '', nodeId: node.id, resultKind: node.kind, citations: node.citations ?? [], assetPaths: [], caption: '' }, ...(node.proofText ? [{ id: `fallback-proof-${index}`, kind: 'proof' as const, level: 4, title: '', content: '', proofText: node.proofText, nodeId: node.id, resultKind: node.kind, citations: node.citations ?? [], assetPaths: [], caption: '' }] : [])]);
  const sourceBlocks = audit.sourceBlocks?.length ? audit.sourceBlocks : fallbackBlocks;
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const focused = nodes.length < applyWorkingPatches(audit.nodes, patches).length;
  const sourceNodeIds = new Set(sourceBlocks.map((block) => block.nodeId).filter(Boolean));
  const additions = nodes.filter((node) => node.id.startsWith('working-') && !sourceNodeIds.has(node.id));
  useEffect(() => {
    let frame = 0; let last = '';
    const update = () => { frame = 0; const center = window.innerHeight / 2; const candidates = [...document.querySelectorAll<HTMLElement>('.reader-document [data-node-id]')].map((element) => ({ id: element.dataset.nodeId || '', rect: element.getBoundingClientRect() })).filter((item) => item.id && item.rect.bottom > 0 && item.rect.top < window.innerHeight).sort((left, right) => Math.abs((left.rect.top + left.rect.bottom) / 2 - center) - Math.abs((right.rect.top + right.rect.bottom) / 2 - center)); const next = candidates[0]?.id; if (next && next !== last) { last = next; setSelectedNodeId(next); } };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    document.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule); schedule();
    return () => { document.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); if (frame) window.cancelAnimationFrame(frame); };
  }, [nodes, setSelectedNodeId]);
  return <article className="interactive-document source-document">
    <header className="interactive-lead">
      <h1>{paper.title}</h1><p className="paper-authors">{paper.authors}</p><p className="paper-identity">arXiv:{paper.arxivId} · {paper.category}</p>
      <section className="paper-abstract"><b>Abstract</b><MathText value={paper.abstract} block /></section>
      <div className="source-completeness"><span>Author text</span><b>{sourceBlocks.filter((block) => block.kind === 'paragraph').length} paragraphs · {sourceBlocks.filter((block) => block.kind === 'result').length} formal statements · {sourceBlocks.filter((block) => block.kind === 'proof').length} proofs · {sourceBlocks.filter((block) => block.kind === 'figure').length} figures</b></div>
    </header>
    <div className="original-source-flow">{sourceBlocks.map((block) => {
      if (focused && (block.kind === 'paragraph' || block.kind === 'figure' || ((block.kind === 'result' || block.kind === 'proof') && !visibleNodeIds.has(block.nodeId)))) return null;
      if (block.kind === 'section') { const Heading = block.level <= 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4'; return <Heading key={block.id} className={`source-section-heading source-section-level-${block.level}`}><MathText value={block.title} /></Heading>; }
      if (block.kind === 'paragraph') return <div key={block.id} className="source-paragraph"><MathText value={block.content} block citations={block.citations} /></div>;
      if (block.kind === 'figure') return <SourceFigure key={block.id} paperId={paper.id} assetPaths={block.assetPaths} caption={block.caption} />;
      const node = nodes.find((item) => item.id === block.nodeId) ?? applyWorkingPatches(audit.nodes, patches).find((item) => item.id === block.nodeId);
      if (!node) return block.content ? <div key={block.id} className="source-paragraph"><MathText value={block.content} block citations={block.citations} /></div> : null;
      const isOpen = expanded[node.id] !== false; const patch = patchForNode(patches, node.id); const sourceNode = audit.nodes.find((item) => item.id === node.id); const citations = node.citations ?? block.citations ?? [];
      const readingMark = marks[block.id] ?? '';
      if (block.kind === 'proof') return isOpen ? <section key={block.id} data-node-id={node.id} className={`source-proof ${readingMark ? `reading-mark-${readingMark}` : ''}`} onClick={() => setSelectedNodeId(node.id)}><div className="source-proof-label"><span>Proof.</span><ReadingMarkSelect value={readingMark} onChange={(value) => setMark(block.id, value)} /></div><EditableTexBlock label="Proof TeX" value={node.proofText || block.proofText} originalValue={sourceNode?.proofText ?? block.proofText} changeRationale={patch?.rationale} citations={citations} emptyText="The source contains no attached proof text." numbered onSave={(value) => saveInlineTex(node, 'proofText', value)} /><ProofReadingTools node={node} citations={citations} expand={expandProofRequest} />{block.assetPaths.length > 0 && <SourceFigure paperId={paper.id} assetPaths={block.assetPaths} caption={block.caption} />}{citations.length > 0 && <CitationSources citations={citations} onExpand={(citation) => expandCitation(node, citation)} onAttach={attachCitation} />}<ProofMap node={node} citations={citations} openNode={setSelectedNodeId} nodes={nodes} expandStep={expandProofStep} /></section> : null;
      return <section key={block.id} data-node-id={node.id} onClick={() => setSelectedNodeId(node.id)} className={`source-result paper-kind-${node.kind} ${selectedNodeId === node.id ? 'source-result-selected' : ''} ${readingMark ? `reading-mark-${readingMark}` : ''}`}>
        <header><b>{displayUnitLabel(node)}.</b>{block.title && <span>(<MathText value={block.title} />)</span>}<AuditPeek node={node} open={() => { setSelectedNodeId(node.id); openAssistant(); }} /><ReadingMarkSelect value={readingMark} onChange={(value) => setMark(block.id, value)} /></header>
        <EditableTexBlock label="Statement TeX" value={node.statement || block.content} originalValue={sourceNode?.statement ?? block.content} changeRationale={patch?.rationale} citations={citations} emptyText="No standalone statement was extracted for this unit." onSave={(value) => saveInlineTex(node, 'statement', value)} />
        {block.assetPaths.length > 0 && <SourceFigure paperId={paper.id} assetPaths={block.assetPaths} caption={block.caption} />}
        <footer><button onClick={(event) => { event.stopPropagation(); setExpanded(node.id, !isOpen); }}>{node.proofText ? isOpen ? 'Collapse proof' : 'Expand complete proof' : 'No attached proof'}</button><button onClick={(event) => { event.stopPropagation(); setSelectedNodeId(node.id); openAssistant(); }}>Ask AI · note · edit</button>{node.dependencies.length > 0 && <span>{node.dependencies.length} logical prerequisite{node.dependencies.length === 1 ? '' : 's'}</span>}</footer>
        {node.dependencies.length > 0 && <details className="source-dependencies"><summary>Logical dependencies</summary><div>{node.dependencies.map((dependency) => <UnitPreviewButton key={dependency} target={nodes.find((item) => item.id === dependency)} fallback="Referenced prerequisite" openNode={setSelectedNodeId} />)}</div></details>}
        {!node.proofText && citations.length > 0 && <CitationSources citations={citations} onExpand={(citation) => expandCitation(node, citation)} onAttach={attachCitation} />}
      </section>;
    })}{additions.length > 0 && <section className="working-additions"><h2>Reader additions</h2>{additions.map((node) => <section key={node.id} className="source-result"><header><b>{displayUnitLabel(node)}.</b></header><EditableTexBlock label="Statement TeX" value={node.statement} originalValue="" changeRationale={patchForNode(patches, node.id)?.rationale} citations={node.citations ?? []} emptyText="No statement." onSave={(value) => saveInlineTex(node, 'statement', value)} /></section>)}</section>}</div>
  </article>;
}

function SourceFigure({ paperId, assetPaths, caption }: { paperId: string; assetPaths: string[]; caption: string }) {
  return <figure className="source-figure"><div>{assetPaths.map((asset, index) => <FigureAsset key={`${asset}:${index}`} paperId={paperId} asset={asset} alt={caption || `Figure ${index + 1}`} />)}</div>{caption && <figcaption><MathText value={caption} block /></figcaption>}</figure>;
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
    try { katex.renderToString(expression, { throwOnError: true, strict: 'ignore', displayMode: Boolean(match[1] || match[2]) }); }
    catch (error) { return error instanceof Error ? error.message.replace(/^KaTeX parse error:\s*/i, '') : 'This formula does not compile.'; }
  }
  return '';
}

function EditableTexBlock({ label, value, originalValue, changeRationale, citations, emptyText, numbered = false, onSave }: { label: string; value: string; originalValue?: string; changeRationale?: string; citations: CitationReference[]; emptyText: string; numbered?: boolean; onSave: (value: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false); const [draft, setDraft] = useState(value); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  function begin(event: ReactMouseEvent | ReactKeyboardEvent) { event.stopPropagation(); setDraft(value); setError(''); setEditing(true); }
  async function save(event: ReactMouseEvent) {
    event.stopPropagation(); const compileError = latexCompileError(draft); if (compileError) { setError(compileError); return; }
    setSaving(true); try { await onSave(draft); setEditing(false); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this TeX edit.'); } finally { setSaving(false); }
  }
  const changed = typeof originalValue === 'string' && originalValue !== value;
  if (!editing) return <div className={`editable-tex-rendered ${changed ? 'tex-modified' : ''}`} role="button" tabIndex={0} title={`Click to edit ${label}`} onClick={begin} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') begin(event); }}><span className="tex-edit-hint">{label} · click to edit</span>{value ? numbered ? <div className="proof-numbered-text">{value.split(/\n\s*\n+/).filter(Boolean).map((paragraph, index) => <div key={index}><span>L{index + 1}</span><MathText value={paragraph} block citations={citations} /></div>)}</div> : <MathText value={value} block citations={citations} /> : <p>{emptyText}</p>}{changed && <aside className="tex-original-popover" role="tooltip"><b>Original text</b><MathText value={originalValue || 'This content was added by the reader.'} block citations={citations} />{changeRationale && <small>{changeRationale}</small>}</aside>}</div>;
  return <div className="editable-tex-source" onClick={(event) => event.stopPropagation()}><header><b>{label}</b><span>Expanded, portable LaTeX · original source preserved</span></header><textarea value={draft} onChange={(event) => { setDraft(event.target.value); setError(''); }} spellCheck={false} autoFocus />{error && <p className="tex-compile-error">Formula error: {error}</p>}<div className="tex-source-preview"><span>Live preview</span>{draft ? <MathText value={draft} block citations={citations} /> : <p>{emptyText}</p>}</div><footer><button onClick={(event) => { event.stopPropagation(); setEditing(false); setError(''); }}>Cancel</button><button onClick={(event) => void save(event)} disabled={saving}>{saving ? 'Saving…' : 'Save to working edition'}</button></footer></div>;
}

function AuditPeek({ node, open }: { node: AuditNode; open: () => void }) {
  return <button className="audit-peek" aria-label={`Preview AI context for ${displayUnitLabel(node)}`} onClick={(event) => { event.stopPropagation(); open(); }}>
    <span aria-hidden="true">i</span><span className="unit-hover-card audit-hover-card" role="tooltip"><b>AI audit context</b><strong>{node.status === 'verified' ? 'Source verified' : node.status}</strong><span>{node.role || 'No separate role was classified.'}</span>{node.whyItMatters && <em>{node.whyItMatters}</em>}<small>Click to pin AI, notes, and editing tools.</small></span>
  </button>;
}

function UnitPreviewButton({ target, fallback, openNode }: { target?: AuditNode; fallback: string; openNode: (id: string) => void }) {
  return <button className="unit-preview-trigger" onClick={(event) => { event.stopPropagation(); if (target) openNode(target.id); }} disabled={!target}>
    <span>{target ? displayUnitLabel(target) : fallback}</span>{target && <span className="unit-hover-card" role="tooltip"><b>{displayUnitLabel(target)}</b>{target.title && <strong><MathText value={target.title} citations={target.citations ?? []} /></strong>}<span><MathText value={target.statement || 'No standalone statement was preserved.'} citations={target.citations ?? []} /></span>{target.role && <em>{target.role}</em>}<small>Click to select this prerequisite.</small></span>}
  </button>;
}

function ProofReadingTools({ node, citations, expand }: { node: AuditNode; citations: CitationReference[]; expand: (node: AuditNode, request: string) => Promise<string> }) {
  const [request, setRequest] = useState(''); const [answer, setAnswer] = useState(''); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  async function run(prompt: string) { if (!prompt.trim() || loading) return; setLoading(true); setError(''); setAnswer(''); try { setAnswer(await expand(node, prompt)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The proof could not be expanded.'); } finally { setLoading(false); } }
  return <section className="proof-reading-tools" onClick={(event) => event.stopPropagation()}><div><button onClick={() => void run('Expand the entire proof line by line in complete detail.')}>Expand full proof</button><div><input value={request} onChange={(event) => setRequest(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void run(request); }} placeholder="L3, or paste a passage…" /><button onClick={() => void run(request)} disabled={!request.trim() || loading}>Explain</button></div></div>{loading && <div className="proof-ai-progress"><span /><span /><span /><p>Reading the complete proof and its dependencies…</p></div>}{error && <p className="proof-step-error">{error}</p>}{answer && <details open className="proof-expanded-answer"><summary>Detailed expansion</summary><MathText value={answer} block citations={citations} /></details>}</section>;
}

function ProofMap({ node, citations, nodes, openNode, expandStep }: { node: AuditNode; citations: CitationReference[]; nodes: AuditNode[]; openNode: (id: string) => void; expandStep: (node: AuditNode, step: string, index: number) => Promise<string> }) {
  const [details, setDetails] = useState<Record<number, string>>({}); const [loading, setLoading] = useState<number | null>(null); const [errors, setErrors] = useState<Record<number, string>>({});
  async function openDetail(index: number, step: string) { if (details[index] || loading === index) return; setLoading(index); setErrors((current) => ({ ...current, [index]: '' })); try { const expanded = await expandStep(node, step, index); setDetails((current) => ({ ...current, [index]: expanded })); } catch (error) { setErrors((current) => ({ ...current, [index]: error instanceof Error ? error.message : 'This step could not be expanded.' })); } finally { setLoading(null); } }
  if (node.proofText.trim().length < 520 || node.proofSketch.length < 2) return null;
  return <details className="proof-map"><summary><span>AI proof map</span></summary><div className="proof-map-body">{node.dependencies.length > 0 && <div className="proof-map-inputs"><b>Inputs used</b>{node.dependencies.map((dependency) => <UnitPreviewButton key={dependency} target={nodes.find((item) => item.id === dependency)} fallback="Referenced prerequisite" openNode={openNode} />)}</div>}<ol>{node.proofSketch.map((step, index) => <li key={index}><details className="proof-step" onToggle={(event) => { if (event.currentTarget.open) void openDetail(index, step); }}><summary><span><b>Step {index + 1}</b><i /></span><MathText value={step} citations={citations} /></summary><div className="proof-step-detail">{loading === index && <div className="proof-ai-progress"><span /><span /><span /><p>Expanding this step from the complete proof…</p></div>}{errors[index] && <p className="proof-step-error">{errors[index]} <button onClick={() => void openDetail(index, step)}>Try again</button></p>}{details[index] && <MathText value={details[index]} block citations={citations} />}</div></details></li>)}</ol></div></details>;
}

function CitationUploadButton({ citation, onAttach }: { citation: CitationReference; onAttach: (citation: CitationReference, file: File) => Promise<string> }) {
  const [status, setStatus] = useState(''); const [busy, setBusy] = useState(false);
  return <label className="citation-upload" onClick={(event) => event.stopPropagation()}><input type="file" accept=".pdf,.tex,.ltx,.bib,application/pdf,text/plain" disabled={busy} onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; setBusy(true); setStatus(''); try { const saved = await onAttach(citation, file); setStatus(saved ? 'Attached locally' : 'Attached'); } catch (error) { setStatus(error instanceof Error ? error.message : 'Upload failed'); } finally { setBusy(false); event.target.value = ''; } }} /><span>{busy ? 'Saving source…' : status || 'Attach local PDF / TeX'}</span></label>;
}

function CitationSources({ citations, onExpand, onAttach }: { citations: CitationReference[]; onExpand?: (citation: CitationReference) => void; onAttach?: (citation: CitationReference, file: File) => Promise<string> }) {
  return <section className="citation-sources"><b>Cited sources <small>Hover or focus to preview</small></b><div>{citations.map((citation) => <article className="citation-source-row" tabIndex={0} key={`${citation.key}:${citation.locator}`}>
    <div className="citation-source-trigger"><span>[{citationAlphaLabel(citation, citation.key)}]{citation.locator ? ` · ${citation.locator}` : ''}</span><strong>{citationTitle(citation, citation.key)}</strong></div>
    <div className="citation-source-popover" role="tooltip"><div><span>[{citationAlphaLabel(citation, citation.key)}]{citation.locator ? ` · ${citation.locator}` : ''}</span></div><h5>{citationTitle(citation, citation.key)}</h5>{citation.authors && <p className="citation-authors">{citation.authors}</p>}{citation.text && !citation.text.startsWith('Bibliography entry ') && <p>{citation.text}</p>}{citation.statement && <div className="citation-result-statement"><b>{citation.locator || 'Cited result'}</b><MathText value={citation.statement} block />{Boolean(citation.definitions?.length) && <dl className="citation-notation"><dt>Notation used in this result</dt>{citation.definitions?.map((item, index) => <div key={`${item.notation}:${index}`}><dd><MathText value={item.notation} /></dd><dd><MathText value={item.definition} citations={[]} />{item.source && <small>{item.source}</small>}</dd></div>)}</dl>}</div>}<footer>{onExpand && <button onClick={(event) => { event.stopPropagation(); onExpand(citation); }}>Retrieve original proof with AI</button>}<a href={citation.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{citation.direct ? 'Open original source ↗' : 'Find original source ↗'}</a>{citation.searchUrl !== citation.url && <a href={citation.searchUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>Search exact title ↗</a>}{citation.arxivId && <a href={`https://arxiv.org/pdf/${citation.arxivId}`} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>Open PDF ↗</a>}{onAttach && <CitationUploadButton citation={citation} onAttach={onAttach} />}</footer></div>
  </article>)}</div></section>;
}

function VersionComparisonPanel({ paper, profile, audit, openUnit, close }: { paper: Paper; profile: Profile; audit: PaperAudit; openUnit: (paperId: string, nodeId: string) => void; close: () => void }) {
  const baseId = paper.arxivId.replace(/v\d+$/i, '');
  const [fromVersion, setFromVersion] = useState(`${baseId}v1`); const [toVersion, setToVersion] = useState(paper.arxivId.match(/v\d+$/i) ? paper.arxivId : baseId); const [result, setResult] = useState<VersionComparison | null>(null); const [sources, setSources] = useState<{ from: string; to: string } | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function compare() {
    if (!fromVersion.trim() || !toVersion.trim()) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await fetch(`${bridgeUrl}/compare-versions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper, profile, fromVersion, toVersion }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Version comparison failed.');
      const parsed = parseJsonObject(readString(data.text));
      setResult({ summary: readString(parsed.summary), changedUnits: asArray(parsed.changedUnits) as VersionChange[], proofChanges: asArray(parsed.proofChanges).map(String), notationChanges: asArray(parsed.notationChanges).map(String), editorialChanges: asArray(parsed.editorialChanges).map(String), dependencyImpact: asArray(parsed.dependencyImpact).map(String), readingRecommendation: readString(parsed.readingRecommendation), warnings: asArray(parsed.warnings).map(String) });
      setSources(data.sources ?? null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Version comparison failed.'); } finally { setBusy(false); }
  }
  function matchingNode(change: VersionChange) { const needle = change.label.toLowerCase(); return audit.nodes.find((node) => node.label.toLowerCase() === needle || node.title.toLowerCase().includes(needle) || needle.includes(node.label.toLowerCase())); }
  return <div className="edition-overlay" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) close(); }}><section className="version-panel"><header><div><p className="reader-kicker">AI mathematical diff</p><h3>Compare arXiv versions</h3><span>TeX-first · local Codex · no API key</span></div><button onClick={close} disabled={busy}>×</button></header><div className="version-picker"><label><span>Version A</span><input value={fromVersion} onChange={(event) => setFromVersion(event.target.value)} placeholder={`${baseId}v1`} /></label><span>→</span><label><span>Version B</span><input value={toVersion} onChange={(event) => setToVersion(event.target.value)} placeholder={baseId} /></label><button onClick={() => void compare()} disabled={busy || !fromVersion.trim() || !toVersion.trim()}>{busy ? 'Reading both sources…' : 'Compare with AI'}</button></div>{error && <p className="version-error">{error}</p>}{busy && <div className="version-loading"><b>Auditing both complete versions</b><p>Proofroom is fetching TeX first, resolving theorem structure, and tracing changes through the dependency graph. This can take several minutes.</p></div>}
    {result && <div className="version-results"><section className="version-summary"><div className="flex items-center justify-between gap-3"><p className="reader-kicker">Executive difference</p>{sources && <span>{sources.from.toUpperCase()} → {sources.to.toUpperCase()}</span>}</div><h4>{result.summary}</h4><p>{result.readingRecommendation}</p></section><section><div className="version-section-head"><b>Changed mathematical units</b><span>{result.changedUnits.length}</span></div><div className="version-changes">{result.changedUnits.map((change, index) => { const match = matchingNode(change); return <article key={`${change.label}-${index}`}><div><span className={`version-change-type version-${change.changeType}`}>{change.changeType}</span><span>{change.significance}</span>{match && <button onClick={() => { openUnit(paper.id, match.id); close(); }}>Open {match.label}</button>}</div><h5>{change.label}</h5><div className="version-before-after"><div><b>Before</b><p>{change.before || 'Not present.'}</p></div><div><b>After</b><p>{change.after || 'Removed.'}</p></div></div><footer><b>Dependency impact</b><p>{change.dependencyImpact || 'No verified dependency impact.'}</p></footer></article>; })}</div></section><div className="version-detail-grid"><ComparisonList title="Proof changes" items={result.proofChanges} /><ComparisonList title="Dependency changes" items={result.dependencyImpact} /><ComparisonList title="Notation changes" items={result.notationChanges} /><ComparisonList title="Editorial changes" items={result.editorialChanges} /></div>{result.warnings.length > 0 && <ComparisonList title="Verification warnings" items={result.warnings} warning />}</div>}
  </section></div>;
}

function ComparisonList({ title, items, warning = false }: { title: string; items: string[]; warning?: boolean }) { return <section className={`comparison-list ${warning ? 'comparison-warning' : ''}`}><div><b>{title}</b><span>{items.length}</span></div>{items.length ? <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>No material change identified.</p>}</section>; }

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
  const nodeKinds: NodeKind[] = ['definition', 'assumption', 'notation', 'lemma', 'proposition', 'theorem', 'corollary', 'proof', 'equation', 'remark', 'example', 'section', 'external-result'];
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

type InspectorProps = { paper: Paper; node: AuditNode; originalNode?: AuditNode; edition: EditionMode; patches: WorkingPatch[]; savePatches: (patches: WorkingPatch[]) => Promise<void>; suggestEdit: (node: AuditNode) => Promise<EditorialSuggestion>; expanded: boolean; setExpanded: (value: boolean) => void; readerNote: string; setReaderNote: (value: string) => void; answer?: string; question: string; setQuestion: (value: string) => void; asking: boolean; ask: () => void; saveNote: (anchor: string, nodeId: string, text: string, latex: string) => void; graph: Graph; addLink: (link: Omit<CrossLink, 'id' | 'source' | 'createdAt'>) => Promise<void>; removeLink: (linkId: string) => Promise<void>; openUnit: (paperId: string, nodeId: string) => void };

function NodeInspector({ paper, node, originalNode, edition, patches, savePatches, suggestEdit, expanded, setExpanded, readerNote, setReaderNote, answer, question, setQuestion, asking, ask, saveNote, graph, addLink, removeLink, openUnit }: InspectorProps) {
  const [noteText, setNoteText] = useState(''); const [noteLatex, setNoteLatex] = useState(''); const [target, setTarget] = useState(''); const [relation, setRelation] = useState<CrossLink['relation']>('uses'); const [linkNote, setLinkNote] = useState(''); const [advancedOpen, setAdvancedOpen] = useState(false);
  const sourceId = unitId(paper.id, node.id); const candidates = graph.nodes.filter((item) => item.paperId !== paper.id); const edges = graph.edges.filter((edge) => edge.from === sourceId || edge.to === sourceId); const nodeById = new Map(graph.nodes.map((item) => [item.id, item]));
  const prerequisiteNodes = edges.filter((edge) => edge.from === sourceId && edge.relation === 'uses').map((edge) => nodeById.get(edge.to)).filter(Boolean) as GraphNode[];
  const dependentNodes = edges.filter((edge) => edge.to === sourceId && edge.relation === 'uses').map((edge) => nodeById.get(edge.from)).filter(Boolean) as GraphNode[];
  function saveLinkedNote() { saveNote(`${displayUnitLabel(node)} · p.${node.anchor.page ?? '—'}`, node.id, noteText, noteLatex); setNoteText(''); setNoteLatex(''); }
  function createLink() { const selected = graph.nodes.find((item) => item.id === target); if (!selected) return; void addLink({ from: { paperId: paper.id, nodeId: node.id }, to: { paperId: selected.paperId, nodeId: selected.nodeId }, relation, note: linkNote }); setTarget(''); setLinkNote(''); }
  return <div className={`inspector-stack inspector-minimal ${advancedOpen ? 'advanced' : ''}`}><div className="assistant-unit-head"><div><span className={kindClass(node.kind)}>{node.kind}</span><a href={`https://arxiv.org/pdf/${paper.arxivId}${node.anchor.page ? `#page=${node.anchor.page}` : ''}`} target="_blank" rel="noreferrer">p.{node.anchor.page ?? '—'} ↗</a></div><p>{displayUnitLabel(node)}</p><h3><MathText value={node.title} citations={node.citations ?? []} /></h3></div><section className="assistant-ask"><div><input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') ask(); }} placeholder={`Ask about ${displayUnitLabel(node)}…`} /><button onClick={ask} disabled={asking || !question.trim()}>{asking ? '…' : 'Ask'}</button></div>{answer && <div className="assistant-answer"><MathText value={answer} block /></div>}</section><button className="assistant-more" onClick={() => setAdvancedOpen(!advancedOpen)}>{advancedOpen ? 'Hide extra tools' : 'Editing, notes, and relationships'} <span>{advancedOpen ? '−' : '+'}</span></button>{advancedOpen && <><WorkingEditionEditor node={node} originalNode={originalNode} edition={edition} patches={patches} savePatches={savePatches} suggestEdit={suggestEdit} /><section className="assistant-source-context"><MathText value={node.statement || 'No standalone statement was preserved by the audit.'} block citations={node.citations ?? []} /><Info label="Role" text={node.role || 'Not classified.'} /><Info label="Why it matters" text={node.whyItMatters || 'Not classified.'} /></section>
    <section className="inspector-section logical-neighborhood"><div className="flex items-center justify-between"><p className="mini-label">Logical neighborhood</p><span>{prerequisiteNodes.length} in · {dependentNodes.length} out</span></div><div className="logical-flow"><div><b>Depends on</b>{prerequisiteNodes.length ? prerequisiteNodes.map((item) => <button key={item.id} onClick={() => openUnit(item.paperId, item.nodeId)}><small>{item.kind}</small><span>{displayUnitLabel(item)} · {item.title}</span></button>) : <p>No audited prerequisites.</p>}</div><i>→</i><div className="logical-current"><small>{node.kind}</small><b>{displayUnitLabel(node)}</b></div><i>→</i><div><b>Used by</b>{dependentNodes.length ? dependentNodes.map((item) => <button key={item.id} onClick={() => openUnit(item.paperId, item.nodeId)}><small>{item.kind}</small><span>{displayUnitLabel(item)} · {item.title}</span></button>) : <p>No audited dependents.</p>}</div></div></section>
    <section className="inspector-section"><button onClick={() => setExpanded(!expanded)} className="inspector-toggle"><span>Full proof & dependencies</span><span>{expanded ? '−' : '+'}</span></button>{expanded && <div className="mt-3"><p className="mini-label">Prerequisites</p><div className="mt-1 flex flex-wrap gap-1">{node.dependencies.length ? node.dependencies.map((dependency) => { const targetNode = graph.nodes.find((item) => item.paperId === paper.id && item.nodeId === dependency); return <span key={dependency} className="ref-chip">{targetNode ? displayUnitLabel(targetNode) : 'Referenced result'}</span>; }) : <span className="text-[11px] text-[#758075]">No audited prerequisites.</span>}</div><p className="mini-label mt-3">Full source proof</p>{node.proofText ? <div className="mt-2 text-[11px] leading-5 text-[#56504c]"><MathText value={node.proofText} block citations={node.citations ?? []} /></div> : <p className="mt-2 text-[11px] leading-5 text-[#758075]">No standalone proof environment is attached in this paper; inspect the cited sources and audited prerequisite chain.</p>}<p className="mini-label mt-3">AI proof route</p>{node.proofSketch.length ? <ol className="mt-2 space-y-2">{node.proofSketch.map((step, index) => <li key={index} className="flex gap-2 text-[11px] leading-5 text-[#56504c]"><span className="grid h-4 w-4 flex-none place-items-center rounded-full bg-white text-[9px] font-bold text-[#8f1d2c]">{index + 1}</span><MathText value={step} citations={node.citations ?? []} /></li>)}</ol> : <p className="mt-2 text-[11px] leading-5 text-[#758075]">No explanatory proof route was certified in the audit.</p>}</div>}</section>
    <section className="inspector-section"><div className="flex justify-between"><p className="mini-label">Cross-paper relations</p><span className="text-[10px] text-[#7d877d]">{edges.length}</span></div>{edges.length ? <div className="mt-2 space-y-1.5">{edges.map((edge) => { const otherId = edge.from === sourceId ? edge.to : edge.from; const other = nodeById.get(otherId); const manual = edge.source === 'manual'; const manualId = manual ? edge.id.replace('manual:', '') : ''; return <div key={edge.id} className="cross-edge"><button onClick={() => other && openUnit(other.paperId, other.nodeId)} className="min-w-0 flex-1 text-left"><b>{edge.relation}</b><span>{other ? `${other.paperTitle} · ${displayUnitLabel(other)}` : 'Referenced result'}</span></button>{manual && <button onClick={() => void removeLink(manualId)} title="Remove relation" className="text-[#899189]">×</button>}</div>; })}</div> : <p className="mt-2 text-[11px] leading-5 text-[#758075]">No local cross-paper relation yet.</p>}{candidates.length > 0 && <div className="mt-3 border-t border-[#e2e7df] pt-3"><select value={target} onChange={(event) => setTarget(event.target.value)} className="w-full rounded border border-[#d5ddd4] bg-white px-2 py-1.5 text-[10px] outline-none"><option value="">Link to another audited unit…</option>{candidates.map((item) => <option key={item.id} value={item.id}>{item.paperTitle} · {displayUnitLabel(item)}</option>)}</select><div className="mt-1.5 flex gap-1.5"><select value={relation} onChange={(event) => setRelation(event.target.value as CrossLink['relation'])} className="rounded border border-[#d5ddd4] bg-white px-1.5 py-1 text-[10px]"><option value="uses">uses</option><option value="extends">extends</option><option value="background">background</option><option value="contrasts">contrasts</option></select><button onClick={createLink} disabled={!target} className="rounded border border-[#cbdacb] px-2 py-1 text-[10px] font-bold text-[#35624b] disabled:opacity-50">Add relation</button></div><input value={linkNote} onChange={(event) => setLinkNote(event.target.value)} placeholder="Optional rationale" className="mt-1.5 w-full rounded border border-[#d5ddd4] px-2 py-1.5 text-[10px] outline-none" /></div>}</section>
    <section className="inspector-section"><p className="mini-label">Your reader layer</p><textarea value={readerNote} onChange={(event) => setReaderNote(event.target.value)} placeholder="Interpretation, caveat, or alternate proof route…" className="mt-2 block min-h-16 w-full rounded border border-[#d5ddd4] p-2 text-[11px] leading-5 outline-none" /></section>
    <section className="inspector-section"><p className="mini-label">Linked LaTeX note</p><textarea value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="Capture a derivation or question…" className="mt-2 block min-h-14 w-full rounded border border-[#d5ddd4] p-2 text-[11px] leading-5 outline-none" /><input value={noteLatex} onChange={(event) => setNoteLatex(event.target.value)} placeholder="LaTeX, e.g. \\|u\\|_{H^1} \\le C" className="mt-1.5 block w-full rounded border border-[#d5ddd4] px-2 py-1.5 text-[10px] outline-none" />{noteLatex && <div className="mt-2 rounded bg-[#f4f6f2] p-1.5"><Latex value={noteLatex} small /></div>}<button onClick={saveLinkedNote} disabled={!noteText.trim()} className="mt-2 rounded bg-[#2d654f] px-2.5 py-1.5 text-[10px] font-bold text-white disabled:opacity-50">Save note</button></section></>}
  </div>;
}

function Info({ label, text }: { label: string; text: string }) { return <div className="rounded border border-[#e3ddd5] bg-[#fbfaf7] p-2.5"><p className="mini-label">{label}</p><div className="mt-1 text-[11px] leading-5 text-[#58514d]"><MathText value={text} block /></div></div>; }

function Library({ papers, audits, patches, busyId, analyze, updatePaper, removePaper, openUnit, openImport }: { papers: Paper[]; audits: Record<string, PaperAudit>; patches: Record<string, WorkingPatch[]>; busyId: string | null; analyze: (paper: Paper) => Promise<void>; updatePaper: (paper: Paper) => Promise<void>; removePaper: (paperId: string) => Promise<void>; openUnit: (paperId: string, nodeId: string) => void; openImport: () => void }) {
  const [query, setQuery] = useState(''); const [editing, setEditing] = useState<Paper | null>(null); const [confirming, setConfirming] = useState(''); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const visible = useMemo(() => { const needle = query.trim().toLowerCase(); if (!needle) return papers; return papers.filter((paper) => [paper.title, paper.authors, paper.arxivId, paper.category, paper.state, ...paper.tags].join(' ').toLowerCase().includes(needle)); }, [papers, query]);
  async function saveEdit() { if (!editing?.title.trim()) return; setSaving(true); setError(''); try { await updatePaper(editing); setEditing(null); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update this paper.'); } finally { setSaving(false); } }
  async function remove(id: string) { setSaving(true); setError(''); try { await removePaper(id); setConfirming(''); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove this paper.'); } finally { setSaving(false); } }
  return <div className="mx-auto max-w-6xl p-6 sm:p-10"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="reader-kicker">Processed literature</p><h2 className="mt-1 text-3xl font-bold tracking-[-.055em]">Your local research library</h2><p className="mt-2 text-sm text-[#707970]">Search every imported paper, reopen its interactive audit, or maintain its local record.</p></div><button onClick={openImport} className="rounded-md bg-[#2d654f] px-3 py-2 text-xs font-bold text-white">+ Import paper</button></div>
    <div className="library-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, author, arXiv ID, field, tag, or reading state…" /><b>{visible.length} of {papers.length}</b></div>{error && <p className="library-error">{error}</p>}
    <div className="library-grid">{visible.map((paper) => <article key={paper.id} className="library-paper"><div className="library-paper-top"><div className="flex flex-wrap gap-1"><span>{paper.category}</span><span>{paper.state}</span>{(patches[paper.id]?.length ?? 0) > 0 && <span>{patches[paper.id].length} working change{patches[paper.id].length === 1 ? '' : 's'}</span>}</div><span className={audits[paper.id] ? 'library-audited' : 'library-pending'}>{audits[paper.id] ? `${audits[paper.id].nodes.length} audited units` : 'Not audited'}</span></div><h3>{paper.title}</h3><p>{paper.authors}</p><small>arXiv:{paper.arxivId}</small><div className="library-tags">{paper.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><div className="library-paper-actions"><button onClick={() => openUnit(paper.id, audits[paper.id]?.nodes[0]?.id ?? '')}>Open reader</button><button onClick={() => void analyze(paper)} disabled={busyId === paper.id}>{busyId === paper.id ? 'Auditing…' : audits[paper.id] ? 'Re-audit' : 'Analyze'}</button><button onClick={() => { setEditing({ ...paper }); setError(''); }}>Edit record</button>{confirming !== paper.id && <button className="library-remove" onClick={() => setConfirming(paper.id)}>Remove</button>}</div>{confirming === paper.id && <div className="library-delete-confirmation" role="alert"><b>Remove this paper?</b><p>Its local notes, reading marks, edits, AI audit, uploaded references, and saved links will be removed with it.</p><div><button onClick={() => setConfirming('')} disabled={saving}>Cancel</button><button className="library-confirm-delete" onClick={() => void remove(paper.id)} disabled={saving}>{saving ? 'Removing…' : 'Remove paper and local data'}</button></div></div>}</article>)}</div>
    {!visible.length && <div className="library-empty">No processed paper matches “{query}”. Try an author, theorem area, arXiv ID, or tag.</div>}
    {editing && <div className="edition-overlay" onMouseDown={(event) => { if (event.currentTarget === event.target) setEditing(null); }}><section className="paper-record-editor"><header><div><p className="reader-kicker">Local library record</p><h3>Edit paper</h3></div><button onClick={() => setEditing(null)}>×</button></header><div className="paper-record-fields"><label><span>Title</span><input value={editing.title} onChange={(event) => setEditing({ ...editing, title: event.target.value })} /></label><label><span>Authors</span><input value={editing.authors} onChange={(event) => setEditing({ ...editing, authors: event.target.value })} /></label><div className="paper-record-row"><label><span>Field</span><input value={editing.category} onChange={(event) => setEditing({ ...editing, category: event.target.value })} /></label><label><span>Reading state</span><select value={editing.state} onChange={(event) => setEditing({ ...editing, state: event.target.value as Paper['state'] })}><option>To read</option><option>Reading</option><option>Read</option></select></label></div><label><span>Tags — separated by commas</span><input value={editing.tags.join(', ')} onChange={(event) => setEditing({ ...editing, tags: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label><label><span>Abstract</span><textarea value={editing.abstract} onChange={(event) => setEditing({ ...editing, abstract: event.target.value })} /></label><p>arXiv:{editing.arxivId} · The source identity and original audit remain unchanged.</p></div><footer><button onClick={() => setEditing(null)}>Cancel</button><button className="paper-record-save" onClick={() => void saveEdit()} disabled={saving || !editing.title.trim()}>{saving ? 'Saving…' : 'Save record'}</button></footer></section></div>}
  </div>;
}

function GraphView({ graph, papers, openUnit }: { graph: Graph; papers: Paper[]; openUnit: (paperId: string, nodeId: string) => void }) { const nodeById = new Map(graph.nodes.map((item) => [item.id, item])); const cross = graph.edges.filter((edge) => nodeById.get(edge.from)?.paperId !== nodeById.get(edge.to)?.paperId); return <div className="mx-auto max-w-6xl p-6 sm:p-10"><div><p className="reader-kicker">Local dependency graph</p><h2 className="mt-1 text-3xl font-bold tracking-[-.055em]">Results that travel between papers</h2><p className="mt-2 text-sm text-[#707970]">Audited units are nodes. Arrows are proof dependencies or explicit relations you add while reading.</p></div>{graph.nodes.length === 0 ? <div className="mt-8 rounded-xl border border-dashed border-[#d8dfd7] p-8 text-sm text-[#7a837a]">Audit at least one paper to build its local graph.</div> : <><div className="graph-canvas mt-8">{papers.filter((paper) => graph.nodes.some((node) => node.paperId === paper.id)).map((paper) => <section key={paper.id} className="graph-paper"><div className="flex items-center justify-between"><b>{paper.title}</b><span>{graph.nodes.filter((node) => node.paperId === paper.id).length} units</span></div><div className="mt-3 flex flex-wrap gap-2">{graph.nodes.filter((node) => node.paperId === paper.id).map((node) => <button key={node.id} onClick={() => openUnit(node.paperId, node.nodeId)} className={`graph-node ${kindClass(node.kind)}`}>{displayUnitLabel(node)}</button>)}</div></section>)}</div><section className="mt-7 rounded-xl border border-[#e0e6df] bg-white p-4"><div className="flex justify-between"><div><p className="reader-kicker">Cross-paper arrows</p><h3 className="mt-1 text-lg font-bold">{cross.length} relation{cross.length === 1 ? '' : 's'}</h3></div><span className="text-[10px] text-[#7c857c]">Add relations from a unit inspector</span></div><div className="mt-4 space-y-2">{cross.length ? cross.map((edge) => { const from = nodeById.get(edge.from); const to = nodeById.get(edge.to); return <div key={edge.id} className="graph-edge"><button onClick={() => from && openUnit(from.paperId, from.nodeId)}>{from ? `${from.paperTitle} · ${displayUnitLabel(from)}` : 'Referenced result'}</button><span>— {edge.relation} →</span><button onClick={() => to && openUnit(to.paperId, to.nodeId)}>{to ? `${to.paperTitle} · ${displayUnitLabel(to)}` : 'Referenced result'}</button>{edge.note && <small>{edge.note}</small>}</div>; }) : <p className="text-sm text-[#788178]">No cross-paper arrows yet. Link a theorem, definition, or external result from the right-hand reader inspector.</p>}</div></section></>}</div>; }

function Discover({ papers, saved, save, refresh, loading, selectedAreas }: { papers: Paper[]; saved: Paper[]; save: (paper: Paper) => Promise<void>; refresh: (area?: string, allToday?: boolean) => Promise<void>; loading: boolean; selectedAreas: string[] }) { const [area, setArea] = useState(selectedAreas[0] || 'math.AG'); return <div className="mx-auto max-w-5xl p-6 sm:p-10"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="reader-kicker">Daily discovery</p><h2 className="mt-1 text-3xl font-bold tracking-[-.055em]">Relevant papers today</h2><p className="mt-2 text-sm text-[#707970]">Browse a compact feed across your interests, or load every paper submitted today in one arXiv math category.</p></div><div className="discovery-actions"><button onClick={() => void refresh()}>{loading ? 'Loading…' : 'Refresh my areas'}</button><label><span>Complete daily category</span><select value={area} onChange={(event) => setArea(event.target.value)}>{mathAreas.map(([id, label]) => <option key={id} value={id}>{id} · {label}</option>)}</select></label><button className="discovery-all" onClick={() => void refresh(area, true)} disabled={loading}>{loading ? 'Loading all…' : 'Load all today'}</button></div></div><div className="mt-8 space-y-3">{papers.length ? papers.map((paper) => { const inVault = saved.some((item) => item.arxivId === paper.arxivId); return <article key={paper.arxivId} className="rounded-xl border border-[#e1e6df] bg-white p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div className="max-w-2xl"><span className="rounded bg-[#edf4ee] px-2 py-1 text-[10px] font-bold text-[#46705a]">{paper.category}</span><h3 className="mt-3 text-lg font-bold">{paper.title}</h3><p className="mt-1 text-xs text-[#737c73]">{paper.authors} · arXiv:{paper.arxivId}</p><p className="mt-3 text-sm leading-6 text-[#606a60]">{paper.abstract}</p></div><button disabled={inVault} onClick={() => void save(paper)} className={`rounded-md px-3 py-2 text-xs font-bold ${inVault ? 'bg-[#edf0ec] text-[#869086]' : 'bg-[#2d654f] text-white'}`}>{inVault ? 'In vault' : '+ Save paper'}</button></div></article>; }) : <div className="library-empty">No arXiv papers were returned for this day and category.</div>}</div></div>; }

function OnboardingDialog({ profile, setProfile, bridge, finish }: { profile: Profile; setProfile: (value: Profile | ((old: Profile) => Profile)) => void; bridge: Bridge | null; finish: () => void }) { const update = (key: 'level' | 'goal' | 'model' | 'reasoning', value: string) => setProfile((current) => ({ ...current, [key]: value })); const model = bridge?.models.find((item) => item.id === profile.model); const efforts = model?.efforts.length ? model.efforts : ['low', 'medium', 'high', 'xhigh']; return <div className="onboarding-shell"><section className="onboarding-dialog"><header><span>First-time setup</span><h2>Shape the reader around your mathematics.</h2><p>This profile stays on this computer and guides paper audits, proof explanations, and discovery.</p></header><div className="onboarding-fields"><Select label="Background" value={profile.level} options={['Undergraduate', 'Graduate student', 'Researcher']} onChange={(value) => update('level', value)} /><Select label="Reading goal" value={profile.goal} options={['Survey new work', 'Understand proofs', 'Apply a result', 'Reproduce a proof']} onChange={(value) => update('goal', value)} /><AreaMultiSelect value={profile.areas} onChange={(areas) => setProfile((current) => ({ ...current, areas }))} /><Select label="Codex model" value={profile.model} options={(bridge?.models ?? []).map((item) => item.id)} labels={(bridge?.models ?? []).reduce<Record<string, string>>((result, item) => ({ ...result, [item.id]: item.label }), {})} onChange={(value) => update('model', value)} emptyLabel="Codex default" /><Select label="Reasoning effort" value={profile.reasoning} options={efforts} onChange={(value) => update('reasoning', value)} /></div><footer><span>You can change these later in Settings.</span><button onClick={finish} disabled={!profile.areas.length}>Start reading</button></footer></section></div>; }

function Settings({ profile, setProfile, bridge }: { profile: Profile; setProfile: (value: Profile | ((old: Profile) => Profile)) => void; bridge: Bridge | null }) { const update = (key: 'level' | 'goal' | 'model' | 'reasoning', value: string) => setProfile((current) => ({ ...current, [key]: value })); const model = bridge?.models.find((item) => item.id === profile.model); const efforts = model?.efforts.length ? model.efforts : ['low', 'medium', 'high', 'xhigh']; return <div className="mx-auto max-w-3xl p-6 sm:p-10"><p className="reader-kicker">Preferences</p><h2 className="mt-1 text-3xl font-bold tracking-[-.055em]">Reader & local Codex</h2><p className="mt-2 text-sm text-[#707970]">Your background steers audits, explanations, and the daily arXiv feed.</p><div className="mt-8 grid gap-4 sm:grid-cols-2"><Select label="Background" value={profile.level} options={['Undergraduate', 'Graduate student', 'Researcher']} onChange={(value) => update('level', value)} /><Select label="Reading goal" value={profile.goal} options={['Survey new work', 'Understand proofs', 'Apply a result', 'Reproduce a proof']} onChange={(value) => update('goal', value)} /><AreaMultiSelect value={profile.areas} onChange={(areas) => setProfile((current) => ({ ...current, areas }))} /><Select label="Codex model" value={profile.model} options={(bridge?.models ?? []).map((item) => item.id)} labels={(bridge?.models ?? []).reduce<Record<string, string>>((result, item) => ({ ...result, [item.id]: item.label }), {})} onChange={(value) => update('model', value)} emptyLabel="Codex default" /><Select label="Reasoning effort" value={profile.reasoning} options={efforts} onChange={(value) => update('reasoning', value)} /></div><div className="france-toggle"><b>Do you like France?</b><button role="switch" aria-checked="false" disabled><i /><span>No</span></button></div></div>; }

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
    setProfile((current) => ({ ...current, model: modelId, reasoning: model?.efforts.includes(current.reasoning) ? current.reasoning : model?.defaultEffort ?? model?.efforts[0] ?? 'xhigh' }));
  }
  return <div className={`model-controls ${compact ? 'model-controls-compact' : ''}`}><label><span>Model</span><select aria-label="AI model" value={profile.model} onChange={(event) => chooseModel(event.target.value)} disabled={!bridge?.models.length}><option value="">Codex default</option>{(bridge?.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label><label><span>Reasoning</span><select aria-label="Reasoning effort" value={profile.reasoning} onChange={(event) => setProfile((current) => ({ ...current, reasoning: event.target.value }))}>{efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label></div>;
}

function AnalysisProgressCard({ progress, profile, bridge }: { progress: AnalysisProgress; profile: Profile; bridge: Bridge | null }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => { const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - progress.startedAt) / 1000))); update(); const timer = window.setInterval(update, 1000); return () => window.clearInterval(timer); }, [progress.startedAt]);
  const active = progress.phase === 'metadata' ? 0 : progress.phase === 'saving' ? 3 : elapsed < 8 ? 1 : 2;
  const stages = ['Fetch arXiv metadata', 'Acquire TeX source', 'Audit results & proofs', 'Build dependency graph'];
  const model = bridge?.models.find((item) => item.id === profile.model)?.label ?? 'Codex default';
  return <aside className="analysis-progress" aria-live="polite"><div className="analysis-progress-glow" /><header><div className="analysis-orbit"><i /><i /><i /></div><div><span>Local AI analysis</span><b>{active === 0 ? 'Preparing paper…' : active === 1 ? 'Reading TeX source…' : active === 2 ? 'Auditing the full paper…' : 'Finishing the reader…'}</b></div><em>{elapsed}s</em></header><h3>{progress.title}</h3><p>arXiv:{progress.arxivId} · {model} · {profile.reasoning} reasoning</p><div className="analysis-track"><span style={{ width: `${[14, 34, 70, 94][active]}%` }} /></div><ol>{stages.map((stage, index) => <li key={stage} className={index < active ? 'done' : index === active ? 'active' : ''}><i>{index < active ? '✓' : index + 1}</i><span>{stage}</span></li>)}</ol><footer>You can keep browsing. The interactive paper will open automatically when the audit is ready.</footer></aside>;
}

function ImportDialog({ close, importArxiv, profile, setProfile, bridge }: { close: () => void; importArxiv: (value: string, convertPdfToLatex?: boolean) => Promise<void>; profile: Profile; setProfile: (value: Profile | ((old: Profile) => Profile)) => void; bridge: Bridge | null }) {
  const [value, setValue] = useState(''); const [convertPdf, setConvertPdf] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent) { event.preventDefault(); if (!value.trim()) return; setBusy(true); setError(''); try { await importArxiv(value, convertPdf); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The paper could not be imported.'); } finally { setBusy(false); } }
  return <div className="import-overlay" onMouseDown={(event) => { if (!busy && event.currentTarget === event.target) close(); }}><form onSubmit={submit} className="import-dialog"><header><div><p className="reader-kicker">ArXiv to interactive paper</p><h2>Import & audit a paper</h2></div><button type="button" onClick={close} disabled={busy}>×</button></header><p className="import-explainer">Paste an arXiv ID, abstract URL, or PDF URL. Proofroom fetches TeX first, reads the complete paper with your local Codex subscription, then builds a theorem-level dependency map.</p><label className="import-source"><span>arXiv ID or URL</span><input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="https://arxiv.org/abs/2608.24719" /></label><label className="import-convert"><input type="checkbox" checked={convertPdf} onChange={(event) => setConvertPdf(event.target.checked)} /><span><b>Convert PDF-only papers to LaTeX first</b><small>If arXiv has no usable TeX source, local AI creates a saved, editable LaTeX working source before the audit. The original PDF remains the authority.</small></span></label><section className="import-ai"><div><b>AI for this audit</b><span>{bridge?.account ? `Local ${bridge.account.type}${bridge.account.planType ? ` · ${bridge.account.planType}` : ''}` : 'Start the local Codex bridge first'}</span></div><ModelControls profile={profile} setProfile={setProfile} bridge={bridge} /></section>{error && <p className="import-error">{error}</p>}<footer><button type="button" onClick={close} disabled={busy}>Cancel</button><button className="import-submit" disabled={busy || !value.trim() || !bridge?.account}>{busy ? <><i /> Fetching metadata…</> : 'Import & analyze'}</button></footer></form></div>;
}
