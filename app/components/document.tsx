import {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  memo,
  startTransition,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { AIText, Latex, MathText } from './math';
import { makeId, reportReaderProcess } from '../lib/app';
import { bridgeUrl } from '../lib/bridge-client';
import {
  applyWorkingPatches,
  displayUnitLabel,
  paperSourceLabel,
  patchForNode,
  resolveSourceBlockIndex,
  sourceBlockAsNode,
} from '../lib/audit';
import {
  citationAlphaLabel,
  citationTitle,
  cleanBibliographicText,
  latexCompileError,
  parseSourceTable,
} from '../lib/tex-text';
import type {
  AuditNode,
  CitationReference,
  Note,
  Paper,
  PaperAudit,
  ReadingMark,
  SourceBlock,
  WorkingPatch,
} from '../lib/types';

function ReadingMarkSelect({
  value,
  onChange,
  openAssistant,
  auditNode,
}: {
  value: ReadingMark;
  onChange: (value: ReadingMark) => void;
  openAssistant?: () => void;
  auditNode?: AuditNode;
}) {
  const symbol = value === 'question' ? '?' : value === 'error' ? '×' : '';
  return (
    <div
      className={`reading-mark-control ${value ? `reading-mark-control-${value}` : ''}`}
      onClick={(event) => event.stopPropagation()}
    >
      <span className="reading-mark-status">
        {symbol ? (
          <button
            className="reading-mark-symbol"
            onClick={openAssistant}
            aria-label={`Open Assistant for this ${value === 'question' ? 'question' : 'possible error'}`}
          >
            {symbol}
          </button>
        ) : auditNode ? (
          <AuditPeek node={auditNode} open={() => openAssistant?.()} />
        ) : (
          <span className="reading-mark-symbol reading-mark-symbol-placeholder" aria-hidden="true" />
        )}
      </span>
      <select
        className={`reading-mark-select ${value ? `reading-mark-select-${value}` : ''}`}
        value={value}
        onChange={(event) => onChange(event.target.value as ReadingMark)}
        aria-label="Mark your understanding"
      >
        <option value="">Mark…</option>
        <option value="understood">Understood</option>
        <option value="question">Question</option>
        <option value="error">Possible error</option>
      </select>
    </div>
  );
}

function SourceBlockActions({
  unit,
  select,
  openAssistant,
}: {
  unit: AuditNode;
  select: () => void;
  openAssistant: (view?: 'ask' | 'notes' | 'compose-note') => void;
}) {
  return (
    <div className="source-block-actions" onClick={(event) => event.stopPropagation()}>
      <button
        onClick={() => {
          select();
          openAssistant('ask');
        }}
      >
        Ask AI
      </button>
      <button
        onClick={() => {
          select();
          openAssistant('compose-note');
        }}
      >
        Note
      </button>
      <span>{displayUnitLabel(unit)}</span>
    </div>
  );
}

type InteractiveDocumentProps = {
  paper: Paper;
  audit: PaperAudit;
  nodes: AuditNode[];
  notes: Note[];
  saveNote: (anchor: string, nodeId: string, text: string, latex: string) => void;
  updateNote: (noteId: string, text: string) => void;
  deleteNote: (noteId: string) => void;
  setSelectedNodeId: (id: string) => void;
  expanded: Record<string, boolean>;
  setExpanded: (id: string, value: boolean) => void;
  marks: Record<string, Exclude<ReadingMark, ''>>;
  setMark: (id: string, value: ReadingMark) => void;
  patches: WorkingPatch[];
  savePatches: (patches: WorkingPatch[]) => Promise<void>;
  openAssistant: (view?: 'ask' | 'notes' | 'compose-note') => void;
  openReference: (citation?: CitationReference) => void;
  expandCitation: (node: AuditNode, citation: CitationReference) => void;
  attachCitation: (citation: CitationReference, file: File) => Promise<string>;
  expandProofStep: (node: AuditNode, step: string, index: number) => Promise<string>;
  expandProofRequest: (node: AuditNode, request: string) => Promise<string>;
};

function InteractiveDocumentComponent({
  paper,
  audit,
  nodes,
  notes,
  saveNote,
  updateNote,
  deleteNote,
  setSelectedNodeId,
  expanded,
  setExpanded,
  marks,
  setMark,
  patches,
  savePatches,
  openAssistant,
  openReference,
  expandCitation,
  attachCitation,
  expandProofStep,
  expandProofRequest,
}: InteractiveDocumentProps) {
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const documentRootRef = useRef<HTMLElement>(null);
  const viewportSelectionRef = useRef('');
  const selectionLockRef = useRef<{ nodeId: string; until: number } | null>(null);
  async function saveInlineTex(node: AuditNode, field: 'statement' | 'proofText', value: string) {
    const currentPatch = patchForNode(patches, node.id);
    if (currentPatch?.kind === 'add') {
      await savePatches(
        patches.map((patch) =>
          patch.id === currentPatch.id
            ? { ...patch, [field]: value, source: 'manual' as const, createdAt: new Date().toISOString() }
            : patch,
        ),
      );
      return;
    }
    const sourceNode = audit.nodes.find((item) => item.id === node.id) ?? node;
    const replacement: WorkingPatch = {
      id: currentPatch?.kind === 'replace' ? currentPatch.id : makeId(),
      kind: 'replace',
      nodeId: sourceNode.id,
      title: node.title,
      statement: field === 'statement' ? value : node.statement,
      proofText: field === 'proofText' ? value : node.proofText,
      nodeKind: node.kind,
      afterNodeId: '',
      rationale: `Inline TeX edit to the ${field === 'statement' ? 'statement' : 'proof'}.`,
      dependencies: node.dependencies,
      proofSketch: node.proofSketch,
      source: 'manual',
      createdAt: new Date().toISOString(),
    };
    await savePatches([
      ...patches.filter((patch) => !(patch.kind === 'replace' && patch.nodeId === sourceNode.id)),
      replacement,
    ]);
  }
  async function saveSourceBlockTex(block: SourceBlock, value: string) {
    const unit = sourceBlockAsNode(block, patches);
    const currentPatch = patchForNode(patches, unit.id);
    const replacement: WorkingPatch = {
      id: currentPatch?.kind === 'replace' ? currentPatch.id : makeId(),
      kind: 'replace',
      nodeId: unit.id,
      title: unit.title,
      statement: value,
      proofText: '',
      nodeKind: unit.kind,
      afterNodeId: '',
      rationale: `Inline TeX edit to the original ${unit.kind}.`,
      dependencies: [],
      proofSketch: [],
      source: 'manual',
      createdAt: new Date().toISOString(),
    };
    await savePatches([
      ...patches.filter((patch) => !(patch.kind === 'replace' && patch.nodeId === unit.id)),
      replacement,
    ]);
  }
  async function revertPatch(patch: WorkingPatch) {
    await savePatches(patches.filter((item) => item.id !== patch.id));
  }
  const fallbackBlocks = nodes.flatMap((node, index): SourceBlock[] => [
    {
      id: `fallback-result-${index}`,
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
            id: `fallback-proof-${index}`,
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
  const sourceBlocks = audit.sourceBlocks?.length ? audit.sourceBlocks : fallbackBlocks;
  const sectionRanges = useMemo(
    () =>
      sourceBlocks
        .map((block, start) => {
          if (block.kind !== 'section') return null;
          let end = sourceBlocks.length;
          for (let index = start + 1; index < sourceBlocks.length; index += 1) {
            const candidate = sourceBlocks[index];
            if (candidate.kind === 'section' && candidate.level <= block.level) {
              end = index;
              break;
            }
          }
          return { id: block.id, start, end };
        })
        .filter(Boolean) as { id: string; start: number; end: number }[],
    [sourceBlocks],
  );
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const focused = nodes.length < applyWorkingPatches(audit.nodes, patches).length;
  const focusedSourceBlockIndexes = new Set(
    focused
      ? nodes.map((item) => resolveSourceBlockIndex(item.id, item, sourceBlocks, patches)).filter((index) => index >= 0)
      : [],
  );
  const sourceNodeIds = new Set(sourceBlocks.map((block) => block.nodeId).filter(Boolean));
  const additions = nodes.filter((node) => node.id.startsWith('working-') && !sourceNodeIds.has(node.id));
  const visibleAbstract = /^Reader-supplied local source\b/i.test(paper.abstract.trim()) ? '' : paper.abstract.trim();
  useEffect(() => {
    const root = documentRootRef.current;
    if (!root) return;
    const select = (next: string) => {
      const lock = selectionLockRef.current;
      if (lock && Date.now() < lock.until && next !== lock.nodeId) return;
      if (lock && Date.now() >= lock.until) selectionLockRef.current = null;
      if (!next || next === viewportSelectionRef.current) return;
      viewportSelectionRef.current = next;
      startTransition(() => setSelectedNodeId(next));
    };
    const observed = Array.from(root.querySelectorAll<HTMLElement>('[data-node-id]'));
    if (typeof IntersectionObserver === 'undefined') {
      let frame = 0;
      const update = () => {
        frame = 0;
        const reader = root.closest<HTMLElement>('.reader-document');
        const x = reader
          ? reader.getBoundingClientRect().left + reader.getBoundingClientRect().width / 2
          : window.innerWidth / 2;
        const target = document.elementFromPoint(x, window.innerHeight / 2)?.closest<HTMLElement>('[data-node-id]');
        if (target && root.contains(target)) select(target.dataset.nodeId || '');
      };
      const schedule = () => {
        if (!frame) frame = window.requestAnimationFrame(update);
      };
      document.addEventListener('scroll', schedule, true);
      window.addEventListener('resize', schedule);
      schedule();
      return () => {
        document.removeEventListener('scroll', schedule, true);
        window.removeEventListener('resize', schedule);
        if (frame) window.cancelAnimationFrame(frame);
      };
    }
    const active = new Set<HTMLElement>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const element = entry.target as HTMLElement;
          if (entry.isIntersecting) active.add(element);
          else active.delete(element);
        }
        const center = window.innerHeight / 2;
        let nearest: HTMLElement | null = null;
        let distance = Number.POSITIVE_INFINITY;
        for (const element of active) {
          const rect = element.getBoundingClientRect();
          const nextDistance = Math.abs((rect.top + rect.bottom) / 2 - center);
          if (nextDistance < distance) {
            nearest = element;
            distance = nextDistance;
          }
        }
        select(nearest?.dataset.nodeId || '');
      },
      { root: null, rootMargin: '-45% 0px -45% 0px', threshold: 0 },
    );
    for (const element of observed) observer.observe(element);
    return () => observer.disconnect();
  }, [collapsedSections, nodes, setSelectedNodeId]);
  useEffect(() => {
    const jump = (event: Event) => {
      const requestedId = (event as CustomEvent<string>).detail;
      const requestedNode =
        nodes.find((item) => item.id === requestedId) ?? audit.nodes.find((item) => item.id === requestedId);
      const targetIndex = resolveSourceBlockIndex(requestedId, requestedNode, sourceBlocks, patches);
      if (targetIndex < 0) return;
      const targetBlock = sourceBlocks[targetIndex];
      const targetId = targetBlock.nodeId || sourceBlockAsNode(targetBlock, patches).id;
      viewportSelectionRef.current = targetId;
      selectionLockRef.current = { nodeId: targetId, until: Date.now() + 1400 };
      const parents = sectionRanges
        .filter((range) => targetIndex > range.start && targetIndex < range.end)
        .map((range) => range.id);
      if (parents.length)
        setCollapsedSections((current) => {
          const next = { ...current };
          for (const id of parents) delete next[id];
          return next;
        });
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          setSelectedNodeId(targetId);
          document
            .querySelector<HTMLElement>(`.reader-document [data-node-id="${CSS.escape(targetId)}"]`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }),
      );
    };
    window.addEventListener('proofroom:jump-unit', jump);
    return () => window.removeEventListener('proofroom:jump-unit', jump);
  }, [audit.nodes, nodes, patches, sectionRanges, setSelectedNodeId, sourceBlocks]);
  return (
    <article ref={documentRootRef} className="interactive-document source-document">
      <header className="interactive-lead">
        <h1>
          <MathText value={paper.title} />
        </h1>
        <div className="paper-metadata">
          <p className="paper-authors">
            <MathText value={paper.authors} />
          </p>
          <p className="paper-identity">
            {paperSourceLabel(paper)}
            {paper.arxivId.startsWith('local-') ? '' : ` · ${paper.category}`}
          </p>
        </div>
        {visibleAbstract && (
          <section className="paper-abstract">
            <b>Abstract</b>
            <MathText value={visibleAbstract} block />
          </section>
        )}
      </header>
      <div className="original-source-flow">
        {sourceBlocks.map((block, blockIndex) => {
          if (
            sectionRanges.some(
              (range) => collapsedSections[range.id] && blockIndex > range.start && blockIndex < range.end,
            )
          )
            return null;
          if (
            focused &&
            !focusedSourceBlockIndexes.has(blockIndex) &&
            (block.kind === 'paragraph' ||
              block.kind === 'figure' ||
              block.kind === 'table' ||
              block.kind === 'bibliography' ||
              ((block.kind === 'result' || block.kind === 'proof') && !visibleNodeIds.has(block.nodeId)))
          )
            return null;
          if (block.kind === 'section') {
            const Heading = block.level <= 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4';
            const collapsed = Boolean(collapsedSections[block.id]);
            const unit = sourceBlockAsNode(block, patches);
            const attachedNotes = notes.filter((item) => item.nodeId === unit.id);
            const patch = patchForNode(patches, unit.id);
            return (
              <section
                key={block.id}
                data-node-id={unit.id}
                className="source-section-unit"
                onClick={() => setSelectedNodeId(unit.id)}
              >
                <UnitStatusRail
                  noteCount={attachedNotes.length}
                  openNote={() => {
                    setSelectedNodeId(unit.id);
                    openAssistant('compose-note');
                  }}
                  patch={patch}
                  originalValue={block.title}
                  currentValue={unit.statement}
                  citations={block.citations}
                  revert={() => (patch ? revertPatch(patch) : Promise.resolve())}
                />
                <Heading
                  className={`source-section-heading source-section-level-${block.level} ${collapsed ? 'source-section-collapsed' : ''}`}
                >
                  <EditableTexBlock
                    label="Section title TeX"
                    value={unit.statement}
                    originalValue={block.title}
                    changeRationale={patch?.rationale}
                    citations={block.citations}
                    emptyText="Untitled section"
                    onSave={(value) => saveSourceBlockTex(block, value)}
                  />
                  <button
                    className="source-section-toggle"
                    onClick={(event) => {
                      event.stopPropagation();
                      setCollapsedSections((current) => ({ ...current, [block.id]: !current[block.id] }));
                    }}
                    aria-expanded={!collapsed}
                    title={collapsed ? 'Expand section' : 'Collapse section'}
                  >
                    <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
                    <small>{collapsed ? 'Expand' : 'Collapse'}</small>
                  </button>
                </Heading>
                <SourceBlockActions
                  unit={unit}
                  select={() => setSelectedNodeId(unit.id)}
                  openAssistant={openAssistant}
                />
              </section>
            );
          }
          if (block.kind === 'paragraph') {
            const unit = sourceBlockAsNode(block, patches);
            const attachedNotes = notes.filter((item) => item.nodeId === unit.id);
            const patch = patchForNode(patches, unit.id);
            return (
              <section
                key={block.id}
                data-node-id={unit.id}
                className="source-paragraph source-prose-unit"
                onClick={() => setSelectedNodeId(unit.id)}
              >
                <UnitStatusRail
                  noteCount={attachedNotes.length}
                  openNote={() => {
                    setSelectedNodeId(unit.id);
                    openAssistant('compose-note');
                  }}
                  patch={patch}
                  originalValue={block.content}
                  currentValue={unit.statement}
                  citations={block.citations}
                  revert={() => (patch ? revertPatch(patch) : Promise.resolve())}
                />
                <EditableTexBlock
                  label="Paragraph TeX"
                  value={unit.statement}
                  originalValue={block.content}
                  changeRationale={patch?.rationale}
                  citations={block.citations}
                  emptyText="Empty paragraph"
                  onSave={(value) => saveSourceBlockTex(block, value)}
                />
                <SourceBlockActions
                  unit={unit}
                  select={() => setSelectedNodeId(unit.id)}
                  openAssistant={openAssistant}
                />
              </section>
            );
          }
          if (block.kind === 'table') {
            const unit = sourceBlockAsNode(block, patches);
            const attachedNotes = notes.filter((item) => item.nodeId === unit.id);
            const patch = patchForNode(patches, unit.id);
            return (
              <section
                key={block.id}
                data-node-id={unit.id}
                className="source-table-unit"
                onClick={() => setSelectedNodeId(unit.id)}
              >
                <UnitStatusRail
                  noteCount={attachedNotes.length}
                  openNote={() => {
                    setSelectedNodeId(unit.id);
                    openAssistant('compose-note');
                  }}
                  patch={patch}
                  originalValue={block.content}
                  currentValue={unit.statement}
                  citations={block.citations}
                  revert={() => (patch ? revertPatch(patch) : Promise.resolve())}
                />
                <EditableSourceTable
                  value={unit.statement}
                  caption={block.caption}
                  citations={block.citations}
                  onSave={(value) => saveSourceBlockTex(block, value)}
                />
                <SourceBlockActions
                  unit={unit}
                  select={() => setSelectedNodeId(unit.id)}
                  openAssistant={openAssistant}
                />
              </section>
            );
          }
          if (block.kind === 'figure') {
            const unit = sourceBlockAsNode(block, patches);
            const attachedNotes = notes.filter((item) => item.nodeId === unit.id);
            const patch = patchForNode(patches, unit.id);
            return (
              <section
                key={block.id}
                data-node-id={unit.id}
                className="source-figure-unit"
                onClick={() => setSelectedNodeId(unit.id)}
              >
                <UnitStatusRail
                  noteCount={attachedNotes.length}
                  openNote={() => {
                    setSelectedNodeId(unit.id);
                    openAssistant('compose-note');
                  }}
                  patch={patch}
                  originalValue={block.caption}
                  currentValue={unit.statement}
                  citations={block.citations}
                  revert={() => (patch ? revertPatch(patch) : Promise.resolve())}
                />
                <SourceFigure paperId={paper.id} assetPaths={block.assetPaths} caption="" />
                {(unit.statement || block.caption) && (
                  <div className="source-figure-editable-caption">
                    <EditableTexBlock
                      label="Figure caption TeX"
                      value={unit.statement}
                      originalValue={block.caption}
                      changeRationale={patch?.rationale}
                      citations={block.citations}
                      emptyText="No figure caption"
                      onSave={(value) => saveSourceBlockTex(block, value)}
                    />
                  </div>
                )}
                <SourceBlockActions
                  unit={unit}
                  select={() => setSelectedNodeId(unit.id)}
                  openAssistant={openAssistant}
                />
              </section>
            );
          }
          if (block.kind === 'bibliography') {
            const unit = sourceBlockAsNode(block, patches);
            return (
              <section
                key={block.id}
                data-node-id={unit.id}
                className="source-bibliography-entry"
                onClick={() => setSelectedNodeId(unit.id)}
              >
                <span className="source-bibliography-key">[{block.title}]</span>
                <MathText value={unit.statement} block />
              </section>
            );
          }
          const node =
            nodes.find((item) => item.id === block.nodeId) ??
            applyWorkingPatches(audit.nodes, patches).find((item) => item.id === block.nodeId);
          if (!node) {
            const unit = sourceBlockAsNode({ ...block, kind: 'paragraph' }, patches);
            const attachedNotes = notes.filter((item) => item.nodeId === unit.id);
            const patch = patchForNode(patches, unit.id);
            return block.content ? (
              <section
                key={block.id}
                data-node-id={unit.id}
                className="source-paragraph source-prose-unit"
                onClick={() => setSelectedNodeId(unit.id)}
              >
                <UnitStatusRail
                  noteCount={attachedNotes.length}
                  openNote={() => {
                    setSelectedNodeId(unit.id);
                    openAssistant('compose-note');
                  }}
                  patch={patch}
                  originalValue={block.content}
                  currentValue={unit.statement}
                  citations={block.citations}
                  revert={() => (patch ? revertPatch(patch) : Promise.resolve())}
                />
                <EditableTexBlock
                  label="Text TeX"
                  value={unit.statement}
                  originalValue={block.content}
                  changeRationale={patch?.rationale}
                  citations={block.citations}
                  emptyText="Empty text block"
                  onSave={(value) => saveSourceBlockTex({ ...block, kind: 'paragraph' }, value)}
                />
                <SourceBlockActions
                  unit={unit}
                  select={() => setSelectedNodeId(unit.id)}
                  openAssistant={openAssistant}
                />
              </section>
            ) : null;
          }
          const isOpen = expanded[node.id] !== false;
          const patch = patchForNode(patches, node.id);
          const sourceNode = audit.nodes.find((item) => item.id === node.id);
          const citations = node.citations ?? block.citations ?? [];
          const attachedNotes = notes.filter((item) => item.nodeId === node.id);
          const readingMark = marks[block.id] ?? '';
          if (block.kind === 'proof') {
            const proofValue = node.proofText || block.proofText;
            const originalProof = sourceNode?.proofText ?? block.proofText;
            const statusRail = (
              <UnitStatusRail
                noteCount={attachedNotes.length}
                openNote={() => {
                  setSelectedNodeId(node.id);
                  openAssistant('compose-note');
                }}
                patch={patch}
                originalValue={originalProof}
                currentValue={proofValue}
                citations={citations}
                revert={() => (patch ? revertPatch(patch) : Promise.resolve())}
              />
            );
            return isOpen ? (
              <section
                key={block.id}
                data-node-id={node.id}
                className={`source-proof ${readingMark ? `reading-mark-${readingMark}` : ''}`}
                onClick={() => setSelectedNodeId(node.id)}
              >
                {statusRail}
                <div className="source-proof-label">
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpanded(node.id, false);
                    }}
                    title="Collapse proof"
                  >
                    Proof. <span aria-hidden="true">▾</span>
                  </button>
                  <button
                    className="source-proof-note"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedNodeId(node.id);
                      openAssistant('compose-note');
                    }}
                  >
                    Note
                  </button>
                  <ReadingMarkSelect
                    value={readingMark}
                    onChange={(value) => setMark(block.id, value)}
                    openAssistant={() => {
                      setSelectedNodeId(node.id);
                      openAssistant('ask');
                    }}
                    auditNode={node}
                  />
                </div>
                <EditableTexBlock
                  label="Proof TeX"
                  value={proofValue}
                  originalValue={originalProof}
                  changeRationale={patch?.rationale}
                  citations={citations}
                  emptyText="The source contains no attached proof text."
                  numbered
                  onSave={(value) => saveInlineTex(node, 'proofText', value)}
                />
                <ProofReadingTools node={node} citations={citations} expand={expandProofRequest} />
                {block.assetPaths.length > 0 && (
                  <SourceFigure paperId={paper.id} assetPaths={block.assetPaths} caption={block.caption} />
                )}
                {citations.length > 0 && (
                  <CitationSources
                    citations={citations}
                    onExpand={(citation) => expandCitation(node, citation)}
                    onOpen={openReference}
                    onAttach={attachCitation}
                  />
                )}
                <ProofMap
                  node={node}
                  citations={citations}
                  openNode={setSelectedNodeId}
                  nodes={nodes}
                  expandStep={expandProofStep}
                />
              </section>
            ) : (
              <section
                key={block.id}
                data-node-id={node.id}
                className={`source-proof source-proof-collapsed ${readingMark ? `reading-mark-${readingMark}` : ''}`}
              >
                {statusRail}
                <div className="source-proof-label">
                  <button
                    onClick={() => {
                      setSelectedNodeId(node.id);
                      setExpanded(node.id, true);
                    }}
                    title="Expand complete proof"
                  >
                    Proof. <span aria-hidden="true">▸</span>
                    <small>Show complete proof</small>
                  </button>
                  <button
                    className="source-proof-note"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedNodeId(node.id);
                      openAssistant('compose-note');
                    }}
                  >
                    Note
                  </button>
                  <ReadingMarkSelect
                    value={readingMark}
                    onChange={(value) => setMark(block.id, value)}
                    openAssistant={() => {
                      setSelectedNodeId(node.id);
                      openAssistant('ask');
                    }}
                    auditNode={node}
                  />
                </div>
              </section>
            );
          }
          return (
            <section
              key={block.id}
              data-node-id={node.id}
              onClick={() => setSelectedNodeId(node.id)}
              className={`source-result paper-kind-${node.kind} ${readingMark ? `reading-mark-${readingMark}` : ''}`}
            >
              <UnitStatusRail
                noteCount={attachedNotes.length}
                openNote={() => {
                  setSelectedNodeId(node.id);
                  openAssistant('compose-note');
                }}
                patch={patch}
                originalValue={sourceNode?.statement ?? block.content}
                currentValue={node.statement || block.content}
                citations={citations}
                revert={() => (patch ? revertPatch(patch) : Promise.resolve())}
              />
              <header>
                <b>{displayUnitLabel(node)}.</b>
                {block.title && (
                  <span>
                    (<MathText value={block.title} />)
                  </span>
                )}
                <ReadingMarkSelect
                  value={readingMark}
                  onChange={(value) => setMark(block.id, value)}
                  openAssistant={() => {
                    setSelectedNodeId(node.id);
                    openAssistant('ask');
                  }}
                  auditNode={node}
                />
              </header>
              <EditableTexBlock
                label="Statement TeX"
                value={node.statement || block.content}
                originalValue={sourceNode?.statement ?? block.content}
                changeRationale={patch?.rationale}
                citations={citations}
                emptyText="No standalone statement was extracted for this unit."
                onSave={(value) => saveInlineTex(node, 'statement', value)}
              />
              {block.assetPaths.length > 0 && (
                <SourceFigure paperId={paper.id} assetPaths={block.assetPaths} caption={block.caption} />
              )}
              <footer>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedNodeId(node.id);
                    openAssistant('ask');
                  }}
                >
                  Ask AI
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedNodeId(node.id);
                    openAssistant('compose-note');
                  }}
                >
                  Note
                </button>
                {!node.proofText && node.kind !== 'definition' ? (
                  <span className="source-no-proof">No attached proof</span>
                ) : null}
              </footer>
              {node.dependencies.length > 0 && (
                <details className="source-dependencies">
                  <summary>Logical dependencies</summary>
                  <div>
                    {node.dependencies.map((dependency) => (
                      <UnitPreviewButton
                        key={dependency}
                        target={nodes.find((item) => item.id === dependency)}
                        fallback="Referenced prerequisite"
                        openNode={setSelectedNodeId}
                      />
                    ))}
                  </div>
                </details>
              )}
              {!node.proofText && citations.length > 0 && (
                <CitationSources
                  citations={citations}
                  onExpand={(citation) => expandCitation(node, citation)}
                  onOpen={openReference}
                  onAttach={attachCitation}
                />
              )}
            </section>
          );
        })}
        {additions.length > 0 && (
          <section className="working-additions">
            <h2>Reader additions</h2>
            {additions.map((node) => (
              <section key={node.id} className="source-result">
                <header>
                  <b>{displayUnitLabel(node)}.</b>
                </header>
                <EditableTexBlock
                  label="Statement TeX"
                  value={node.statement}
                  originalValue=""
                  changeRationale={patchForNode(patches, node.id)?.rationale}
                  citations={node.citations ?? []}
                  emptyText="No statement."
                  onSave={(value) => saveInlineTex(node, 'statement', value)}
                />
              </section>
            ))}
          </section>
        )}
        <WholePaperNotes
          notes={notes.filter((note) => note.nodeId === '__paper__')}
          save={(text) => saveNote('Whole paper', '__paper__', text, '')}
          update={updateNote}
          remove={deleteNote}
        />
      </div>
    </article>
  );
}

