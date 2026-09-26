import { asArray, makeId, paperChatAnswerKey, parseJsonObject, readString } from './app';
import { citationAlphaLabel, citationTitle, cleanBibliographicText, cleanTeXProse } from './tex-text';
import type {
  Anchor,
  AuditNode,
  CitationReference,
  CrossLink,
  EditorialSuggestion,
  NodeKind,
  Note,
  Paper,
  PaperAudit,
  ReadingMark,
  SourceBlock,
  SourceBlockKind,
  UpdateMigrationItem,
  VersionChange,
  VersionComparison,
  WorkingPatch,
} from './types';

export function normalizeNotes(notes: Note[]) {
  const seen = new Set<string>();
  return notes.filter((note) => {
    if (note.nodeId === '__paper__') return true;
    const key = `${note.paperId}:${note.nodeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function readCitation(value: unknown): CitationReference {
  const entry = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const title = cleanBibliographicText(readString(entry.title, readString(entry.key, 'Cited source')));
  const searchUrl = readString(entry.searchUrl, `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`);
  return {
    key: readString(entry.key),
    locator: cleanBibliographicText(readString(entry.locator)),
    statement: readString(entry.statement),
    definitions: asArray(entry.definitions)
      .map((item) => {
        const definition = item as Record<string, unknown>;
        return {
          notation: readString(definition.notation),
          definition: readString(definition.definition),
          source: cleanBibliographicText(readString(definition.source)),
        };
      })
      .filter((item) => item.notation && item.definition),
    title,
    authors: cleanBibliographicText(readString(entry.authors)),
    text: cleanBibliographicText(readString(entry.text, title)),
    url: readString(entry.url, searchUrl),
    searchUrl,
    doi: readString(entry.doi),
    arxivId: readString(entry.arxivId),
    direct: Boolean(entry.direct),
  };
}
export function parseAudit(rawText: string, threadId: string): PaperAudit {
  const clean = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('Codex returned no structured audit. Try again.');
  const data = JSON.parse(clean.slice(first, last + 1)) as Record<string, unknown>;
  const auditData = data.audit as Record<string, unknown> | undefined;
  if (!auditData || !Array.isArray(data.nodes)) throw new Error('Codex returned an incomplete audit. Try again.');
  const kinds = new Set<NodeKind>([
    'definition',
    'assumption',
    'notation',
    'lemma',
    'proposition',
    'theorem',
    'corollary',
    'conjecture',
    'proof',
    'equation',
    'remark',
    'example',
    'section',
    'table',
    'external-result',
  ]);
  const statuses = new Set<AuditNode['status']>(['verified', 'needs-verification', 'unavailable']);
  const sourceStatus = new Set<PaperAudit['audit']['sourceStatus']>(['full-text-read', 'partial-text-read', 'blocked']);
  const confidence = new Set<Anchor['confidence']>(['verified', 'approximate', 'unverified']);
  return {
    threadId,
    generatedAt: new Date().toISOString(),
    rawText,
    audit: {
      sourceStatus: sourceStatus.has(auditData.sourceStatus as PaperAudit['audit']['sourceStatus'])
        ? (auditData.sourceStatus as PaperAudit['audit']['sourceStatus'])
        : 'partial-text-read',
      sourceSummary: readString(auditData.sourceSummary, 'No source summary returned.'),
      centralQuestion: readString(auditData.centralQuestion, 'Not established.'),
      mainContribution: readString(auditData.mainContribution, 'Not established.'),
      verificationWarnings: asArray(auditData.verificationWarnings).map(String),
    },
    nodes: data.nodes.map((item, index): AuditNode => {
      const entry = item as Record<string, unknown>;
      const anchor = entry.anchor as Record<string, unknown> | undefined;
      return {
        id: readString(entry.id, `unit-${index + 1}`),
        kind: kinds.has(entry.kind as NodeKind) ? (entry.kind as NodeKind) : 'section',
        displayName: readString(entry.displayName) || undefined,
        label: readString(entry.label, `Unit ${index + 1}`),
        title: readString(entry.title, readString(entry.label, `Unit ${index + 1}`)),
        statement: readString(entry.statement),
        proofText: readString(entry.proofText),
        citations: asArray(entry.citations).map(readCitation),
        status: statuses.has(entry.status as AuditNode['status'])
          ? (entry.status as AuditNode['status'])
          : 'needs-verification',
        anchor: {
          label: readString(anchor?.label, 'Source location unavailable'),
          page: typeof anchor?.page === 'number' ? anchor.page : null,
          confidence: confidence.has(anchor?.confidence as Anchor['confidence'])
            ? (anchor?.confidence as Anchor['confidence'])
            : 'unverified',
        },
        role: readString(entry.role),
        dependencies: asArray(entry.dependencies).map(String),
        proofSketch: asArray(entry.proofSketch).map(String),
        whyItMatters: readString(entry.whyItMatters),
        expandable: Boolean(entry.expandable),
      };
    }),
    sourceBlocks: asArray(data.sourceBlocks).map((item, index): SourceBlock => {
      const block = item as Record<string, unknown>;
      const kind = readString(block.kind) as SourceBlockKind;
      return {
        id: readString(block.id, `source-block-${index + 1}`),
        kind: ['section', 'paragraph', 'result', 'proof', 'figure', 'table', 'bibliography'].includes(kind)
          ? kind
          : 'paragraph',
        level: typeof block.level === 'number' ? block.level : 4,
        title: readString(block.title),
        content: readString(block.content),
        proofText: readString(block.proofText),
        nodeId: readString(block.nodeId),
        resultKind: readString(block.resultKind),
        citations: asArray(block.citations).map(readCitation),
        assetPaths: asArray(block.assetPaths).map(String),
        caption: readString(block.caption),
      };
    }),
    readingPaths: asArray(data.readingPaths).map((item) => {
      const path = item as Record<string, unknown>;
      return {
        goal: readString(path.goal, 'Reading path'),
        nodeIds: asArray(path.nodeIds).map(String),
        reason: readString(path.reason),
      };
    }),
    crossPaperLinks: asArray(data.crossPaperLinks)
      .map((item) => {
        const link = item as Record<string, unknown>;
        const relation = ['uses', 'extends', 'background', 'contrasts'].includes(readString(link.relation))
          ? (readString(link.relation) as CrossLink['relation'])
          : 'uses';
        return {
          fromNodeId: readString(link.fromNodeId),
          targetPaperId: readString(link.targetPaperId),
          targetNodeId: readString(link.targetNodeId),
          relation,
          rationale: readString(link.rationale),
        };
      })
      .filter((link) => link.fromNodeId && link.targetPaperId && link.targetNodeId),
    openQuestions: asArray(data.openQuestions).map(String),
    editorialCorrections: asArray(data.editorialCorrections)
      .map((item) => {
        const correction = item as Record<string, unknown>;
        const field = correction.field === 'proofText' ? ('proofText' as const) : ('statement' as const);
        const confidenceValue = readString(correction.confidence);
        const correctionConfidence: EditorialSuggestion['confidence'] =
          confidenceValue === 'high' || confidenceValue === 'medium' ? confidenceValue : 'low';
        return {
          nodeId: readString(correction.nodeId),
          field,
          original: readString(correction.original),
          replacement: readString(correction.replacement),
          rationale: readString(correction.rationale),
          confidence: correctionConfidence,
        };
      })
      .filter((correction) => correction.nodeId && correction.replacement),
  };
}
export function normalizeAuditCitations(audit: PaperAudit): PaperAudit {
  return {
    ...audit,
    nodes: (audit.nodes ?? []).map((node) => ({ ...node, citations: (node.citations ?? []).map(readCitation) })),
    sourceBlocks: (audit.sourceBlocks ?? []).map((block) => ({
      ...block,
      citations: (block.citations ?? []).map(readCitation),
    })),
  };
}

export function kindClass(kind: NodeKind) {
  if (kind === 'theorem' || kind === 'corollary') return 'bg-[#295e49] text-white';
  if (kind === 'lemma' || kind === 'proposition' || kind === 'conjecture') return 'bg-[#dceee1] text-[#286448]';
  if (kind === 'definition' || kind === 'notation' || kind === 'assumption') return 'bg-[#e5edf7] text-[#3c6390]';
  return 'bg-[#f4eee7] text-[#816552]';
}
export function displayUnitLabel(unit: { kind: NodeKind; label?: string; title?: string; displayName?: string }) {
  if (unit.displayName) {
    const number = /\b(?:\d+(?:\.\d+)*|[IVX]+(?:\.[IVX]+)*)\b/i.exec(unit.label || '')?.[0];
    return number ? `${unit.displayName} ${number}` : unit.displayName;
  }
  const printed =
    /^(Theorem|Lemma|Proposition|Corollary|Conjecture|Definition|Remark|Example|Equation|Section)s?\s+[\dIVX]+(?:\.[\dIVX]+)*/i;
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
export function unitId(paperId: string, nodeId: string) {
  return `${paperId}::${nodeId}`;
}
export function arxivBaseId(value: string) {
  return value.replace(/^arXiv:/i, '').replace(/v\d+$/i, '');
}
export function paperSourceLabel(paper: Paper) {
  return paper.arxivId.startsWith('local-') ? 'Local source' : `arXiv:${paper.arxivId}`;
}
export function arxivVersionNumber(value: string) {
  return Number(/v(\d+)$/i.exec(value)?.[1] ?? 0);
}
export function patchForNode(patches: WorkingPatch[], nodeId: string) {
  if (nodeId.startsWith('working-'))
    return patches.find((patch) => patch.kind === 'add' && `working-${patch.id}` === nodeId);
  return patches.findLast((patch) => patch.kind === 'replace' && patch.nodeId === nodeId);
}
function sourceBlockUnitId(block: SourceBlock) {
  return `source-block:${block.id}`;
}
function originalSourceBlockValue(block: SourceBlock) {
  return block.kind === 'section'
    ? block.title
    : block.kind === 'figure'
      ? block.caption
      : block.kind === 'proof'
        ? block.proofText
        : block.content;
}
function sourceBlockValue(block: SourceBlock, patches: WorkingPatch[]) {
  const patch = patchForNode(patches, sourceBlockUnitId(block));
  const original = originalSourceBlockValue(block);
  return patch?.kind === 'replace' ? patch.statement : original;
}
export function sourceBlockAsNode(block: SourceBlock, patches: WorkingPatch[]): AuditNode {
  const value = sourceBlockValue(block, patches);
  const kind: NodeKind =
    block.kind === 'section'
      ? 'section'
      : block.kind === 'figure'
        ? 'figure'
        : block.kind === 'table'
          ? 'table'
          : 'paragraph';
  return {
    id: sourceBlockUnitId(block),
    kind,
    label: kind === 'section' ? value : '',
    title:
      kind === 'section'
        ? value
        : kind === 'figure'
          ? value || 'Paper figure'
          : kind === 'table'
            ? block.caption || 'Paper table'
            : 'Author text',
    statement: value,
    proofText: '',
    citations: block.citations ?? [],
    status: 'verified',
    anchor: {
      label: kind === 'section' ? value : kind === 'table' ? 'Author table' : 'Author text',
      page: null,
      confidence: 'verified',
    },
    role:
      kind === 'section'
        ? 'Section heading and the text that follows it.'
        : kind === 'figure'
          ? 'An original figure and its caption.'
          : kind === 'table'
            ? 'An original table from the paper.'
            : 'A paragraph of the original author text.',
    dependencies: [],
    proofSketch: [],
    whyItMatters: '',
    expandable: false,
  };
}

export function parseVersionComparison(rawText: string): VersionComparison {
  const parsed = parseJsonObject(rawText);
  const changeTypes = new Set<VersionChange['changeType']>([
    'added',
    'removed',
    'strengthened',
    'weakened',
    'corrected',
    'reorganized',
    'wording',
  ]);
  const significances = new Set<VersionChange['significance']>([
    'mathematical',
    'proof-level',
    'expository',
    'uncertain',
  ]);
  return {
    summary: readString(parsed.summary),
    changedUnits: asArray(parsed.changedUnits).map((item): VersionChange => {
      const change = item as Record<string, unknown>;
      return {
        label: readString(change.label, 'Changed unit'),
        changeType: changeTypes.has(change.changeType as VersionChange['changeType'])
          ? (change.changeType as VersionChange['changeType'])
          : 'wording',
        before: readString(change.before),
        after: readString(change.after),
        significance: significances.has(change.significance as VersionChange['significance'])
          ? (change.significance as VersionChange['significance'])
          : 'uncertain',
        dependencyImpact: readString(change.dependencyImpact),
      };
    }),
    proofChanges: asArray(parsed.proofChanges).map(String),
    notationChanges: asArray(parsed.notationChanges).map(String),
    editorialChanges: asArray(parsed.editorialChanges).map(String),
    dependencyImpact: asArray(parsed.dependencyImpact).map(String),
    readingRecommendation: readString(parsed.readingRecommendation),
    warnings: asArray(parsed.warnings).map(String),
  };
}

export function updateMatchText(value: string) {
  return cleanTeXProse(value || '')
    .toLowerCase()
    .replace(/\\[a-z]+/g, ' ')
    .replace(/[^a-z0-9\u00c0-\u024f\u0370-\u03ff]+/g, ' ')
    .trim();
}
function updateSimilarity(left: string, right: string) {
  const a = new Set(
    updateMatchText(left)
      .split(/\s+/)
      .filter((token) => token.length > 1),
  );
  const b = new Set(
    updateMatchText(right)
      .split(/\s+/)
      .filter((token) => token.length > 1),
  );
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}
function updateNodeText(node: AuditNode) {
  return [node.label, node.title, node.statement, node.proofText.slice(0, 1200)].filter(Boolean).join(' ');
}
function updateBlockText(block: SourceBlock) {
  return [block.title, block.caption, block.content, block.proofText].filter(Boolean).join(' ');
}

function buildUpdateUnitMap(previous: PaperAudit, next: PaperAudit) {
  const nodeMap: Record<string, string> = {};
  const usedNodes = new Set<string>();
  previous.nodes.forEach((oldNode, oldIndex) => {
    const candidates = next.nodes
      .map((newNode, newIndex) => {
        if (oldNode.kind !== newNode.kind) return { node: newNode, score: -1 };
        const oldLabel = updateMatchText(oldNode.label);
        const newLabel = updateMatchText(newNode.label);
        const oldTitle = updateMatchText(oldNode.title);
        const newTitle = updateMatchText(newNode.title);
        const labelScore = oldLabel && oldLabel === newLabel ? 0.46 : 0;
        const titleScore = oldTitle && oldTitle === newTitle ? 0.24 : 0;
        const textScore = updateSimilarity(updateNodeText(oldNode), updateNodeText(newNode)) * 0.55;
        const positionScore = Math.max(
          0,
          0.08 -
            Math.abs(oldIndex / Math.max(1, previous.nodes.length) - newIndex / Math.max(1, next.nodes.length)) * 0.08,
        );
        return { node: newNode, score: labelScore + titleScore + textScore + positionScore };
      })
      .filter((item) => !usedNodes.has(item.node.id))
      .sort((left, right) => right.score - left.score);
    if (candidates[0] && candidates[0].score >= 0.38) {
      nodeMap[oldNode.id] = candidates[0].node.id;
      usedNodes.add(candidates[0].node.id);
    }
  });
  const blockMap: Record<string, string> = {};
  const usedBlocks = new Set<string>();
  previous.sourceBlocks.forEach((oldBlock, oldIndex) => {
    let candidates = next.sourceBlocks.filter((block) => block.kind === oldBlock.kind && !usedBlocks.has(block.id));
    if ((oldBlock.kind === 'result' || oldBlock.kind === 'proof') && oldBlock.nodeId && nodeMap[oldBlock.nodeId])
      candidates = candidates.filter((block) => block.nodeId === nodeMap[oldBlock.nodeId]);
    const ranked = candidates
      .map((newBlock, newIndex) => {
        const exactTitle =
          updateMatchText(oldBlock.title || oldBlock.caption) &&
          updateMatchText(oldBlock.title || oldBlock.caption) === updateMatchText(newBlock.title || newBlock.caption)
            ? 0.5
            : 0;
        const textScore = updateSimilarity(updateBlockText(oldBlock), updateBlockText(newBlock)) * 0.65;
        const positionScore = Math.max(
          0,
          0.08 -
            Math.abs(
              oldIndex / Math.max(1, previous.sourceBlocks.length) - newIndex / Math.max(1, next.sourceBlocks.length),
            ) *
              0.08,
        );
        return { block: newBlock, score: exactTitle + textScore + positionScore };
      })
      .sort((left, right) => right.score - left.score);
    const threshold =
      oldBlock.kind === 'result' || oldBlock.kind === 'proof' ? 0.18 : oldBlock.kind === 'paragraph' ? 0.48 : 0.34;
    if (ranked[0] && ranked[0].score >= threshold) {
      blockMap[oldBlock.id] = ranked[0].block.id;
      usedBlocks.add(ranked[0].block.id);
    }
  });
  const unitMap = { ...nodeMap };
  for (const [from, to] of Object.entries(blockMap))
    unitMap[sourceBlockUnitId(previous.sourceBlocks.find((block) => block.id === from)!)] = sourceBlockUnitId(
      next.sourceBlocks.find((block) => block.id === to)!,
    );
  return { nodeMap, blockMap, unitMap };
}

function mergeUpdatedField(original: string, edited: string, latest: string) {
  if (edited === original) return { value: latest, conflict: false };
  if (latest === original) return { value: edited, conflict: false };
  let prefix = 0;
  while (prefix < original.length && prefix < edited.length && original[prefix] === edited[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < edited.length - prefix &&
    original[original.length - 1 - suffix] === edited[edited.length - 1 - suffix]
  )
    suffix += 1;
  const removed = original.slice(prefix, original.length - suffix);
  const inserted = edited.slice(prefix, edited.length - suffix);
  if (removed && latest.split(removed).length === 2)
    return { value: latest.replace(removed, inserted), conflict: false };
  if (
    !removed &&
    prefix <= latest.length &&
    latest.slice(Math.max(0, prefix - 20), prefix) === original.slice(Math.max(0, prefix - 20), prefix)
  )
    return { value: `${latest.slice(0, prefix)}${inserted}${latest.slice(prefix)}`, conflict: false };
  return { value: latest, conflict: true };
}

function unitBaseline(audit: PaperAudit, id: string) {
  const node = audit.nodes.find((item) => item.id === id);
  if (node) return { title: node.title, statement: node.statement, proofText: node.proofText, nodeKind: node.kind };
  const block = audit.sourceBlocks.find((item) => sourceBlockUnitId(item) === id);
  if (!block) return null;
  return {
    title: block.title,
    statement: originalSourceBlockValue(block),
    proofText: '',
    nodeKind:
      block.kind === 'section'
        ? ('section' as const)
        : block.kind === 'figure'
          ? ('figure' as const)
          : block.kind === 'table'
            ? ('table' as const)
            : ('paragraph' as const),
  };
}

export function migrateReaderWork({
  paper,
  previous,
  next,
  notes,
  nodeNotes,
  nodeAnswers,
  expanded,
  marks,
  patches,
}: {
  paper: Paper;
  previous: PaperAudit;
  next: PaperAudit;
  notes: Note[];
  nodeNotes: Record<string, string>;
  nodeAnswers: Record<string, string>;
  expanded: Record<string, boolean>;
  marks: Record<string, Exclude<ReadingMark, ''>>;
  patches: WorkingPatch[];
}) {
  const maps = buildUpdateUnitMap(previous, next);
  const items: UpdateMigrationItem[] = [];
  const conflicts: UpdateMigrationItem[] = [];
  const migratedNotes: Note[] = [];
  let notesCarried = 0;
  let notesToPaper = 0;
  for (const note of notes) {
    if (note.nodeId === '__paper__') {
      migratedNotes.push(note);
      notesCarried += 1;
      continue;
    }
    const target = maps.unitMap[note.nodeId];
    if (target) {
      migratedNotes.push({ ...note, nodeId: target });
      notesCarried += 1;
      items.push({
        type: 'note',
        label: note.anchor || 'Reader note',
        status: 'carried',
        detail: 'Reattached to the matching unit in the latest version.',
        fromId: note.nodeId,
        toId: target,
      });
    } else {
      const preserved = {
        ...note,
        id: makeId(),
        nodeId: '__paper__',
        anchor: `From ${paper.arxivId} · ${note.anchor}`,
        text: `Previous-version note (${note.anchor}):\n\n${note.text}`,
      };
      migratedNotes.push(preserved);
      notesToPaper += 1;
      const item = {
        type: 'note' as const,
        label: note.anchor || 'Reader note',
        status: 'paper-note' as const,
        detail: 'The original anchor changed, so this was preserved as a paper-level note.',
        fromId: note.nodeId,
        toId: '__paper__',
      };
      items.push(item);
      conflicts.push(item);
    }
  }
  const migratedNodeNotes: Record<string, string> = {};
  for (const [id, value] of Object.entries(nodeNotes)) {
    const target = maps.unitMap[id];
    if (target) migratedNodeNotes[target] = value;
    else if (value.trim()) {
      migratedNotes.push({
        id: makeId(),
        paperId: paper.id,
        nodeId: '__paper__',
        anchor: `From ${paper.arxivId}`,
        text: `Previous-version note:\n\n${value}`,
        latex: '',
        createdAt: new Date().toISOString(),
      });
      notesToPaper += 1;
    }
  }
  // AI answers belong to the old audit thread. They remain in the archived
  // snapshot but are not shown as if they had been checked against new text.
  const migratedAnswers: Record<string, string> = nodeAnswers[paperChatAnswerKey]
    ? { [paperChatAnswerKey]: nodeAnswers[paperChatAnswerKey] }
    : {};
  const migratedExpanded: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(expanded)) {
    const target = maps.unitMap[id];
    if (target) migratedExpanded[target] = value;
  }
  const migratedMarks: Record<string, Exclude<ReadingMark, ''>> = {};
  let marksCarried = 0;
  for (const [id, value] of Object.entries(marks)) {
    const target = maps.blockMap[id] ?? maps.unitMap[id];
    if (target) {
      migratedMarks[target] = value;
      marksCarried += 1;
      items.push({
        type: 'mark',
        label: 'Reading mark',
        status: 'carried',
        detail: 'Moved to the matching environment.',
        fromId: id,
        toId: target,
      });
    }
  }
  const migratedPatches: WorkingPatch[] = [];
  let editsCarried = 0;
  let editsReview = 0;
  for (const patch of patches.filter((item) => item.source === 'manual')) {
    if (patch.kind === 'add') {
      const afterNodeId = maps.unitMap[patch.afterNodeId] ?? next.nodes.at(-1)?.id ?? '';
      migratedPatches.push({ ...patch, afterNodeId });
      editsCarried += 1;
      items.push({
        type: 'edit',
        label: patch.title || 'Reader addition',
        status: 'carried',
        detail: 'Reader-added content was retained in the working edition.',
        fromId: patch.afterNodeId,
        toId: afterNodeId,
      });
      continue;
    }
    const targetId = maps.unitMap[patch.nodeId];
    const oldBase = unitBaseline(previous, patch.nodeId);
    const newBase = targetId ? unitBaseline(next, targetId) : null;
    if (!targetId || !oldBase || !newBase) {
      editsReview += 1;
      const item = {
        type: 'edit' as const,
        label: patch.title || 'Working edit',
        status: 'review' as const,
        detail:
          'The edited source unit has no safe match in the latest version. The edit remains in the archived version for review.',
        fromId: patch.nodeId,
        toId: '',
      };
      items.push(item);
      conflicts.push(item);
      continue;
    }
    if (patch.kind === 'delete') {
      migratedPatches.push({ ...patch, nodeId: targetId });
      editsCarried += 1;
      items.push({
        type: 'edit',
        label: patch.title || 'Deleted unit',
        status: 'carried',
        detail: 'The reader deletion was applied to the matching latest-version unit.',
        fromId: patch.nodeId,
        toId: targetId,
      });
      continue;
    }
    const title = mergeUpdatedField(oldBase.title, patch.title, newBase.title);
    const statement = mergeUpdatedField(oldBase.statement, patch.statement, newBase.statement);
    const proofText = mergeUpdatedField(oldBase.proofText, patch.proofText, newBase.proofText);
    if (title.conflict || statement.conflict || proofText.conflict) {
      editsReview += 1;
      const item = {
        type: 'edit' as const,
        label: patch.title || 'Working edit',
        status: 'review' as const,
        detail:
          'Both the author and reader changed the same text. The new author text is kept; the archived edit is flagged for review.',
        fromId: patch.nodeId,
        toId: targetId,
      };
      items.push(item);
      conflicts.push(item);
      continue;
    }
    migratedPatches.push({
      ...patch,
      nodeId: targetId,
      title: title.value,
      statement: statement.value,
      proofText: proofText.value,
    });
    editsCarried += 1;
    items.push({
      type: 'edit',
      label: patch.title || 'Working edit',
      status: 'carried',
      detail: 'Merged onto the latest author text with a three-way source comparison.',
      fromId: patch.nodeId,
      toId: targetId,
    });
  }
  return {
    maps,
    reader: {
      notes: migratedNotes,
      nodeNotes: migratedNodeNotes,
      nodeAnswers: migratedAnswers,
      expanded: migratedExpanded,
      marks: migratedMarks,
    },
    patches: migratedPatches,
    migration: { notesCarried, notesToPaper, marksCarried, editsCarried, editsReview, items, conflicts },
  };
}

export function automaticEditorialPatches(audit: PaperAudit, existing: WorkingPatch[]) {
  const manualReplacements = new Set(
    existing.filter((patch) => patch.kind === 'replace' && patch.source === 'manual').map((patch) => patch.nodeId),
  );
  const automatic = new Map<string, WorkingPatch>();
  for (const correction of audit.editorialCorrections ?? []) {
    const sourceNode = audit.nodes.find((item) => item.id === correction.nodeId);
    if (!sourceNode || correction.confidence !== 'high' || !correction.replacement.trim()) continue;
    const directBlock = audit.sourceBlocks.find(
      (block) => block.nodeId === sourceNode.id && (correction.field !== 'proofText' || block.kind === 'proof'),
    );
    const originalNeedles = [
      correction.original.trim(),
      correction.field === 'proofText' ? sourceNode.proofText.trim() : sourceNode.statement.trim(),
    ].filter(Boolean);
    const embeddedBlock = directBlock
      ? undefined
      : audit.sourceBlocks.find((block) => {
          const value = originalSourceBlockValue(block);
          return originalNeedles.some((needle) => value.includes(needle));
        });
    if (embeddedBlock) {
      const targetId = sourceBlockUnitId(embeddedBlock);
      if (manualReplacements.has(targetId)) continue;
      const original = originalSourceBlockValue(embeddedBlock);
      const current = automatic.get(targetId) ?? {
        id: makeId(),
        kind: 'replace' as const,
        nodeId: targetId,
        title: embeddedBlock.title || sourceNode.title,
        statement: original,
        proofText: '',
        nodeKind:
          embeddedBlock.kind === 'section'
            ? ('section' as const)
            : embeddedBlock.kind === 'figure'
              ? ('figure' as const)
              : embeddedBlock.kind === 'table'
                ? ('table' as const)
                : ('paragraph' as const),
        afterNodeId: '',
        rationale: '',
        dependencies: [],
        proofSketch: [],
        source: 'ai' as const,
        createdAt: new Date().toISOString(),
      };
      const needle = originalNeedles.find((candidate) => current.statement.includes(candidate));
      if (!needle) continue;
      current.statement = current.statement.replace(needle, correction.replacement.trim());
      current.rationale = [current.rationale, correction.rationale].filter(Boolean).join(' ');
      automatic.set(targetId, current);
      continue;
    }
    if (manualReplacements.has(sourceNode.id)) continue;
    const current = automatic.get(sourceNode.id) ?? {
      id: makeId(),
      kind: 'replace' as const,
      nodeId: sourceNode.id,
      title: sourceNode.title,
      statement: sourceNode.statement,
      proofText: sourceNode.proofText,
      nodeKind: sourceNode.kind,
      afterNodeId: '',
      rationale: '',
      dependencies: sourceNode.dependencies,
      proofSketch: sourceNode.proofSketch,
      source: 'ai' as const,
      createdAt: new Date().toISOString(),
    };
    current[correction.field] = correction.replacement.trim();
    current.rationale = [current.rationale, correction.rationale].filter(Boolean).join(' ');
    automatic.set(sourceNode.id, current);
  }
  return [...automatic.values()];
}

export function resolveSourceBlockIndex(
  requestedId: string,
  requestedNode: AuditNode | undefined,
  sourceBlocks: SourceBlock[],
  patches: WorkingPatch[],
) {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/\\[a-z]+/gi, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const stopWords = new Set([
    'about',
    'after',
    'again',
    'against',
    'being',
    'between',
    'could',
    'every',
    'first',
    'from',
    'have',
    'into',
    'other',
    'paper',
    'result',
    'section',
    'their',
    'theorem',
    'these',
    'this',
    'using',
    'where',
    'which',
    'with',
  ]);
  let targetIndex = sourceBlocks.findIndex(
    (block) => block.nodeId === requestedId || sourceBlockAsNode(block, patches).id === requestedId,
  );
  if (targetIndex >= 0 || !requestedNode) return targetIndex;
  const requestedTitle = normalize(requestedNode.title);
  targetIndex = sourceBlocks.findIndex(
    (block) => block.kind === 'section' && requestedTitle && normalize(block.title) === requestedTitle,
  );
  if (targetIndex >= 0) return targetIndex;
  const sectionMatch = requestedNode.anchor.label.match(/^Section\s+(\d+)(?:\.(\d+))?/i);
  if (sectionMatch) {
    const major = Number(sectionMatch[1]);
    const minor = Number(sectionMatch[2] || 0);
    const majorSections = sourceBlocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => block.kind === 'section' && block.level === 1);
    const majorSection = majorSections[major - 1];
    if (majorSection) {
      if (!minor) return majorSection.index;
      const majorEnd = majorSections[major]?.index ?? sourceBlocks.length;
      const subsections = sourceBlocks
        .map((block, index) => ({ block, index }))
        .filter(
          ({ block, index }) =>
            index > majorSection.index && index < majorEnd && block.kind === 'section' && block.level === 2,
        );
      return subsections[minor - 1]?.index ?? majorSection.index;
    }
  }
  const queryTokens = new Set(
    normalize(`${requestedNode.title} ${requestedNode.statement}`)
      .split(' ')
      .filter((word) => word.length >= 4 && !stopWords.has(word)),
  );
  let best = { index: -1, score: 0 };
  sourceBlocks.forEach((block, index) => {
    const candidate = new Set(normalize(`${block.title} ${block.content} ${block.proofText}`).split(' '));
    const score = [...queryTokens].reduce((sum, word) => sum + (candidate.has(word) ? 1 : 0), 0);
    if (score > best.score) best = { index, score };
  });
  return best.score >= 2 ? best.index : -1;
}
export function applyWorkingPatches(nodes: AuditNode[], patches: WorkingPatch[]) {
  const deleted = new Set(patches.filter((patch) => patch.kind === 'delete').map((patch) => patch.nodeId));
  const replacements = new Map(
    patches.filter((patch) => patch.kind === 'replace').map((patch) => [patch.nodeId, patch]),
  );
  const result: AuditNode[] = [];
  for (const node of nodes) {
    if (!deleted.has(node.id)) {
      const replacement = replacements.get(node.id);
      result.push(
        replacement
          ? {
              ...node,
              kind: replacement.nodeKind || node.kind,
              title: replacement.title || node.title,
              statement: replacement.statement || node.statement,
              proofText: replacement.proofText || node.proofText,
              dependencies: replacement.dependencies.length ? replacement.dependencies : node.dependencies,
              proofSketch: replacement.proofSketch.length ? replacement.proofSketch : node.proofSketch,
              status: 'needs-verification',
              anchor: { ...node.anchor, confidence: 'approximate' },
            }
          : node,
      );
    }
    for (const patch of patches.filter((item) => item.kind === 'add' && item.afterNodeId === node.id)) {
      result.push({
        id: `working-${patch.id}`,
        kind: patch.nodeKind || 'proposition',
        label: 'Working edition',
        title: patch.title,
        statement: patch.statement,
        proofText: patch.proofText,
        citations: [],
        status: 'needs-verification',
        anchor: { label: 'Working edition — reader addition', page: null, confidence: 'unverified' },
        role: patch.rationale || 'Reader-added proposition',
        dependencies: patch.dependencies,
        proofSketch: patch.proofSketch,
        whyItMatters: 'This unit was added in the working edition and is not part of the original source.',
        expandable: true,
      });
    }
  }
  return result;
}

export function dependencyFocus(nodes: AuditNode[], targetId: string) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visible = new Set<string>();
  function visit(id: string) {
    if (!id || visible.has(id)) return;
    visible.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
  }
  visit(targetId);
  return nodes.filter((node) => visible.has(node.id)).map((node) => node.id);
}

export type ExportSelection = {
  abstract: boolean;
  prose: boolean;
  statements: boolean;
  proofs: boolean;
  figures: boolean;
  citations: boolean;
  audit: boolean;
  notes: boolean;
  focusedOnly: boolean;
};

export function buildPaperExport(
  paper: Paper,
  audit: PaperAudit,
  nodes: AuditNode[],
  patches: WorkingPatch[],
  readerNotes: Record<string, string>,
  notes: Note[],
  selection: ExportSelection,
  focusIds: string[],
) {
  const visible = new Set(selection.focusedOnly && focusIds.length ? focusIds : nodes.map((node) => node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const lines = [`# ${paper.title}`, '', paper.authors, '', paperSourceLabel(paper), ''];
  const references = new Map<string, CitationReference>();
  const addCitations = (citations: CitationReference[] = []) => {
    for (const citation of citations) references.set(`${citation.key}:${citation.locator}`, citation);
  };
  if (selection.abstract) lines.push('## Abstract', '', paper.abstract, '');
  for (const block of audit.sourceBlocks ?? []) {
    const workingValue = sourceBlockValue(block, patches);
    if (block.kind === 'section' && selection.prose)
      lines.push(`${'#'.repeat(Math.min(6, block.level + 2))} ${workingValue}`, '');
    if (block.kind === 'paragraph' && selection.prose) {
      lines.push(workingValue, '');
      addCitations(block.citations);
    }
    if (block.kind === 'table' && selection.prose) {
      lines.push(workingValue, '');
      if (block.caption) lines.push(`*${block.caption}*`, '');
      addCitations(block.citations);
    }
    if (block.kind === 'figure' && selection.figures) {
      for (const asset of block.assetPaths)
        lines.push(`![${workingValue || 'Original figure'}](../attachments/source/${asset})`, '');
      if (workingValue) lines.push(`*${workingValue}*`, '');
      addCitations(block.citations);
    }
    if ((block.kind === 'result' || block.kind === 'proof') && block.nodeId && !visible.has(block.nodeId)) continue;
    const node = block.nodeId ? byId.get(block.nodeId) : undefined;
    if (block.kind === 'result' && node && selection.statements) {
      lines.push(
        `### ${displayUnitLabel(node)}${node.title ? ` — ${node.title}` : ''}`,
        '',
        node.statement || block.content,
        '',
      );
      addCitations(node.citations);
    }
    if (block.kind === 'proof' && node && selection.proofs) {
      lines.push(`**Proof of ${displayUnitLabel(node)}.**`, '', node.proofText || block.proofText, '');
      addCitations(node.citations);
    }
  }
  if (selection.audit)
    lines.push(
      '## AI reading audit',
      '',
      `**Central question.** ${audit.audit.centralQuestion}`,
      '',
      `**Main contribution.** ${audit.audit.mainContribution}`,
      '',
      `**Source status.** ${audit.audit.sourceSummary}`,
      '',
    );
  if (selection.notes) {
    const selectedNotes = Object.entries(readerNotes).filter(([id, value]) => visible.has(id) && value.trim());
    const linkedNotes = notes.filter((note) => note.nodeId === '__paper__' || visible.has(note.nodeId));
    if (selectedNotes.length || linkedNotes.length) lines.push('## Reader notes', '');
    for (const [id, value] of selectedNotes)
      lines.push(`### ${displayUnitLabel(byId.get(id) ?? ({ kind: 'section' } as AuditNode))}`, '', value, '');
    for (const note of linkedNotes)
      lines.push(`### ${note.anchor}`, '', note.text, note.latex ? `$$${note.latex}$$` : '', '');
  }
  if (selection.citations && references.size) {
    lines.push('## References', '');
    for (const citation of references.values())
      lines.push(
        `- [${citationAlphaLabel(citation, citation.key)}] ${citation.authors ? `${citation.authors}. ` : ''}${citationTitle(citation, citation.key)}${citation.url ? ` — ${citation.url}` : ''}`,
      );
    lines.push('');
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

export function completeLatexSource(paper: Paper, audit: PaperAudit, nodes: AuditNode[], patches: WorkingPatch[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const citationKeys = new Map<string, CitationReference>();
  for (const node of nodes) for (const citation of node.citations ?? []) citationKeys.set(citation.key, citation);
  const sourceText = (value: string) =>
    String(value || '').replace(
      /\[\[cite:([^\]|]+)(?:\|([^\]]*))?\]\]/g,
      (_match, key, locator) => `\\cite${locator ? `[${locator}]` : ''}{${key}}`,
    );
  const lines = [
    '\\documentclass[11pt]{article}',
    '\\usepackage{amsmath,amssymb,amsthm,mathtools,graphicx,xcolor,hyperref}',
    '\\newtheorem{theorem}{Theorem}[section]',
    '\\newtheorem{lemma}[theorem]{Lemma}',
    '\\newtheorem{proposition}[theorem]{Proposition}',
    '\\newtheorem{corollary}[theorem]{Corollary}',
    '\\newtheorem{conjecture}[theorem]{Conjecture}',
    '\\theoremstyle{definition}',
    '\\newtheorem{definition}[theorem]{Definition}',
    '\\newtheorem{assumption}[theorem]{Assumption}',
    '\\newtheorem{remark}[theorem]{Remark}',
    '\\newtheorem{example}[theorem]{Example}',
    `\\title{${sourceText(paper.title)}}`,
    `\\author{${sourceText(paper.authors)}}`,
    '\\date{}',
    '\\begin{document}',
    '\\maketitle',
    '\\begin{abstract}',
    sourceText(paper.abstract),
    '\\end{abstract}',
    '',
  ];
  const blocks = audit.sourceBlocks?.length
    ? audit.sourceBlocks
    : nodes.flatMap((node, index): SourceBlock[] => [
        {
          id: `export-result-${index}`,
          kind: 'result',
          level: 4,
          title: '',
          content: node.statement,
          proofText: '',
          nodeId: node.id,
          resultKind: node.kind,
          citations: node.citations ?? [],
          assetPaths: [],
          caption: '',
        },
        ...(node.proofText
          ? [
              {
                id: `export-proof-${index}`,
                kind: 'proof' as const,
                level: 4,
                title: '',
                content: '',
                proofText: node.proofText,
                nodeId: node.id,
                resultKind: node.kind,
                citations: node.citations ?? [],
                assetPaths: [],
                caption: '',
              },
            ]
          : []),
      ]);
  for (const block of blocks) {
    const workingValue = sourceBlockValue(block, patches);
    if (block.kind === 'section') {
      const command = block.level <= 1 ? 'section' : block.level === 2 ? 'subsection' : 'subsubsection';
      lines.push(`\\${command}{${sourceText(workingValue)}}`, '');
      continue;
    }
    if (block.kind === 'paragraph') {
      lines.push(sourceText(workingValue), '');
      continue;
    }
    if (block.kind === 'figure') {
      if (block.assetPaths.length) {
        lines.push(
          '\\begin{figure}[htbp]',
          '\\centering',
          ...block.assetPaths.map((asset) => `\\includegraphics[width=\\linewidth]{${asset}}`),
          ...(workingValue ? [`\\caption{${sourceText(workingValue)}}`] : []),
          '\\end{figure}',
          '',
        );
      }
      continue;
    }
    const node = byId.get(block.nodeId);
    if (!node) continue;
    if (block.kind === 'proof') {
      const proof = node.proofText || block.proofText;
      if (proof.trim()) lines.push('\\begin{proof}', sourceText(proof), '\\end{proof}', '');
      continue;
    }
    const environment = [
      'theorem',
      'lemma',
      'proposition',
      'corollary',
      'conjecture',
      'definition',
      'assumption',
      'remark',
      'example',
    ].includes(node.kind)
      ? node.kind
      : 'remark';
    lines.push(
      `\\begin{${environment}}${block.title ? `[${sourceText(block.title)}]` : ''}`,
      sourceText(node.statement || block.content),
      `\\end{${environment}}`,
      '',
    );
  }
  if (citationKeys.size) {
    lines.push('\\begin{thebibliography}{99}');
    for (const citation of citationKeys.values())
      lines.push(
        `\\bibitem{${citation.key}} ${sourceText([citation.authors, citation.title, citation.text].filter(Boolean).join('. '))}`,
      );
    lines.push('\\end{thebibliography}', '');
  }
  lines.push('\\end{document}', '');
  return lines.join('\n');
}
