import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { PaperVault } from './paper-vault.mjs';

const PORT = Number(process.env.PROOFROOM_CODEX_PORT || 4318);
const HOST = '127.0.0.1';
const WORKDIR = process.cwd();
const vault = new PaperVault(path.resolve(process.env.PROOFROOM_LIBRARY_DIR || path.join(WORKDIR, 'proofroom-library')));
const MAX_SOURCE_BYTES = 80 * 1024 * 1024;

function isAllowedOrigin(origin) {
  return !origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function sendJson(response, status, body, origin) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(origin && isAllowedOrigin(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
  });
  response.end(JSON.stringify(body));
}

function runProgram(command, args, maxOutput = MAX_SOURCE_BYTES) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: WORKDIR, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = []; let size = 0;
    child.stdout.on('data', (chunk) => { size += chunk.length; if (size <= maxOutput) stdout.push(chunk); else child.kill(); });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (size > maxOutput) return reject(new Error('arXiv source archive expands beyond the local safety limit.'));
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `${command} exited with ${code}.`));
    });
  });
}

async function collectTexFiles(directory, root = directory, depth = 0) {
  if (depth > 8) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['__MACOSX', 'auto'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTexFiles(absolute, root, depth + 1));
    else if (entry.isFile() && /\.(tex|ltx)$/i.test(entry.name)) files.push({ absolute, relative: path.relative(root, absolute) });
    if (files.length >= 2000) break;
  }
  return files;
}

async function chooseMainTex(files) {
  const scored = [];
  for (const file of files) {
    const details = await stat(file.absolute);
    if (details.size > 12 * 1024 * 1024) continue;
    const text = await readFile(file.absolute, 'utf8');
    const name = path.basename(file.relative).toLowerCase();
    const score = (/\\documentclass/.test(text) ? 100 : 0) + (/\\begin\{document\}/.test(text) ? 50 : 0) + (/^(main|paper|article|ms|manuscript)\.(tex|ltx)$/.test(name) ? 25 : 0) + Math.min(details.size / 50_000, 20);
    scored.push({ ...file, bytes: details.size, score });
  }
  return scored.sort((left, right) => right.score - left.score)[0] ?? null;
}