const MemoizedInteractiveDocument = memo(
  InteractiveDocumentComponent,
  (previous, next) =>
    previous.paper === next.paper &&
    previous.audit === next.audit &&
    previous.nodes === next.nodes &&
    previous.notes === next.notes &&
    previous.expanded === next.expanded &&
    previous.marks === next.marks &&
    previous.patches === next.patches,
);

// The memoized document ignores callback identity so typing or scrolling does not
// re-render the whole paper. Give it stable callbacks that always call the latest
// props; otherwise its actions kept using the model, reasoning effort, and thread
// captured when the document last rendered.
export function InteractiveDocument(props: InteractiveDocumentProps) {
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const callbacks = useMemo(
    () => ({
      saveNote: (...args: Parameters<InteractiveDocumentProps['saveNote']>) => latest.current.saveNote(...args),
      updateNote: (...args: Parameters<InteractiveDocumentProps['updateNote']>) => latest.current.updateNote(...args),
      deleteNote: (...args: Parameters<InteractiveDocumentProps['deleteNote']>) => latest.current.deleteNote(...args),
      setSelectedNodeId: (...args: Parameters<InteractiveDocumentProps['setSelectedNodeId']>) =>
        latest.current.setSelectedNodeId(...args),
      setExpanded: (...args: Parameters<InteractiveDocumentProps['setExpanded']>) =>
        latest.current.setExpanded(...args),
      setMark: (...args: Parameters<InteractiveDocumentProps['setMark']>) => latest.current.setMark(...args),
      savePatches: (...args: Parameters<InteractiveDocumentProps['savePatches']>) =>
        latest.current.savePatches(...args),
      openAssistant: (...args: Parameters<InteractiveDocumentProps['openAssistant']>) =>
        latest.current.openAssistant(...args),
      openReference: (...args: Parameters<InteractiveDocumentProps['openReference']>) =>
        latest.current.openReference(...args),
      expandCitation: (...args: Parameters<InteractiveDocumentProps['expandCitation']>) =>
        latest.current.expandCitation(...args),
      attachCitation: (...args: Parameters<InteractiveDocumentProps['attachCitation']>) =>
        latest.current.attachCitation(...args),
      expandProofStep: (...args: Parameters<InteractiveDocumentProps['expandProofStep']>) =>
        latest.current.expandProofStep(...args),
      expandProofRequest: (...args: Parameters<InteractiveDocumentProps['expandProofRequest']>) =>
        latest.current.expandProofRequest(...args),
    }),
    [],
  );
  return <MemoizedInteractiveDocument {...props} {...callbacks} />;
}

