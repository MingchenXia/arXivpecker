import type {
  Graph,
  Note,
  Paper,
  PaperChatMessage,
  Profile,
  ReaderProcessUpdate,
  ReadingMark,
  ServiceResponse,
  WorkingPatch,
} from './types';

export const bridgeUrl = 'http://127.0.0.1:4318';
export const preferenceKey = 'proofroom-reader-preferences-v1';
export const onboardingCompleteKey = 'arxivpecker-onboarding-complete-v1';
export const paperScaleKey = 'proofroom-paper-scale-v1';
export const assistantSizeKey = 'arxivpecker-assistant-size-v1';
export const selectedPaperKey = 'arxivpecker-selected-paper-v1';

// Storage access throws when site data is blocked (or the quota is full). Reader
// preferences are conveniences, so fall back to defaults instead of failing.
export function readStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Not remembered this session. */
  }
}

type PaperPdfRecord = Pick<Paper, 'id' | 'arxivId'> & { source?: Paper['source'] };
export function hasOriginalPaper(paper: PaperPdfRecord) {
  return !paper.arxivId.startsWith('local-') || Boolean(paper.source?.localPdf);
}
export function originalPaperUrl(paper: PaperPdfRecord, page?: number) {
  const base = paper.arxivId.startsWith('local-')
    ? `${bridgeUrl}/paper-pdf?paperId=${encodeURIComponent(paper.id)}`
    : paper.source?.pdfUrl || `https://arxiv.org/pdf/${paper.arxivId}`;
  return `${base}${page ? `#page=${page}` : ''}`;
}
export const paperChatAnswerKey = '__paper_chat__';
export const reasoningDefaultMigrationKey = 'proofroom-reasoning-default-xhigh-v1';
export const defaultReasoning = 'xhigh';
export const defaultProfile: Profile = {
  level: 'Graduate student',
  areas: ['math.AP'],
  goal: 'Understand proofs',
  model: '',
  reasoning: defaultReasoning,
};
export const mathAreas = [
  ['math.AC', 'Commutative Algebra'],
  ['math.AG', 'Algebraic Geometry'],
  ['math.AP', 'Analysis of PDEs'],
  ['math.AT', 'Algebraic Topology'],
  ['math.CA', 'Classical Analysis and ODEs'],
  ['math.CO', 'Combinatorics'],
  ['math.CT', 'Category Theory'],
  ['math.CV', 'Complex Variables'],
  ['math.DG', 'Differential Geometry'],
  ['math.DS', 'Dynamical Systems'],
  ['math.FA', 'Functional Analysis'],
  ['math.GM', 'General Mathematics'],
  ['math.GN', 'General Topology'],
  ['math.GR', 'Group Theory'],
  ['math.GT', 'Geometric Topology'],
  ['math.HO', 'History and Overview'],
  ['math.IT', 'Information Theory'],
  ['math.KT', 'K-Theory and Homology'],
  ['math.LO', 'Logic'],
  ['math.MG', 'Metric Geometry'],
  ['math.MP', 'Mathematical Physics'],
  ['math.NA', 'Numerical Analysis'],
  ['math.NT', 'Number Theory'],
  ['math.OA', 'Operator Algebras'],
  ['math.OC', 'Optimization and Control'],
  ['math.PR', 'Probability'],
  ['math.QA', 'Quantum Algebra'],
  ['math.RA', 'Rings and Algebras'],
  ['math.RT', 'Representation Theory'],
  ['math.SG', 'Symplectic Geometry'],
  ['math.SP', 'Spectral Theory'],
  ['math.ST', 'Statistics Theory'],
] as const;

export function normalizeReaderProfile(value: unknown): Profile {
  const stored = value && typeof value === 'object' ? (value as Partial<Profile> & { area?: string }) : {};
  const areas = Array.isArray(stored.areas)
    ? stored.areas.filter((area): area is string => typeof area === 'string' && mathAreas.some(([id]) => id === area))
    : typeof stored.area === 'string'
      ? [stored.area]
      : defaultProfile.areas;
  return {
    ...defaultProfile,
    ...stored,
    reasoning:
      stored.reasoningConfigured && typeof stored.reasoning === 'string' && stored.reasoning.trim()
        ? stored.reasoning
        : defaultReasoning,
    areas: areas.length ? areas : defaultProfile.areas,
  };
}

