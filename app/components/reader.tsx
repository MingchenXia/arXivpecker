import {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { indexedVisibleProof, InteractiveDocument } from './document';
import { ReaderIcon } from './icons';
import { NodeInspector, VersionComparisonPanel } from './inspector';
import { MathText, typesetAllMath } from './math';
import {
  assistantSizeKey,
  fileAsBase64,
  hasOriginalPaper,
  originalPaperUrl,
  paperChatAnswerKey,
  paperScaleKey,
  parsePaperChat,
  readStorage,
  readString,
  reportReaderProcess,
  writeStorage,
} from '../lib/app';
import { bridgePost } from '../lib/bridge-client';
import { arxivKey, citedArxivPapers } from '../lib/cited-papers';
import type { CitedArxivPaper } from '../lib/cited-papers';
import {
  applyWorkingPatches,
  buildPaperExport,
  completeLatexSource,
  dependencyFocus,
  displayUnitLabel,
  kindClass,
  patchForNode,
  sourceBlockAsNode,
} from '../lib/audit';
import type { ExportSelection } from '../lib/audit';
import { citationTitle } from '../lib/tex-text';
import type {
  AssistantSize,
  AuditNode,
  CitationReference,
  CrossLink,
  EditionMode,
  EditorialSuggestion,
  Graph,
  GraphNode,
  Note,
  Paper,
  PaperAudit,
  PaperChatMessage,
  Profile,
  ReaderMode,
  ReaderNavigationRequest,
  ReaderProcessTarget,
  ReadingMark,
  ReferenceTarget,
  WorkingPatch,
} from '../lib/types';

// Outlives Reader remounts, so leaving the reader and returning does not replay
// an activity-tray navigation that was already handled.
let handledNavigationNonce = 0;

type ReaderProps = {
  paper?: Paper;
  audit?: PaperAudit;
  openImport: () => void;
  selectedNodeId: string;
  setSelectedNodeId: (id: string) => void;
  expanded: Record<string, boolean>;
  setExpanded: (id: string, value: boolean) => void;
  marks: Record<string, Exclude<ReadingMark, ''>>;
  setMark: (id: string, value: ReadingMark) => void;
  readerNotes: Record<string, string>;
  notes: Note[];
  answers: Record<string, string>;
  saveAnswer: (key: string, value: string) => void;
  isUnderstood: (unit: GraphNode) => boolean;
  libraryByArxivId: Record<string, string>;
  addCitedPapers: (arxivIds: string[]) => Promise<void>;
  savePaperMessages: (messages: PaperChatMessage[]) => void;
  patches: WorkingPatch[];
  savePatches: (patches: WorkingPatch[]) => Promise<void>;
  suggestEdit: (node: AuditNode) => Promise<EditorialSuggestion>;
  graph: Graph;
  analysing: boolean;
  auditActionLabel?: string;
  askingId: string | null;
  analyze: () => void;
  askNode: (node: AuditNode, question: string) => Promise<void>;
  rememberAuditThread: (threadId: string) => void;
  saveNote: (anchor: string, nodeId: string, text: string, latex: string) => void;
  updateNote: (noteId: string, text: string) => void;
  deleteNote: (noteId: string) => void;
  addLink: (link: Omit<CrossLink, 'id' | 'source' | 'createdAt'>) => Promise<void>;
  removeLink: (linkId: string) => Promise<void>;
  openUnit: (paperId: string, nodeId: string) => void;
  profile: Profile;
  navigationRequest: ReaderNavigationRequest | null;
};

export function Reader({
  paper,
  audit,
  openImport,
  selectedNodeId,
  setSelectedNodeId,
  expanded,
  setExpanded,
  marks,
  setMark,
  readerNotes,
  notes,
  answers,
  saveAnswer,
  isUnderstood,
  libraryByArxivId,
  addCitedPapers,
  savePaperMessages,
  patches,
  savePatches,
  suggestEdit,
  graph,
  analysing,
  auditActionLabel,
  askingId,
  analyze,
  askNode,
  rememberAuditThread,
  saveNote,
  updateNote,
  deleteNote,
  addLink,
  removeLink,
  openUnit,
  profile,
  navigationRequest,
}: ReaderProps) {
  const [mode, setMode] = useState<ReaderMode>('interactive');
  const [edition, setEdition] = useState<EditionMode>('working');
  const [focusPath, setFocusPath] = useState(false);
  const [focusSelection, setFocusSelection] = useState('path:0');
  const [question, setQuestion] = useState('');
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [assistantSize, setAssistantSize] = useState<AssistantSize | null>(null);
  const [paperChatOpen, setPaperChatOpen] = useState(false);
  const [paperQuestion, setPaperQuestion] = useState('');
  const [askingPaperIds, setAskingPaperIds] = useState<string[]>([]);
  const paperAsking = Boolean(paper && askingPaperIds.includes(paper.id));
  const [paperMessages, setPaperMessages] = useState<PaperChatMessage[]>(() =>
    parsePaperChat(answers[paperChatAnswerKey]),
  );
  const [paperScale, setPaperScale] = useState(1);
  const [paperScaleReady, setPaperScaleReady] = useState(false);
  const [fontPanelOpen, setFontPanelOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [referenceTarget, setReferenceTarget] = useState<ReferenceTarget | null>(null);
  const [markupOpen, setMarkupOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [mobileDockOpen, setMobileDockOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [originalPage, setOriginalPage] = useState<number | undefined>();
  const [assistantRequest, setAssistantRequest] = useState<{
    view: 'ask' | 'notes' | 'compose-note';
    nonce: number;
  } | null>(null);
  const paperMessagesRef = useRef<PaperChatMessage[]>(paperMessages);
  // Which paper's chat paperMessagesRef currently holds; an answer may arrive after a switch.
  const paperMessagesOwnerRef = useRef(paper?.id);
  const readerDocumentRef = useRef<HTMLElement>(null);
  const selectedDocumentElementRef = useRef<HTMLElement | null>(null);
  const originalNodes = useMemo(() => audit?.nodes ?? [], [audit]);
  const editionNodes = useMemo(
    () => (edition === 'working' ? applyWorkingPatches(originalNodes, patches) : originalNodes),
    [edition, originalNodes, patches],
  );
  const sourceUnits = useMemo(
    () =>
      (audit?.sourceBlocks ?? [])
        .filter((block) => block.kind === 'section' || block.kind === 'paragraph' || block.kind === 'figure')
        .map((block) => sourceBlockAsNode(block, edition === 'working' ? patches : [])),
    [audit, edition, patches],
  );
  const selectedPathIndex = Number(focusSelection.replace('path:', ''));
  const selectedTargetId = focusSelection.startsWith('result:') ? focusSelection.slice(7) : '';
  const selectedTarget = editionNodes.find((item) => item.id === selectedTargetId);
  const activePath = useMemo(() => {
    if (!audit) return undefined;
    return selectedTarget
      ? {
          goal: `Focus on ${displayUnitLabel(selectedTarget)}`,
          nodeIds: dependencyFocus(editionNodes, selectedTarget.id),
          reason: 'Showing only this result and the parts it depends on; unrelated branches are hidden.',
        }
      : (audit.readingPaths[selectedPathIndex] ?? audit.readingPaths[0]);
  }, [audit, editionNodes, selectedPathIndex, selectedTarget]);
  const units = useMemo(
    () =>
      focusPath && activePath ? editionNodes.filter((item) => activePath.nodeIds.includes(item.id)) : editionNodes,
    [activePath, editionNodes, focusPath],
  );
  const node =
    editionNodes.find((item) => item.id === selectedNodeId) ??
    sourceUnits.find((item) => item.id === selectedNodeId) ??
    editionNodes[0] ??
    sourceUnits[0];
  const storedPaperChat = answers[paperChatAnswerKey] ?? '';
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const saved = parsePaperChat(storedPaperChat);
      paperMessagesRef.current = saved;
      paperMessagesOwnerRef.current = paper?.id;
      setPaperMessages(saved);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [paper?.id, storedPaperChat]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setPaperQuestion(''));
    return () => window.cancelAnimationFrame(frame);
  }, [paper?.id]);
  useEffect(() => {
    if (paper?.id) window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [paper?.id]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuestion(''), 0);
    return () => window.clearTimeout(timer);
  }, [selectedNodeId]);
  useEffect(() => {
    if (
      !audit ||
      editionNodes.some((item) => item.id === selectedNodeId) ||
      sourceUnits.some((item) => item.id === selectedNodeId)
    )
      return;
    const timer = window.setTimeout(() => setSelectedNodeId(editionNodes[0]?.id ?? sourceUnits[0]?.id ?? ''), 0);
    return () => window.clearTimeout(timer);
  }, [audit, editionNodes, selectedNodeId, setSelectedNodeId, sourceUnits]);
  useEffect(() => {
    const previous = selectedDocumentElementRef.current;
    previous?.classList.remove('source-block-selected', 'source-result-selected');
    selectedDocumentElementRef.current = null;
    if (mode !== 'interactive' || !selectedNodeId) return;
    const target =
      readerDocumentRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(selectedNodeId)}"]`) ?? null;
    if (!target) return;
    target.classList.add(
      target.classList.contains('source-result') ? 'source-result-selected' : 'source-block-selected',
    );
    selectedDocumentElementRef.current = target;
  }, [audit, edition, expanded, marks, mode, notes, patches, selectedNodeId, units]);
  useEffect(() => {
    const update = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  useEffect(() => {
    const saved = Number(readStorage(paperScaleKey));
    const frame = window.requestAnimationFrame(() => {
      if (Number.isFinite(saved) && saved >= 0.8 && saved <= 1.4) setPaperScale(saved);
      setPaperScaleReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (paperScaleReady) writeStorage(paperScaleKey, String(paperScale));
  }, [paperScale, paperScaleReady]);
  useEffect(() => {
    function dismissFloatingReaderPanels(event: PointerEvent) {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        target.closest('[data-reader-floating-panel], .reader-floating-panel, .reader-tool-dock')
      )
        return;
      // Selecting paper text is the core markup interaction. Keep the toolbar
      // mounted until pointer-up so its active tool can apply immediately.
      if (document.body.dataset.readerMarkupActive === 'true' && target.closest('.reader-document')) return;
      setOutlineOpen(false);
      setInspectorOpen(false);
      setPaperChatOpen(false);
      setReferenceOpen(false);
      setMarkupOpen(false);
      setToolsOpen(false);
      setFontPanelOpen(false);
      setPrintOpen(false);
      setMobileDockOpen(false);
    }
    document.addEventListener('pointerdown', dismissFloatingReaderPanels, true);
    return () => document.removeEventListener('pointerdown', dismissFloatingReaderPanels, true);
  }, []);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = JSON.parse(readStorage(assistantSizeKey) ?? 'null') as AssistantSize | null;
        if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height))
          setAssistantSize({ width: Math.max(280, saved.width), height: Math.max(240, saved.height) });
      } catch {
        /* Use the compact default assistant size. */
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  function beginAssistantResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const panel = event.currentTarget.closest<HTMLElement>('.reader-inspector');
    if (!panel) return;
    const start = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    let next = { width: start.width, height: start.height };
    const move = (pointer: PointerEvent) => {
      const maximumWidth = window.innerWidth <= 720 ? window.innerWidth - 16 : window.innerWidth - 82;
      next = {
        width: Math.round(Math.min(maximumWidth, Math.max(280, start.width - (pointer.clientX - startX)))),
        height: Math.round(Math.min(window.innerHeight - 76, Math.max(240, start.height + (pointer.clientY - startY)))),
      };
      setAssistantSize(next);
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.classList.remove('assistant-resizing');
      writeStorage(assistantSizeKey, JSON.stringify(next));
    };
    document.body.classList.add('assistant-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  }
  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (isFullscreen) setIsFullscreen(false);
    else {
      const page = document.querySelector<HTMLElement>('.reader-page');
      let enteredNative = false;
      if (page?.requestFullscreen) {
        try {
          await page.requestFullscreen();
          enteredNative = Boolean(document.fullscreenElement);
        } catch {
          /* Use the embedded-reader fallback below. */
        }
      }
      if (!enteredNative) setIsFullscreen(true);
    }
    setToolsOpen(false);
    setFontPanelOpen(false);
  }
  function showRightPanel(panel: 'outline' | 'chat' | 'assistant' | 'reference' | 'markup' | 'tools' | null) {
    setOutlineOpen(panel === 'outline');
    setPaperChatOpen(panel === 'chat');
    setInspectorOpen(panel === 'assistant');
    setReferenceOpen(panel === 'reference');
    setMarkupOpen(panel === 'markup');
    setToolsOpen(panel === 'tools');
    setMobileDockOpen(false);
  }
  useEffect(() => {
    if (
      !navigationRequest ||
      navigationRequest.paperId !== paper?.id ||
      handledNavigationNonce >= navigationRequest.nonce
    )
      return;
    let jumpFrame = 0;
    const openFrame = window.requestAnimationFrame(() => {
      // Mark it handled only once it runs: a cancelled frame (StrictMode's
      // effect replay) must not swallow the request.
      handledNavigationNonce = navigationRequest.nonce;
      setMode('interactive');
      setEdition('working');
      setFocusPath(false);
      setOutlineOpen(false);
      setReferenceOpen(false);
      setMarkupOpen(false);
      setToolsOpen(false);
      setMobileDockOpen(false);
      if (navigationRequest.panel === 'paper-chat') {
        setInspectorOpen(false);
        setPaperChatOpen(true);
        return;
      }
      setPaperChatOpen(false);
      setInspectorOpen(true);
      if (!navigationRequest.nodeId) return;
      setSelectedNodeId(navigationRequest.nodeId);
      setAssistantRequest((current) => ({ view: 'ask', nonce: (current?.nonce ?? 0) + 1 }));
      jumpFrame = window.requestAnimationFrame(() =>
        window.dispatchEvent(new CustomEvent('proofroom:jump-unit', { detail: navigationRequest.nodeId })),
      );
    });
    return () => {
      window.cancelAnimationFrame(openFrame);
      if (jumpFrame) window.cancelAnimationFrame(jumpFrame);
    };
  }, [navigationRequest, paper?.id, setSelectedNodeId]);
  function openOriginalPaper(targetPage?: number) {
    setOriginalPage(targetPage);
    setMode('source');
    setEdition('original');
    showRightPanel(null);
    setPrintOpen(false);
    setFontPanelOpen(false);
    setExportOpen(false);
    setComparisonOpen(false);
  }
  function returnToEnhancedPaper() {
    setMode('interactive');
    setEdition('working');
    setOriginalPage(undefined);
  }
  function printOriginalPaper() {
    const frame = document.querySelector<HTMLIFrameElement>('.reader-pdf');
    try {
      if (frame?.contentWindow) {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        return;
      }
    } catch {
      /* Fall through to the browser's native PDF tab. */
    }
    const printable = window.open(pdfUrl, '_blank', 'noopener,noreferrer');
    if (printable)
      window.setTimeout(() => {
        printable.focus();
        printable.print();
      }, 650);
  }
  function jumpToDocumentUnit(nodeId: string) {
    setSelectedNodeId(nodeId);
    window.dispatchEvent(new CustomEvent('proofroom:jump-unit', { detail: nodeId }));
  }
  async function askPaperContext() {
    const prompt = paperQuestion.trim();
    if (!paper || !audit || !prompt || paperAsking) return;
    const processId = `paper-question:${paper.id}`;
    const resultTarget: ReaderProcessTarget = { paperId: paper.id, panel: 'paper-chat' };
    reportReaderProcess({
      id: processId,
      label: 'Full-paper question',
      detail: paper.title,
      status: 'running',
      resultTarget,
    });
    const askedPaperId = paper.id;
    const savePaperChat = savePaperMessages;
    const showIfCurrent = (messages: PaperChatMessage[]) => {
      if (paperMessagesOwnerRef.current !== askedPaperId) return;
      paperMessagesRef.current = messages;
      setPaperMessages(messages);
    };
    const userMessages: PaperChatMessage[] = [...paperMessagesRef.current, { role: 'user', text: prompt }];
    showIfCurrent(userMessages);
    savePaperChat(userMessages);
    setPaperQuestion('');
    setAskingPaperIds((current) => [...current, askedPaperId]);
    try {
      const data = await bridgePost(
        '/paper-question',
        { paper, profile, node, question: prompt, threadId: audit.threadId },
        'Local Codex could not answer this paper question.',
      );
      rememberAuditThread(readString(data.threadId));
      const completed: PaperChatMessage[] = [...userMessages, { role: 'assistant', text: readString(data.text) }];
      showIfCurrent(completed);
      savePaperChat(completed);
      reportReaderProcess({
        id: processId,
        label: 'Full-paper answer ready',
        detail: paper.title,
        status: 'complete',
        resultTarget,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The local Codex question failed.';
      const failed: PaperChatMessage[] = [...userMessages, { role: 'assistant', text: message }];
      showIfCurrent(failed);
      savePaperChat(failed);
      reportReaderProcess({ id: processId, label: 'Full-paper question stopped', detail: message, status: 'error' });
    } finally {
      setAskingPaperIds((current) => current.filter((id) => id !== askedPaperId));
    }
  }
  async function attachCitationSource(citation: CitationReference, file: File) {
    if (!paper) throw new Error('No paper is open.');
    const dataBase64 = await fileAsBase64(file);
    const data = await bridgePost(
      '/vault/citation-asset',
      {
        paperId: paper.id,
        upload: { citation, fileName: file.name, mime: file.type, dataBase64 },
      },
      'The cited source could not be attached.',
    );
    return readString(data.saved?.relativePath);
  }
  function openReference(citation?: CitationReference) {
    if (citation)
      setReferenceTarget({
        title: citationTitle(citation, citation.key),
        arxivId: citation.arxivId || undefined,
        url: citation.arxivId ? `https://arxiv.org/pdf/${citation.arxivId}` : citation.url || citation.searchUrl,
      });
    showRightPanel('reference');
  }
  async function expandProofStep(target: AuditNode, step: string, index: number) {
    if (!paper || !audit?.threadId) throw new Error('Run the full-paper audit first.');
    const visibleLines = indexedVisibleProof(target.id);
    const prompt = `Expand Step ${index + 1} of the AI proof map in complete mathematical detail: “${step}”. Use the complete original proof and the durable full-paper audit as the authority. State every prerequisite used, fill in intermediate equations, explain each implication, and identify exactly where this step occurs using the reader-visible L-numbers below. Cite only line numbers supported by this map. Clearly separate text present in the source from explanatory details you supply. Do not invent a missing argument.\n\nReader-visible proof map:\n${visibleLines || 'No rendered line map is available; do not claim an L-number.'}`;
    const data = await bridgePost(
      '/node-question',
      { paper, profile, node: target, question: prompt, threadId: audit.threadId },
      'This proof step could not be expanded.',
    );
    return readString(data.text);
  }
  async function askAboutUnit(target: AuditNode, prompt: string, failure: string) {
    if (!paper || !audit) throw new Error('Run the full-paper audit first.');
    const data = await bridgePost(
      '/node-question',
      { paper, profile, node: target, question: prompt, threadId: audit.threadId },
      failure,
    );
    if (!audit.threadId && readString(data.threadId)) rememberAuditThread(readString(data.threadId));
    return readString(data.text);
  }
  async function expandProofRequest(target: AuditNode, request: string) {
    if (!paper || !audit?.threadId) throw new Error('Run the full-paper audit first.');
    const visibleLines = indexedVisibleProof(target.id);
    const prompt = `The reader is working inside the complete proof of ${displayUnitLabel(target)} and asks: “${request}”. The L-labels refer exactly to the current rendered proof-line map below, including one line for each displayed formula. Give a detailed, source-faithful expansion at exactly the requested scope; include intermediate equations and prerequisites, distinguish author text from explanation, and do not invent missing mathematics.\n\nReader-visible proof map:\n${visibleLines || 'No rendered line map is available; ask the reader to reopen the proof before claiming an L-number.'}`;
    const data = await bridgePost(
      '/node-question',
      { paper, profile, node: target, question: prompt, threadId: audit.threadId },
      'The proof could not be expanded.',
    );
    return readString(data.text);
  }
  if (!paper) return <EmptyVault onImport={openImport} />;
  const hasOriginalPdf = hasOriginalPaper(paper);
  if (!audit)
    return (
      <section className="mx-auto max-w-3xl px-6 py-14">
        <div className="rounded-xl border border-[#d8e4d9] bg-[#f3f8f3] p-7">
          <h2 className="text-2xl font-bold tracking-[-.04em]">Analyze this paper to begin.</h2>
          <div className="mt-6 flex gap-2">
            <button
              onClick={analyze}
              disabled={analysing}
              className="rounded-md bg-[#2d654f] px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50"
            >
              {analysing ? 'Auditing…' : (auditActionLabel ?? 'Analyze')}
            </button>
            {hasOriginalPdf && (
              <a
                href={originalPaperUrl(paper)}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-[#cddbd0] bg-white px-4 py-2.5 text-xs font-bold text-[#39634c]"
              >
                Original PDF ↗
              </a>
            )}
          </div>
        </div>
      </section>
    );
  const page = originalPage ?? node?.anchor.page ?? undefined;
  const pdfUrl = originalPaperUrl(paper, page);
  return (
    <section
      className={`reader-page ${mode === 'source' ? 'reader-original-mode' : ''} ${analysing ? 'reader-audit-locked' : ''} ${isFullscreen ? 'reader-fullscreen-active' : ''}`}
    >
      <div className="fullscreen-edge-top" aria-hidden="true" />
      <div className="reader-titlebar">
        <h2>
          <MathText value={paper.title} />
        </h2>
        {analysing && (
          <span className="reader-edit-lock">
            <i />
            Audit running · editing paused
          </span>
        )}
        <div className="reader-top-actions">
          {hasOriginalPdf && (
            <button
              className={mode === 'source' ? 'active reader-back-to-paper' : ''}
              onClick={() =>
                mode === 'source' ? returnToEnhancedPaper() : openOriginalPaper(node?.anchor.page ?? undefined)
              }
              aria-label={mode === 'source' ? 'Back to enhanced paper' : 'Open original paper'}
            >
              <ReaderIcon name="original" />
              <span>{mode === 'source' ? 'Back to paper' : 'Original paper'}</span>
            </button>
          )}
          <button
            className={fontPanelOpen ? 'active' : ''}
            onClick={() => {
              setFontPanelOpen(!fontPanelOpen);
              setPrintOpen(false);
            }}
            aria-label="Adjust paper text size"
          >
            <ReaderIcon name="magnify" />
            <span>Text size</span>
            <output>{Math.round(paperScale * 100)}%</output>
          </button>
          <button
            className={isFullscreen ? 'active' : ''}
            onClick={() => void toggleFullscreen()}
            aria-label={isFullscreen ? 'Exit fullscreen reading' : 'Enter fullscreen reading'}
          >
            <ReaderIcon name="fullscreen" />
            <span>{isFullscreen ? 'Exit full screen' : 'Full screen'}</span>
          </button>
          <button
            className={printOpen ? 'active' : ''}
            onClick={() => {
              if (mode === 'source') printOriginalPaper();
              else {
                setPrintOpen(!printOpen);
                setFontPanelOpen(false);
              }
            }}
            aria-label={mode === 'source' ? 'Print the original paper' : 'Print or save the working paper'}
          >
            <ReaderIcon name="print" />
            <span>Print</span>
          </button>
          <button onClick={analyze} disabled={analysing} className="reader-reaudit">
            {analysing ? 'Auditing…' : (auditActionLabel ?? 'Re-audit')}
          </button>
        </div>
      </div>
      {activePath && focusPath && mode !== 'source' && (
        <div className="reader-path">
          <b>{activePath.goal}</b>
          <span>{activePath.reason}</span>
          <button onClick={() => setFocusPath(false)}>Show full paper</button>
        </div>
      )}
      <div
        className={`reader-grid ${outlineOpen ? 'reader-grid-outline' : ''} ${inspectorOpen ? 'reader-grid-inspector' : ''}`}
      >
        {outlineOpen && (
          <aside className="reader-outline reader-drawer" data-reader-floating-panel>
            <div className="drawer-head">
              <div>
                <span className="reader-kicker">Logical outline</span>
                <b>{units.length} units</b>
              </div>
              <button
                type="button"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  setOutlineOpen(false);
                }}
                onClick={(event) => event.stopPropagation()}
                aria-label="Close outline"
              >
                ×
              </button>
            </div>
            <div className="space-y-0.5">
              {units.map((item) => {
                const changed = patchForNode(patches, item.id);
                return (
                  <button
                    key={item.id}
                    onClick={() => jumpToDocumentUnit(item.id)}
                    className={`outline-unit ${selectedNodeId === item.id ? 'outline-unit-active' : ''}`}
                  >
                    <span className={`outline-kind ${kindClass(item.kind)}`}>{item.kind[0].toUpperCase()}</span>
                    <span className="min-w-0">
                      <small>{displayUnitLabel(item)}</small>
                      <b>
                        <MathText value={item.title} />
                      </b>
                    </span>
                    {changed && (
                      <i
                        className="working-dot"
                        title={changed.kind === 'add' ? 'Added in working edition' : 'Edited in working edition'}
                      >
                        W
                      </i>
                    )}
                    {item.status !== 'verified' && !changed && (
                      <i className="ml-auto h-1.5 w-1.5 flex-none rounded-full bg-[#b8873c]" />
                    )}
                  </button>
                );
              })}
            </div>
          </aside>
        )}
        <main
          ref={readerDocumentRef}
          className="reader-document"
          style={{ zoom: paperScale, width: `${100 / paperScale}%` } as CSSProperties}
        >
          {mode === 'source' ? (
            <iframe title={`Original paper: ${paper.title}`} src={pdfUrl} className="reader-pdf" />
          ) : (
            <InteractiveDocument
              paper={paper}
              audit={audit}
              nodes={units}
              notes={notes}
              saveNote={saveNote}
              updateNote={updateNote}
              deleteNote={deleteNote}
              setSelectedNodeId={setSelectedNodeId}
              expanded={expanded}
              setExpanded={setExpanded}
              marks={marks}
              setMark={setMark}
              patches={patches}
              savePatches={savePatches}
              openAssistant={(view = 'ask') => {
                setAssistantRequest((current) => ({ view, nonce: (current?.nonce ?? 0) + 1 }));
                showRightPanel('assistant');
              }}
              openReference={openReference}
              expandCitation={(target, citation) => {
                const prompt = `Retrieve and expand the cited ${citation.locator || 'result'} from “${citation.title}” (${citation.url}). Show its complete original statement and proof when accessible, then explain how this paper uses it. Clearly identify anything that could not be verified.`;
                setSelectedNodeId(target.id);
                setQuestion(prompt);
                showRightPanel('assistant');
                void askNode(target, prompt);
              }}
              attachCitation={attachCitationSource}
              expandProofStep={expandProofStep}
              expandProofRequest={expandProofRequest}
              libraryByArxivId={libraryByArxivId}
              addCitedPapers={addCitedPapers}
              openPaper={(paperId) => openUnit(paperId, '')}
            />
          )}
        </main>
        {inspectorOpen && mode !== 'source' && (
          <aside
            className="reader-inspector reader-drawer"
            data-reader-floating-panel
            style={assistantSize ? { width: assistantSize.width, height: assistantSize.height } : undefined}
          >
            <div className="drawer-head">
              <b>Assistant</b>
              <button onClick={() => setInspectorOpen(false)} aria-label="Close assistant">
                ×
              </button>
            </div>
            {node ? (
              <NodeInspector
                key={`${edition}:${node.id}`}
                paper={paper}
                node={node}
                originalNode={audit.nodes.find((item) => item.id === node.id)}
                plainSource={node.id.startsWith('source-block:')}
                edition={edition}
                patches={patches}
                savePatches={savePatches}
                suggestEdit={suggestEdit}
                expanded={expanded[node.id] !== false}
                setExpanded={(value) => setExpanded(node.id, value)}
                expandProof={expandProofRequest}
                notes={notes.filter((item) => item.nodeId === node.id).slice(0, 1)}
                answer={answers[node.id]}
                question={question}
                setQuestion={setQuestion}
                asking={askingId === node.id}
                ask={() => void askNode(node, question)}
                saveNote={saveNote}
                updateNote={updateNote}
                deleteNote={deleteNote}
                graph={graph}
                addLink={addLink}
                removeLink={removeLink}
                openUnit={openUnit}
                openOriginalPaper={openOriginalPaper}
                assistantRequest={assistantRequest}
                clearAssistantRequest={() => setAssistantRequest(null)}
                isUnderstood={isUnderstood}
                studyAnswers={answers}
                saveAnswer={saveAnswer}
                askAboutUnit={askAboutUnit}
              />
            ) : (
              <p className="p-4 text-xs text-[#6e6a64]">Select a document unit.</p>
            )}
            <button
              className="assistant-resize-handle"
              onPointerDown={beginAssistantResize}
              aria-label="Resize assistant panel"
              title="Drag to resize"
            />
          </aside>
        )}
      </div>
      {mode !== 'source' && (
        <>
          <div className="fullscreen-edge-right" aria-hidden="true" />
          <nav className={`reader-tool-dock ${mobileDockOpen ? 'mobile-open' : ''}`} aria-label="Paper tools">
            <button
              className={outlineOpen ? 'active' : ''}
              onClick={() => showRightPanel(outlineOpen ? null : 'outline')}
              aria-label="Toggle logical outline"
            >
              <b>☰</b>
              <span>Outline</span>
            </button>
            <button
              className={paperChatOpen ? 'active' : ''}
              onClick={() => showRightPanel(paperChatOpen ? null : 'chat')}
              aria-label="Ask AI about the whole paper"
            >
              <b>?</b>
              <span>Ask paper</span>
            </button>
            <button
              className={inspectorOpen ? 'active' : ''}
              onClick={() => showRightPanel(inspectorOpen ? null : 'assistant')}
              disabled={!node}
              aria-label="Toggle AI, notes, and editing"
            >
              <b>AI</b>
              <span>Current text</span>
            </button>
            <button
              className={referenceOpen ? 'active' : ''}
              onClick={() => showRightPanel(referenceOpen ? null : 'reference')}
              aria-label="Open floating reference reader"
            >
              <ReaderIcon name="reference" />
              <span>Reference reader</span>
            </button>
            <button
              className={markupOpen ? 'active' : ''}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => showRightPanel(markupOpen ? null : 'markup')}
              aria-label="Open text markup tools"
            >
              <b className="markup-dock-icon">✎</b>
              <span>Markup</span>
            </button>
            <button
              className={toolsOpen ? 'active' : ''}
              onClick={() => showRightPanel(toolsOpen ? null : 'tools')}
              aria-label="More reader options"
            >
              <b>•••</b>
              <span>More options</span>
            </button>
          </nav>
          <button
            className={`reader-mobile-tools-toggle ${mobileDockOpen ? 'active' : ''}`}
            onClick={() => setMobileDockOpen((open) => !open)}
            aria-expanded={mobileDockOpen}
            aria-label={mobileDockOpen ? 'Hide paper tools' : 'Show paper tools'}
          >
            <span aria-hidden="true">{mobileDockOpen ? '×' : '•••'}</span>
          </button>
        </>
      )}
      {fontPanelOpen && (
        <aside className="paper-size-popover" data-reader-floating-panel aria-label="Paper text size">
          <header>
            <div>
              <b>Paper text size</b>
              <span>Applies to the complete paper</span>
            </div>
            <button onClick={() => setFontPanelOpen(false)} aria-label="Close text size controls">
              ×
            </button>
          </header>
          <input
            aria-label="Paper text size percentage"
            type="range"
            min="80"
            max="140"
            step="10"
            value={Math.round(paperScale * 100)}
            onChange={(event) => setPaperScale(Number(event.target.value) / 100)}
          />
          <div className="paper-size-row">
            <button
              onClick={() => setPaperScale((value) => Math.max(0.8, Number((value - 0.1).toFixed(1))))}
              disabled={paperScale <= 0.8}
              aria-label="Decrease paper text size"
            >
              A−
            </button>
            <output aria-live="polite">{Math.round(paperScale * 100)}%</output>
            <button
              onClick={() => setPaperScale((value) => Math.min(1.4, Number((value + 0.1).toFixed(1))))}
              disabled={paperScale >= 1.4}
              aria-label="Increase paper text size"
            >
              A+
            </button>
            <button onClick={() => setPaperScale(1)}>Reset</button>
          </div>
        </aside>
      )}
      {toolsOpen && (
        <aside className="reader-tool-menu" data-reader-floating-panel>
          <header>
            <b>More reader options</b>
            <button onClick={() => setToolsOpen(false)} aria-label="Close reader options">
              ×
            </button>
          </header>
          <section>
            <label htmlFor="focus-selection">Focus on</label>
            <select
              id="focus-selection"
              value={focusSelection}
              onChange={(event) => setFocusSelection(event.target.value)}
            >
              {audit.readingPaths.length > 0 && (
                <optgroup label="Audited reading goals">
                  {audit.readingPaths.map((path, index) => (
                    <option key={`${path.goal}:${index}`} value={`path:${index}`}>
                      {path.goal}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="A specific result">
                {editionNodes
                  .filter((item) =>
                    ['theorem', 'lemma', 'proposition', 'corollary', 'conjecture', 'definition'].includes(item.kind),
                  )
                  .map((item) => (
                    <option key={item.id} value={`result:${item.id}`}>
                      {displayUnitLabel(item)}
                      {item.title ? ` — ${item.title}` : ''}
                    </option>
                  ))}
              </optgroup>
            </select>
            <div className="focus-actions">
              <button
                onClick={() => {
                  setFocusPath(true);
                  setMode('interactive');
                  setToolsOpen(false);
                }}
              >
                Apply focus
              </button>
              {focusPath && <button onClick={() => setFocusPath(false)}>Show all</button>}
            </div>
          </section>
          <footer>
            <button
              onClick={() => {
                setExportOpen(true);
                setToolsOpen(false);
              }}
            >
              Save selected parts
            </button>
            <button
              onClick={() => {
                setComparisonOpen(true);
                setToolsOpen(false);
              }}
            >
              Compare versions
            </button>
          </footer>
        </aside>
      )}
      {paperChatOpen && (
        <PaperChatDialog
          paper={paper}
          currentNode={node}
          messages={paperMessages}
          question={paperQuestion}
          setQuestion={setPaperQuestion}
          asking={paperAsking}
          ask={() => void askPaperContext()}
          close={() => setPaperChatOpen(false)}
        />
      )}
      {printOpen && (
        <PrintPanel
          paper={paper}
          audit={audit}
          workingNodes={applyWorkingPatches(originalNodes, patches)}
          patches={patches}
          edition={edition}
          setEdition={setEdition}
          mode={mode}
          setMode={setMode}
          readerNotes={readerNotes}
          notes={notes}
          close={() => setPrintOpen(false)}
        />
      )}
      {referenceOpen && (
        <ReferenceReaderPanel
          paper={paper}
          graph={graph}
          target={referenceTarget}
          setTarget={setReferenceTarget}
          attach={attachCitationSource}
          close={() => setReferenceOpen(false)}
          cited={audit ? citedArxivPapers(audit) : []}
          libraryByArxivId={libraryByArxivId}
          addCitedPapers={addCitedPapers}
          openPaper={(paperId) => openUnit(paperId, '')}
        />
      )}
      {markupOpen && <AnnotationToolbar close={() => setMarkupOpen(false)} />}
      {exportOpen && (
        <ExportPaperPanel
          paper={paper}
          audit={audit}
          nodes={editionNodes}
          patches={patches}
          focusIds={activePath?.nodeIds ?? []}
          readerNotes={readerNotes}
          notes={notes}
          focusActive={focusPath}
          close={() => setExportOpen(false)}
        />
      )}
      {comparisonOpen && (
        <VersionComparisonPanel
          paper={paper}
          profile={profile}
          audit={audit}
          openUnit={openUnit}
          close={() => setComparisonOpen(false)}
        />
      )}
    </section>
  );
}

function PrintPanel({
  paper,
  audit,
  workingNodes,
  patches,
  edition,
  setEdition,
  mode,
  setMode,
  readerNotes,
  notes,
  close,
}: {
  paper: Paper;
  audit: PaperAudit;
  workingNodes: AuditNode[];
  patches: WorkingPatch[];
  edition: EditionMode;
  setEdition: (value: EditionMode) => void;
  mode: ReaderMode;
  setMode: (value: ReaderMode) => void;
  readerNotes: Record<string, string>;
  notes: Note[];
  close: () => void;
}) {
  const [annotations, setAnnotations] = useState(false);
  const [proofMaps, setProofMaps] = useState(false);
  const [citations, setCitations] = useState(false);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [savingLatex, setSavingLatex] = useState(false);
  const nodes = workingNodes;
  async function buildPrintView() {
    const printWindow = window.open('', '_blank', 'popup,width=980,height=820');
    if (!printWindow) {
      setError('Allow pop-ups once so the local print view can open.');
      return;
    }
    printWindow.document.write(
      '<title>Preparing print view…</title><p style="font:14px system-ui;padding:24px">Building the print-ready paper locally…</p>',
    );
    const previousEdition = edition;
    const previousMode = mode;
    setMode('interactive');
    setEdition('working');
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
    );
    // The copy must contain every formula, including those not yet scrolled near.
    typesetAllMath();
    const source = document.querySelector<HTMLElement>('.source-document');
    if (!source) {
      printWindow.close();
      setError('The paper view was not ready. Please try again.');
      setEdition(previousEdition);
      setMode(previousMode);
      return;
    }
    const clone = source.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll(
        '.tex-edit-hint,.reading-mark-control,.proof-reading-tools,.audit-peek,.source-result > footer,.source-block-actions,.source-section-toggle,.paper-reading-guide,.source-completeness',
      )
      .forEach((element) => element.remove());
    if (!annotations)
      clone.querySelectorAll('[class*="reading-mark-"],.tex-modified').forEach((element) => {
        element.className = element.className
          .replace(/reading-mark-(?:understood|question|error)|tex-modified/g, '')
          .trim();
      });
    if (!proofMaps) clone.querySelectorAll('.proof-map').forEach((element) => element.remove());
    if (!citations) clone.querySelectorAll('.citation-sources').forEach((element) => element.remove());
    if (includeNotes) {
      const entries = [
        ...Object.entries(readerNotes)
          .filter(([, value]) => value.trim())
          .map(([nodeId, value]) => ({
            anchor: displayUnitLabel(
              nodes.find((item) => item.id === nodeId) ?? ({ kind: 'section', label: 'Paper note' } as AuditNode),
            ),
            value,
          })),
        ...notes
          .filter((note) => note.text.trim())
          .map((note) => ({ anchor: note.anchor, value: `${note.text}${note.latex ? `\n\n${note.latex}` : ''}` })),
      ];
      if (entries.length) {
        const section = document.createElement('section');
        section.className = 'print-reader-notes';
        const heading = document.createElement('h2');
        heading.textContent = 'Reader notes';
        section.appendChild(heading);
        for (const entry of entries) {
          const article = document.createElement('article');
          article.innerHTML = '<b></b><p></p>';
          const label = article.querySelector('b');
          const text = article.querySelector('p');
          if (label) label.textContent = entry.anchor;
          if (text) text.textContent = entry.value;
          section.appendChild(article);
        }
        clone.appendChild(section);
      }
    }
    const styles = [...document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')]
      .map((element) => element.outerHTML)
      .join('\n');
    printWindow.document.open();
    printWindow.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>${paper.title.replace(/[<>]/g, '')}</title>${styles}<style>body{margin:0;background:#fff}.source-document{width:100%;max-width:none;padding:0}.interactive-lead,.original-source-flow{max-width:760px;margin-inline:auto;border:0;box-shadow:none}.print-reader-notes{max-width:760px;margin:36px auto;padding:24px 0;border-top:1px solid #999}.print-reader-notes h2{font:600 24px Georgia,serif}.print-reader-notes article{margin:16px 0}.print-reader-notes b{font:700 10px system-ui;color:#666}.print-reader-notes p{white-space:pre-wrap;font:14px/1.6 Georgia,serif}@page{margin:18mm}@media print{.source-document{padding:0!important}.source-result,.source-proof{break-inside:avoid-page}.citation-source-popover,.unit-hover-card{display:none!important}}</style></head><body></body></html>`,
    );
    printWindow.document.close();
    printWindow.document.body.appendChild(printWindow.document.importNode(clone, true));
    setEdition(previousEdition);
    setMode(previousMode);
    window.setTimeout(() => {
      printWindow.focus();
      printWindow.print();
    }, 500);
  }
  async function saveLatex() {
    setSavingLatex(true);
    setError('');
    setSaved('');
    try {
      const data = await bridgePost(
        '/vault/latex-export',
        {
          paperId: paper.id,
          export: { edition: 'working', content: completeLatexSource(paper, audit, nodes, patches) },
        },
        'The complete LaTeX source could not be saved.',
      );
      setSaved(readString(data.saved?.relativePath));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The complete LaTeX source could not be saved.');
    } finally {
      setSavingLatex(false);
    }
  }
  return (
    <aside className="print-panel reader-floating-panel" aria-label="Print options">
      <header>
        <div>
          <b>Print or save</b>
        </div>
        <button onClick={close} aria-label="Close print options">
          ×
        </button>
      </header>
      <div className="print-options">
        <label>
          <input type="checkbox" checked={annotations} onChange={(event) => setAnnotations(event.target.checked)} />
          <span>Reading marks and edit highlights</span>
        </label>
        <label>
          <input type="checkbox" checked={includeNotes} onChange={(event) => setIncludeNotes(event.target.checked)} />
          <span>Reader notes</span>
        </label>
        <label>
          <input type="checkbox" checked={citations} onChange={(event) => setCitations(event.target.checked)} />
          <span>Cited-source cards</span>
        </label>
        <label>
          <input type="checkbox" checked={proofMaps} onChange={(event) => setProofMaps(event.target.checked)} />
          <span>AI proof maps</span>
        </label>
      </div>
      {error && <p className="panel-error">{error}</p>}
      {saved && <p className="panel-saved">Saved locally: {saved}</p>}
      <footer>
        <button onClick={() => void saveLatex()} disabled={savingLatex}>
          {savingLatex ? 'Saving LaTeX…' : 'Save complete LaTeX'}
        </button>
        <button onClick={() => void buildPrintView()}>Build PDF & print</button>
      </footer>
    </aside>
  );
}

type MarkupTool = 'highlight' | 'underline' | 'bold' | 'italic' | 'color';

function AnnotationToolbar({ close }: { close: () => void }) {
  const [highlightColor, setHighlightColor] = useState('#ffe58a');
  const [textColor, setTextColor] = useState('#8f1d2c');
  const [status, setStatus] = useState('Choose a tool, then select paper text.');
  const [undoCount, setUndoCount] = useState(0);
  const [activeTool, setActiveTool] = useState<MarkupTool | 'erase' | null>(null);
  const undoRef = useRef<HTMLElement[][]>([]);
  const selectedRangeRef = useRef<Range | null>(null);
  const activeToolRef = useRef<MarkupTool | 'erase' | null>(null);
  const autoActionRef = useRef<(tool: MarkupTool | 'erase') => void>(() => undefined);
  useEffect(() => {
    const remember = () => {
      const selection = window.getSelection();
      const paperRoot = document.querySelector('.reader-document');
      if (
        selection &&
        selection.rangeCount > 0 &&
        !selection.isCollapsed &&
        selection.toString().trim() &&
        paperRoot?.contains(selection.getRangeAt(0).commonAncestorContainer)
      )
        selectedRangeRef.current = selection.getRangeAt(0).cloneRange();
    };
    remember();
    document.addEventListener('selectionchange', remember);
    document.addEventListener('pointerup', remember, true);
    return () => {
      document.removeEventListener('selectionchange', remember);
      document.removeEventListener('pointerup', remember, true);
    };
  }, []);
  function selectedRange() {
    const selection = window.getSelection();
    const paperRoot = document.querySelector('.reader-document');
    if (
      selection &&
      selection.rangeCount > 0 &&
      !selection.isCollapsed &&
      selection.toString().trim() &&
      paperRoot?.contains(selection.getRangeAt(0).commonAncestorContainer)
    )
      return selection.getRangeAt(0).cloneRange();
    const remembered = selectedRangeRef.current;
    return remembered && paperRoot?.contains(remembered.commonAncestorContainer) ? remembered.cloneRange() : null;
  }
  function selectableTextNodes(range: Range) {
    const common = range.commonAncestorContainer;
    const root = common.nodeType === window.Node.TEXT_NODE ? common.parentNode : common;
    if (!root) return [] as Text[];
    const nodes: Text[] = [];
    if (common.nodeType === window.Node.TEXT_NODE) nodes.push(common as Text);
    else {
      const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT);
      let current = walker.nextNode();
      while (current) {
        nodes.push(current as Text);
        current = walker.nextNode();
      }
    }
    return nodes.filter((node) => {
      const parent = node.parentElement;
      if (
        !parent ||
        !node.data.trim() ||
        parent.closest(
          '.reader-tool-dock,.annotation-toolbar,.reader-floating-panel,.editable-tex-source,button,input,textarea,select,.katex,.proof-line-gutter',
        )
      )
        return false;
      try {
        return range.intersectsNode(node);
      } catch {
        return false;
      }
    });
  }
  function apply(tool: MarkupTool) {
    const range = selectedRange();
    if (!range) {
      setStatus('Select some paper text first.');
      return;
    }
    const wrappers: HTMLElement[] = [];
    for (const node of selectableTextNodes(range)) {
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.data.length;
      if (end <= start) continue;
      const tail = node.splitText(end);
      void tail;
      const selected = node.splitText(start);
      const wrapper = document.createElement('span');
      wrapper.className = `reader-annotation reader-annotation-${tool}`;
      wrapper.dataset.readerAnnotation = tool;
      if (tool === 'highlight') wrapper.style.backgroundColor = highlightColor;
      if (tool === 'underline') {
        wrapper.style.textDecoration = `underline 2px ${textColor}`;
        wrapper.style.textUnderlineOffset = '3px';
      }
      if (tool === 'bold') wrapper.style.fontWeight = '800';
      if (tool === 'italic') wrapper.style.fontStyle = 'italic';
      if (tool === 'color') wrapper.style.color = textColor;
      selected.parentNode?.replaceChild(wrapper, selected);
      wrapper.appendChild(selected);
      wrappers.push(wrapper);
    }
    window.getSelection()?.removeAllRanges();
    selectedRangeRef.current = null;
    if (!wrappers.length) {
      setStatus('That selection contains no editable paper text.');
      return;
    }
    undoRef.current.push(wrappers);
    setUndoCount(undoRef.current.length);
    setStatus(`${tool[0].toUpperCase() + tool.slice(1)} applied.`);
  }
  function erase() {
    const range = selectedRange();
    if (!range) {
      setStatus('Select marked text to erase its formatting.');
      return;
    }
    const marks = [...document.querySelectorAll<HTMLElement>('.reader-document .reader-annotation')].filter(
      (element) => {
        try {
          return range.intersectsNode(element);
        } catch {
          return false;
        }
      },
    );
    for (const mark of marks) mark.replaceWith(...mark.childNodes);
    window.getSelection()?.removeAllRanges();
    selectedRangeRef.current = null;
    setStatus(marks.length ? 'Formatting erased.' : 'No markup was found in that selection.');
  }
  function undo() {
    const wrappers = undoRef.current.pop() ?? [];
    for (const wrapper of wrappers) if (wrapper.isConnected) wrapper.replaceWith(...wrapper.childNodes);
    setUndoCount(undoRef.current.length);
    setStatus(wrappers.length ? 'Last markup undone.' : 'Nothing to undo.');
  }
  function chooseTool(tool: MarkupTool | 'erase') {
    setActiveTool(tool);
    activeToolRef.current = tool;
    if (selectedRange()) {
      if (tool === 'erase') erase();
      else apply(tool);
    } else
      setStatus(
        `${tool === 'erase' ? 'Eraser' : tool[0].toUpperCase() + tool.slice(1)} active — select text to apply.`,
      );
  }
  useEffect(() => {
    autoActionRef.current = (tool) => {
      if (tool === 'erase') erase();
      else apply(tool);
    };
  });
  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);
  useEffect(() => {
    document.body.dataset.readerMarkupActive = 'true';
    return () => {
      delete document.body.dataset.readerMarkupActive;
    };
  }, []);
  useEffect(() => {
    let startCaret: Range | null = null;
    let startPoint: { x: number; y: number } | null = null;
    const caretAt = (x: number, y: number) => {
      const extended = document as Document & {
        caretRangeFromPoint?: (left: number, top: number) => Range | null;
        caretPositionFromPoint?: (left: number, top: number) => { offsetNode: Node; offset: number } | null;
      };
      const direct = extended.caretRangeFromPoint?.(x, y);
      if (direct) return direct;
      const position = extended.caretPositionFromPoint?.(x, y);
      if (!position) return null;
      const range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
      return range;
    };
    const insidePaper = (target: EventTarget | null) =>
      target instanceof Node &&
      Boolean(document.querySelector('.reader-document')?.contains(target)) &&
      !(
        target instanceof Element &&
        Boolean(
          target.closest('button,input,textarea,select,.editable-tex-source,.reader-floating-panel,.reader-tool-dock'),
        )
      );
    const beginSelection = (event: PointerEvent) => {
      if (!activeToolRef.current || !insidePaper(event.target)) return;
      startCaret = caretAt(event.clientX, event.clientY);
      startPoint = { x: event.clientX, y: event.clientY };
    };
    const applyOnRelease = (event: PointerEvent) => {
      const tool = activeToolRef.current;
      const paperRoot = document.querySelector('.reader-document');
      if (!tool || !paperRoot?.contains(event.target as Node)) {
        startCaret = null;
        startPoint = null;
        return;
      }
      const selection = window.getSelection();
      if (
        (!selection || selection.isCollapsed || !selection.toString().trim()) &&
        startCaret &&
        startPoint &&
        Math.hypot(event.clientX - startPoint.x, event.clientY - startPoint.y) > 3
      ) {
        const endCaret = caretAt(event.clientX, event.clientY);
        if (endCaret && selection) {
          selection.removeAllRanges();
          selection.addRange(startCaret);
          selection.extend(endCaret.startContainer, endCaret.startOffset);
          if (selection.rangeCount && selection.toString().trim())
            selectedRangeRef.current = selection.getRangeAt(0).cloneRange();
        }
      }
      startCaret = null;
      startPoint = null;
      window.setTimeout(() => autoActionRef.current(tool), 0);
    };
    document.addEventListener('pointerdown', beginSelection, true);
    document.addEventListener('pointerup', applyOnRelease, true);
    return () => {
      document.removeEventListener('pointerdown', beginSelection, true);
      document.removeEventListener('pointerup', applyOnRelease, true);
    };
  }, []);
  const holdSelection = (event: ReactMouseEvent) => event.preventDefault();
  return (
    <aside
      className="annotation-toolbar reader-floating-panel"
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest('button')) event.preventDefault();
      }}
    >
      <header>
        <div>
          <b>Markup</b>
          <span>{status}</span>
        </div>
        <button onClick={close} aria-label="Close markup tools">
          ×
        </button>
      </header>
      <div className="annotation-tools">
        <button
          className={activeTool === 'highlight' ? 'active' : ''}
          onMouseDown={holdSelection}
          onClick={() => chooseTool('highlight')}
          title="Highlight text as you select it"
        >
          <i className="annotation-highlighter" style={{ background: highlightColor }} />
          Highlight
        </button>
        <label title="Highlight color">
          <input type="color" value={highlightColor} onChange={(event) => setHighlightColor(event.target.value)} />
          <span>Highlight color</span>
        </label>
        <button
          className={activeTool === 'underline' ? 'active' : ''}
          onMouseDown={holdSelection}
          onClick={() => chooseTool('underline')}
        >
          <u>U</u>Underline
        </button>
        <button
          className={activeTool === 'bold' ? 'active' : ''}
          onMouseDown={holdSelection}
          onClick={() => chooseTool('bold')}
        >
          <b>B</b>Bold
        </button>
        <button
          className={activeTool === 'italic' ? 'active' : ''}
          onMouseDown={holdSelection}
          onClick={() => chooseTool('italic')}
        >
          <i>I</i>Italic
        </button>
        <button
          className={activeTool === 'color' ? 'active' : ''}
          onMouseDown={holdSelection}
          onClick={() => chooseTool('color')}
        >
          <span style={{ color: textColor }}>A</span>Text color
        </button>
        <label title="Text and underline color">
          <input type="color" value={textColor} onChange={(event) => setTextColor(event.target.value)} />
          <span>Text color</span>
        </label>
        <button
          className={activeTool === 'erase' ? 'active' : ''}
          onMouseDown={holdSelection}
          onClick={() => chooseTool('erase')}
        >
          <span>⌫</span>Eraser
        </button>
        <button onMouseDown={holdSelection} onClick={undo} disabled={!undoCount}>
          <span>↶</span>Undo
        </button>
      </div>
    </aside>
  );
}

