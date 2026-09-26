import { FormEvent, useEffect, useMemo, useState } from 'react';
import { ProcessMascot } from './icons';
import { MathText } from './math';
import {
  assistantSizeKey,
  defaultProfile,
  defaultReasoning,
  elapsedLabel,
  mathAreas,
  paperScaleKey,
  preferenceKey,
  readStorage,
  reportReaderProcess,
} from '../lib/app';
import { bridgeGet, bridgePost } from '../lib/bridge-client';
import { arxivBaseId, displayUnitLabel, kindClass, paperSourceLabel } from '../lib/audit';
import { searchablePaperText } from '../lib/tex-text';
import type {
  AuditJob,
  Bridge,
  CloudProviderStatus,
  CloudShareRecord,
  Graph,
  Paper,
  PaperAudit,
  PaperJobKind,
  PaperUpdateRecord,
  Profile,
  ReaderProcessTarget,
  ReaderProcessUpdate,
  WorkingPatch,
} from '../lib/types';

function CloudSharing({ papers }: { papers: Paper[] }) {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<CloudProviderStatus[]>([]);
  const [provider, setProvider] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState('My arXivpecker library');
  const [parts, setParts] = useState({
    source: true,
    audit: true,
    notes: true,
    edits: true,
    references: true,
    preferences: true,
  });
  const [gitRemote, setGitRemote] = useState('');
  const [gitBranch, setGitBranch] = useState('main');
  const [recent, setRecent] = useState<CloudShareRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<CloudShareRecord | null>(null);
  const [copied, setCopied] = useState(false);
  const currentProvider = providers.find((item) => item.id === provider);
  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const data = await bridgeGet<{ providers?: CloudProviderStatus[]; recent?: CloudShareRecord[] }>(
        '/cloud/status',
        'Cloud connections could not be checked.',
      );
      const available = data.providers ?? [];
      setProviders(available);
      setRecent(data.recent ?? []);
      setProvider((current) => current || available.find((item) => item.available)?.id || available[0]?.id || 'icloud');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Cloud connections could not be checked.');
    } finally {
      setLoading(false);
    }
  }
  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) {
      if (!selected.length) setSelected(papers.map((paper) => paper.id));
      void refresh();
    }
  }
  function togglePaper(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((paperId) => paperId !== id) : [...current, id]));
  }
  async function createShare() {
    if (!selected.length || !provider) return;
    const processId = `cloud-share:${Date.now()}`;
    reportReaderProcess({
      id: processId,
      label: 'Saving cloud share',
      detail: `${selected.length} paper${selected.length === 1 ? '' : 's'}`,
      status: 'running',
    });
    setSharing(true);
    setError('');
    setSaved(null);
    try {
      const localJson = (key: string) => {
        try {
          return JSON.parse(readStorage(key) || 'null');
        } catch {
          return null;
        }
      };
      const uiPreferences = {
        readerProfile: localJson(preferenceKey),
        paperScale: Number(readStorage(paperScaleKey) || 1),
        assistantSize: localJson(assistantSizeKey),
      };
      const data = await bridgePost(
        '/cloud/share',
        { provider, paperIds: selected, title, selection: parts, gitRemote, gitBranch, uiPreferences },
        'The cloud copy could not be created.',
        { require: ['share'] },
      );
      setSaved(data.share);
      setRecent((current) =>
        [data.share as CloudShareRecord, ...current.filter((item) => item.id !== data.share?.id)].slice(0, 20),
      );
      reportReaderProcess({
        id: processId,
        label: 'Cloud share saved',
        detail: data.share.location,
        status: 'complete',
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The cloud copy could not be created.';
      setError(message);
      reportReaderProcess({ id: processId, label: 'Cloud share stopped', detail: message, status: 'error' });
    } finally {
      setSharing(false);
    }
  }
  async function copyLocation() {
    if (!saved) return;
    await navigator.clipboard.writeText(saved.location);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }
  const partChoices: [keyof typeof parts, string][] = [
    ['source', 'Original source'],
    ['audit', 'AI audit'],
    ['notes', 'Notes & marks'],
    ['edits', 'Working changes'],
    ['references', 'References'],
    ['preferences', 'Reader preferences'],
  ];
  return (
    <section className={`cloud-sharing ${open ? 'open' : ''}`}>
      <button className="cloud-sharing-disclosure" onClick={toggleOpen} aria-expanded={open}>
        <span>
          <b>Cloud sharing</b>
          <small>
            {open
              ? 'Choose papers, reading data, and a destination.'
              : 'Save selected papers, notes, edits, and preferences.'}
          </small>
        </span>
        <span>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="cloud-sharing-body">
          <div className="cloud-provider-row" aria-label="Cloud destination">
            {providers.map((item) => (
              <button
                key={item.id}
                className={provider === item.id ? 'active' : ''}
                onClick={() => {
                  setProvider(item.id);
                  setSaved(null);
                  setError('');
                }}
              >
                <i className={item.available ? 'connected' : ''} />
                <span>{item.label}</span>
              </button>
            ))}
            {loading && (
              <span className="cloud-provider-loading">
                <i />
                Checking…
              </span>
            )}
          </div>
          {currentProvider && (
            <div className="cloud-connection">
              <span>
                <i className={currentProvider.available ? 'connected' : ''} />
                {currentProvider.detail}
              </span>
              <div>
                {currentProvider.connectUrl && (
                  <a href={currentProvider.connectUrl} target="_blank" rel="noreferrer">
                    {currentProvider.available ? 'Open cloud' : 'Sign in'}
                  </a>
                )}
                <button onClick={() => void refresh()} disabled={loading}>
                  Refresh
                </button>
              </div>
            </div>
          )}
          {provider === 'git' && (
            <div className="cloud-git-fields">
              <label>
                <span>Remote repository</span>
                <input
                  value={gitRemote}
                  onChange={(event) => setGitRemote(event.target.value)}
                  placeholder="git@github.com:you/reading-library.git"
                />
              </label>
              <label>
                <span>Branch</span>
                <input value={gitBranch} onChange={(event) => setGitBranch(event.target.value)} />
              </label>
              <p>
                Uses your existing SSH key or system Git credentials.{' '}
                <a href="https://github.com/login" target="_blank" rel="noreferrer">
                  GitHub
                </a>{' '}
                ·{' '}
                <a href="https://gitlab.com/users/sign_in" target="_blank" rel="noreferrer">
                  GitLab
                </a>{' '}
                ·{' '}
                <a href="https://bitbucket.org/account/signin/" target="_blank" rel="noreferrer">
                  Bitbucket
                </a>
              </p>
            </div>
          )}
          <div className="cloud-share-columns">
            <section>
              <header>
                <b>Papers</b>
                <div>
                  <button onClick={() => setSelected(papers.map((paper) => paper.id))}>All</button>
                  <button onClick={() => setSelected([])}>None</button>
                </div>
              </header>
              <div className="cloud-paper-list">
                {papers.map((paper) => (
                  <label key={paper.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(paper.id)}
                      onChange={() => togglePaper(paper.id)}
                    />
                    <span>
                      <b>
                        <MathText value={paper.title} />
                      </b>
                      <small>{paperSourceLabel(paper)}</small>
                    </span>
                  </label>
                ))}
              </div>
            </section>
            <section>
              <header>
                <b>Include</b>
                <small>Paper records are always included.</small>
              </header>
              <div className="cloud-part-list">
                {partChoices.map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={parts[key]}
                      onChange={(event) => setParts({ ...parts, [key]: event.target.checked })}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <label className="cloud-share-title">
                <span>Share name</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
              </label>
            </section>
          </div>
          {error && <p className="cloud-share-error">{error}</p>}
          {saved && (
            <div className="cloud-share-saved">
              <div>
                <b>Cloud copy saved</b>
                <span>{saved.location}</span>
              </div>
              <button onClick={() => void copyLocation()}>{copied ? 'Copied' : 'Copy location'}</button>
              {saved.connectUrl && (
                <a href={saved.connectUrl} target="_blank" rel="noreferrer">
                  Open cloud
                </a>
              )}
            </div>
          )}
          <footer className="cloud-share-footer">
            <span>
              {selected.length} paper{selected.length === 1 ? '' : 's'} selected
            </span>
            <button
              onClick={() => void createShare()}
              disabled={
                sharing || !selected.length || !currentProvider?.available || (provider === 'git' && !gitRemote.trim())
              }
            >
              {sharing ? (
                <>
                  <i />
                  Saving…
                </>
              ) : (
                'Create cloud copy'
              )}
            </button>
          </footer>
          {recent.length > 0 && (
            <details className="cloud-share-history">
              <summary>
                Recent cloud copies <span>{recent.length}</span>
              </summary>
              <div>
                {recent.slice(0, 6).map((item) => (
                  <article key={item.id}>
                    <div>
                      <b>{item.title}</b>
                      <span>
                        {item.providerLabel} · {item.paperCount} paper{item.paperCount === 1 ? '' : 's'}
                      </span>
                    </div>
                    <small>{new Date(item.createdAt).toLocaleString()}</small>
                  </article>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

export function Library({
  papers,
  audits,
  patches,
  updates,
  jobs,
  auditJobs,
  analyze,
  cancelAudit,
  refreshPaper,
  showUpdate,
  updatePaper,
  removePaper,
  reorderPapers,
  openUnit,
  openImport,
}: {
  papers: Paper[];
  audits: Record<string, PaperAudit>;
  patches: Record<string, WorkingPatch[]>;
  updates: Record<string, PaperUpdateRecord[]>;
  jobs: Record<string, PaperJobKind>;
  auditJobs: Record<string, AuditJob>;
  analyze: (paper: Paper) => Promise<void>;
  cancelAudit: (paperId: string) => Promise<void>;
  refreshPaper: (paper: Paper) => Promise<void>;
  showUpdate: (update: PaperUpdateRecord) => void;
  updatePaper: (paper: Paper) => Promise<void>;
  removePaper: (paperId: string) => Promise<void>;
  reorderPapers: (papers: Paper[]) => Promise<void>;
  openUnit: (paperId: string, nodeId: string) => void;
  openImport: () => void;
}) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Paper | null>(null);
  const [confirming, setConfirming] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [draggingId, setDraggingId] = useState('');
  const [dropId, setDropId] = useState('');
  const visible = useMemo(() => {
    const needle = searchablePaperText(query);
    if (!needle) return papers;
    return papers.filter((paper) =>
      searchablePaperText(
        [paper.title, paper.authors, paper.arxivId, paper.category, paper.state, ...paper.tags].join(' '),
      ).includes(needle),
    );
  }, [papers, query]);
  async function saveEdit() {
    if (!editing?.title.trim()) return;
    setSaving(true);
    setError('');
    try {
      await updatePaper(editing);
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update this paper.');
    } finally {
      setSaving(false);
    }
  }
  async function remove(id: string) {
    setSaving(true);
    setError('');
    try {
      await removePaper(id);
      setConfirming('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove this paper.');
    } finally {
      setSaving(false);
    }
  }
  function finishDrop(targetId: string) {
    if (!draggingId || draggingId === targetId) {
      setDraggingId('');
      setDropId('');
      return;
    }
    const from = papers.findIndex((item) => item.id === draggingId);
    const to = papers.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...papers];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setDraggingId('');
    setDropId('');
    void reorderPapers(next);
  }
  return (
    <div className="mx-auto max-w-6xl p-6 sm:p-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-3xl font-bold tracking-[-.055em]">Library</h2>
        <button onClick={openImport} className="rounded-md bg-[#2d654f] px-3 py-2 text-xs font-bold text-white">
          + Import paper
        </button>
      </div>
      <CloudSharing papers={papers} />
      <div className="library-search">
        <span>⌕</span>
        <input
          aria-label="Search papers"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search papers…"
        />
        <b>
          {visible.length} of {papers.length}
        </b>
      </div>
      {error && <p className="library-error">{error}</p>}
      <div className="library-grid">
        {visible.map((paper) => {
          const latestUpdate = updates[paper.id]?.[0];
          const job = jobs[paper.id];
          const checkpoint = auditJobs[paper.id];
          // 'ready' means the audit finished and is being saved; neither may be restarted.
          const remoteRunning = checkpoint?.state === 'running' || checkpoint?.state === 'ready';
          const resumable = Boolean(checkpoint && !remoteRunning);
          const busy = Boolean(job) || remoteRunning;
          const updating = job === 'update';
          return (
            <article
              key={paper.id}
              draggable={!busy}
              aria-busy={busy}
              onDragStart={(event) => {
                setDraggingId(paper.id);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropId(paper.id);
              }}
              onDragLeave={() => setDropId((current) => (current === paper.id ? '' : current))}
              onDrop={(event) => {
                event.preventDefault();
                finishDrop(paper.id);
              }}
              onDragEnd={() => {
                setDraggingId('');
                setDropId('');
              }}
              className={`library-paper ${draggingId === paper.id ? 'library-paper-dragging' : ''} ${dropId === paper.id && draggingId !== paper.id ? 'library-paper-drop' : ''} ${busy ? 'library-paper-auditing' : ''}`}
            >
              <button
                className="library-drag-handle"
                aria-label={`Drag to reorder ${paper.title}`}
                title="Drag to reorder"
                disabled={busy}
              >
                ⠿
              </button>
              <div className="library-paper-top">
                <div className="flex flex-wrap gap-1">
                  <span>{paper.category}</span>
                  {(patches[paper.id]?.length ?? 0) > 0 && (
                    <span>
                      {patches[paper.id].length} working change{patches[paper.id].length === 1 ? '' : 's'}
                    </span>
                  )}
                  {latestUpdate && (
                    <button className="library-version-chip" onClick={() => showUpdate(latestUpdate)} disabled={busy}>
                      {latestUpdate.fromVersion.replace(arxivBaseId(latestUpdate.fromVersion), '') ||
                        latestUpdate.fromVersion}{' '}
                      →{' '}
                      {latestUpdate.toVersion.replace(arxivBaseId(latestUpdate.toVersion), '') ||
                        latestUpdate.toVersion}
                    </button>
                  )}
                </div>
                <span
                  className={
                    busy
                      ? 'library-auditing'
                      : resumable
                        ? 'library-pending'
                        : audits[paper.id]
                          ? 'library-audited'
                          : 'library-pending'
                  }
                >
                  {busy ? (
                    <>
                      <i />
                      <b>{updating ? 'Updating' : 'Auditing'}</b>
                    </>
                  ) : resumable ? (
                    'Audit paused'
                  ) : audits[paper.id] ? (
                    'Audited'
                  ) : (
                    'Not audited'
                  )}
                </span>
              </div>
              <h3>
                <MathText value={paper.title} />
              </h3>
              <p>
                <MathText value={paper.authors} />
              </p>
              <small>{paperSourceLabel(paper)}</small>
              <div className="library-tags">
                {paper.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
              <div className="library-paper-actions">
                <div className="library-primary-actions">
                  <button
                    onClick={() => openUnit(paper.id, audits[paper.id]?.nodes[0]?.id ?? '')}
                    disabled={busy}
                    aria-label={`Open ${paper.title} in the reader`}
                    title="Open in reader"
                  >
                    Open
                  </button>
                  {!paper.arxivId.startsWith('local-') && (
                    <button
                      className="library-update"
                      onClick={() => void refreshPaper(paper)}
                      disabled={busy}
                      aria-label={`Check arXiv for a newer version of ${paper.title}`}
                      title="Check for a newer arXiv version"
                    >
                      {updating ? 'Update…' : 'Update'}
                    </button>
                  )}
                  {checkpoint?.state === 'running' && (
                    <button
                      onClick={() => void cancelAudit(paper.id)}
                      aria-label={`Stop the AI audit of ${paper.title}`}
                      title="Stop the audit; it can be continued later"
                    >
                      Stop
                    </button>
                  )}
                  <button
                    onClick={() => void analyze(paper)}
                    disabled={busy}
                    aria-label={`${resumable ? 'Continue audit' : audits[paper.id] ? 'Re-audit' : 'Analyze'} ${paper.title}`}
                    title={
                      resumable
                        ? 'Continue the saved AI audit thread'
                        : audits[paper.id]
                          ? 'Run the AI audit again'
                          : 'Analyze with AI'
                    }
                  >
                    {busy && !updating ? 'Audit…' : resumable ? 'Continue audit' : 'Audit'}
                  </button>
                  {latestUpdate && (
                    <button
                      onClick={() => showUpdate(latestUpdate)}
                      disabled={busy}
                      aria-label={`View version changes for ${paper.title}`}
                      title="View version changes"
                    >
                      Changes
                    </button>
                  )}
                </div>
                <div className="library-record-actions">
                  <button
                    onClick={() => {
                      setEditing({ ...paper });
                      setError('');
                    }}
                    disabled={busy}
                    aria-label={`Edit the library record for ${paper.title}`}
                    title="Edit library record"
                  >
                    Edit
                  </button>
                  {confirming !== paper.id && (
                    <button
                      className="library-remove"
                      onClick={() => setConfirming(paper.id)}
                      disabled={busy}
                      aria-label={`Remove ${paper.title} from the Library`}
                      title="Remove from Library"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
              {confirming === paper.id && (
                <div className="library-delete-confirmation" role="alert">
                  <b>Remove this paper?</b>
                  <p>
                    Its local notes, reading marks, edits, AI audit, update history, uploaded references, and saved
                    links will be removed with it.
                  </p>
                  <div>
                    <button onClick={() => setConfirming('')} disabled={saving}>
                      Cancel
                    </button>
                    <button className="library-confirm-delete" onClick={() => void remove(paper.id)} disabled={saving}>
                      {saving ? 'Removing…' : 'Remove paper and local data'}
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {!visible.length && <div className="library-empty">No matches.</div>}
      {editing && (
        <div
          className="edition-overlay"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setEditing(null);
          }}
        >
          <section className="paper-record-editor">
            <header>
              <h3>Edit paper</h3>
              <button onClick={() => setEditing(null)}>×</button>
            </header>
            <div className="paper-record-fields">
              <label>
                <span>Title</span>
                <input
                  value={editing.title}
                  onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                />
              </label>
              <label>
                <span>Authors</span>
                <input
                  value={editing.authors}
                  onChange={(event) => setEditing({ ...editing, authors: event.target.value })}
                />
              </label>
              <div className="paper-record-row">
                <label>
                  <span>Field</span>
                  <input
                    value={editing.category}
                    onChange={(event) => setEditing({ ...editing, category: event.target.value })}
                  />
                </label>
                <label>
                  <span>Reading state</span>
                  <select
                    value={editing.state}
                    onChange={(event) => setEditing({ ...editing, state: event.target.value as Paper['state'] })}
                  >
                    <option>To read</option>
                    <option>Reading</option>
                    <option>Read</option>
                  </select>
                </label>
              </div>
              <label>
                <span>Tags</span>
                <input
                  value={editing.tags.join(', ')}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      tags: event.target.value
                        .split(',')
                        .map((item) => item.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              <label>
                <span>Abstract</span>
                <textarea
                  value={editing.abstract}
                  onChange={(event) => setEditing({ ...editing, abstract: event.target.value })}
                />
              </label>
            </div>
            <footer>
              <button onClick={() => setEditing(null)}>Cancel</button>
              <button
                className="paper-record-save"
                onClick={() => void saveEdit()}
                disabled={saving || !editing.title.trim()}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

export function GraphView({
  graph,
  papers,
  openUnit,
}: {
  graph: Graph;
  papers: Paper[];
  openUnit: (paperId: string, nodeId: string) => void;
}) {
  const nodeById = new Map(graph.nodes.map((item) => [item.id, item]));
  const cross = graph.edges.filter((edge) => nodeById.get(edge.from)?.paperId !== nodeById.get(edge.to)?.paperId);
  return (
    <div className="mx-auto max-w-6xl p-6 sm:p-10">
      <div>
        <p className="reader-kicker">Local dependency graph</p>
        <h2 className="mt-1 text-3xl font-bold tracking-[-.055em]">Results that travel between papers</h2>
        <p className="mt-2 text-sm text-[#707970]">
          Audited units are nodes. Arrows are proof dependencies or explicit relations you add while reading.
        </p>
      </div>
      {graph.nodes.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-[#d8dfd7] p-8 text-sm text-[#7a837a]">
          Audit at least one paper to build its local graph.
        </div>
      ) : (
        <>
          <div className="graph-canvas mt-8">
            {papers
              .filter((paper) => graph.nodes.some((node) => node.paperId === paper.id))
              .map((paper) => (
                <section key={paper.id} className="graph-paper">
                  <div className="flex items-center justify-between">
                    <b>{paper.title}</b>
                    <span>{graph.nodes.filter((node) => node.paperId === paper.id).length} units</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {graph.nodes
                      .filter((node) => node.paperId === paper.id)
                      .map((node) => (
                        <button
                          key={node.id}
                          onClick={() => openUnit(node.paperId, node.nodeId)}
                          className={`graph-node ${kindClass(node.kind)}`}
                        >
                          {displayUnitLabel(node)}
                        </button>
                      ))}
                  </div>
                </section>
              ))}
          </div>
          <section className="mt-7 rounded-xl border border-[#e0e6df] bg-white p-4">
            <div className="flex justify-between">
              <div>
                <p className="reader-kicker">Cross-paper arrows</p>
                <h3 className="mt-1 text-lg font-bold">
                  {cross.length} relation{cross.length === 1 ? '' : 's'}
                </h3>
              </div>
              <span className="text-[10px] text-[#7c857c]">Add relations from a unit inspector</span>
            </div>
            <div className="mt-4 space-y-2">
              {cross.length ? (
                cross.map((edge) => {
                  const from = nodeById.get(edge.from);
                  const to = nodeById.get(edge.to);
                  return (
                    <div key={edge.id} className="graph-edge">
                      <button onClick={() => from && openUnit(from.paperId, from.nodeId)}>
                        {from ? `${from.paperTitle} · ${displayUnitLabel(from)}` : 'Referenced result'}
                      </button>
                      <span>— {edge.relation} →</span>
                      <button onClick={() => to && openUnit(to.paperId, to.nodeId)}>
                        {to ? `${to.paperTitle} · ${displayUnitLabel(to)}` : 'Referenced result'}
                      </button>
                      {edge.note && <small>{edge.note}</small>}
                    </div>
                  );
                })
              ) : (
                <p className="text-sm text-[#788178]">
                  No cross-paper arrows yet. Link a theorem, definition, or external result from the right-hand reader
                  inspector.
                </p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export function Discover({
  papers,
  saved,
  save,
  refresh,
  loading,
  selectedAreas,
}: {
  papers: Paper[];
  saved: Paper[];
  save: (paper: Paper) => Promise<void>;
  refresh: (area?: string, latestBatch?: boolean) => Promise<void>;
  loading: boolean;
  selectedAreas: string[];
}) {
  const [area, setArea] = useState(selectedAreas[0] || 'math.AG');
  return (
    <div className="mx-auto max-w-5xl p-6 sm:p-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-3xl font-bold tracking-[-.055em]">Latest arXiv</h2>
        <div className="discovery-actions">
          <button onClick={() => void refresh()}>{loading ? 'Loading…' : 'My areas'}</button>
          <label>
            <span>Category</span>
            <select value={area} onChange={(event) => setArea(event.target.value)}>
              {mathAreas.map(([id, label]) => (
                <option key={id} value={id}>
                  {id} · {label}
                </option>
              ))}
            </select>
          </label>
          <button className="discovery-all" onClick={() => void refresh(area, true)} disabled={loading}>
            {loading ? 'Loading…' : 'Load latest'}
          </button>
        </div>
      </div>
      <div className="mt-8 space-y-3">
        {papers.length ? (
          papers.map((paper) => {
            const inVault = saved.some(
              (item) => item.arxivId.replace(/v\d+$/i, '') === paper.arxivId.replace(/v\d+$/i, ''),
            );
            return (
              <article key={paper.arxivId} className="rounded-xl border border-[#e1e6df] bg-white p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 max-w-2xl">
                    <span className="rounded bg-[#edf4ee] px-2 py-1 text-[10px] font-bold text-[#46705a]">
                      {paper.category}
                    </span>
                    <h3 className="mt-3 text-lg font-bold">
                      <MathText value={paper.title} />
                    </h3>
                    <p className="mt-1 text-xs text-[#737c73]">
                      <MathText value={paper.authors} /> · arXiv:{paper.arxivId}
                    </p>
                    {paper.abstract && (
                      <div className="mt-3 text-sm leading-6 text-[#606a60]">
                        <MathText value={paper.abstract} block />
                      </div>
                    )}
                  </div>
                  <button
                    disabled={inVault}
                    onClick={() => void save(paper)}
                    className={`rounded-md px-3 py-2 text-xs font-bold ${inVault ? 'bg-[#edf0ec] text-[#869086]' : 'bg-[#2d654f] text-white'}`}
                  >
                    {inVault ? 'Saved' : '+ Save'}
                  </button>
                </div>
              </article>
            );
          })
        ) : (
          <div className="library-empty">No papers found.</div>
        )}
      </div>
    </div>
  );
}

export function OnboardingDialog({
  profile,
  setProfile,
  bridge,
  finish,
}: {
  profile: Profile;
  setProfile: (value: Profile | ((old: Profile) => Profile)) => void;
  bridge: Bridge | null;
  finish: () => void;
}) {
  const update = (key: 'level' | 'goal' | 'model' | 'reasoning', value: string) =>
    setProfile((current) => ({
      ...current,
      [key]: value,
      ...(key === 'reasoning' ? { reasoningConfigured: true } : {}),
    }));
  const model = bridge?.models.find((item) => item.id === profile.model);
  const efforts = model?.efforts.length ? model.efforts : ['low', 'medium', 'high', 'xhigh'];
  return (
    <div className="onboarding-shell">
      <section className="onboarding-dialog">
        <header>
          <span>First-time setup</span>
          <h2>Set your reading profile.</h2>
        </header>
        <div className="onboarding-fields">
          <Select
            label="Background"
            value={profile.level}
            options={['Undergraduate', 'Graduate student', 'Researcher']}
            onChange={(value) => update('level', value)}
          />
          <Select
            label="Reading goal"
            value={profile.goal}
            options={['Survey new work', 'Understand proofs', 'Apply a result', 'Reproduce a proof']}
            onChange={(value) => update('goal', value)}
          />
          <AreaMultiSelect
            value={profile.areas}
            onChange={(areas) => setProfile((current) => ({ ...current, areas }))}
          />
          <Select
            label="Codex model"
            value={profile.model}
            options={(bridge?.models ?? []).map((item) => item.id)}
            labels={(bridge?.models ?? []).reduce<Record<string, string>>(
              (result, item) => ({ ...result, [item.id]: item.label }),
              {},
            )}
            onChange={(value) => update('model', value)}
            emptyLabel="Codex default"
          />
          <Select
            label="Reasoning effort"
            value={profile.reasoning}
            options={efforts}
            onChange={(value) => update('reasoning', value)}
          />
        </div>
        <footer>
          <button onClick={finish} disabled={!profile.areas.length}>
            Start reading
          </button>
        </footer>
      </section>
    </div>
  );
}

export function Settings({
  profile,
  setProfile,
  bridge,
}: {
  profile: Profile;
  setProfile: (value: Profile | ((old: Profile) => Profile)) => void;
  bridge: Bridge | null;
}) {
  const update = (key: 'level' | 'goal' | 'model' | 'reasoning', value: string) =>
    setProfile((current) => ({ ...current, [key]: value }));
  const model = bridge?.models.find((item) => item.id === profile.model);
  const efforts = model?.efforts.length ? model.efforts : ['low', 'medium', 'high', 'xhigh'];
  return (
    <div className="mx-auto max-w-3xl p-6 sm:p-10">
      <h2 className="text-3xl font-bold tracking-[-.055em]">Settings</h2>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Select
          label="Background"
          value={profile.level}
          options={['Undergraduate', 'Graduate student', 'Researcher']}
          onChange={(value) => update('level', value)}
        />
        <Select
          label="Reading goal"
          value={profile.goal}
          options={['Survey new work', 'Understand proofs', 'Apply a result', 'Reproduce a proof']}
          onChange={(value) => update('goal', value)}
        />
        <AreaMultiSelect value={profile.areas} onChange={(areas) => setProfile((current) => ({ ...current, areas }))} />
        <Select
          label="Codex model"
          value={profile.model}
          options={(bridge?.models ?? []).map((item) => item.id)}
          labels={(bridge?.models ?? []).reduce<Record<string, string>>(
            (result, item) => ({ ...result, [item.id]: item.label }),
            {},
          )}
          onChange={(value) => update('model', value)}
          emptyLabel="Codex default"
        />
        <Select
          label="Reasoning effort"
          value={profile.reasoning}
          options={efforts}
          onChange={(value) => update('reasoning', value)}
        />
      </div>
      <div className="france-toggle">
        <b>Do you like France?</b>
        <button role="switch" aria-checked="false" disabled>
          <i />
          <span>No</span>
        </button>
      </div>
    </div>
  );
}

function AreaMultiSelect({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const visible = mathAreas.filter(([id, label]) => `${id} ${label}`.toLowerCase().includes(query.toLowerCase()));
  function toggle(id: string) {
    onChange(value.includes(id) ? (value.length === 1 ? value : value.filter((area) => area !== id)) : [...value, id]);
  }
  return (
    <div className="area-multiselect">
      <div className="area-multiselect-head">
        <span>Mathematical areas</span>
        <small>{value.length} selected</small>
      </div>
      <button className="area-multiselect-trigger" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          {value.slice(0, 3).join(' · ')}
          {value.length > 3 ? ` +${value.length - 3}` : ''}
        </span>
        <b>{open ? '−' : '+'}</b>
      </button>
      {open && (
        <div className="area-multiselect-menu">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter all arXiv math areas…"
            autoFocus
          />
          <div>
            {visible.map(([id, label]) => (
              <label key={id}>
                <input type="checkbox" checked={value.includes(id)} onChange={() => toggle(id)} />
                <span>
                  <b>{id}</b>
                  <small>{label}</small>
                </span>
              </label>
            ))}
          </div>
          <footer>
            <button onClick={() => onChange(mathAreas.map(([id]) => id))}>Select all</button>
            <button
              onClick={() => {
                onChange([defaultProfile.areas[0]]);
                setOpen(false);
              }}
            >
              Reset
            </button>
            <button onClick={() => setOpen(false)}>Done</button>
          </footer>
        </div>
      )}
    </div>
  );
}

export function Select({
  label,
  value,
  options,
  labels = {},
  onChange,
  emptyLabel,
}: {
  label: string;
  value: string;
  options: string[];
  labels?: Record<string, string>;
  onChange: (value: string) => void;
  emptyLabel?: string;
}) {
  return (
    <label className="rounded-xl border border-[#e1e6df] bg-white p-4">
      <span className="text-xs font-bold">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-3 block w-full rounded-md border border-[#dce3da] bg-[#fbfcf9] px-2.5 py-2 text-xs text-[#415c4b] outline-none"
      >
        <option value="">{emptyLabel ?? 'Codex default'}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option] ?? option}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ModelControls({
  profile,
  setProfile,
  bridge,
  compact = false,
}: {
  profile: Profile;
  setProfile: (value: Profile | ((old: Profile) => Profile)) => void;
  bridge: Bridge | null;
  compact?: boolean;
}) {
  const selected = bridge?.models.find((item) => item.id === profile.model);
  const efforts = selected?.efforts.length ? selected.efforts : ['low', 'medium', 'high', 'xhigh'];
  function chooseModel(modelId: string) {
    const model = bridge?.models.find((item) => item.id === modelId);
    setProfile((current) => ({
      ...current,
      model: modelId,
      reasoning: model?.efforts.includes(current.reasoning)
        ? current.reasoning
        : model?.efforts.includes(defaultReasoning)
          ? defaultReasoning
          : (model?.defaultEffort ?? model?.efforts[0] ?? defaultReasoning),
    }));
  }
  return (
    <div className={`model-controls ${compact ? 'model-controls-compact' : ''}`}>
      <label>
        <span>Model</span>
        <select
          aria-label="AI model"
          value={profile.model}
          onChange={(event) => chooseModel(event.target.value)}
          disabled={!bridge?.models.length}
        >
          <option value="">Codex default</option>
          {(bridge?.models ?? []).map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Reasoning</span>
        <select
          aria-label="Reasoning effort"
          value={profile.reasoning}
          onChange={(event) =>
            setProfile((current) => ({ ...current, reasoning: event.target.value, reasoningConfigured: true }))
          }
        >
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

type ReaderProcessEntry = ReaderProcessUpdate & { startedAt: number; updatedAt: number };

export function ProcessTray({
  openResult,
  retryAudit,
  cancelAudit,
}: {
  openResult: (target: ReaderProcessTarget) => void;
  retryAudit: (paperId: string) => void;
  cancelAudit: (paperId: string) => void;
}) {
  // Activity is deliberately session-only. A fresh app launch begins with an
  // empty tray instead of resurfacing stale completed or interrupted work.
  const [entries, setEntries] = useState<ReaderProcessEntry[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  const [now, setNow] = useState(0);
  useEffect(() => {
    const receive = (event: Event) => {
      const update = (event as CustomEvent<ReaderProcessUpdate>).detail;
      const timestamp = Date.now();
      setCollapsed(false);
      setEntries((current) => {
        const previous = current.find((item) => item.id === update.id);
        return [
          {
            ...update,
            startedAt: previous?.status === 'running' ? previous.startedAt : timestamp,
            updatedAt: timestamp,
          },
          ...current.filter((item) => item.id !== update.id),
        ].slice(0, 14);
      });
    };
    const toggle = () => setCollapsed((current) => !current);
    window.addEventListener('proofroom:process', receive);
    window.addEventListener('proofroom:toggle-process-tray', toggle);
    return () => {
      window.removeEventListener('proofroom:process', receive);
      window.removeEventListener('proofroom:toggle-process-tray', toggle);
    };
  }, []);
  const visibleEntries = entries;
  useEffect(() => {
    if (!entries.some((item) => item.status === 'running')) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [entries]);
  const running = visibleEntries.filter((item) => item.status === 'running').length;
  const hasError = visibleEntries.some((item) => item.status === 'error');
  useEffect(() => {
    document.documentElement.classList.toggle('ai-process-running', running > 0);
    document.documentElement.classList.toggle('ai-process-error', hasError);
    return () => {
      document.documentElement.classList.remove('ai-process-running');
      document.documentElement.classList.remove('ai-process-error');
    };
  }, [hasError, running]);
  function activateResult(item: ReaderProcessEntry) {
    if (item.status !== 'complete' || !item.resultTarget) return;
    openResult(item.resultTarget);
    setCollapsed(true);
  }
  const trayCollapsed = collapsed;
  if (trayCollapsed)
    return (
      <button
        className={`process-tray-collapsed ${running ? 'running' : 'finished'} ${visibleEntries.length ? '' : 'process-tray-idle'}`}
        onClick={() => setCollapsed(false)}
        aria-label={
          visibleEntries.length
            ? `Open activity tray · ${running || visibleEntries.length} ${running ? 'running' : 'recorded'} process${(running || visibleEntries.length) === 1 ? '' : 'es'}`
            : 'Open AI activity tray'
        }
      >
        <ProcessMascot busy={running > 0} />
        {visibleEntries.length > 0 && <span>{running || visibleEntries.length}</span>}
      </button>
    );
  return (
    <aside className="process-tray" aria-live="polite">
      <header>
        <ProcessMascot busy={running > 0} />
        <div>
          <b>AI activity</b>
          <span>{running ? `${running} running` : 'All finished'}</span>
        </div>
        <button onClick={() => setCollapsed(true)} aria-label="Collapse activity tray">
          ⌄
        </button>
      </header>
      <div>
        {visibleEntries.length ? (
          visibleEntries.map((item) => {
            const navigable = item.status === 'complete' && Boolean(item.resultTarget);
            return (
              <article
                key={item.id}
                className={`process-entry process-${item.status} ${navigable ? 'process-navigable' : ''}`}
                data-detail={item.detail}
                role={navigable ? 'button' : undefined}
                tabIndex={navigable ? 0 : undefined}
                aria-label={navigable ? `Open ${item.label}: ${item.detail}` : undefined}
                title={navigable ? 'Open result' : undefined}
                onClick={() => activateResult(item)}
                onKeyDown={(event) => {
                  if (!navigable || (event.key !== 'Enter' && event.key !== ' ')) return;
                  event.preventDefault();
                  activateResult(item);
                }}
              >
                <i>{item.status === 'complete' ? '✓' : item.status === 'error' ? '!' : ''}</i>
                <div>
                  <b>{item.label}</b>
                  <span>{item.detail}</span>
                </div>
                <div className="process-entry-tail">
                  <time>
                    {item.status === 'running'
                      ? elapsedLabel(item.startedAt, now)
                      : item.status === 'complete'
                        ? 'Done'
                        : 'Stopped'}
                  </time>
                  {navigable && (
                    <span className="process-entry-open" aria-hidden="true">
                      →
                    </span>
                  )}
                  {item.status === 'running' && item.cancelPaperId && (
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        cancelAudit(item.cancelPaperId as string);
                      }}
                      aria-label="Stop AI audit"
                      title="Stop audit (it can be continued later)"
                    >
                      ■
                    </button>
                  )}
                  {item.status === 'error' && item.retryPaperId && (
                    <button
                      onClick={() => retryAudit(item.retryPaperId as string)}
                      aria-label="Retry AI audit"
                      title="Retry audit"
                    >
                      ↻
                    </button>
                  )}
                </div>
              </article>
            );
          })
        ) : (
          <p className="process-empty">No activity.</p>
        )}
      </div>
    </aside>
  );
}

export function ImportDialog({
  close,
  importArxiv,
  importLocalSource,
  profile,
  setProfile,
  bridge,
}: {
  close: () => void;
  importArxiv: (
    value: string,
    convertPdfToLatex?: boolean,
    correctnessAudit?: boolean,
    detailedAudit?: boolean,
  ) => Promise<void>;
  importLocalSource: (
    file: File,
    title: string,
    convertPdfToLatex?: boolean,
    correctnessAudit?: boolean,
    detailedAudit?: boolean,
  ) => Promise<void>;
  profile: Profile;
  setProfile: (value: Profile | ((old: Profile) => Profile)) => void;
  bridge: Bridge | null;
}) {
  const [value, setValue] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [localTitle, setLocalTitle] = useState('');
  const [convertPdf, setConvertPdf] = useState(true);
  const [correctnessAudit, setCorrectnessAudit] = useState(true);
  const [detailedAudit, setDetailedAudit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim() && !file) return;
    setBusy(true);
    setError('');
    try {
      if (file) await importLocalSource(file, localTitle, convertPdf, correctnessAudit, detailedAudit);
      else await importArxiv(value, convertPdf, correctnessAudit, detailedAudit);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The paper could not be imported.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="import-overlay"
      onMouseDown={(event) => {
        if (!busy && event.currentTarget === event.target) close();
      }}
    >
      <form onSubmit={submit} className="import-dialog">
        <header>
          <div>
            <h2>Import & audit a paper</h2>
          </div>
          <button type="button" onClick={close} disabled={busy}>
            ×
          </button>
        </header>
        <p className="import-explainer">
          Upload the author’s TeX when possible; use one ZIP for multiple files. You can also enter an arXiv ID or URL.
        </p>
        <label className="import-source">
          <span>arXiv ID or URL</span>
          <input
            autoFocus
            value={value}
            disabled={Boolean(file)}
            onChange={(event) => setValue(event.target.value)}
            placeholder="https://arxiv.org/abs/2608.24719"
          />
        </label>
        <div className="import-divider">
          <span>or upload source</span>
        </div>
        <label className="import-file">
          <input
            type="file"
            accept=".tex,.ltx,.zip,.pdf,application/pdf,application/zip,text/plain"
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null;
              setFile(selected);
              if (selected && !localTitle)
                setLocalTitle(selected.name.replace(/\.(pdf|tex|ltx|zip)$/i, '').replace(/[-_]+/g, ' '));
            }}
          />
          <span>
            <b>{file ? file.name : 'Choose TeX, ZIP, or PDF'}</b>
            <small>ZIP for multiple files</small>
          </span>
        </label>
        {file && (
          <label className="import-source import-local-title">
            <span>Paper title</span>
            <input
              value={localTitle}
              onChange={(event) => setLocalTitle(event.target.value)}
              placeholder="Paper title"
            />
          </label>
        )}
        <div className="import-options">
          <label className="import-depth">
            <span>
              <b>Audit depth</b>
            </span>
            <select
              value={detailedAudit ? 'detailed' : 'standard'}
              onChange={(event) => setDetailedAudit(event.target.value === 'detailed')}
            >
              <option value="detailed">Detailed</option>
              <option value="standard">Standard</option>
            </select>
          </label>
          <label className="import-convert">
            <input type="checkbox" checked={convertPdf} onChange={(event) => setConvertPdf(event.target.checked)} />
            <span>
              <b>Convert PDF-only papers to LaTeX first</b>
            </span>
          </label>
          <label className="import-convert">
            <input
              type="checkbox"
              checked={correctnessAudit}
              onChange={(event) => setCorrectnessAudit(event.target.checked)}
            />
            <span>
              <b>Audit mathematical correctness</b>
            </span>
          </label>
        </div>
        <section className="import-ai">
          <div>
            <b>AI for this audit</b>
          </div>
          <ModelControls profile={profile} setProfile={setProfile} bridge={bridge} />
        </section>
        {error && <p className="import-error">{error}</p>}
        <footer>
          <button type="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="import-submit" disabled={busy || (!value.trim() && !file) || !bridge?.account}>
            {busy ? (
              <>
                <i /> Preparing source…
              </>
            ) : (
              'Import & analyze'
            )}
          </button>
        </footer>
      </form>
    </div>
  );
}