export function EditableSavedNote({
  note,
  update,
  remove,
  autoEdit = false,
}: {
  note: Note;
  update: (noteId: string, text: string) => void;
  remove: (noteId: string) => void;
  autoEdit?: boolean;
}) {
  const [editing, setEditing] = useState(autoEdit);
  const [draft, setDraft] = useState(note.text);
  function save() {
    if (!draft.trim()) return;
    update(note.id, draft);
    setEditing(false);
  }
  if (!editing)
    return (
      <article className="editable-saved-note">
        <button
          onClick={() => {
            setDraft(note.text);
            setEditing(true);
          }}
          title="Click to edit note"
        >
          <MathText value={note.text} block />
          {note.latex && <Latex value={note.latex} small />}
          <small>Click to edit</small>
        </button>
      </article>
    );
  return (
    <article className="editable-saved-note editing">
      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus />
      {draft.trim() && (
        <div className="saved-note-preview">
          <MathText value={draft} block />
        </div>
      )}
      <footer>
        <button className="note-delete" onClick={() => remove(note.id)}>
          Delete
        </button>
        <button
          onClick={() => {
            setDraft(note.text);
            setEditing(false);
          }}
        >
          Cancel
        </button>
        <button onClick={save} disabled={!draft.trim()}>
          Save
        </button>
      </footer>
    </article>
  );
}