async function acquireArxivSource(paper, requestedArxivId = paper.arxivId, versionCache = false) {
  const sourceRoot = await vault.sourceDirectory(paper.id);
  const cacheName = String(requestedArxivId).replace(/[^a-zA-Z0-9.-]+/g, '-');
  const sourceDirectory = versionCache ? path.join(sourceRoot, 'versions', cacheName) : sourceRoot;
  const manifestFile = path.join(sourceDirectory, 'proofroom-source.json');
  try {
    const cached = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (cached.kind === 'tex' && cached.entryFile && (!cached.arxivId || cached.arxivId === requestedArxivId)) { await stat(cached.entryFile); return { ...cached, cached: true }; }
  } catch { /* Download or repair the source cache below. */ }
  await mkdir(sourceDirectory, { recursive: true });
  const archive = path.join(sourceDirectory, 'arxiv-source.tar');
  const encodedArxivId = String(requestedArxivId).split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`https://export.arxiv.org/e-print/${encodedArxivId}`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(90_000),
    headers: { 'User-Agent': 'Proofroom/0.2 (local mathematics paper reader)' },
  });
  if (!response.ok) throw new Error(`arXiv TeX source returned ${response.status}.`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_SOURCE_BYTES) throw new Error('arXiv TeX source is larger than the local safety limit.');
  const payload = Buffer.from(await response.arrayBuffer());
  if (!payload.length || payload.length > MAX_SOURCE_BYTES) throw new Error('arXiv TeX source is empty or too large.');
  await writeFile(archive, payload);
  try {
    const listing = (await runProgram('tar', ['-tf', archive], 4 * 1024 * 1024)).toString('utf8').split('\n').filter(Boolean);
    if (listing.some((entry) => path.isAbsolute(entry) || path.normalize(entry).split(path.sep).includes('..'))) throw new Error('arXiv source archive contains an unsafe path.');
    await runProgram('tar', ['-xf', archive, '-C', sourceDirectory], 4 * 1024 * 1024);
  } catch (tarError) {
    try { await writeFile(path.join(sourceDirectory, 'main.tex'), await runProgram('gzip', ['-dc', archive])); }
    catch { throw tarError; }
  }
  const texFiles = await collectTexFiles(sourceDirectory);
  const main = await chooseMainTex(texFiles);
  if (!main || main.score < 50) throw new Error('No reliable main TeX document was found in the arXiv source bundle.');
  const manifest = { kind: 'tex', arxivId: requestedArxivId, entryFile: main.absolute, sourceDirectory, fileCount: texFiles.length, archiveBytes: payload.length, fetchedAt: new Date().toISOString(), cached: false };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function makeAuditSchema() {
  const anchor = {
    type: 'object',
    additionalProperties: false,
    required: ['label', 'page', 'confidence'],
    properties: {
      label: { type: 'string' },
      page: { type: ['integer', 'null'] },
      confidence: { enum: ['verified', 'approximate', 'unverified'] },
    },
  };
  const node = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'kind', 'label', 'title', 'statement', 'status', 'anchor', 'role', 'dependencies', 'proofSketch', 'whyItMatters', 'expandable'],
    properties: {
      id: { type: 'string' },
      kind: { enum: ['definition', 'assumption', 'notation', 'lemma', 'proposition', 'theorem', 'corollary', 'proof', 'equation', 'remark', 'example', 'section', 'external-result'] },
      label: { type: 'string' },
      title: { type: 'string' },
      statement: { type: 'string' },
      status: { enum: ['verified', 'needs-verification', 'unavailable'] },
      anchor,
      role: { type: 'string' },
      dependencies: { type: 'array', items: { type: 'string' } },
      proofSketch: { type: 'array', items: { type: 'string' } },
      whyItMatters: { type: 'string' },
      expandable: { type: 'boolean' },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['audit', 'nodes', 'readingPaths', 'crossPaperLinks', 'openQuestions'],
    properties: {
      audit: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceStatus', 'sourceSummary', 'centralQuestion', 'mainContribution', 'verificationWarnings'],
        properties: {
          sourceStatus: { enum: ['full-text-read', 'partial-text-read', 'blocked'] },
          sourceSummary: { type: 'string' },
          centralQuestion: { type: 'string' },
          mainContribution: { type: 'string' },
          verificationWarnings: { type: 'array', items: { type: 'string' } },
        },
      },
      nodes: { type: 'array', minItems: 1, items: node },
      readingPaths: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['goal', 'nodeIds', 'reason'],
          properties: { goal: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } },
        },
      },
      crossPaperLinks: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['fromNodeId', 'targetPaperId', 'targetNodeId', 'relation', 'rationale'],
          properties: {
            fromNodeId: { type: 'string' },
            targetPaperId: { type: 'string' },
            targetNodeId: { type: 'string' },
            relation: { enum: ['uses', 'extends', 'background', 'contrasts'] },
            rationale: { type: 'string' },
          },
        },
      },
      openQuestions: { type: 'array', items: { type: 'string' } },
    },
  };
}

function makeEditorialSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['hasIssue', 'replacement', 'rationale', 'confidence'],
    properties: {
      hasIssue: { type: 'boolean' },
      replacement: { type: 'string' },
      rationale: { type: 'string' },
      confidence: { enum: ['high', 'medium', 'low'] },
    },
  };
}

function makeVersionComparisonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'changedUnits', 'proofChanges', 'notationChanges', 'editorialChanges', 'dependencyImpact', 'readingRecommendation', 'warnings'],
    properties: {
      summary: { type: 'string' },
      changedUnits: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['label', 'changeType', 'before', 'after', 'significance', 'dependencyImpact'],
          properties: {
            label: { type: 'string' },
            changeType: { enum: ['added', 'removed', 'strengthened', 'weakened', 'corrected', 'reorganized', 'wording'] },
            before: { type: 'string' },
            after: { type: 'string' },
            significance: { enum: ['mathematical', 'proof-level', 'expository', 'uncertain'] },
            dependencyImpact: { type: 'string' },
          },
        },
      },
      proofChanges: { type: 'array', items: { type: 'string' } },
      notationChanges: { type: 'array', items: { type: 'string' } },
      editorialChanges: { type: 'array', items: { type: 'string' } },
      dependencyImpact: { type: 'array', items: { type: 'string' } },
      readingRecommendation: { type: 'string' },
      warnings: { type: 'array', items: { type: 'string' } },
    },
  };
}

