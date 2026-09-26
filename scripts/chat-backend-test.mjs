import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ChatCompletionsBackend, chatBackendFromEnvironment, extractJson } from './chat-backend.mjs';

// Drives the OpenAI-compatible backend against a scripted Chat Completions
// server, alone and behind the real bridge.
const project = path.resolve(import.meta.dirname, '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'arxivpecker-chat-backend-'));
const requests = [];
const server = { rejectStructured: false, slowMs: 0 };

const fake = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ data: [{ id: 'fake-chat' }, { id: 'fake-large' }] }));
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404);
    return response.end();
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  requests.push({ payload, authorization: request.headers.authorization ?? '' });
  if (payload.response_format && server.rejectStructured) {
    response.writeHead(400, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ error: { message: 'response_format is not supported' } }));
  }
  const last = payload.messages.at(-1).content;
  const wantsJson = /JSON Schema/.test(last);
  const answer = wantsJson
    ? `${server.rejectStructured ? 'Here it is:\n```json\n' : ''}${JSON.stringify({ hasIssue: false, replacement: '', rationale: 'Fine.', confidence: 'high' })}${server.rejectStructured ? '\n```' : ''}`
    : `Answer to: ${last.slice(0, 60)}`;
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta) => response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  send({ reasoning_content: 'Thinking.' });
  for (const piece of answer.match(/.{1,12}/gs)) {
    if (server.slowMs) await new Promise((resolve) => setTimeout(resolve, server.slowMs));
    if (response.destroyed) return;
    send({ content: piece });
  }
  response.end('data: [DONE]\n\n');
});
fake.listen(0, '127.0.0.1');
await once(fake, 'listening');
const baseUrl = `http://127.0.0.1:${fake.address().port}/v1`;

// A small TeX project with an \input file, as the backend must inline it.
const source = path.join(root, 'source');
await mkdir(source, { recursive: true });
await writeFile(path.join(source, 'main.tex'), '\\begin{document}\n\\input{proof}\n\\end{document}\n');
await writeFile(path.join(source, 'proof.tex'), '\\begin{theorem}Every widget is blue.\\end{theorem}\n');
const primarySource = { kind: 'tex', entryFile: path.join(source, 'main.tex'), sourceDirectory: source };
const paper = { id: 'p', title: 'Widgets', arxivId: '2401.00001', abstract: '', authors: '' };
const profile = { model: '', reasoning: 'high', level: 'Graduate student', areas: [], goal: '' };
const node = {
  id: 'thm',
  kind: 'theorem',
  label: 'Theorem 1',
  title: 'Blue widgets',
  statement: 'Every widget is blue.',
};

