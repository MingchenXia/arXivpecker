import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  auditPrompt,
  comparisonPrompt,
  editorialPrompt,
  latexConversionPrompt,
  makeAuditSchema,
  makeEditorialSchema,
  makeVersionComparisonSchema,
  nodeQuestionPrompt,
  paperQuestionPrompt,
} from './codex-prompts.mjs';

const WORKDIR = process.cwd();
// Mathematical audits may need to run for hours. They keep running by default
// until Codex completes, fails, or the reader stops them. Operators can opt in
// to an idle or absolute cutoff by setting the corresponding environment value.
function optionalTimeoutFromEnv(keys) {
  const raw = keys.map((key) => process.env[key]).find((value) => value !== undefined && value !== '');
  const timeout = Number(raw);
  return Number.isFinite(timeout) && timeout > 0 ? Math.max(60_000, timeout) : 0;
}
const CODEX_TURN_IDLE_TIMEOUT_MS = optionalTimeoutFromEnv(['CODEX_TURN_IDLE_TIMEOUT_MS', 'CODEX_TURN_TIMEOUT_MS']);
const CODEX_TURN_HARD_TIMEOUT_MS = optionalTimeoutFromEnv(['CODEX_TURN_HARD_TIMEOUT_MS']);
const CODEX_STARTUP_RPC_TIMEOUT_MS = Math.max(30_000, Number(process.env.CODEX_STARTUP_RPC_TIMEOUT_MS) || 60_000);
// Resuming a large archived audit can require Codex to restore its full rollout
// from disk. It is a lifecycle operation, not a normal lightweight RPC.
const CODEX_THREAD_RESTORE_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.CODEX_THREAD_RESTORE_TIMEOUT_MS) || 2 * 60 * 1000,
);

function isArchivedSessionError(error) {
  return /\b(?:session|thread)\b[^\r\n]*\b(?:is|was|has been) archived\b/i.test(error?.message ?? '');
}

class CodexAppServer {
  constructor({
    turnIdleTimeoutMs = CODEX_TURN_IDLE_TIMEOUT_MS,
    turnHardTimeoutMs = CODEX_TURN_HARD_TIMEOUT_MS,
    threadRestoreTimeoutMs = CODEX_THREAD_RESTORE_TIMEOUT_MS,
  } = {}) {
    this.process = null;
    this.starting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.loadedThreads = new Set();
    this.turns = new Map();
    // Events for a turn can arrive in the same stdout chunk as the turn/start
    // response, before runTurn has registered the turn; keep them for replay.
    this.earlyTurnEvents = new Map();
    this.account = null;
    this.models = [];
    this.lastError = null;
    this.turnIdleTimeoutMs = Math.max(0, Number(turnIdleTimeoutMs) || 0);
    const hardTimeout = Number(turnHardTimeoutMs);
    this.turnHardTimeoutMs =
      Number.isFinite(hardTimeout) && hardTimeout > 0 ? Math.max(this.turnIdleTimeoutMs, hardTimeout) : 0;
    this.threadRestoreTimeoutMs = Math.max(60_000, threadRestoreTimeoutMs);
  }

  async start() {
    if (this.starting) return this.starting;
    if (this.process && !this.process.killed) return;
    this.starting = new Promise((resolve, reject) => {
      const child = spawn('codex', ['app-server'], { cwd: WORKDIR, stdio: ['pipe', 'pipe', 'pipe'] });
      this.process = child;
      const lines = createInterface({ input: child.stdout });
      const startupTimeout = setTimeout(
        () => reject(new Error('Codex app-server did not finish its local startup checks.')),
        CODEX_STARTUP_RPC_TIMEOUT_MS * 2 + 5_000,
      );

      lines.on('line', (line) => this.handleLine(line));
      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) console.error(`[proofroom-codex] ${text}`);
      });
      child.on('error', (error) => this.stopWithError(error, child));
      child.stdin.on('error', (error) => this.stopWithError(error, child));
      child.on('exit', (code) =>
        this.stopWithError(new Error(`Codex app-server exited (${code ?? 'unknown'}).`), child),
      );