function auditPrompt({ paper, profile, localInventory, primarySource }) {
  const libraryContext = localInventory.length
    ? JSON.stringify(localInventory, null, 2)
    : 'No other audited papers are available in the local vault yet.';
  const sourceInstructions = primarySource?.kind === 'tex'
    ? `A local arXiv TeX source bundle has already been acquired. Read it before doing anything else.
- main TeX entry: ${primarySource.entryFile}
- source directory: ${primarySource.sourceDirectory}
- TeX files available: ${primarySource.fileCount}

Prefer these local TeX files over the PDF: preserve theorem environment labels, \\label/\\ref relationships, section structure, equations, and \\input/\\include dependencies. Use the PDF only to verify pagination or material absent from the source bundle.`
    : `The arXiv TeX source could not be used (${primarySource?.error || 'unavailable'}). Fall back to the primary PDF at https://arxiv.org/pdf/${paper.arxivId}.`;
  return `You are Proofroom's mathematical-paper audit engine. Work for a ${profile.level} in ${profile.area}, whose goal is "${profile.goal}".

FIRST: Read the WHOLE primary source before making a guide. Inspect the introduction, every section heading, all named definitions, assumptions, propositions, lemmas, theorems, corollaries, and the proof architecture. Do not use only the abstract. If full text is unavailable, report partial-text-read or blocked and do not invent missing mathematical statements.

${sourceInstructions}

Paper:
- title: ${paper.title}
- authors: ${paper.authors}
- arXiv id: ${paper.arxivId}
- abstract URL: https://arxiv.org/abs/${paper.arxivId}
- PDF URL: https://arxiv.org/pdf/${paper.arxivId}
- imported abstract: ${paper.abstract}

Existing audited papers in this reader's local vault:
${libraryContext}

THEN: Produce a source-anchored audit that will become the durable context for later questions about individual theorems. Each node must be a distinct clickable document unit. Include the exact label and page whenever available. Mark a statement verified only when you saw it in the primary source. Dependencies must reference other node ids and point only from a result to prerequisites. The proofSketch must be a short ordered list; use an empty list if it cannot be audited. Include no made-up formulas, theorem statements, page numbers, or citations.

Cross-paper links are optional but useful. Return one only when this paper explicitly uses, extends, contrasts with, or needs background from a unit listed in the existing local vault. Use the exact paperId and node id supplied above; never guess a link. Otherwise return an empty crossPaperLinks array.

Return JSON only, matching the supplied schema. The source summary must state exactly what was read and any limitations.`;
}

function nodeQuestionPrompt({ paper, node, question }) {
  return `The full-paper audit from the previous turn is the controlling context. The reader selected this audited document unit:
${JSON.stringify(node)}

Paper: ${paper.title} (arXiv:${paper.arxivId})
Reader question: ${question}

Answer only about this selected unit and its declared dependency chain. Start with the source anchor and verification status. Preserve uncertainty: if the audit does not establish a claim, say what needs checking in the primary paper. Explain at the reader's configured level; give a proof expansion only when the dependencies justify it. Do not silently replace the paper's theorem by a stronger or simpler statement.`;
}

function editorialPrompt({ paper, node }) {
  return `The full-paper audit from the previous turn is controlling context. Inspect the primary source again at this selected unit before suggesting any change.\n\nPaper: ${paper.title} (arXiv:${paper.arxivId})\nSelected unit: ${JSON.stringify(node)}\n\nAct as a source-preserving mathematical editor. Identify only a genuine typo, notation inconsistency, or unambiguous local wording error. Do not rewrite for style, strengthen a claim, fill in a proof, or change a theorem's mathematics. Return JSON only with keys: hasIssue (boolean), replacement (string), rationale (string), confidence ("high"|"medium"|"low"). If no clear error is verifiable from the primary source, use hasIssue:false and an empty replacement.`;
}