function WholePaperNotes({
  notes,
  save,
  update,
  remove,
}: {
  notes: Note[];
  save: (text: string) => void;
  update: (noteId: string, text: string) => void;
  remove: (noteId: string) => void;
}) {
  const [text, setText] = useState('');
  function submit() {
    if (!text.trim()) return;
    save(text.trim());
    setText('');
  }
  return (
    <section className="whole-paper-notes">
      <header>
        <div>
          <b>Paper notes</b>
          <span>Add as many whole-paper notes as you need.</span>
        </div>
        {notes.length > 0 && <small>{notes.length} saved</small>}
      </header>
      {notes.length > 0 && (
        <div className="whole-paper-note-list">
          {notes.map((note) => (
            <EditableSavedNote key={note.id} note={note} update={update} remove={remove} />
          ))}
        </div>
      )}
      <div className="whole-paper-note-box">
        <textarea
          aria-label="Paper note"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Write in plain text and LaTeX, for example: The key estimate is $\lVert T f\rVert_2 \leq C\lVert f\rVert_2$."
        />
        {text.trim() && (
          <div className="whole-paper-note-preview" aria-label="Typeset note preview">
            <MathText value={text} block />
          </div>
        )}
        <button onClick={submit} disabled={!text.trim()}>
          Add paper note
        </button>
      </div>
    </section>
  );
}

