import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAppServer } from './codex-bridge.mjs';

const threadId = 'saved-paper-audit';
const archived = () => new Error(`session ${threadId} is archived. Run codex unarchive first.`);
const params = { threadId, input: [{ type: 'text', text: 'Explain the proof.' }], model: 'reader-model', effort: 'xhigh', approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: true } };

test('concurrent callers wait for the app-server initialization handshake', async () => {
  const server = new CodexAppServer();
  server.process = { killed: false };
  let initialize;
  server.starting = new Promise(resolve => { initialize = resolve; });
  let ready = false;
  const waiting = server.start().then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  initialize();
  await waiting;
  assert.equal(ready, true);
});

test('a failed app-server child is terminated without harming its replacement', () => {
  const server = new CodexAppServer();
  let failedKills = 0;
  const failed = { killed: false, kill: () => { failedKills += 1; failed.killed = true; } };
  server.process = failed;
  server.stopWithError(new Error('initialize timed out.'), failed);
  assert.equal(failedKills, 1);
  assert.equal(server.process, null);
  const replacement = { killed: false, kill: () => assert.fail('A stale exit must not kill the replacement.') };
  server.process = replacement;
  server.stopWithError(new Error('stale child exited'), failed);
  assert.equal(server.process, replacement);
});

function mockServer(handler) {
  const server = new CodexAppServer();
  const calls = [];
  server.start = async () => {};
  server.call = async (method, request, timeoutMs) => { calls.push({ method, request, timeoutMs }); return handler(method, request, server); };
  return { server, calls };
}

function mockTimedServer({ idle = 80, hard = 320 } = {}) {
  const server = new CodexAppServer({ turnIdleTimeoutMs: idle, turnHardTimeoutMs: hard });
  const calls = [];
  server.call = async (method, request) => {
    calls.push({ method, request });
    return method === 'turn/start' ? { turn: { id: 'reply' } } : {};
  };
  return { server, calls };
}

function complete(server, status = 'completed', error) {
  setImmediate(() => server.handleNotification({ method: 'turn/completed', params: { turn: { id: 'reply', status, error, items: [{ type: 'agentMessage', text: 'The original audit is still in context.' }] } } }));
  return { turn: { id: 'reply' } };
}

test('archived audit resumes in the same thread without creating a blank session', async () => {
  let resumes = 0;
  const { server, calls } = mockServer((method) => { if (method === 'thread/resume' && ++resumes === 1) throw archived(); return {}; });
  await server.resumeThread(threadId);
  assert.deepEqual(calls.map(c => c.method), ['thread/resume', 'thread/unarchive', 'thread/resume']);
  assert.ok(calls.every(c => c.request.threadId === threadId));
  assert.ok(calls.every(c => c.timeoutMs >= 60_000), 'Archived audit restoration must not use the 30-second generic RPC timeout.');
  assert.ok(server.loadedThreads.has(threadId));
  await server.resumeThread(threadId);
  assert.equal(calls.length, 3, 'Already loaded threads are reused.');
});

test('a cached thread archived by another client recovers at turn/start', async () => {
  let starts = 0;
  const { server, calls } = mockServer((method, request, instance) => {
    if (method === 'turn/start') { if (++starts === 1) throw archived(); return complete(instance); }
    return {};
  });
  server.loadedThreads.add(threadId);
  const reply = await server.runTurn(params);
  assert.match(reply.text, /original audit/);
  assert.deepEqual(calls.map(c => c.method), ['turn/start', 'thread/unarchive', 'thread/resume', 'turn/start']);
  assert.deepEqual(calls[3].request, params, 'Recovery preserves model, effort, sandbox, question, and thread.');
});

