'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BrandMascot, RailIcon } from './components/icons';
import { PaperUpdatePanel } from './components/inspector';
import { MathText } from './components/math';
import { Reader } from './components/reader';
import { Discover, GraphView, ImportDialog, Library, ModelControls, OnboardingDialog, ProcessTray, Settings } from './components/views';
import { bridgeUrl, defaultProfile, emptyGraph, emptyPatches, emptyRecord, fallbackDiscoveries, fileAsBase64, makeId, normalizeReaderProfile, onboardingCompleteKey, paperChatAnswerKey, parseJsonObject, preferenceKey, readServiceResponse, readStorage, readString, reasoningDefaultMigrationKey, reportReaderProcess, selectedPaperKey, writeStorage } from './lib/app';
import { arxivBaseId, arxivVersionNumber, automaticEditorialPatches, displayUnitLabel, migrateReaderWork, normalizeAuditCitations, normalizeNotes, parseAudit, parseVersionComparison } from './lib/audit';
import type { AuditJob, AuditNode, Bridge, CrossLink, EditorialSuggestion, Graph, Note, Paper, PaperAudit, PaperJobKind, PaperUpdateRecord, Profile, ReaderNavigationRequest, ReaderProcessTarget, ReadingMark, VaultSnapshot, View, WorkingPatch } from './lib/types';

type ReaderStateSlices = { notes: Note[]; nodeNotes: Record<string, Record<string, string>>; nodeAnswers: Record<string, Record<string, string>>; expanded: Record<string, Record<string, boolean>>; marks: Record<string, Record<string, Exclude<ReadingMark, ''>>> };

// State updates replace only the slice of the paper they touch, so comparing
// slices by identity finds every paper whose reader state needs saving.
function changedReaderPapers(previous: ReaderStateSlices, next: ReaderStateSlices) {
  const changed = new Set<string>();
  for (const key of ['nodeNotes', 'nodeAnswers', 'expanded', 'marks'] as const) {
    const before: Record<string, unknown> = previous[key]; const after: Record<string, unknown> = next[key];
    if (before === after) continue;
    for (const paperId of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[paperId] !== after[paperId]) changed.add(paperId);
  }
  if (previous.notes !== next.notes) {
    const byPaper = (notes: Note[]) => { const groups = new Map<string, Note[]>(); for (const note of notes) { const group = groups.get(note.paperId); if (group) group.push(note); else groups.set(note.paperId, [note]); } return groups; };
    const before = byPaper(previous.notes); const after = byPaper(next.notes);
    for (const paperId of new Set([...before.keys(), ...after.keys()])) {
      const left = before.get(paperId) ?? []; const right = after.get(paperId) ?? [];
      if (left.length !== right.length || left.some((note, index) => note !== right[index])) changed.add(paperId);
    }
  }
  return changed;
}