function SourceFigure({ paperId, assetPaths, caption }: { paperId: string; assetPaths: string[]; caption: string }) {
  return (
    <figure className="source-figure">
      <div>
        {assetPaths.map((asset, index) => (
          <FigureAsset
            key={`${asset}:${index}`}
            paperId={paperId}
            asset={asset}
            alt={caption || `Figure ${index + 1}`}
          />
        ))}
      </div>
      {caption && (
        <figcaption>
          <MathText value={caption} block />
        </figcaption>
      )}
    </figure>
  );
}

function SourceTable({
  value,
  caption,
  citations,
}: {
  value: string;
  caption: string;
  citations: CitationReference[];
}) {
  const parsed = useMemo(() => parseSourceTable(value), [value]);
  if (!parsed.rows.length) return <pre className="source-table-fallback">{value}</pre>;
  return (
    <div className="source-table-scroll">
      <table>
        <tbody>
          {parsed.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => {
                const Cell = rowIndex === 0 ? 'th' : 'td';
                return (
                  <Cell
                    key={cellIndex}
                    colSpan={cell.colSpan}
                    style={{ textAlign: parsed.alignments[cellIndex] || 'left' }}
                  >
                    {cell.literal ? (
                      <pre className="source-table-code">{cell.value}</pre>
                    ) : (
                      <MathText value={cell.value} citations={citations} />
                    )}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {caption && (
        <p className="source-table-caption">
          <MathText value={caption} citations={citations} />
        </p>
      )}
    </div>
  );
}

function EditableSourceTable({
  value,
  caption,
  citations,
  onSave,
}: {
  value: string;
  caption: string;
  citations: CitationReference[];
  onSave: (value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save(event: ReactMouseEvent) {
    event.stopPropagation();
    if (!parseSourceTable(draft).rows.length) {
      setError('This TeX does not contain a readable tabular environment.');
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this table.');
    } finally {
      setSaving(false);
    }
  }
  if (!editing)
    return (
      <div
        className="source-table-rendered"
        role="button"
        tabIndex={0}
        title="Click to edit table TeX"
        onClick={(event) => {
          event.stopPropagation();
          if (document.body.dataset.readerMarkupActive !== 'true') {
            setDraft(value);
            setError('');
            setEditing(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setDraft(value);
            setError('');
            setEditing(true);
          }
        }}
      >
        <span className="tex-edit-hint">Click to edit</span>
        <SourceTable value={value} caption={caption} citations={citations} />
      </div>
    );
  return (
    <div className="editable-tex-source source-table-editor" onClick={(event) => event.stopPropagation()}>
      <header>
        <b>Table TeX</b>
      </header>
      <textarea
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setError('');
        }}
        spellCheck={false}
        autoFocus
      />
      {error && <p className="tex-compile-error">{error}</p>}
      <div className="tex-source-preview">
        <span>Live preview</span>
        <SourceTable value={draft} caption={caption} citations={citations} />
      </div>
      <footer>
        <button
          onClick={(event) => {
            event.stopPropagation();
            setEditing(false);
            setError('');
          }}
        >
          Cancel
        </button>
        <button onClick={(event) => void save(event)} disabled={saving}>
          {saving ? 'Saving…' : 'Save to working edition'}
        </button>
      </footer>
    </div>
  );
}

function FigureAsset({ paperId, asset, alt }: { paperId: string; asset: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const url = `${bridgeUrl}/asset?paperId=${encodeURIComponent(paperId)}&file=${encodeURIComponent(asset)}`;
  return failed ? (
    <div className="source-figure-missing">
      <b>Figure asset unavailable</b>
      <span>{asset}</span>
    </div>
  ) : (
    <a href={url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
      {/* Original paper assets are served dynamically by the local bridge, so the framework image
          optimizer cannot know their dimensions or paths in advance. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} />
    </a>
  );
}

function proofCoordinateScale(content: HTMLElement) {
  const reader = content.closest<HTMLElement>('.reader-document');
  return reader ? Number(window.getComputedStyle(reader).zoom) || 1 : 1;
}

function visibleProofSourceLines(nodeId: string) {
  if (typeof document === 'undefined') return [];
  const proof = document.querySelector<HTMLElement>(
    `.source-proof[data-node-id="${CSS.escape(nodeId)}"]:not(.source-proof-collapsed)`,
  );
  const content = proof?.querySelector<HTMLElement>('.proof-line-content');
  const root = content?.querySelector<HTMLElement>(':scope > .math-text');
  if (!proof || !content || !root) return [];
  const lineTops = Array.from(proof.querySelectorAll<HTMLElement>('.proof-line-gutter > span'))
    .map((label) => Number(label.style.top.replace('px', '')))
    .filter(Number.isFinite);
  if (!lineTops.length) return [];
  const lines = lineTops.map(() => '');
  const origin = content.getBoundingClientRect().top;
  const scale = proofCoordinateScale(content);
  const style = window.getComputedStyle(root);
  const fontSize = Number(style.fontSize.replace('px', '')) || 16;
  const lineHeight = Number(style.lineHeight.replace('px', '')) || fontSize * 1.7;
  const nearestLine = (top: number) =>
    lineTops.reduce(
      (best, candidate, index) => (Math.abs(candidate - top) < Math.abs(lineTops[best] - top) ? index : best),
      0,
    );
  const append = (line: number, source: string) => {
    if (source) lines[line] += source;
  };

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

export function indexedVisibleProof(nodeId: string) {
  return visibleProofSourceLines(nodeId)
    .map((line, index) => `L${index + 1}: ${line}`)
    .join('\n');
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

// contentKey identifies the text being numbered. The children element is new on every
// parent render, so depending on it rebuilt every proof's observers and re-measured.
function VisualLineNumbers({ children, contentKey }: { children: ReactNode; contentKey: string }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [lineTops, setLineTops] = useState<number[]>([]);
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let frame = 0;
    let active = false;
    let measured = false;
    let resizeObserver: ResizeObserver | null = null;
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
      const proseTolerance = Math.max(3, fontSize * 0.3);

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
      for (const rect of displayRects)
        tops.push((rect.top - origin) / scale + Math.max(0, (rect.height / scale - lineHeight) / 2));

      tops.sort((left, right) => left - right);
      const mergeTolerance = Math.max(5, fontSize * 0.45);
      const merged = tops.filter((top, index) => index === 0 || Math.abs(top - tops[index - 1]) >= mergeTolerance);
      measured = merged.length > 0;
      setLineTops(merged.map((top) => Math.round(top * 2) / 2));
    };
    const schedule = () => {
      if (!active) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    const activate = () => {
      if (active) return;
      active = true;
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(content);
      schedule();
    };
    const deactivate = () => {
      active = false;
      resizeObserver?.disconnect();
      resizeObserver = null;
      window.cancelAnimationFrame(frame);
      frame = 0;
    };
    const visibilityTarget = content.closest<HTMLElement>('.source-proof') ?? content;
    const visibilityObserver =
      'IntersectionObserver' in window
        ? new IntersectionObserver(
            ([entry]) => {
              if (entry.isIntersecting) activate();
              else deactivate();
            },
            { root: null, rootMargin: '900px 0px', threshold: 0 },
          )
        : null;
    const checkVisibility = () => {
      const rect = visibilityTarget.getBoundingClientRect();
      if (rect.bottom >= -900 && rect.top <= window.innerHeight + 900) {
        activate();
        if (!measured) schedule();
      } else deactivate();
    };
    checkVisibility();
    const unwatchViewport = watchProofViewport(checkVisibility);
    visibilityTarget.addEventListener('focusin', checkVisibility);
    if (visibilityObserver) visibilityObserver.observe(visibilityTarget);
    else activate();
    // A nearby content-visibility container may still be skipped when the
    // intersection callback first fires. Measure again once it is painted.
    visibilityTarget.addEventListener('contentvisibilityautostatechange', schedule);
    document.fonts.addEventListener('loadingdone', schedule);
    window.addEventListener('resize', schedule);
    return () => {
      visibilityObserver?.disconnect();
      unwatchViewport();
      deactivate();
      visibilityTarget.removeEventListener('focusin', checkVisibility);
      visibilityTarget.removeEventListener('contentvisibilityautostatechange', schedule);
      document.fonts.removeEventListener('loadingdone', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [contentKey]);
  return (
    <div className="proof-numbered-text">
      <div className="proof-line-gutter" aria-hidden="true">
        {lineTops.map((top, index) => (
          <span key={`${index}:${top}`} style={{ top }}>{`L${index + 1}`}</span>
        ))}
      </div>
      <div className="proof-line-content" ref={contentRef}>
        {children}
      </div>
    </div>
  );
}

function EditableTexBlock({
  label,
  value,
  originalValue,
  changeRationale,
  citations,
  emptyText,
  numbered = false,
  onSave,
}: {
  label: string;
  value: string;
  originalValue?: string;
  changeRationale?: string;
  citations: CitationReference[];
  emptyText: string;
  numbered?: boolean;
  onSave: (value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  function begin(event: ReactMouseEvent | ReactKeyboardEvent) {
    event.stopPropagation();
    if (document.body.dataset.readerMarkupActive === 'true') return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    setDraft(value);
    setError('');
    setEditing(true);
  }
  async function save(event: ReactMouseEvent) {
    event.stopPropagation();
    const compileError = latexCompileError(draft);
    if (compileError) {
      setError(compileError);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this TeX edit.');
    } finally {
      setSaving(false);
    }
  }
  const changed = typeof originalValue === 'string' && originalValue !== value;
  if (!editing)
    return (
      <div
        className={`editable-tex-rendered ${changed ? 'tex-modified' : ''}`}
        role="button"
        tabIndex={0}
        title={`Click to edit ${label}`}
        onClick={begin}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') begin(event);
        }}
      >
        <span className="tex-edit-hint">Click to edit</span>
        {value ? (
          numbered ? (
            <VisualLineNumbers contentKey={value}>
              <MathText value={value} block citations={citations} />
            </VisualLineNumbers>
          ) : (
            <MathText value={value} block citations={citations} />
          )
        ) : (
          <p>{emptyText}</p>
        )}
        {changed && (
          <aside className="tex-original-popover" role="tooltip">
            <b>Original text</b>
            <MathText value={originalValue || 'This content was added by the reader.'} block citations={citations} />
            {changeRationale && <small>{changeRationale}</small>}
          </aside>
        )}
      </div>
    );
  return (
    <div className="editable-tex-source" onClick={(event) => event.stopPropagation()}>
      <header>
        <b>{label}</b>
        <span>Expanded, portable LaTeX · original source preserved</span>
      </header>
      <textarea
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setError('');
        }}
        spellCheck={false}
        autoFocus
      />
      {error && <p className="tex-compile-error">Formula error: {error}</p>}
      <div className="tex-source-preview">
        <span>Live preview</span>
        {draft ? <MathText value={draft} block citations={citations} /> : <p>{emptyText}</p>}
      </div>
      <footer>
        <button
          onClick={(event) => {
            event.stopPropagation();
            setEditing(false);
            setError('');
          }}
        >
          Cancel
        </button>
        <button onClick={(event) => void save(event)} disabled={saving}>
          {saving ? 'Saving…' : 'Save to working edition'}
        </button>
      </footer>
    </div>
  );
}

function AuditPeek({ node, open }: { node: AuditNode; open: () => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipId = useId();
  const [preview, setPreview] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const statusLabel =
    node.status === 'verified' ? 'Checked' : node.status === 'needs-verification' ? 'Needs review' : 'Not verified';
  function keepOpen() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setPreview(true);
  }
  function hideSoon() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setPreview(false), 220);
  }
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  useLayoutEffect(() => {
    if (!preview) return;
    const place = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      const card = cardRef.current;
      if (!anchor || !card) return;
      const edge = 12;
      const gap = 8;
      const width = Math.min(390, window.innerWidth - edge * 2);
      const maxHeight = Math.min(480, window.innerHeight - edge * 2);
      const height = Math.min(card.scrollHeight + 2, maxHeight);
      const below = window.innerHeight - anchor.bottom - edge - gap;
      const above = anchor.top - edge - gap;
      const preferredTop = below >= height || below >= above ? anchor.bottom + gap : anchor.top - gap - height;
      setPosition({
        width,
        maxHeight,
        left: Math.max(edge, Math.min(anchor.right - width, window.innerWidth - width - edge)),
        top: Math.max(edge, Math.min(preferredTop, window.innerHeight - height - edge)),
        visibility: 'visible',
      });
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreview(false);
    };
    const outside = (event: PointerEvent) => {
      if (!triggerRef.current?.contains(event.target as Node) && !cardRef.current?.contains(event.target as Node))
        setPreview(false);
    };
    place();
    const observer = new ResizeObserver(place);
    if (cardRef.current) observer.observe(cardRef.current);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', outside);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('pointerdown', outside);
    };
  }, [preview]);
  return (
    <>
      <button
        ref={triggerRef}
        className={`audit-peek audit-peek-${node.status}`}
        aria-label={`${statusLabel}: preview AI audit for ${displayUnitLabel(node)}`}
        aria-describedby={preview ? tooltipId : undefined}
        onMouseEnter={keepOpen}
        onMouseLeave={hideSoon}
        onFocus={keepOpen}
        onBlur={hideSoon}
        onClick={(event) => {
          event.stopPropagation();
          setPreview(false);
          open();
        }}
      >
        <span aria-hidden="true">
          {node.status === 'verified' ? '✓' : node.status === 'needs-verification' ? '!' : '?'}
        </span>
      </button>
      {preview &&
        createPortal(
          <aside
            ref={cardRef}
            id={tooltipId}
            className="audit-hover-portal"
            role="tooltip"
            style={position}
            onMouseEnter={keepOpen}
            onMouseLeave={hideSoon}
            onClick={(event) => event.stopPropagation()}
          >
            <b>AI audit · {statusLabel}</b>
            <strong>{displayUnitLabel(node)}</strong>
            {node.role && <MathText value={node.role} block />}
            {node.whyItMatters && <MathText value={node.whyItMatters} block />}
          </aside>,
          document.fullscreenElement ?? document.body,
        )}
    </>
  );
}

function NoteMarker({ count, open }: { count: number; open: () => void }) {
  return (
    <button
      className="source-note-marker"
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
      aria-label={`Open ${count} saved note${count === 1 ? '' : 's'}`}
      title={`Open ${count} saved note${count === 1 ? '' : 's'}`}
    >
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4.5 3.5h8l3 3v10h-11z" />
        <path d="M12.5 3.5v3h3M7 10h6M7 13h4" />
      </svg>
      {count > 1 && <span>{count}</span>}
    </button>
  );
}

function ModifiedMarker({
  patch,
  originalValue,
  currentValue,
  citations,
  revert,
}: {
  patch: WorkingPatch;
  originalValue: string;
  currentValue: string;
  citations: CitationReference[];
  revert: () => Promise<void>;
}) {
  const [restoring, setRestoring] = useState(false);
  const origin =
    patch.source === 'ai' ? 'AI typo correction' : patch.kind === 'add' ? 'Reader addition' : 'Reader edit';
  async function restore(event: ReactMouseEvent) {
    event.stopPropagation();
    setRestoring(true);
    try {
      await revert();
    } finally {
      setRestoring(false);
    }
  }
  return (
    <div className="source-modified-marker" onClick={(event) => event.stopPropagation()}>
      <button className="source-modified-trigger" aria-label={`Modified: ${origin}`} aria-haspopup="true">
        Modified
      </button>
      <aside className="source-modified-popover" role="tooltip">
        <header>
          <b>{origin}</b>
          <span>{patch.source === 'ai' ? 'AI' : 'You'}</span>
        </header>
        <p>
          {patch.rationale ||
            (patch.source === 'ai'
              ? 'A high-confidence typo was corrected during the full-paper audit.'
              : 'This passage differs from the original paper.')}
        </p>
        <div>
          <b>Before</b>
          <MathText
            value={originalValue || 'This passage did not exist in the original paper.'}
            block
            citations={citations}
          />
        </div>
        <div>
          <b>Now</b>
          <MathText value={currentValue || 'Hidden from the working edition.'} block citations={citations} />
        </div>
        <button className="source-restore-original" onClick={(event) => void restore(event)} disabled={restoring}>
          {restoring ? 'Restoring…' : 'Restore original'}
        </button>
      </aside>
    </div>
  );
}

function UnitStatusRail({
  noteCount,
  openNote,
  patch,
  originalValue,
  currentValue,
  citations,
  revert,
}: {
  noteCount: number;
  openNote: () => void;
  patch?: WorkingPatch;
  originalValue: string;
  currentValue: string;
  citations: CitationReference[];
  revert: () => Promise<void>;
}) {
  const modified = Boolean(patch && (patch.kind === 'add' || originalValue !== currentValue));
  if (!noteCount && !modified) return null;
  return (
    <div className="unit-status-rail">
      {noteCount > 0 && (
        <div className="unit-status-notes">
          <NoteMarker count={noteCount} open={openNote} />
        </div>
      )}
      {modified && patch && (
        <div className="unit-status-changes">
          <ModifiedMarker
            patch={patch}
            originalValue={originalValue}
            currentValue={currentValue}
            citations={citations}
            revert={revert}
          />
        </div>
      )}
    </div>
  );
}

function UnitPreviewButton({
  target,
  fallback,
  openNode,
}: {
  target?: AuditNode;
  fallback: string;
  openNode: (id: string) => void;
}) {
  return (
    <button
      className="unit-preview-trigger"
      onClick={(event) => {
        event.stopPropagation();
        if (target) openNode(target.id);
      }}
      disabled={!target}
    >
      <span>{target ? displayUnitLabel(target) : fallback}</span>
      {target && (
        <span className="unit-hover-card" role="tooltip">
          <b>{displayUnitLabel(target)}</b>
          {target.title && (
            <strong>
              <MathText value={target.title} citations={target.citations ?? []} />
            </strong>
          )}
          <span>
            <MathText
              value={target.statement || 'No standalone statement was preserved.'}
              citations={target.citations ?? []}
            />
          </span>
          {target.role && <em>{target.role}</em>}
          <small>Click to select this prerequisite.</small>
        </span>
      )}
    </button>
  );
}

function ProofReadingTools({
  node,
  citations,
  expand,
}: {
  node: AuditNode;
  citations: CitationReference[];
  expand: (node: AuditNode, request: string) => Promise<string>;
}) {
  const [request, setRequest] = useState('');
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function run(prompt: string) {
    if (!prompt.trim() || loading) return;
    const processId = `proof-expansion:${node.id}`;
    reportReaderProcess({ id: processId, label: 'Expanding proof', detail: displayUnitLabel(node), status: 'running' });
    setLoading(true);
    setError('');
    setAnswer('');
    try {
      setAnswer(await expand(node, prompt));
      reportReaderProcess({
        id: processId,
        label: 'Proof expansion ready',
        detail: displayUnitLabel(node),
        status: 'complete',
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The proof could not be expanded.';
      setError(message);
      reportReaderProcess({ id: processId, label: 'Proof expansion stopped', detail: message, status: 'error' });
    } finally {
      setLoading(false);
    }
  }
  return (
    <section className="proof-reading-tools" onClick={(event) => event.stopPropagation()}>
      <div>
        <button onClick={() => void run('Expand the entire proof line by line in complete detail.')}>
          Expand full proof
        </button>
        <div>
          <input
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void run(request);
            }}
            placeholder="L3, or paste a passage…"
          />
          <button onClick={() => void run(request)} disabled={!request.trim() || loading}>
            Explain
          </button>
        </div>
      </div>
      {loading && (
        <div className="proof-ai-progress">
          <span />
          <span />
          <span />
          <p>Reading the complete proof and its dependencies…</p>
        </div>
      )}
      {error && <p className="proof-step-error">{error}</p>}
      {answer && (
        <details open className="proof-expanded-answer">
          <summary>Detailed expansion</summary>
          <AIText value={answer} citations={citations} />
        </details>
      )}
    </section>
  );
}

function ProofMap({
  node,
  citations,
  nodes,
  openNode,
  expandStep,
}: {
  node: AuditNode;
  citations: CitationReference[];
  nodes: AuditNode[];
  openNode: (id: string) => void;
  expandStep: (node: AuditNode, step: string, index: number) => Promise<string>;
}) {
  const [details, setDetails] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});
  async function openDetail(index: number, step: string) {
    if (details[index] || loading === index) return;
    const processId = `proof-map:${node.id}:${index}`;
    reportReaderProcess({
      id: processId,
      label: `Expanding proof step ${index + 1}`,
      detail: displayUnitLabel(node),
      status: 'running',
    });
    setLoading(index);
    setErrors((current) => ({ ...current, [index]: '' }));
    try {
      const expanded = await expandStep(node, step, index);
      setDetails((current) => ({ ...current, [index]: expanded }));
      reportReaderProcess({
        id: processId,
        label: `Proof step ${index + 1} ready`,
        detail: displayUnitLabel(node),
        status: 'complete',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'This step could not be expanded.';
      setErrors((current) => ({ ...current, [index]: message }));
      reportReaderProcess({
        id: processId,
        label: `Proof step ${index + 1} stopped`,
        detail: message,
        status: 'error',
      });
    } finally {
      setLoading(null);
    }
  }
  if (node.proofText.trim().length < 520 || node.proofSketch.length < 2) return null;
  return (
    <details className="proof-map">
      <summary>
        <span>AI proof map</span>
        <small>{node.proofSketch.length} expandable steps</small>
      </summary>
      <div className="proof-map-body">
        {node.dependencies.length > 0 && (
          <div className="proof-map-inputs">
            <b>Inputs used</b>
            {node.dependencies.map((dependency) => (
              <UnitPreviewButton
                key={dependency}
                target={nodes.find((item) => item.id === dependency)}
                fallback="Referenced prerequisite"
                openNode={openNode}
              />
            ))}
          </div>
        )}
        <ol>
          {node.proofSketch.map((step, index) => (
            <li key={index}>
              <details
                className="proof-step"
                onToggle={(event) => {
                  if (event.currentTarget.open) void openDetail(index, step);
                }}
              >
                <summary>
                  <span className="proof-step-number">
                    <b>{index + 1}</b>
                    <i />
                  </span>
                  <span className="proof-step-summary">
                    <MathText value={step} citations={citations} />
                    <small>Open for complete detail</small>
                  </span>
                </summary>
                <div className="proof-step-detail">
                  {loading === index && (
                    <div className="proof-ai-progress">
                      <span />
                      <span />
                      <span />
                      <p>Expanding this step from the complete proof…</p>
                    </div>
                  )}
                  {errors[index] && (
                    <p className="proof-step-error">
                      {errors[index]} <button onClick={() => void openDetail(index, step)}>Try again</button>
                    </p>
                  )}
                  {details[index] && <AIText value={details[index]} citations={citations} />}
                </div>
              </details>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}

function CitationUploadButton({
  citation,
  onAttach,
}: {
  citation: CitationReference;
  onAttach: (citation: CitationReference, file: File) => Promise<string>;
}) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <label className="citation-upload" onClick={(event) => event.stopPropagation()}>
      <input
        type="file"
        accept=".pdf,.tex,.ltx,.bib,application/pdf,text/plain"
        disabled={busy}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setBusy(true);
          setStatus('');
          try {
            const saved = await onAttach(citation, file);
            setStatus(saved ? 'Attached locally' : 'Attached');
          } catch (error) {
            setStatus(error instanceof Error ? error.message : 'Upload failed');
          } finally {
            setBusy(false);
            event.target.value = '';
          }
        }}
      />
      <span>{busy ? 'Saving source…' : status || 'Attach local PDF / TeX'}</span>
    </label>
  );
}

function CitationSources({
  citations,
  onExpand,
  onOpen,
  onAttach,
}: {
  citations: CitationReference[];
  onExpand?: (citation: CitationReference) => void;
  onOpen?: (citation: CitationReference) => void;
  onAttach?: (citation: CitationReference, file: File) => Promise<string>;
}) {
  return (
    <section className="citation-sources">
      <b>
        Cited sources <small>Hover or focus to preview</small>
      </b>
      <div>
        {citations.map((citation) => (
          <article className="citation-source-row" tabIndex={0} key={`${citation.key}:${citation.locator}`}>
            <div className="citation-source-trigger">
              <span>
                [{citationAlphaLabel(citation, citation.key)}]{citation.locator ? ` · ${citation.locator}` : ''}
              </span>
              <strong>
                <MathText value={citationTitle(citation, citation.key)} />
              </strong>
            </div>
            <div className="citation-source-popover" role="tooltip">
              <div>
                <span>
                  [{citationAlphaLabel(citation, citation.key)}]{citation.locator ? ` · ${citation.locator}` : ''}
                </span>
              </div>
              <h5>
                <MathText value={citationTitle(citation, citation.key)} />
              </h5>
              {citation.authors && <p className="citation-authors">{cleanBibliographicText(citation.authors)}</p>}
              {citation.text && !citation.text.startsWith('Bibliography entry ') && (
                <div className="citation-source-text">
                  <MathText value={cleanBibliographicText(citation.text)} block />
                </div>
              )}
              {citation.statement && (
                <div className="citation-result-statement">
                  <b>{citation.locator || 'Cited result'}</b>
                  <MathText value={cleanBibliographicText(citation.statement)} block />
                  {Boolean(citation.definitions?.length) && (
                    <dl className="citation-notation">
                      <dt>Notation used in this result</dt>
                      {citation.definitions?.map((item, index) => (
                        <div key={`${item.notation}:${index}`}>
                          <dd>
                            <MathText value={item.notation} />
                          </dd>
                          <dd>
                            <MathText value={item.definition} citations={[]} />
                            {item.source && <small>{cleanBibliographicText(item.source)}</small>}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              )}
              <footer>
                {onOpen && (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(citation);
                    }}
                  >
                    Open in reference reader
                  </button>
                )}
                {onExpand && (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onExpand(citation);
                    }}
                  >
                    Retrieve original proof with AI
                  </button>
                )}
                <a href={citation.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                  {citation.direct ? 'Open in browser ↗' : 'Find in browser ↗'}
                </a>
                {citation.searchUrl !== citation.url && (
                  <a
                    href={citation.searchUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                  >
                    Search exact title ↗
                  </a>
                )}
                {onAttach && <CitationUploadButton citation={citation} onAttach={onAttach} />}
              </footer>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