      (async () => {
        try {
          await this.call(
            'initialize',
            {
              clientInfo: { name: 'arxivpecker_local_reader', title: 'arXivpecker local reader', version: '0.2.0' },
            },
            CODEX_STARTUP_RPC_TIMEOUT_MS,
          );
          this.notify('initialized', {});
          const [accountResult, modelsResult] = await Promise.all([
            this.call('account/read', { refreshToken: false }, CODEX_STARTUP_RPC_TIMEOUT_MS),
            this.call('model/list', { limit: 50 }, CODEX_STARTUP_RPC_TIMEOUT_MS),
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
    })
      .catch((error) => {
        this.stopWithError(error);
        throw error;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  stopWithError(error, sourceProcess = this.process) {
    // An exit event from an older failed child can arrive after a replacement
    // has started. It must never tear down that healthy replacement.
    if (sourceProcess && sourceProcess !== this.process) return;
    const failedProcess = this.process;
    this.lastError = error instanceof Error ? error.message : String(error);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    for (const turn of this.turns.values()) turn.reject(error);
    this.turns.clear();
    this.loadedThreads.clear();
    this.process = null;
    if (failedProcess && !failedProcess.killed && typeof failedProcess.kill === 'function') failedProcess.kill();
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
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.write({ method, params });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && message.method) {
      // A request from the app-server (for example an approval). This bridge runs
      // with approvals off and cannot answer interactively; say so rather than
      // leaving Codex waiting forever.
      try {
        this.write({ id: message.id, error: { code: -32601, message: 'arXivpecker does not handle this request.' } });
      } catch {
        /* The process is already gone. */
      }
      return;
    }
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
    // App-server streams turn/* and item/* events throughout an active turn.
    // Any event scoped to this turn is evidence that Codex is still working,
    // including reasoning deltas and token-usage updates that this bridge does
    // not otherwise need to render.
    const notifiedTurnId = params.turnId ?? params.turn?.id;
    if (notifiedTurnId && !this.turns.has(notifiedTurnId)) {
      const events = this.earlyTurnEvents.get(notifiedTurnId) ?? [];
      if (events.length < 1000) events.push(message);
      this.earlyTurnEvents.set(notifiedTurnId, events);
      // Events of turns that already ended (e.g. after an interrupt) are never replayed.
      while (this.earlyTurnEvents.size > 32) this.earlyTurnEvents.delete(this.earlyTurnEvents.keys().next().value);
      return;
    }
    let activeTurn = notifiedTurnId ? this.turns.get(notifiedTurnId) : null;
    if (!activeTurn && params.threadId) {
      activeTurn = [...this.turns.values()].find((turn) => turn.threadId === params.threadId);
    }
    if (activeTurn && message.method !== 'turn/completed') {
      activeTurn.touch();
      activeTurn.progress(message);
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
      const inlineMessages = (params.turn.items ?? [])
        .filter((item) => item.type === 'agentMessage')
        .map((item) => item.text ?? '');
      const text = [...turn.messages, ...inlineMessages].filter(Boolean).at(-1) ?? '';
      this.turns.delete(turnId);
      if (params.turn.status === 'completed' && text) turn.resolve({ text, status: params.turn.status });
      else turn.reject(new Error(params.turn.error?.message || `Codex turn ended with status ${params.turn.status}.`));
    }
  }

  async restoreArchivedThread(threadId) {
    this.loadedThreads.delete(threadId);
    // Restore the original conversation, including the complete paper audit.
    // Starting a blank thread here would silently discard that context.
    await this.call('thread/unarchive', { threadId }, this.threadRestoreTimeoutMs);
    await this.call('thread/resume', { threadId }, this.threadRestoreTimeoutMs);
    this.loadedThreads.add(threadId);
  }

  async resumeThread(threadId) {
    if (this.loadedThreads.has(threadId)) return;
    try {
      await this.call('thread/resume', { threadId }, this.threadRestoreTimeoutMs);
      this.loadedThreads.add(threadId);
    } catch (error) {
      if (!isArchivedSessionError(error)) throw error;
      await this.restoreArchivedThread(threadId);
    }
  }

  /** Stops the running turn of a thread; its caller receives `reason` as the error. */
  interruptThread(threadId, reason = 'Stopped by the reader.') {
    let stopped = 0;
    for (const turn of [...this.turns.values()])
      if (turn.threadId === threadId) {
        turn.interrupt(new Error(reason));
        stopped += 1;
      }
    return stopped;
  }

  async runTurn(params, { taskLabel = 'Codex task', onProgress = null, isCancelled = () => false } = {}) {
    let result;
    try {
      result = await this.call('turn/start', params, 30000);
    } catch (error) {
      // A loaded session can be archived by another Codex client. Retry once
      // only when turn/start explicitly rejected it, never after a timeout or
      // a turn/completed failure (which could duplicate already performed work).
      if (!isArchivedSessionError(error)) throw error;
      await this.restoreArchivedThread(params.threadId);
      result = await this.call('turn/start', params, 30000);
    }
    const turnId = result.turn?.id;
    if (!turnId) throw new Error('Codex did not return a turn id.');
    return new Promise((resolve, reject) => {
      let idleTimer;
      let hardTimer;
      let settled = false;
      const clearTimers = () => {
        clearTimeout(idleTimer);
        clearTimeout(hardTimer);
      };
      const interruptAndReject = (error) => {
        if (settled) return;
        settled = true;
        this.turns.delete(turnId);
        clearTimers();
        void this.call('turn/interrupt', { threadId: params.threadId, turnId }, 10000).catch(() => {});
        reject(error);
      };
      const idleTimeout = () =>
        interruptAndReject(
          new Error(
            `${taskLabel} received no Codex progress for ${Math.round(this.turnIdleTimeoutMs / 60_000)} minutes and was interrupted.`,
          ),
        );
      const touch = () => {
        if (!this.turnIdleTimeoutMs) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(idleTimeout, this.turnIdleTimeoutMs);
      };
      const turn = {
        threadId: params.threadId,
        messages: [],
        touch,
        interrupt: interruptAndReject,
        progress: (message) => {
          try {
            onProgress?.(message);
          } catch {
            /* Progress reporting must never break the turn. */
          }
        },
        resolve: (value) => {
          if (settled) return;
          settled = true;
          clearTimers();
          resolve(value);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          clearTimers();
          reject(error);
        },
      };
      this.turns.set(turnId, turn);
      touch();
      // A stop requested while turn/start was in flight found no turn to interrupt.
      if (isCancelled()) {
        interruptAndReject(new Error('Stopped by the reader.'));
        return;
      }
      const early = this.earlyTurnEvents.get(turnId) ?? [];
      this.earlyTurnEvents.delete(turnId);
      for (const message of early) this.handleNotification(message);
      if (this.turnHardTimeoutMs)
        hardTimer = setTimeout(
          () =>
            interruptAndReject(
              new Error(
                `${taskLabel} reached the ${Math.round(this.turnHardTimeoutMs / 60_000)}-minute safety limit and was interrupted.`,
              ),
            ),
          this.turnHardTimeoutMs,
        );
    });
  }

  async analyze({
    paper,
    profile,
    localInventory = [],
    primarySource = null,
    correctnessAudit = true,
    detailedAudit = true,
    updateContext = null,
    resumeThreadId = '',
    onThreadReady = null,
    onProgress = null,
    isCancelled = () => false,
  }) {
    await this.start();
    const model = profile.model || this.models.find((item) => item.isDefault)?.model || undefined;
    let threadId = String(resumeThreadId || '');
    if (threadId) await this.resumeThread(threadId);
    else {
      const created = await this.call('thread/start', {
        model,
        cwd: WORKDIR,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        developerInstructions:
          'You are a mathematical reading assistant. Do not modify any files. Primary-source accuracy is more important than speed.',
      });
      threadId = created.thread?.id;
      if (!threadId) throw new Error('Codex did not create an analysis thread.');
      this.loadedThreads.add(threadId);
    }
    if (onThreadReady) await onThreadReady(threadId);
    const output = await this.runTurn(
      {
        threadId,
        input: [
          {
            type: 'text',
            text: auditPrompt({
              paper,
              profile,
              localInventory,
              primarySource,
              correctnessAudit,
              detailedAudit,
              updateContext,
              continuation: Boolean(resumeThreadId),
            }),
            text_elements: [],
          },
        ],
        model,
        effort: profile.reasoning,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: true },
        outputSchema: makeAuditSchema(),
      },
      { taskLabel: 'AI audit', onProgress, isCancelled },
    );
    return { threadId, ...output };
  }

  async convertPdfToLatex({ paper, profile, pdfPath = '' }) {
    await this.start();
    const model = profile.model || this.models.find((item) => item.isDefault)?.model || undefined;
    const created = await this.call('thread/start', {
      model,
      cwd: WORKDIR,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions:
        'You are a source-faithful mathematical transcription assistant. Do not modify files or invent missing mathematics.',
    });
    const threadId = created.thread?.id;
    if (!threadId) throw new Error('Codex did not create a LaTeX conversion thread.');
    this.loadedThreads.add(threadId);
    const output = await this.runTurn({
      threadId,
      input: [{ type: 'text', text: latexConversionPrompt({ paper, pdfPath }), text_elements: [] }],
      model,
      effort: profile.reasoning,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
    });
    return { threadId, ...output };
  }

  async compareVersions({ paper, profile, fromVersion, toVersion, fromSource, toSource, readerContext = null }) {
    await this.start();
    const model = profile.model || this.models.find((item) => item.isDefault)?.model || undefined;
    const created = await this.call('thread/start', {
      model,
      cwd: WORKDIR,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions:
        'You are a source-critical mathematical version comparison assistant. Do not modify files. Distinguish mathematical changes from TeX or formatting changes.',
    });
    const threadId = created.thread?.id;
    if (!threadId) throw new Error('Codex did not create a comparison thread.');
    this.loadedThreads.add(threadId);
    const output = await this.runTurn({
      threadId,
      input: [
        {
          type: 'text',
          text: comparisonPrompt({ paper, fromVersion, toVersion, fromSource, toSource, profile, readerContext }),
          text_elements: [],
        },
      ],
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
    const model = profile.model || undefined;
    const continuation = Boolean(threadId);
    let readerThreadId = String(threadId || '');
    if (readerThreadId) await this.resumeThread(readerThreadId);
    else {
      const created = await this.call('thread/start', {
        model,
        cwd: WORKDIR,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        developerInstructions:
          'You are a source-critical mathematical reading assistant. Do not modify files. Re-open the local primary source whenever the saved audit context is insufficient.',
      });
      readerThreadId = created.thread?.id;
      if (!readerThreadId) throw new Error('Codex did not create a reader conversation.');
      this.loadedThreads.add(readerThreadId);
    }
    const output = await this.runTurn({
      threadId: readerThreadId,
      input: [{ type: 'text', text: nodeQuestionPrompt({ paper, node, question, continuation }), text_elements: [] }],
      model,
      effort: profile.reasoning,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
    });
    return { threadId: readerThreadId, ...output };
  }

  async answerPaper({ paper, profile, currentNode, question, threadId }) {
    await this.start();
    const model = profile.model || undefined;
    const continuation = Boolean(threadId);
    let readerThreadId = String(threadId || '');
    if (readerThreadId) await this.resumeThread(readerThreadId);
    else {
      const created = await this.call('thread/start', {
        model,
        cwd: WORKDIR,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        developerInstructions:
          'You are a source-critical mathematical reading assistant. Do not modify files. Re-open the local primary source whenever the saved audit context is insufficient.',
      });
      readerThreadId = created.thread?.id;
      if (!readerThreadId) throw new Error('Codex did not create a reader conversation.');
      this.loadedThreads.add(readerThreadId);
    }
    const output = await this.runTurn({
      threadId: readerThreadId,
      input: [
        { type: 'text', text: paperQuestionPrompt({ paper, currentNode, question, continuation }), text_elements: [] },
      ],
      model,
      effort: profile.reasoning,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
    });
    return { threadId: readerThreadId, ...output };
  }

  async suggestEditorialPatch({ paper, profile, node, threadId }) {
    await this.start();
    await this.resumeThread(threadId);
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

export { CodexAppServer };
