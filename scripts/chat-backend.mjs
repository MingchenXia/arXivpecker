// An AI backend for any OpenAI-compatible Chat Completions endpoint: a hosted
// API, or a local model server such as Ollama, LM Studio, or vLLM. It offers the
// same tasks as CodexAppServer, but a chat model cannot open files, so the
// paper's expanded TeX is sent with the first message of each conversation.
import { randomUUID } from 'node:crypto';
import {
  auditPrompt,
  comparisonPrompt,
  editorialPrompt,
  makeAuditSchema,
  makeEditorialSchema,
  makeVersionComparisonSchema,
  nodeQuestionPrompt,
  paperQuestionPrompt,
} from './codex-prompts.mjs';
import { readExpandedTex } from './tex-source.mjs';

const SYSTEM_PROMPT =
  'You are a source-critical mathematical reading assistant. You cannot open files or browse: wherever the instructions refer to the local primary source, TeX entry file, or source directory, use the paper source included in this conversation. Never invent mathematics that is not in the source.';

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** The first JSON value in a reply, tolerating code fences and prose around it. */
export function extractJson(text) {
  const trimmed = String(text || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
  const candidate = (fenced ?? trimmed).trim();
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    const start = candidate.search(/[{[]/);
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (start >= 0 && end > start) {
      const slice = candidate.slice(start, end + 1);
      JSON.parse(slice);
      return slice;
    }
    throw new Error('The model did not answer with the requested JSON.');
  }
}

/** Reads a Chat Completions event stream, reporting each content and reasoning delta. */
async function readStream(response, onDelta) {
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return text;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.error) throw new Error(event.error.message || 'The model reported an error.');
      const delta = event.choices?.[0]?.delta ?? {};
      if (delta.content) text += delta.content;
      onDelta(delta.content ? 'agentMessage' : delta.reasoning_content || delta.reasoning ? 'reasoning' : '');
    }
  }
  return text;
}

class ChatCompletionsBackend {
  constructor({
    baseUrl,
    apiKey = '',
    model = '',
    maxSourceChars = 400_000,
    requestTimeoutMs = 30 * 60_000,
    resolveSource = async () => null,
  }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.maxSourceChars = maxSourceChars;
    this.requestTimeoutMs = requestTimeoutMs;
    // The bridge supplies where a paper's TeX lives, for questions that start a new conversation.
    this.resolveSource = resolveSource;
    this.threads = new Map();
    this.models = [];
    this.reachable = false;
    this.lastError = '';
    this.structuredOutput = true;
  }

  headers() {
    return { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  async start() {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`The model server answered ${response.status} to /models.`);
      const data = await response.json();
      this.models = (Array.isArray(data?.data) ? data.data : []).map((item) => String(item.id)).filter(Boolean);
      this.reachable = true;
      this.lastError = '';
    } catch (error) {
      // Some servers do not list models; a configured model is enough to try.
      this.reachable = Boolean(this.model);
      this.lastError = error instanceof Error ? error.message : 'The model server could not be reached.';
    }
  }

  status() {
    const ids = [...new Set([this.model, ...this.models].filter(Boolean))];
    return {
      running: this.reachable,
      backend: { kind: 'chat-completions', label: 'OpenAI-compatible API', baseUrl: this.baseUrl, model: this.model },
      account: this.reachable ? { type: 'api', planType: null } : null,
      models: ids.map((id) => ({
        id,
        label: id,
        efforts: [],
        defaultEffort: null,
        isDefault: id === (this.model || ids[0]),
      })),
      lastError: this.lastError,
    };
  }

  modelFor(profile) {
    return profile?.model || this.model || this.models[0] || '';
  }

  async sourceMessage(label, source) {
    if (!source) return '';
    if (!['tex', 'ai-tex'].includes(source.kind) || !source.entryFile)
      throw httpError(
        422,
        'This AI backend reads TeX only. Import the paper with its TeX source, or switch the bridge to Codex to read PDFs.',
      );
    let tex = await readExpandedTex(source.entryFile, source.sourceDirectory);
    const note =
      tex.length > this.maxSourceChars
        ? `\n\n[The source was cut after ${this.maxSourceChars} of ${tex.length} characters to fit the model's context.]`
        : '';
    tex = tex.slice(0, this.maxSourceChars);
    return `${label} (expanded TeX, with its \\input files inlined):\n\n\`\`\`latex\n${tex}\n\`\`\`${note}`;
  }

