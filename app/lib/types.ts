import type { CitingWork } from '../api/citations/openalex';

export type View = 'reader' | 'library' | 'review' | 'graph' | 'discover' | 'settings';
export type ReaderMode = 'source' | 'interactive';
export type EditionMode = 'original' | 'working';
export type Paper = {
  id: string;
  title: string;
  authors: string;
  category: string;
  arxivId: string;
  abstract: string;
  state: 'To read' | 'Reading' | 'Read';
  tags: string[];
  folder?: string;
  source?: { abstractUrl?: string; pdfUrl?: string; texUrl?: string; analysisFormat?: string; localPdf?: string };
};
export type Profile = {
  level: string;
  areas: string[];
  goal: string;
  model: string;
  reasoning: string;
  reasoningConfigured?: boolean;
};
export type Note = {
  id: string;
  paperId: string;
  nodeId: string;
  anchor: string;
  text: string;
  latex: string;
  createdAt: string;
};

export type ReadingMark = '' | 'understood' | 'question' | 'error';
export type Anchor = { label: string; page: number | null; confidence: 'verified' | 'approximate' | 'unverified' };
export type CitationReference = {
  key: string;
  /** The label the paper prints, when its bibliography sets one: a biblatex shorthand or \bibitem[label]. */
  label?: string;
  locator: string;
  statement: string;
  definitions?: { notation: string; definition: string; source: string }[];
  title: string;
  authors: string;
  text: string;
  url: string;
  searchUrl: string;
  doi: string;
  arxivId: string;
  direct: boolean;
};
export type NodeKind =
  | 'definition'
  | 'assumption'
  | 'notation'
  | 'lemma'
  | 'proposition'
  | 'theorem'
  | 'corollary'
  | 'conjecture'
  | 'proof'
  | 'equation'
  | 'remark'
  | 'example'
  | 'section'
  | 'paragraph'
  | 'figure'
  | 'table'
  | 'external-result';