test('whole-paper questions, unit questions, and editorial suggestions share recovery', async () => {
  for (const method of ['answerPaper', 'answerNode', 'suggestEditorialPatch']) {
    let resumes = 0;
    const { server, calls } = mockServer((rpc, request, instance) => {
      if (rpc === 'thread/resume' && ++resumes === 1) throw archived();
      if (rpc === 'turn/start') return complete(instance);
      return {};
    });
    await server[method]({ threadId, paper: { title: 'Paper', arxivId: '1234.56789' }, node: { statement: 'Claim' }, question: 'Why?', profile: { reasoning: 'xhigh' } });
    assert.deepEqual(calls.map(c => c.method), ['thread/resume', 'thread/unarchive', 'thread/resume', 'turn/start'], method);
  }
});

test('authentication, missing-thread, and timeout errors are not retried', async () => {
  for (const message of ['Your authentication token has been invalidated.', 'thread not found', 'turn/start timed out.']) {
    const { server, calls } = mockServer(() => { throw new Error(message); });
    await assert.rejects(server.runTurn(params), { message });
    assert.equal(calls.length, 1);
  }
});

test('failed unarchive leaves the thread unloaded and reports the error', async () => {
  const { server, calls } = mockServer((method) => { throw method === 'thread/resume' ? archived() : new Error('Could not restore the saved session.'); });
  await assert.rejects(server.resumeThread(threadId), /Could not restore/);
  assert.equal(server.loadedThreads.has(threadId), false);
  assert.equal(calls.length, 2);
});

test('recovery retries turn/start at most once', async () => {
  const { server, calls } = mockServer(method => { if (method === 'turn/start') throw archived(); return {}; });
  await assert.rejects(server.runTurn(params), /is archived/);
  assert.equal(calls.filter(c => c.method === 'turn/start').length, 2);
});

test('a failed accepted turn is never replayed', async () => {
  const { server, calls } = mockServer((method, request, instance) => complete(instance, 'failed', { message: archived().message }));
  await assert.rejects(server.runTurn(params), /is archived/);
  assert.equal(calls.length, 1);
});

test('active turn notifications extend the inactivity watchdog', async () => {
  const { server, calls } = mockTimedServer({ idle: 200, hard: 1_200 });
  const reply = server.runTurn(params, { taskLabel: 'AI audit' });
  const progress = setInterval(() => server.handleNotification({ method: 'item/reasoning/summaryTextDelta', params: { threadId, turnId: 'reply', delta: '.' } }), 40);
  await new Promise(resolve => setTimeout(resolve, 520));
  clearInterval(progress);
  server.handleNotification({ method: 'turn/completed', params: { turn: { id: 'reply', status: 'completed', items: [{ type: 'agentMessage', text: 'Long audit completed.' }] } } });
  assert.equal((await reply).text, 'Long audit completed.');
  assert.equal(calls.some(call => call.method === 'turn/interrupt'), false);
});

test('an inactive turn is interrupted after its idle limit', async () => {
  const { server, calls } = mockTimedServer({ idle: 100, hard: 800 });
  await assert.rejects(server.runTurn(params, { taskLabel: 'AI audit' }), /no Codex progress/);
  assert.equal(calls.filter(call => call.method === 'turn/interrupt').length, 1);
});

test('an audit has no automatic cutoff when neither watchdog is configured', async () => {
  const { server, calls } = mockTimedServer({ idle: 0, hard: 0 });
  const reply = server.runTurn(params, { taskLabel: 'AI audit' });
  await new Promise(resolve => setTimeout(resolve, 140));
  server.handleNotification({ method: 'turn/completed', params: { turn: { id: 'reply', status: 'completed', items: [{ type: 'agentMessage', text: 'Audit completed after an unbounded run.' }] } } });
  assert.match((await reply).text, /unbounded run/);
  assert.equal(calls.some(call => call.method === 'turn/interrupt'), false);
});

test('the hard safety limit still stops a continuously active turn', async () => {
  const { server, calls } = mockTimedServer({ idle: 200, hard: 600 });
  const progress = setInterval(() => server.handleNotification({ method: 'thread/tokenUsage/updated', params: { threadId } }), 40);
  try {
    await assert.rejects(server.runTurn(params, { taskLabel: 'AI audit' }), /safety limit/);
  } finally {
    clearInterval(progress);
  }
  assert.equal(calls.filter(call => call.method === 'turn/interrupt').length, 1);
});