  newThread(context) {
    const id = `chat-${randomUUID()}`;
    this.threads.set(id, { messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...context], controller: null });
    return id;
  }

  interruptThread(threadId, reason = 'Stopped by the reader.') {
    const thread = this.threads.get(threadId);
    if (thread?.controller) thread.controller.abort(new Error(reason));
  }

  /** One turn: sends the thread plus `prompt`, streams the reply, and keeps both in the thread. */
  async turn(threadId, prompt, { profile, schema, schemaName, onProgress, isCancelled = () => false } = {}) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error('This conversation is no longer available.');
    if (isCancelled()) throw new Error('Stopped by the reader.');
    const model = this.modelFor(profile);
    if (!model) throw httpError(503, 'No model is configured for the AI backend (PROOFROOM_AI_MODEL).');
    const content = schema
      ? `${prompt}\n\nAnswer with only a JSON value that matches this JSON Schema:\n${JSON.stringify(schema)}`
      : prompt;
    const messages = [...thread.messages, { role: 'user', content }];
    const controller = new AbortController();
    thread.controller = controller;
    const timeout = setTimeout(
      () => controller.abort(new Error('The model did not finish within the time limit.')),
      this.requestTimeoutMs,
    );
    let items = 0;
    const report = (type) => {
      if (!type) return;
      items += 1;
      // Progress is counted per step, not per token.
      if (items % 40 === 1) onProgress?.({ method: 'item/completed', params: { item: { type } } });
    };
    try {
      const send = (structured) =>
        fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          signal: controller.signal,
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            ...(structured
              ? { response_format: { type: 'json_schema', json_schema: { name: schemaName, schema, strict: false } } }
              : {}),
          }),
        });
      let response = await send(Boolean(schema && this.structuredOutput));
      // Not every server supports structured output; the schema is also in the prompt.
      if (schema && this.structuredOutput && response.status === 400) {
        this.structuredOutput = false;
        response = await send(false);
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw httpError(
          response.status === 401 || response.status === 403 ? 401 : 502,
          `The model server answered ${response.status}${detail ? `: ${detail.slice(0, 300)}` : '.'}`,
        );
      }
      const text = await readStream(response, report);
      if (!text.trim()) throw new Error('The model returned an empty answer.');
      const answer = schema ? extractJson(text) : text;
      thread.messages = [...messages, { role: 'assistant', content: answer }];
      return { text: answer, status: 'completed' };
    } catch (error) {
      if (controller.signal.aborted)
        throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Stopped.');
      throw error;
    } finally {
      clearTimeout(timeout);
      thread.controller = null;
    }
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
    const continuation = this.threads.has(resumeThreadId);
    const threadId = continuation
      ? resumeThreadId
      : this.newThread([{ role: 'user', content: await this.sourceMessage('The paper source', primarySource) }]);
    if (onThreadReady) await onThreadReady(threadId);
    const prompt = auditPrompt({
      paper,
      profile,
      localInventory,
      primarySource,
      correctnessAudit,
      detailedAudit,
      updateContext,
      continuation,
    });
    const output = await this.turn(threadId, prompt, {
      profile,
      schema: makeAuditSchema(),
      schemaName: 'paper_audit',
      onProgress,
      isCancelled,
    });
    return { threadId, ...output };
  }

  async convertPdfToLatex() {
    throw httpError(
      422,
      'Converting a PDF to LaTeX needs the Codex backend, which can read PDFs. Import the TeX source instead.',
    );
  }

  async compareVersions({ paper, profile, fromVersion, toVersion, fromSource, toSource, readerContext = null }) {
    const threadId = this.newThread([
      { role: 'user', content: await this.sourceMessage(`Version ${fromVersion}`, fromSource) },
      { role: 'user', content: await this.sourceMessage(`Version ${toVersion}`, toSource) },
    ]);
    const output = await this.turn(
      threadId,
      comparisonPrompt({ paper, fromVersion, toVersion, fromSource, toSource, profile, readerContext }),
      { profile, schema: makeVersionComparisonSchema(), schemaName: 'version_comparison' },
    );
    return { threadId, ...output };
  }

  /** The audit conversation if this bridge still holds it, or a new one carrying the paper source. */
  async readerThread(paper, threadId) {
    if (this.threads.has(threadId)) return { threadId, continuation: true };
    const source = await this.resolveSource(paper);
    return {
      threadId: this.newThread(
        source ? [{ role: 'user', content: await this.sourceMessage('The paper source', source) }] : [],
      ),
      continuation: false,
    };
  }

  async answerNode({ paper, profile, node, question, threadId }) {
    const reader = await this.readerThread(paper, threadId);
    const output = await this.turn(
      reader.threadId,
      nodeQuestionPrompt({ paper, node, question, continuation: reader.continuation }),
      { profile },
    );
    return { threadId: reader.threadId, ...output };
  }

  async answerPaper({ paper, profile, currentNode, question, threadId }) {
    const reader = await this.readerThread(paper, threadId);
    const output = await this.turn(
      reader.threadId,
      paperQuestionPrompt({ paper, currentNode, question, continuation: reader.continuation }),
      { profile },
    );
    return { threadId: reader.threadId, ...output };
  }

  async suggestEditorialPatch({ paper, profile, node, threadId }) {
    const reader = await this.readerThread(paper, threadId);
    return this.turn(reader.threadId, editorialPrompt({ paper, node }), {
      profile,
      schema: makeEditorialSchema(),
      schemaName: 'editorial_patch',
    });
  }
}

/**
 * The bridge's AI backend, from the environment: Codex by default, or
 * PROOFROOM_AI_BACKEND=openai-compatible with PROOFROOM_AI_BASE_URL,
 * PROOFROOM_AI_MODEL, and (for hosted APIs) PROOFROOM_AI_API_KEY.
 */
export function chatBackendFromEnvironment(env, options = {}) {
  if (!/^(openai-compatible|chat-completions)$/i.test(env.PROOFROOM_AI_BACKEND || '')) return null;
  if (!env.PROOFROOM_AI_BASE_URL)
    throw new Error(
      'PROOFROOM_AI_BACKEND=openai-compatible needs PROOFROOM_AI_BASE_URL (for example http://localhost:11434/v1).',
    );
  return new ChatCompletionsBackend({
    baseUrl: env.PROOFROOM_AI_BASE_URL,
    apiKey: env.PROOFROOM_AI_API_KEY || '',
    model: env.PROOFROOM_AI_MODEL || '',
    maxSourceChars: Number(env.PROOFROOM_AI_MAX_SOURCE_CHARS) || 400_000,
    ...options,
  });
}

export { ChatCompletionsBackend };