function saveReaderState(paperId: string, state: ReaderStateSlices) {
  const body = JSON.stringify({ paperId, reader: { notes: state.notes.filter((item) => item.paperId === paperId), nodeNotes: state.nodeNotes[paperId] ?? {}, nodeAnswers: state.nodeAnswers[paperId] ?? {}, expanded: state.expanded[paperId] ?? {}, marks: state.marks[paperId] ?? {} } });
  // keepalive lets a save started as the tab closes complete; browsers cap it at 64 KB.
  return fetch(`${bridgeUrl}/vault/reader`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < 20_000 });
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
  const [readerNavigationRequest, setReaderNavigationRequest] = useState<ReaderNavigationRequest | null>(null);
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [vaultReady, setVaultReady] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [loadingDiscoveries, setLoadingDiscoveries] = useState(false);
  const [notice, setNotice] = useState('');
  const noticeTimerRef = useRef<number | undefined>(undefined);

  const paper = papers.find((item) => item.id === selectedPaperId) ?? papers[0];
  const audit = paper ? audits[paper.id] : undefined;
  const auditJob = paper ? auditJobs[paper.id] : undefined;
  const activePaperId = paper?.id ?? '';
  const activePaperNotes = useMemo(() => activePaperId ? notes.filter((item) => item.paperId === activePaperId) : [], [activePaperId, notes]);
  const readerState = useMemo<ReaderStateSlices>(() => ({ notes, nodeNotes, nodeAnswers, expanded, marks }), [notes, nodeNotes, nodeAnswers, expanded, marks]);
  const savedReaderStateRef = useRef<ReaderStateSlices | null>(null);
  const readerSnapshotAppliedRef = useRef(false);
  const dirtyReaderPapersRef = useRef(new Set<string>());
  const readerSaveTimerRef = useRef<number | undefined>(undefined);
  const flushReaderSavesRef = useRef(() => {});

  function notify(message: string) { setNotice(message); window.clearTimeout(noticeTimerRef.current); noticeTimerRef.current = window.setTimeout(() => setNotice(''), 8500); }
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
    readerSnapshotAppliedRef.current = true; dirtyReaderPapersRef.current.clear();
    setPapers(snapshot.papers); setAudits(Object.fromEntries(Object.entries(snapshot.audits).map(([paperId, paperAudit]) => [paperId, normalizeAuditCitations(paperAudit)]))); setNotes(normalizeNotes(snapshot.notes)); setNodeNotes(snapshot.nodeNotes); setNodeAnswers(snapshot.nodeAnswers); setExpanded(snapshot.expanded); setMarks(snapshot.marks ?? {}); setPatches(snapshot.patches ?? {}); setUpdates(snapshot.updates ?? {}); setAuditJobs(snapshot.auditJobs ?? {}); setLinks(snapshot.links); setGraph(snapshot.graph ?? emptyGraph);
    if (snapshot.profile) { const next = normalizeReaderProfile(snapshot.profile); if (!readStorage(reasoningDefaultMigrationKey)) writeStorage(reasoningDefaultMigrationKey, 'applied'); setProfile(next); }
    setSelectedPaperId((current) => {
      if (snapshot.papers.some((item) => item.id === current)) return current;
      const saved = readStorage(selectedPaperKey) ?? '';
      return snapshot.papers.some((item) => item.id === saved) ? saved : snapshot.papers[0]?.id ?? '';
    });
  }
  async function refreshBridge() { try { const response = await fetch(`${bridgeUrl}/status`); const data = await response.json() as Bridge; setBridge(data); if (data.models?.length) setProfile((current) => data.models.some((item) => item.id === current.model) ? current : { ...current, model: data.models.find((item) => item.isDefault)?.id ?? '' }); } catch { setBridge(null); } }
  async function loadVault() {
    const locallySaved = readStorage(preferenceKey); const setupCompleted = readStorage(onboardingCompleteKey) === 'complete';
    function restoreLocalProfile() {
      if (!locallySaved) return false;
      try { setProfile(normalizeReaderProfile(JSON.parse(locallySaved))); writeStorage(onboardingCompleteKey, 'complete'); return true; }
      catch { return false; }
    }
    try {
      const response = await fetch(`${bridgeUrl}/vault`); if (!response.ok) throw new Error(); const snapshot = await response.json() as VaultSnapshot; applySnapshot(snapshot);
      if (snapshot.profile) writeStorage(onboardingCompleteKey, 'complete');
      else if (!restoreLocalProfile() && !setupCompleted) setOnboardingOpen(true);
    } catch { if (!restoreLocalProfile() && !setupCompleted) setOnboardingOpen(true); }
    finally { setVaultReady(true); }
  }
  function completeOnboarding() {
    const completedProfile = { ...profile, reasoningConfigured: true };
    setProfile(completedProfile); writeStorage(preferenceKey, JSON.stringify(completedProfile)); writeStorage(onboardingCompleteKey, 'complete'); setOnboardingOpen(false);
    void fetch(`${bridgeUrl}/vault/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: completedProfile }) });
  }
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadVault(); void refreshBridge(); }, 0);
    return () => window.clearTimeout(timer);
    // The bridge functions intentionally run once when this local reader mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (!vaultReady || onboardingOpen) return; writeStorage(preferenceKey, JSON.stringify(profile)); void fetch(`${bridgeUrl}/vault/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile }) }); }, [profile, vaultReady, onboardingOpen]);
  useEffect(() => { if (vaultReady && selectedPaperId) writeStorage(selectedPaperKey, selectedPaperId); }, [selectedPaperId, vaultReady]);
  // Reader state is saved per paper. Every paper whose slice changed is saved
  // after a short pause, so an AI answer that lands after switching papers, or an
  // edit made just before a switch, reaches the vault. Papers with a running
  // audit or update wait until that job finishes, as before.
  useEffect(() => {
    flushReaderSavesRef.current = () => {
      window.clearTimeout(readerSaveTimerRef.current);
      for (const paperId of [...dirtyReaderPapersRef.current]) {
        if (paperJobs[paperId]) continue;
        dirtyReaderPapersRef.current.delete(paperId);
        saveReaderState(paperId, readerState).then((response) => { if (!response.ok) throw new Error(); }).catch(() => {
          dirtyReaderPapersRef.current.add(paperId);
          notify('Some reader changes could not be saved locally. They will be retried with your next change.');
        });
      }
    };
  });
  useEffect(() => {
    if (!vaultReady) return;
    const previous = savedReaderStateRef.current; savedReaderStateRef.current = readerState;
    if (!previous || readerSnapshotAppliedRef.current) { readerSnapshotAppliedRef.current = false; return; }
    for (const paperId of changedReaderPapers(previous, readerState)) dirtyReaderPapersRef.current.add(paperId);
    if (!dirtyReaderPapersRef.current.size) return;
    window.clearTimeout(readerSaveTimerRef.current);
    readerSaveTimerRef.current = window.setTimeout(() => flushReaderSavesRef.current(), 500);
  }, [vaultReady, readerState]);
  useEffect(() => {
    if (!dirtyReaderPapersRef.current.size) return;
    window.clearTimeout(readerSaveTimerRef.current);
    readerSaveTimerRef.current = window.setTimeout(() => flushReaderSavesRef.current(), 500);
  }, [paperJobs]);
  useEffect(() => {
    const flush = () => flushReaderSavesRef.current();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

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
      const automatic = automaticEditorialPatches(next, patches[stored.id] ?? []);
      const prior = (patches[stored.id] ?? []).filter((patch) => !(patch.kind === 'replace' && patch.source === 'ai')); const correctedPatches = [...prior, ...automatic];
      if (automatic.length) { const correctionResponse = await fetch(`${bridgeUrl}/vault/patches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId: stored.id, patches: correctedPatches }) }); const correctionData = await readServiceResponse(correctionResponse); if (!correctionResponse.ok) throw new Error(correctionData.error || 'Could not save audited typo corrections.'); setPatches((current) => ({ ...current, [stored.id]: correctionData.patches ?? [] })); }
      const sourceLabel = data.primarySource?.kind === 'tex' ? 'TeX-first source' : data.primarySource?.kind === 'ai-tex' ? 'AI-converted LaTeX source' : 'PDF fallback';
      const savedPaper = snapshot.paper;
      setPapers((current) => [savedPaper, ...current.filter((item) => item.id !== stored.id && item.arxivId !== stored.arxivId)]); setAudits((current) => ({ ...current, [stored.id]: next })); setAuditJobs((current) => { const nextJobs = { ...current }; delete nextJobs[stored.id]; return nextJobs; }); setGraph(snapshot.graph ?? emptyGraph); setLinks(snapshot.links ?? []); reportReaderProcess({ id: processId, label: 'AI audit complete', detail: stored.title, status: 'complete' }); notify(`“${stored.title}” is ready · ${next.nodes.length} audited units · ${sourceLabel}${automatic.length ? ` · ${automatic.length} verified typo correction${automatic.length === 1 ? '' : 's'} highlighted` : ''}.`); void refreshBridge();
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
  async function askNode(targetNode: AuditNode, question: string) { if (!audit || !paper || !question.trim()) return; const processId = `node-question:${paper.id}:${targetNode.id}`; const resultTarget: ReaderProcessTarget = { paperId: paper.id, nodeId: targetNode.id, panel: 'assistant' }; reportReaderProcess({ id: processId, label: 'AI question', detail: displayUnitLabel(targetNode), status: 'running', resultTarget }); setAskingId(targetNode.id); try { const response = await fetch(`${bridgeUrl}/node-question`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paper, profile, node: targetNode, question, threadId: audit.threadId }) }); const data = await readServiceResponse(response); if (!response.ok) throw new Error(data.error || 'Codex did not answer this unit.'); rememberAuditThread(paper.id, readString(data.threadId)); setNodeAnswers((current) => ({ ...current, [paper.id]: { ...current[paper.id], [targetNode.id]: readString(data.text) } })); reportReaderProcess({ id: processId, label: 'AI answer ready', detail: displayUnitLabel(targetNode), status: 'complete', resultTarget }); } catch (error) { const message = error instanceof Error ? error.message : 'The local Codex question failed.'; reportReaderProcess({ id: processId, label: 'AI question stopped', detail: message, status: 'error' }); notify(message); } finally { setAskingId(null); } }
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
  function openProcessResult(target: ReaderProcessTarget) {
    if (!papers.some((item) => item.id === target.paperId)) { notify('This paper is no longer in the library.'); return; }
    setSelectedPaperId(target.paperId); if (target.nodeId) setSelectedNodeId(target.nodeId); setView('reader');
    setReaderNavigationRequest((current) => ({ ...target, nonce: (current?.nonce ?? 0) + 1 }));
  }

  return <main className={`app-shell min-h-screen bg-[#f8f8f5] text-[#20251f] lg:grid lg:grid-cols-[54px_235px_minmax(0,1fr)] ${view === 'reader' ? 'app-reader-mode' : ''} ${view === 'discover' ? '' : 'app-no-vault'} ${vaultSidebarOpen ? '' : 'app-vault-collapsed'}`}>
    <nav className="hidden min-h-screen flex-col items-center gap-2 border-r border-[#e0e4dd] bg-[#273b31] py-4 text-[#dfece4] lg:flex"><div className="brand-rail-mark mb-4" title="arXivpecker"><BrandMascot compact /></div>{([['reader', 'Read'], ['library', 'Library'], ['discover', 'Discover'], ['settings', 'Settings']] as const).map(([target, label]) => <button key={target} onClick={() => setView(target)} title={label} aria-label={label} className={`grid h-9 w-9 place-items-center rounded-lg ${view === target ? 'bg-[#476956] text-white' : 'hover:bg-[#3b5b49]'}`}><RailIcon name={target} /></button>)}<div className="flex-1" /><button onClick={() => window.dispatchEvent(new Event('proofroom:toggle-process-tray'))} title="Show or hide AI activity" aria-label="Show or hide AI activity" className={`bridge-status-light mb-2 ${bridge?.account ? 'bridge-ready' : 'bridge-unavailable'}`} /></nav>
    <nav className="mobile-app-nav lg:hidden" aria-label="Main navigation"><div title="arXivpecker"><BrandMascot compact /></div>{([['reader', 'Read'], ['library', 'Library'], ['discover', 'Discover'], ['settings', 'Settings']] as const).map(([target, label]) => <button key={target} onClick={() => setView(target)} aria-label={label} className={view === target ? 'active' : ''}><RailIcon name={target} /><span>{label}</span></button>)}<button onClick={() => window.dispatchEvent(new Event('proofroom:toggle-process-tray'))} aria-label="AI activity" className="mobile-activity-button"><i className={`bridge-status-light ${bridge?.account ? 'bridge-ready' : 'bridge-unavailable'}`} /><span>AI</span></button></nav>
    {view === 'discover' && <aside className={`local-vault-sidebar hidden min-h-screen flex-col border-r border-[#e2e6e0] bg-[#f0f2ed] p-4 lg:flex ${vaultSidebarOpen ? '' : 'collapsed'}`}><div className="flex items-start justify-between"><div><h1 className="text-lg font-bold tracking-[-.04em]">Papers</h1></div><div className="vault-head-actions"><button onClick={() => setVaultSidebarOpen(false)} title="Collapse papers" aria-label="Collapse papers">‹</button><button onClick={() => setImporting(true)} title="Import paper" aria-label="Import paper">+</button></div></div><button onClick={() => setImporting(true)} className="my-4 rounded-md bg-[#deebe1] px-3 py-2 text-left text-[11px] font-bold text-[#2d604b]">+ Import paper</button><div className="mb-2 flex justify-between text-[10px] font-bold text-[#677068]"><span>YOUR LIBRARY</span><span>{papers.length}</span></div><div className="min-h-0 flex-1 space-y-1 overflow-y-auto">{papers.length ? papers.map((item) => <button key={item.id} onClick={() => { setSelectedPaperId(item.id); setView('reader'); }} className="w-full rounded-lg p-2 text-left hover:bg-[#e7ebe6]"><span className="flex items-start gap-2"><i className={`mt-1 h-1.5 w-1.5 flex-none rounded-full ${audits[item.id] ? 'bg-[#499b70]' : 'bg-[#d6b756]'}`} /><span><b className="block text-[11px] leading-[1.35]"><MathText value={item.title} /></b><small className="mt-1 block text-[9px] text-[#788178]">{item.arxivId}</small></span></span></button>) : <p className="rounded-lg border border-dashed border-[#d5ddd5] p-3 text-[11px] leading-5 text-[#788178]">Import a paper to begin.</p>}</div></aside>}{!vaultSidebarOpen && view === 'discover' && <button className="vault-reopen hidden lg:grid" onClick={() => setVaultSidebarOpen(true)} title="Expand papers" aria-label="Expand papers">›</button>}
    <section className="min-w-0"><header className="app-header"><div className="app-header-title">{view === 'reader' && paper ? <><span /><MathText value={paper.title} /></> : view === 'graph' ? 'Local dependency graph' : view[0].toUpperCase() + view.slice(1)}</div><div className="app-header-actions"><ModelControls profile={profile} setProfile={setProfile} bridge={bridge} compact /><button onClick={() => setImporting(true)} className="header-import">+ Import</button></div></header>{notice && <div className="notice-banner">{notice}</div>}
      {view === 'reader' && <Reader paper={paper} audit={audit} openImport={() => setImporting(true)} selectedNodeId={selectedNodeId} setSelectedNodeId={setSelectedNodeId} expanded={paper ? expanded[paper.id] ?? emptyRecord : emptyRecord} setExpanded={(id, value) => paper && setExpanded((current) => ({ ...current, [paper.id]: { ...current[paper.id], [id]: value } }))} marks={paper ? marks[paper.id] ?? emptyRecord : emptyRecord} setMark={(id, value) => paper && setMarks((current) => { const paperMarks = { ...(current[paper.id] ?? {}) }; if (value) paperMarks[id] = value; else delete paperMarks[id]; return { ...current, [paper.id]: paperMarks }; })} readerNotes={paper ? nodeNotes[paper.id] ?? emptyRecord : emptyRecord} notes={activePaperNotes} answers={paper ? nodeAnswers[paper.id] ?? emptyRecord : emptyRecord} savePaperMessages={(messages) => paper && setNodeAnswers((current) => ({ ...current, [paper.id]: { ...(current[paper.id] ?? {}), [paperChatAnswerKey]: JSON.stringify(messages) } }))} patches={paper ? patches[paper.id] ?? emptyPatches : emptyPatches} savePatches={(next) => paper ? saveWorkingPatches(paper.id, next) : Promise.resolve()} suggestEdit={suggestEditorialFix} graph={graph} analysing={Boolean(paper && (paperJobs[paper.id] || auditJob?.state === 'running'))} auditActionLabel={auditJob?.state === 'paused' || auditJob?.state === 'preparing' ? 'Continue audit' : undefined} askingId={askingId} analyze={() => paper && void analyzePaper(paper)} askNode={askNode} rememberAuditThread={(threadId) => paper && rememberAuditThread(paper.id, threadId)} saveNote={saveNote} updateNote={updateNote} deleteNote={deleteNote} addLink={addLink} removeLink={removeLink} openUnit={openUnit} profile={profile} navigationRequest={readerNavigationRequest} />}
      {view === 'library' && <Library papers={papers} audits={audits} patches={patches} updates={updates} jobs={paperJobs} auditJobs={auditJobs} analyze={analyzePaper} refreshPaper={refreshArxivPaper} showUpdate={setUpdatePanel} updatePaper={updatePaperInfo} removePaper={removePaperFromVault} reorderPapers={reorderLibrary} openUnit={openUnit} openImport={() => setImporting(true)} />}
      {view === 'graph' && <GraphView graph={graph} papers={papers} openUnit={openUnit} />}
      {view === 'discover' && <Discover papers={discoveries} saved={papers} save={saveDiscovery} refresh={refreshDiscoveries} loading={loadingDiscoveries} selectedAreas={profile.areas} />}
      {view === 'settings' && <Settings profile={profile} setProfile={setProfile} bridge={bridge} />}
    </section>{onboardingOpen && <OnboardingDialog profile={profile} setProfile={setProfile} bridge={bridge} finish={completeOnboarding} />}{importing && <ImportDialog close={() => setImporting(false)} importArxiv={importArxiv} importLocalSource={importLocalSource} profile={profile} setProfile={setProfile} bridge={bridge} />}{updatePanel && <PaperUpdatePanel paper={papers.find((item) => item.id === updatePanel.paperId)} audit={audits[updatePanel.paperId]} update={updatePanel} openUnit={openUnit} close={() => setUpdatePanel(null)} />}<ProcessTray openResult={openProcessResult} retryAudit={(paperId) => { const target = papers.find((item) => item.id === paperId); if (target && !paperJobs[target.id]) void analyzePaper(target); }} />
  </main>;
}