function comparisonPrompt({ paper, fromVersion, toVersion, fromSource, toSource, profile }) {
  const describe = (version, source) => source?.kind === 'tex'
    ? `${version}: local TeX entry ${source.entryFile} (source directory ${source.sourceDirectory})`
    : `${version}: TeX unavailable; inspect https://arxiv.org/pdf/${version} (${source?.error || 'PDF fallback'})`;
  return `You are comparing two primary-source versions of the same mathematical paper for a ${profile.level} reader whose goal is "${profile.goal}".

Paper: ${paper.title}
Version A: ${describe(fromVersion, fromSource)}
Version B: ${describe(toVersion, toSource)}

Read both complete sources before reporting differences. Prefer the local TeX trees. Resolve \\input and \\include files, theorem environments, labels, references, equations, and bibliography changes. Use a structural mathematical comparison, not a raw line-by-line diff.

Prioritize changes to definitions, assumptions, theorem/lemma/proposition statements, proof steps, counterexamples, hypotheses, conclusions, and logical dependencies. Distinguish a genuine strengthening or weakening from wording, renumbering, or moved text. For each changed unit, provide a compact before/after paraphrase and explain how its prerequisite or downstream dependency chain changes. Never infer a mathematical change from formatting alone. Put uncertain cases in warnings.

Return JSON only, matching the supplied schema. The reading recommendation should tell a mathematician exactly which changed results or proofs deserve rereading.`;
}