export type AuditNode = {
  id: string;
  kind: NodeKind;
  displayName?: string;
  label: string;
  title: string;
  statement: string;
  proofText: string;
  citations: CitationReference[];
  status: 'verified' | 'needs-verification' | 'unavailable';
  anchor: Anchor;
  role: string;
  dependencies: string[];
  proofSketch: string[];
  whyItMatters: string;
  expandable: boolean;
};
export type WorkingPatch = {
  id: string;
  kind: 'replace' | 'delete' | 'add';
  nodeId: string;
  title: string;
  statement: string;
  proofText: string;
  nodeKind: NodeKind | '';
  afterNodeId: string;
  rationale: string;
  dependencies: string[];
  proofSketch: string[];
  source: 'manual' | 'ai';
  createdAt: string;
};
export type EditorialSuggestion = {
  hasIssue: boolean;
  replacement: string;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
};
export type VersionChange = {
  label: string;
  changeType: 'added' | 'removed' | 'strengthened' | 'weakened' | 'corrected' | 'reorganized' | 'wording';
  before: string;
  after: string;
  significance: 'mathematical' | 'proof-level' | 'expository' | 'uncertain';
  dependencyImpact: string;
};
export type VersionComparison = {
  summary: string;
  changedUnits: VersionChange[];
  proofChanges: string[];
  notationChanges: string[];
  editorialChanges: string[];
  dependencyImpact: string[];
  readingRecommendation: string;
  warnings: string[];
};
export type UpdateMigrationItem = {
  type: 'note' | 'edit' | 'mark' | 'reader-context';
  label: string;
  status: 'carried' | 'review' | 'paper-note';
  detail: string;
  fromId: string;
  toId: string;
};
export type PaperUpdateRecord = {
  id: string;
  paperId: string;
  fromVersion: string;
  toVersion: string;
  createdAt: string;
  status: 'updated' | 'current';
  comparison: VersionComparison;
  migration: {
    notesCarried: number;
    notesToPaper: number;
    marksCarried: number;
    editsCarried: number;
    editsReview: number;
    items: UpdateMigrationItem[];
    conflicts: UpdateMigrationItem[];
  };
};
export type CrossLink = {
  id: string;
  from: { paperId: string; nodeId: string };
  to: { paperId: string; nodeId: string };
  relation: 'uses' | 'extends' | 'background' | 'contrasts';
  note: string;
  source: 'manual' | 'audit';
  createdAt?: string;
};
type AuditCrossLink = {
  fromNodeId: string;
  targetPaperId: string;
  targetNodeId: string;
  relation: CrossLink['relation'];
  rationale: string;
};
export type SourceBlockKind = 'section' | 'paragraph' | 'result' | 'proof' | 'figure' | 'table' | 'bibliography';
export type SourceBlock = {
  id: string;
  kind: SourceBlockKind;
  level: number;
  title: string;
  content: string;
  proofText: string;
  nodeId: string;
  resultKind: string;
  citations: CitationReference[];
  assetPaths: string[];
  caption: string;
};
export type PaperAudit = {
  threadId: string;
  generatedAt: string;
  rawText: string;
  audit: {
    sourceStatus: 'full-text-read' | 'partial-text-read' | 'blocked';
    sourceSummary: string;
    centralQuestion: string;
    mainContribution: string;
    verificationWarnings: string[];
  };
  nodes: AuditNode[];
  sourceBlocks: SourceBlock[];
  readingPaths: { goal: string; nodeIds: string[]; reason: string }[];
  crossPaperLinks: AuditCrossLink[];
  openQuestions: string[];
  editorialCorrections?: {
    nodeId: string;
    field: 'statement' | 'proofText';
    original: string;
    replacement: string;
    rationale: string;
    confidence: 'high' | 'medium' | 'low';
  }[];
};
export type AuditJob = {
  version: number;
  paperId: string;
  /** 'ready': Codex finished and the result is stored, waiting to become the interactive reader. */
  state: 'preparing' | 'running' | 'paused' | 'ready' | 'completed';
  threadId: string;
  options: { convertPdfToLatex: boolean; correctnessAudit: boolean; detailedAudit: boolean };
  attempts: number;
  startedAt: string;
  updatedAt: string;
  message: string;
  progress?: { steps: number; activity: string; lastActivityAt: string } | null;
};
export type GraphNode = {
  id: string;
  paperId: string;
  paperTitle: string;
  arxivId: string;
  nodeId: string;
  label: string;
  title: string;
  kind: NodeKind;
  page: number | null;
  status: AuditNode['status'];
};
type GraphEdge = {
  id: string;
  from: string;
  to: string;
  relation: CrossLink['relation'];
  source: 'manual' | 'audit' | 'citation';
  note?: string;
};
export type Graph = { version: number; updatedAt: string | null; nodes: GraphNode[]; edges: GraphEdge[] };
export type Bridge = {
  running: boolean;
  /** Which AI backend the bridge runs: the signed-in Codex CLI, or an OpenAI-compatible API. */
  backend?: { kind: 'codex' | 'chat-completions'; label: string; baseUrl: string; model: string };
  account: { type: string; planType: string | null } | null;
  models: { id: string; label: string; efforts: string[]; defaultEffort: string | null; isDefault: boolean }[];
  lastError: string | null;
};
type ReaderProcessStatus = 'running' | 'complete' | 'error';
export type ReaderProcessTarget = { paperId: string; nodeId?: string; panel: 'assistant' | 'paper-chat' };
export type ReaderProcessUpdate = {
  id: string;
  label: string;
  detail: string;
  status: ReaderProcessStatus;
  retryPaperId?: string;
  /** Offers to stop this paper's running audit. */
  cancelPaperId?: string;
  resultTarget?: ReaderProcessTarget;
};
export type ReaderNavigationRequest = ReaderProcessTarget & { nonce: number };
export type PaperJobKind = 'audit' | 'update';
export type ReferenceTarget = { title: string; url?: string; arxivId?: string; paperId?: string };
/** Without a height, the assistant grows with its content up to the window's height. */
export type AssistantSize = { width: number; height?: number };
export type CloudProviderStatus = { id: string; label: string; available: boolean; connectUrl: string; detail: string };
export type CloudShareRecord = {
  id: string;
  title: string;
  provider: string;
  providerLabel: string;
  fileName: string;
  location: string;
  connectUrl: string;
  paperCount: number;
  createdAt: string;
};
export type PaperChatMessage = { role: 'user' | 'assistant'; text: string };
export type VaultSnapshot = {
  papers: Paper[];
  audits: Record<string, PaperAudit>;
  notes: Note[];
  nodeNotes: Record<string, Record<string, string>>;
  nodeAnswers: Record<string, Record<string, string>>;
  expanded: Record<string, Record<string, boolean>>;
  marks: Record<string, Record<string, Exclude<ReadingMark, ''>>>;
  patches: Record<string, WorkingPatch[]>;
  updates: Record<string, PaperUpdateRecord[]>;
  auditJobs?: Record<string, AuditJob>;
  profile: Profile | null;
  links: CrossLink[];
  graph: Graph;
  vault: { paperFolders: { paperId: string; folder: string }[] };
};
export type ServiceResponse = {
  error?: string;
  paper?: Paper;
  papers?: Paper[];
  snapshot?: VaultSnapshot;
  graph?: Graph;
  links?: CrossLink[];
  patches?: WorkingPatch[];
  text?: string;
  threadId?: string;
  primarySource?: { kind?: string };
  sourceRecord?: Record<string, unknown>;
  update?: PaperUpdateRecord;
  saved?: { relativePath?: string };
  link?: CrossLink;
  batchLabel?: string;
  sources?: { from: string; to: string };
  share?: CloudShareRecord;
  job?: AuditJob;
  found?: boolean;
  citedByCount?: number;
  citing?: CitingWork[];
};