function ReferenceReaderPanel({
  paper,
  graph,
  target,
  setTarget,
  attach,
  close,
  cited,
  libraryByArxivId,
  addCitedPapers,
  openPaper,
}: {
  paper: Paper;
  graph: Graph;
  target: ReferenceTarget | null;
  setTarget: (value: ReferenceTarget | null) => void;
  attach: (citation: CitationReference, file: File) => Promise<string>;
  close: () => void;
  cited: CitedArxivPaper[];
  libraryByArxivId: Record<string, string>;
  addCitedPapers: (arxivIds: string[]) => Promise<void>;
  openPaper: (paperId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const missing = cited.filter((item) => !libraryByArxivId[arxivKey(item.arxivId)]);
  async function add(arxivIds: string[]) {
    setAdding(true);
    try {
      await addCitedPapers(arxivIds);
    } finally {
      setAdding(false);
    }
  }
  const targetPaperId = target?.arxivId ? libraryByArxivId[arxivKey(target.arxivId)] : undefined;
  const [value, setValue] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const papers = useMemo(
    () => [
      ...new Map(
        graph.nodes
          .filter((item) => item.paperId !== paper.id)
          .map((item) => [item.paperId, { id: item.paperId, title: item.paperTitle, arxivId: item.arxivId }]),
      ).values(),
    ],
    [graph.nodes, paper.id],
  );
  function openValue() {
    const id = (
      value.match(/(?:abs|pdf)\/([^?#]+)|(?:arxiv:)?\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)/i)?.[1] ||
      value.match(/(?:abs|pdf)\/([^?#]+)|(?:arxiv:)?\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)/i)?.[2] ||
      ''
    ).replace(/\.pdf$/i, '');
    if (id) setTarget({ title: `arXiv:${id}`, arxivId: id, url: `https://arxiv.org/pdf/${id}` });
    else if (/^https?:\/\//i.test(value.trim())) setTarget({ title: value.trim(), url: value.trim() });
  }
  async function upload(file: File) {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['pdf', 'tex', 'ltx', 'zip'].includes(extension)) {
      setUploadStatus('Choose one PDF, TeX file, or ZIP project.');
      return;
    }
    setUploading(true);
    setUploadStatus('');
    try {
      const citation: CitationReference = {
        key: `reader-upload-${Date.now()}`,
        locator: '',
        statement: '',
        title: file.name,
        authors: '',
        text: '',
        url: '',
        searchUrl: '',
        doi: '',
        arxivId: '',
        direct: true,
      };
      await attach(citation, file);
      const previewable = extension !== 'zip';
      setTarget({ title: file.name, url: previewable ? URL.createObjectURL(file) : undefined });
      setUploadStatus(previewable ? 'Attached locally' : 'ZIP source project attached locally');
    } catch (error) {
      setUploadStatus(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }
  function beginDrag(event: ReactPointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('button,select,input,a')) return;
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!rect) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ dx: event.clientX - rect.left, dy: event.clientY - rect.top });
    setPosition({ x: rect.left, y: rect.top });
  }
  function moveDrag(event: ReactPointerEvent<HTMLElement>) {
    if (!drag) return;
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    const width = rect?.width || 660;
    const height = rect?.height || 720;
    setPosition({
      x: Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - drag.dx)),
      y: Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - drag.dy)),
    });
  }
  return (
    <aside
      className="reference-reader reader-floating-panel"
      style={position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : undefined}
    >
      <header onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={() => setDrag(null)}>
        <div>
          <b>Reference reader</b>
          {target?.title && <span>{target.title}</span>}
        </div>
        <div>
          {target?.arxivId &&
            target.paperId !== paper.id &&
            (targetPaperId ? (
              <button onClick={() => openPaper(targetPaperId)}>Open in reader</button>
            ) : (
              <button onClick={() => void add([target.arxivId ?? ''])} disabled={adding}>
                {adding ? 'Adding…' : 'Add to library'}
              </button>
            ))}
          {target?.url && (
            <a href={target.url} target="_blank" rel="noreferrer">
              Browser ↗
            </a>
          )}
          <button onClick={close} aria-label="Close reference reader">
            ×
          </button>
        </div>
      </header>
      <div className="reference-chooser">
        <select
          value=""
          onChange={(event) => {
            const selected = papers.find((item) => item.id === event.target.value);
            if (selected)
              setTarget({
                title: selected.title,
                arxivId: selected.arxivId,
                paperId: selected.id,
                url: originalPaperUrl(selected),
              });
          }}
        >
          <option value="">Open from Library…</option>
          {papers.filter(hasOriginalPaper).map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
        <div>
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') openValue();
            }}
            placeholder="arXiv ID or URL"
          />
          <button onClick={openValue} disabled={!value.trim()}>
            Open
          </button>
        </div>
        <label className="reference-upload">
          <input
            type="file"
            accept=".pdf,.tex,.ltx,.zip,application/pdf,application/zip,text/plain"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = '';
            }}
          />
          <span>{uploading ? 'Attaching…' : 'Upload PDF / TeX / ZIP'}</span>
          <small>ZIP for multiple files</small>
        </label>
        {uploadStatus && <p className="reference-upload-status">{uploadStatus}</p>}
      </div>
      {cited.length > 0 && (
        <details className="reference-cited">
          <summary>
            Cited on arXiv · {cited.length}
            {missing.length > 0 && (
              <button
                onClick={(event) => {
                  event.preventDefault();
                  void add(missing.map((item) => item.arxivId));
                }}
                disabled={adding}
              >
                {adding ? 'Adding…' : `Add ${missing.length} to library`}
              </button>
            )}
          </summary>
          <ul>
            {cited.map((item) => {
              const paperId = libraryByArxivId[arxivKey(item.arxivId)];
              return (
                <li key={item.arxivId}>
                  <button
                    className="reference-cited-title"
                    onClick={() =>
                      setTarget({
                        title: item.title,
                        arxivId: item.arxivId,
                        url: `https://arxiv.org/pdf/${item.arxivId}`,
                      })
                    }
                  >
                    <small>
                      [{item.key}] arXiv:{item.arxivId}
                    </small>
                    <MathText value={item.title} />
                  </button>
                  {paperId ? (
                    <button onClick={() => openPaper(paperId)}>Open</button>
                  ) : (
                    <button onClick={() => void add([item.arxivId])} disabled={adding}>
                      Add
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {target?.url ? (
        <iframe title={`Reference: ${target.title}`} src={target.url} />
      ) : (
        <div className="reference-empty">
          <ReaderIcon name="reference" />
          <b>{target ? target.title : 'Open a paper'}</b>
        </div>
      )}
    </aside>
  );
}

function PaperChatDialog({
  paper,
  currentNode,
  messages,
  question,
  setQuestion,
  asking,
  ask,
  close,
}: {
  paper: Paper;
  currentNode?: AuditNode;
  messages: { role: 'user' | 'assistant'; text: string }[];
  question: string;
  setQuestion: (value: string) => void;
  asking: boolean;
  ask: () => void;
  close: () => void;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  function beginDrag(event: ReactPointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('button')) return;
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!rect) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ dx: event.clientX - rect.left, dy: event.clientY - rect.top });
    setPosition({ x: rect.left, y: rect.top });
  }
  function moveDrag(event: ReactPointerEvent<HTMLElement>) {
    if (!drag) return;
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    const width = rect?.width || 620;
    const height = rect?.height || 640;
    setPosition({
      x: Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - drag.dx)),
      y: Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - drag.dy)),
    });
  }
  function endDrag(event: ReactPointerEvent<HTMLElement>) {
    if (drag) event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
  }
  return (
    <div className="paper-chat-shell">
      <section
        className="paper-chat-dialog"
        data-reader-floating-panel
        style={position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : undefined}
      >
        <header onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <div>
            <b>Ask AI</b>
            {currentNode && <small>Near {displayUnitLabel(currentNode)}</small>}
          </div>
          <button onClick={close} aria-label="Close paper conversation">
            ×
          </button>
        </header>
        <div className="paper-chat-messages">
          {messages.length ? (
            messages.map((message, index) => (
              <article key={index} className={`paper-chat-${message.role}`}>
                <b>{message.role === 'user' ? 'You' : 'Local Codex'}</b>
                <MathText value={message.text} block />
              </article>
            ))
          ) : (
            <div className="paper-chat-empty">
              <b>
                <MathText value={paper.title} />
              </b>
            </div>
          )}
          {asking && (
            <div className="paper-chat-thinking">
              <i />
              <i />
              <i />
              <span>Reading…</span>
            </div>
          )}
        </div>
        <footer>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') ask();
            }}
            placeholder="Ask about this paper…"
            autoFocus
          />
          <div>
            <span>⌘ Enter</span>
            <button onClick={ask} disabled={asking || !question.trim()}>
              {asking ? 'Reading…' : 'Ask'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function ExportPaperPanel({
  paper,
  audit,
  nodes,
  patches,
  focusIds,
  readerNotes,
  notes,
  focusActive,
  close,
}: {
  paper: Paper;
  audit: PaperAudit;
  nodes: AuditNode[];
  patches: WorkingPatch[];
  focusIds: string[];
  readerNotes: Record<string, string>;
  notes: Note[];
  focusActive: boolean;
  close: () => void;
}) {
  const [selection, setSelection] = useState<ExportSelection>({
    abstract: true,
    prose: true,
    statements: true,
    proofs: true,
    figures: true,
    citations: true,
    audit: false,
    notes: true,
    focusedOnly: focusActive,
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const choices: { key: keyof ExportSelection; label: string; detail: string }[] = [
    { key: 'abstract', label: 'Abstract', detail: 'Title, authors, and abstract' },
    { key: 'prose', label: 'Paper prose', detail: 'Section headings and author paragraphs' },
    { key: 'statements', label: 'Formal statements', detail: 'Definitions, lemmas, propositions, and theorems' },
    { key: 'proofs', label: 'Complete proofs', detail: 'Full author proofs, not proof maps' },
    { key: 'figures', label: 'Figures', detail: 'Links to original local assets' },
    { key: 'citations', label: 'References', detail: 'Resolved alpha-style bibliography' },
    { key: 'audit', label: 'AI audit guide', detail: 'Central question and contribution' },
    { key: 'notes', label: 'Reader notes', detail: 'Notes linked to included results' },
  ];
  async function save() {
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const content = buildPaperExport(paper, audit, nodes, patches, readerNotes, notes, selection, focusIds);
      const fileName = `${paper.arxivId.replace(/[^a-zA-Z0-9.-]+/g, '-')}-${selection.focusedOnly ? 'focused-' : ''}reading-edition.md`;
      const data = await bridgePost(
        '/vault/export',
        { paperId: paper.id, export: { fileName, content, selection } },
        'The paper selection could not be saved.',
      );
      setSaved(readString(data.saved?.relativePath));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The paper selection could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="export-paper-panel">
      <header>
        <div>
          <b>Save a reading edition</b>
          <span>Choose exactly what belongs in this local copy.</span>
        </div>
        <button onClick={close}>×</button>
      </header>
      <label className="export-focus">
        <input
          type="checkbox"
          checked={selection.focusedOnly}
          disabled={!focusIds.length}
          onChange={(event) => setSelection({ ...selection, focusedOnly: event.target.checked })}
        />
        <span>
          <b>Only the current focus</b>
          <small>
            {focusIds.length
              ? `${focusIds.length} result${focusIds.length === 1 ? '' : 's'} and prerequisites`
              : 'Choose a focus path first'}
          </small>
        </span>
      </label>
      <div className="export-choices">
        {choices.map((choice) => (
          <label key={choice.key}>
            <input
              type="checkbox"
              checked={selection[choice.key]}
              onChange={(event) => setSelection({ ...selection, [choice.key]: event.target.checked })}
            />
            <span>
              <b>{choice.label}</b>
              <small>{choice.detail}</small>
            </span>
          </label>
        ))}
      </div>
      {error && <p className="export-error">{error}</p>}
      {saved && <p className="export-saved">Saved locally: {saved}</p>}
      <footer>
        <button onClick={close}>Close</button>
        <button onClick={() => void save()} disabled={busy || !choices.some((choice) => selection[choice.key])}>
          {busy ? 'Saving…' : 'Save to paper folder'}
        </button>
      </footer>
    </aside>
  );
}

function EmptyVault({ onImport }: { onImport: () => void }) {
  return (
    <section className="mx-auto max-w-3xl px-6 py-14">
      <div className="rounded-xl border border-dashed border-[#ccd9cd] bg-white p-9 text-center">
        <h2 className="text-2xl font-bold tracking-[-.04em]">Import a paper to begin.</h2>
        <button onClick={onImport} className="mt-6 rounded-md bg-[#2d654f] px-4 py-2.5 text-xs font-bold text-white">
          Import paper
        </button>
      </div>
    </section>
  );
}