function normalizeArxivVersion(value) {
  return decodeURIComponent(String(value || '').trim())
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf(?:\?.*)?$/i, '')
    .replace(/[?#].*$/, '')
    .match(/(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i)?.[0] ?? '';
}

class CodexAppServer {
  constructor() {
    this.process = null;
    this.starting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.loadedThreads = new Set();
    this.turns = new Map();
    this.account = null;
    this.models = [];
    this.lastError = null;
  }

  async start() {
    if (this.process && !this.process.killed) return;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const child = spawn('codex', ['app-server'], { cwd: WORKDIR, stdio: ['pipe', 'pipe', 'pipe'] });
      this.process = child;
      const lines = createInterface({ input: child.stdout });
      const startupTimeout = setTimeout(() => reject(new Error('Codex app-server did not start within 20 seconds.')), 20000);

      lines.on('line', (line) => this.handleLine(line));
      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) console.error(`[proofroom-codex] ${text}`);
      });
      child.on('error', (error) => this.stopWithError(error));
      child.on('exit', (code) => this.stopWithError(new Error(`Codex app-server exited (${code ?? 'unknown'}).`)));

      (async () => {
        try {
          await this.call('initialize', {
            clientInfo: { name: 'proofroom_local_reader', title: 'Proofroom local reader', version: '0.1.0' },
          }, 18000);
          this.notify('initialized', {});
          const [accountResult, modelsResult] = await Promise.all([
            this.call('account/read', { refreshToken: false }, 18000),
            this.call('model/list', { limit: 50 }, 18000),
          ]);
          this.account = accountResult.account ?? null;
          this.models = modelsResult.data ?? modelsResult.models ?? [];
          clearTimeout(startupTimeout);
          resolve();
        } catch (error) {
          clearTimeout(startupTimeout);
          reject(error);
        }
      })();
    }).catch((error) => {
      this.stopWithError(error);
      throw error;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  stopWithError(error) {
    this.lastError = error instanceof Error ? error.message : String(error);
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    for (const turn of this.turns.values()) turn.reject(error);
    this.turns.clear();
    this.loadedThreads.clear();
    this.process = null;
  }

  write(message) {
    if (!this.process?.stdin.writable) throw new Error('Codex app-server is not available.');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  call(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ method, id, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params) { this.write({ method, params }); }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined) {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || 'Codex app-server request failed.'));
      else request.resolve(message.result);
      return;
    }
    this.handleNotification(message);
  }

  handleNotification(message) {
    const params = message.params ?? {};
    if (message.method === 'account/updated') {
      this.account = params.authMode ? { type: params.authMode, planType: params.planType ?? null } : null;
      return;
    }
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
      const turn = this.turns.get(params.turnId);
      if (turn) turn.messages.push(params.item.text ?? '');
      return;
    }
    if (message.method === 'turn/completed') {
      const turnId = params.turn?.id;
      const turn = this.turns.get(turnId);
      if (!turn) return;
      const inlineMessages = (params.turn.items ?? []).filter((item) => item.type === 'agentMessage').map((item) => item.text ?? '');
      const text = [...turn.messages, ...inlineMessages].filter(Boolean).at(-1) ?? '';
      this.turns.delete(turnId);
      if (params.turn.status === 'completed' && text) turn.resolve({ text, status: params.turn.status });
      else turn.reject(new Error(params.turn.error?.message || `Codex turn ended with status ${params.turn.status}.`));
    }
  }

  async runTurn(params) {
    const result = await this.call('turn/start', params, 30000);
    const turnId = result.turn?.id;
    if (!turnId) throw new Error('Codex did not return a turn id.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turns.delete(turnId);
        reject(new Error('Codex analysis exceeded the 12-minute local wait limit.'));
      }, 12 * 60 * 1000);
      this.turns.set(turnId, {
        messages: [],
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  async analyze({ paper, profile, localInventory = [], primarySource = null }) {
    await this.start();
    const model = profile.model || this.models.find((item) => item.isDefault)?.model || undefined;
    const created = await this.call('thread/start', {
      model,
      cwd: WORKDIR,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: 'You are a mathematical reading assistant. Do not modify any files. Primary-source accuracy is more important than speed.',
    });
    const threadId = created.thread?.id;
    if (!threadId) throw new Error('Codex did not create an analysis thread.');
    this.loadedThreads.add(threadId);
    const output = await this.runTurn({
      threadId,
      input: [{ type: 'text', text: auditPrompt({ paper, profile, localInventory, primarySource }), text_elements: [] }],
      model,
      effort: profile.reasoning,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
      outputSchema: makeAuditSchema(),
    });
    return { threadId, ...output };
  }

  async compareVersions({ paper, profile, fromVersion, toVersion, fromSource, toSource }) {
    await this.start();
    const model = profile.model || this.models.find((item) => item.isDefault)?.model || undefined;
    const created = await this.call('thread/start', {
      model,
      cwd: WORKDIR,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: 'You are a source-critical mathematical version comparison assistant. Do not modify files. Distinguish mathematical changes from TeX or formatting changes.',
    });
    const threadId = created.thread?.id;
    if (!threadId) throw new Error('Codex did not create a comparison thread.');
    this.loadedThreads.add(threadId);
    const output = await this.runTurn({
      threadId,
      input: [{ type: 'text', text: comparisonPrompt({ paper, fromVersion, toVersion, fromSource, toSource, profile }), text_elements: [] }],
      model,
      effort: profile.reasoning,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
      outputSchema: makeVersionComparisonSchema(),
    });
    return { threadId, ...output };
  }

  async answerNode({ paper, profile, node, question, threadId }) {
    await this.start();
    if (!this.loadedThreads.has(threadId)) {
      await this.call('thread/resume', { threadId });
      this.loadedThreads.add(threadId);
    }
    const model = profile.model || undefined;
    return this.runTurn({
      threadId,
      input: [{ type: 'text', text: nodeQuestionPrompt({ paper, node, question }), text_elements: [] }],
      model,
      effort: profile.reasoning,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
    });
  }

  async suggestEditorialPatch({ paper, profile, node, threadId }) {
    await this.start();
    if (!this.loadedThreads.has(threadId)) {
      await this.call('thread/resume', { threadId });
      this.loadedThreads.add(threadId);
    }
    return this.runTurn({
      threadId,
      input: [{ type: 'text', text: editorialPrompt({ paper, node }), text_elements: [] }],
      model: profile.model || undefined,
      effort: profile.reasoning,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
      outputSchema: makeEditorialSchema(),
    });
  }

  status() {
    return {
      running: Boolean(this.process && !this.process.killed),
      account: this.account ? { type: this.account.type, planType: this.account.planType ?? null } : null,
      models: this.models.map((item) => ({
        id: item.model ?? item.id,
        label: item.displayName ?? item.model ?? item.id,
        efforts: (item.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort),
        defaultEffort: item.defaultReasoningEffort ?? null,
        isDefault: Boolean(item.isDefault),
      })),
      lastError: this.lastError,
    };
  }
}

const codex = new CodexAppServer();
let queue = Promise.resolve();

function validatePaper(value) {
  return value && typeof value.title === 'string' && typeof value.arxivId === 'string' && typeof value.abstract === 'string';
}

function normalizeProfile(value) {
  return {
    level: typeof value?.level === 'string' ? value.level : 'Graduate student',
    area: typeof value?.area === 'string' ? value.area : 'math.GN',
    goal: typeof value?.goal === 'string' ? value.goal : 'Understand proofs',
    model: typeof value?.model === 'string' ? value.model : '',
    reasoning: typeof value?.reasoning === 'string' ? value.reasoning : 'medium',
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error('Request body is too large.'));
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Request body must be JSON.')); }
    });
    request.on('error', reject);
  });
}