export function parsePaperChat(value: string | undefined): PaperChatMessage[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is PaperChatMessage =>
        Boolean(
          item &&
          typeof item === 'object' &&
          ((item as PaperChatMessage).role === 'user' || (item as PaperChatMessage).role === 'assistant') &&
          typeof (item as PaperChatMessage).text === 'string',
        ),
      )
      .slice(-100);
  } catch {
    return [];
  }
}
export const emptyGraph: Graph = { version: 1, updatedAt: null, nodes: [], edges: [] };
// Shared empty values keep props stable for papers without saved reader state,
// so the memoized document is not re-rendered on every Home render.
export const emptyRecord: Record<string, never> = {};
export const emptyPatches: WorkingPatch[] = [];
export const fallbackDiscoveries: Paper[] = [
  {
    id: 'd-1',
    title: 'Stability estimates for degenerate elliptic equations',
    authors: 'E. Moreno',
    category: 'math.AP',
    arxivId: '2608.05192',
    abstract: 'New stability estimates that extend compactness methods to a degenerate setting.',
    state: 'To read',
    tags: ['elliptic PDE', 'stability'],
  },
  {
    id: 'd-2',
    title: 'Geodesic convexity in spaces of probability measures',
    authors: 'N. Berg · K. Ito',
    category: 'math.OC',
    arxivId: '2608.05014',
    abstract: 'A concise treatment of geodesic convexity and its variational consequences.',
    state: 'To read',
    tags: ['optimal transport', 'convexity'],
  },
];

export function reportReaderProcess(update: ReaderProcessUpdate) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ReaderProcessUpdate>('proofroom:process', { detail: update }));
}

export function elapsedLabel(startedAt: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function readString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}
export function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}
export async function readServiceResponse(response: Response): Promise<ServiceResponse> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return { error: `The service response could not be read (HTTP ${response.status}).` };
  }
  if (!text.trim()) return { error: `The service returned an empty response (HTTP ${response.status}).` };
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ServiceResponse)
      : { error: `The service returned an invalid response (HTTP ${response.status}).` };
  } catch {
    return { error: `The service returned an invalid response (HTTP ${response.status}).` };
  }
}
export function makeId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `patch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
export function fileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The reference file could not be read.'));
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}
export function parseJsonObject(rawText: string) {
  const clean = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('Codex returned no structured suggestion.');
  return JSON.parse(clean.slice(first, last + 1)) as Record<string, unknown>;
}

export type ReaderStateSlices = {
  notes: Note[];
  nodeNotes: Record<string, Record<string, string>>;
  nodeAnswers: Record<string, Record<string, string>>;
  expanded: Record<string, Record<string, boolean>>;
  marks: Record<string, Record<string, Exclude<ReadingMark, ''>>>;
};

// State updates replace only the slice of the paper they touch, so comparing
// slices by identity finds every paper whose reader state needs saving.
export function changedReaderPapers(previous: ReaderStateSlices, next: ReaderStateSlices) {
  const changed = new Set<string>();
  for (const key of ['nodeNotes', 'nodeAnswers', 'expanded', 'marks'] as const) {
    const before: Record<string, unknown> = previous[key];
    const after: Record<string, unknown> = next[key];
    if (before === after) continue;
    for (const paperId of new Set([...Object.keys(before), ...Object.keys(after)]))
      if (before[paperId] !== after[paperId]) changed.add(paperId);
  }
  if (previous.notes !== next.notes) {
    const byPaper = (notes: Note[]) => {
      const groups = new Map<string, Note[]>();
      for (const note of notes) {
        const group = groups.get(note.paperId);
        if (group) group.push(note);
        else groups.set(note.paperId, [note]);
      }
      return groups;
    };
    const before = byPaper(previous.notes);
    const after = byPaper(next.notes);
    for (const paperId of new Set([...before.keys(), ...after.keys()])) {
      const left = before.get(paperId) ?? [];
      const right = after.get(paperId) ?? [];
      if (left.length !== right.length || left.some((note, index) => note !== right[index])) changed.add(paperId);
    }
  }
  return changed;
}

export function saveReaderState(paperId: string, state: ReaderStateSlices) {
  const body = JSON.stringify({
    paperId,
    reader: {
      notes: state.notes.filter((item) => item.paperId === paperId),
      nodeNotes: state.nodeNotes[paperId] ?? {},
      nodeAnswers: state.nodeAnswers[paperId] ?? {},
      expanded: state.expanded[paperId] ?? {},
      marks: state.marks[paperId] ?? {},
    },
  });
  // keepalive lets a save started as the tab closes complete; browsers cap it at 64 KB.
  return fetch(`${bridgeUrl}/vault/reader`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: body.length < 20_000,
  });
}