let bridge;
try {
  assert.equal(chatBackendFromEnvironment({}), null, 'Codex stays the default.');
  assert.throws(() => chatBackendFromEnvironment({ PROOFROOM_AI_BACKEND: 'openai-compatible' }), /BASE_URL/);
  assert.equal(extractJson('Sure:\n```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJson('prefix {"a":[1]} suffix'), '{"a":[1]}');
  assert.throws(() => extractJson('no json here'), /JSON/);

  let resolved = 0;
  const backend = new ChatCompletionsBackend({
    baseUrl,
    apiKey: 'test-key',
    model: 'fake-chat',
    resolveSource: async () => {
      resolved += 1;
      return primarySource;
    },
  });
  await backend.start();
  const status = backend.status();
  assert.equal(status.backend.kind, 'chat-completions');
  assert.deepEqual(
    status.models.map((item) => [item.id, item.isDefault]),
    [
      ['fake-chat', true],
      ['fake-large', false],
    ],
  );
  assert.equal(status.account.type, 'api');

  // A question in a new conversation sends the paper's expanded TeX first.
  const progress = [];
  const first = await backend.answerNode({ paper, profile, node, question: 'Why blue?', threadId: '' });
  assert.match(first.text, /^Answer to:/);
  assert.equal(resolved, 1);
  const firstRequest = requests.at(-1);
  assert.equal(firstRequest.authorization, 'Bearer test-key');
  assert.equal(firstRequest.payload.model, 'fake-chat');
  assert.equal(firstRequest.payload.stream, true);
  assert.match(firstRequest.payload.messages[1].content, /Every widget is blue\./, 'The \\input file is inlined.');

  // A follow-up continues the same conversation, answer included, without resending the source.
  await backend.answerNode({ paper, profile, node, question: 'And red?', threadId: first.threadId });
  const followUp = requests.at(-1).payload.messages;
  assert.equal(resolved, 1);
  assert.equal(followUp.filter((message) => message.content.includes('```latex')).length, 1);
  assert.equal(followUp.at(-2).role, 'assistant');

  // Structured answers ask for a JSON schema, and fall back to the prompt when the server refuses.
  const patch = await backend.suggestEditorialPatch({ paper, profile, node, threadId: first.threadId });
  assert.equal(JSON.parse(patch.text).confidence, 'high');
  assert.equal(requests.at(-1).payload.response_format.type, 'json_schema');
  server.rejectStructured = true;
  const refused = new ChatCompletionsBackend({ baseUrl, model: 'fake-chat' });
  const fallback = await refused.analyze({
    paper,
    profile,
    primarySource,
    onProgress: (message) => progress.push(message.params.item.type),
  });
  assert.equal(JSON.parse(fallback.text).rationale, 'Fine.', 'A fenced JSON reply is unwrapped.');
  assert.equal(requests.at(-1).payload.response_format, undefined);
  assert.equal(requests.at(-2).payload.response_format.type, 'json_schema');
  assert.ok(progress.includes('reasoning'), 'Reasoning deltas are reported as progress.');
  server.rejectStructured = false;

  // Stopping interrupts the running request.
  server.slowMs = 60;
  const running = backend.answerPaper({ paper, profile, question: 'Summarize.', threadId: first.threadId });
  await new Promise((resolve) => setTimeout(resolve, 150));
  backend.interruptThread(first.threadId);
  await assert.rejects(running, /Stopped by the reader/);
  server.slowMs = 0;

  // PDFs need Codex.
  await assert.rejects(
    backend.analyze({ paper, profile, primarySource: { kind: 'uploaded-pdf', entryFile: 'x.pdf' } }),
    (error) => error.status === 422,
  );

  // Behind the real bridge: /status reports the backend, and a question is answered from the stored TeX.
  const library = path.join(root, 'library');
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  probe.close();
  await once(probe, 'close');
  bridge = spawn(process.execPath, ['scripts/codex-bridge.mjs'], {
    cwd: project,
    env: {
      ...process.env,
      PROOFROOM_LIBRARY_DIR: library,
      PROOFROOM_CODEX_PORT: String(port),
      PROOFROOM_AI_BACKEND: 'openai-compatible',
      PROOFROOM_AI_BASE_URL: baseUrl,
      PROOFROOM_AI_MODEL: 'fake-chat',
    },
    stdio: 'ignore',
  });
  const bridgeUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(`${bridgeUrl}/vault`)).ok) break;
    } catch {
      if (attempt > 100) throw new Error('The bridge did not start.');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const bridgeStatus = await (await fetch(`${bridgeUrl}/status`)).json();
  assert.equal(bridgeStatus.backend.kind, 'chat-completions');
  assert.ok(bridgeStatus.account);
  const vault = await (await fetch(`${bridgeUrl}/vault`)).json();
  const stored = vault.papers.find((item) => item.id === 'arxiv-2608.24719');
  const storedNode = vault.audits[stored.id].nodes.find((item) => item.kind === 'theorem');
  const answered = await fetch(`${bridgeUrl}/node-question`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
    body: JSON.stringify({ paper: stored, profile, node: storedNode, question: 'What is proved?', threadId: '' }),
  });
  assert.equal(answered.status, 200);
  const reply = await answered.json();
  assert.match(reply.text, /^Answer to:/);
  assert.match(reply.threadId, /^chat-/);
  assert.match(
    requests.at(-1).payload.messages[1].content,
    /\\begin\{document\}|\\section/,
    'The bridge sends the stored paper TeX.',
  );
} finally {
  if (bridge && bridge.exitCode === null) {
    bridge.kill('SIGTERM');
    await once(bridge, 'exit');
  }
  fake.close();
  await rm(root, { recursive: true, force: true });
}
console.log(
  'Chat backend: source inlining, conversations, structured output and its fallback, cancellation, and the bridge verified.',
);