function enqueue(work) {
  const scheduled = queue.then(work, work);
  queue = scheduled.catch(() => {});
  return scheduled;
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (!isAllowedOrigin(origin)) return sendJson(response, 403, { error: 'This local bridge accepts only localhost origins.' }, origin);
  const pathname = new URL(request.url || '/', `http://${HOST}:${PORT}`).pathname;
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    });
    return response.end();
  }
  try {
    if (request.method === 'GET' && pathname === '/vault') return sendJson(response, 200, await vault.snapshot(), origin);
    if (request.method === 'GET' && pathname === '/vault/graph') {
      const snapshot = await vault.snapshot();
      return sendJson(response, 200, { graph: snapshot.graph, links: snapshot.links, vault: snapshot.vault }, origin);
    }
    if (request.method === 'GET' && pathname === '/status') {
      try { await codex.start(); } catch { /* status returns useful error below */ }
      return sendJson(response, 200, codex.status(), origin);
    }
    if (request.method !== 'POST' || !['/analyze', '/compare-versions', '/node-question', '/node-edit/suggest', '/vault/paper', '/vault/paper/update', '/vault/paper/delete', '/vault/audit', '/vault/reader', '/vault/patches', '/vault/profile', '/vault/link', '/vault/link/delete'].includes(pathname)) {
      return sendJson(response, 404, { error: 'Not found.' }, origin);
    }
    const body = await readBody(request);
    if (pathname === '/vault/profile') return sendJson(response, 200, { profile: await vault.saveProfile(normalizeProfile(body.profile)) }, origin);
    if (pathname === '/vault/link') return sendJson(response, 200, { link: await vault.addLink(body.link), graph: await vault.rebuildGraph() }, origin);
    if (pathname === '/vault/link/delete') { await vault.removeLink(String(body.linkId || '')); return sendJson(response, 200, { graph: await vault.rebuildGraph() }, origin); }
    if (pathname === '/vault/paper/delete') {
      if (!body.paperId) return sendJson(response, 400, { error: 'paperId is required.' }, origin);
      const removed = await vault.removePaper(String(body.paperId));
      return sendJson(response, 200, { removed, snapshot: await vault.snapshot() }, origin);
    }
    if (pathname === '/vault/reader') {
      if (!body.paperId) return sendJson(response, 400, { error: 'paperId is required.' }, origin);
      return sendJson(response, 200, { reader: await vault.saveReader(String(body.paperId), body.reader ?? {}) }, origin);
    }
    if (pathname === '/vault/patches') {
      if (!body.paperId) return sendJson(response, 400, { error: 'paperId is required.' }, origin);
      const patches = await vault.savePatches(String(body.paperId), body.patches ?? []);
      const snapshot = await vault.snapshot();
      return sendJson(response, 200, { patches, graph: snapshot.graph }, origin);
    }
    if (!validatePaper(body.paper)) return sendJson(response, 400, { error: 'A paper with title, arXiv id, and abstract is required.' }, origin);
    if (pathname === '/vault/paper' || pathname === '/vault/paper/update') return sendJson(response, 200, { paper: await vault.upsertPaper(body.paper) }, origin);
    if (pathname === '/vault/audit') {
      if (!body.audit || !Array.isArray(body.audit.nodes)) return sendJson(response, 400, { error: 'A structured audit is required.' }, origin);
      const paper = await vault.saveAudit(body.paper, body.audit);
      const snapshot = await vault.snapshot();
      return sendJson(response, 200, { paper, graph: snapshot.graph, links: snapshot.links }, origin);
    }
    const profile = normalizeProfile(body.profile);
    const output = await enqueue(async () => {
      if (pathname === '/compare-versions') {
        const paper = await vault.upsertPaper(body.paper);
        const fromVersion = normalizeArxivVersion(body.fromVersion);
        const toVersion = normalizeArxivVersion(body.toVersion);
        if (!fromVersion || !toVersion) throw new Error('Two valid arXiv versions are required.');
        if (fromVersion.replace(/v\d+$/i, '') !== toVersion.replace(/v\d+$/i, '')) throw new Error('Version comparison requires two versions of the same arXiv paper.');
        const load = async (version) => { try { return await acquireArxivSource(paper, version, true); } catch (error) { return { kind: 'pdf', error: error instanceof Error ? error.message : 'TeX source unavailable' }; } };
        const [fromSource, toSource] = await Promise.all([load(fromVersion), load(toVersion)]);
        const compared = await codex.compareVersions({ paper, profile, fromVersion, toVersion, fromSource, toSource });
        return { ...compared, fromVersion, toVersion, sources: { from: fromSource.kind, to: toSource.kind } };
      }
      if (pathname === '/analyze') {
        const paper = await vault.upsertPaper(body.paper);
        const localInventory = await vault.compactInventory();
        let primarySource;
        try {
          primarySource = await acquireArxivSource(paper);
          await vault.saveSourceRecord(paper.id, { analysisFormat: 'tex', sourceDirectory: primarySource.sourceDirectory, mainTex: primarySource.entryFile, sourceFetchedAt: primarySource.fetchedAt });
        } catch (error) {
          primarySource = { kind: 'pdf', error: error instanceof Error ? error.message : 'TeX source unavailable' };
          await vault.saveSourceRecord(paper.id, { analysisFormat: 'pdf', sourceError: primarySource.error });
        }
        const analyzed = await codex.analyze({ paper, profile, primarySource, localInventory: localInventory.filter((item) => item.paperId !== paper.id) });
        return { ...analyzed, paper, primarySource: { kind: primarySource.kind, fileCount: primarySource.fileCount ?? 0, cached: Boolean(primarySource.cached), error: primarySource.error ?? null } };
      }
      if (!body.threadId || !body.node) throw new Error('threadId and node are required.');
      if (pathname === '/node-edit/suggest') return codex.suggestEditorialPatch({ paper: body.paper, profile, node: body.node, threadId: body.threadId });
      if (typeof body.question !== 'string') throw new Error('A question is required.');
      return codex.answerNode({ paper: body.paper, profile, node: body.node, question: body.question, threadId: body.threadId });
    });
    return sendJson(response, 200, output, origin);
  } catch (error) {
    return sendJson(response, 500, { error: error instanceof Error ? error.message : 'Local Codex bridge failed.' }, origin);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Proofroom Codex bridge listening on http://${HOST}:${PORT}`);
  console.log('Uses your local Codex/ChatGPT sign-in. No OpenAI API key is used.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    codex.process?.kill();
    process.exit(0);
  });
}
