import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Drives the audit job lifecycle through the real bridge, with the scripted
// Codex stand-in from e2e/fixtures/bin in place of the Codex CLI.
const project = path.resolve(import.meta.dirname, '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'arxivpecker-audit-job-'));
const library = path.join(root, 'library');
const codexLog = path.join(root, 'codex.log');
const paperId = 'arxiv-2607.17203';
const origin = 'http://localhost:3000';

async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  return port;
}

async function startBridge(port) {
  const output = [];
  const child = spawn(process.execPath, ['scripts/codex-bridge.mjs'], {
    cwd: project,
    env: {
      ...process.env,
      PROOFROOM_LIBRARY_DIR: library,
      PROOFROOM_CODEX_PORT: String(port),
      PATH: `${path.join(project, 'e2e', 'fixtures', 'bin')}${path.delimiter}${process.env.PATH}`,
      FAKE_CODEX_TURN_MS: '2500',
      FAKE_CODEX_LOG: codexLog,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Bridge stopped:\n${output.join('')}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/vault`)).ok) return child;
    } catch {
      /* Still starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Bridge did not start:\n${output.join('')}`);
}

async function stopBridge(child) {
  child.kill('SIGTERM');
  if (child.exitCode === null) await once(child, 'exit');
}

/** Opens the server-sent event stream and returns a way to wait for a matching job event. */
async function openEvents(url) {
  const controller = new AbortController();
  const response = await fetch(`${url}/events`, { headers: { Origin: origin }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  const events = [];
  const waiters = [];
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!event || !data) continue;
          events.push({ event, data: JSON.parse(data) });
          for (const waiter of [...waiters]) if (waiter.test(events.at(-1))) waiter.resolve(events.at(-1));
        }
      }
    } catch {
      /* Closed by the test. */
    }
  })();
  return {
    events,
    close: () => controller.abort(),
    next(test, label, timeoutMs = 20_000) {
      const seen = events.find(test);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
        waiters.push({ test, resolve: (value) => (clearTimeout(timer), resolve(value)) });
      });
    },
  };
}

const jobIs =
  (state, predicate = () => true) =>
  (entry) =>
    entry.event === 'job' &&
    entry.data.paperId === paperId &&
    entry.data.job.state === state &&
    predicate(entry.data.job);

async function post(url, pathname, body) {
  const response = await fetch(`${url}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

let bridge;
try {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  bridge = await startBridge(port);
  const paper = (await (await fetch(`${url}/vault`)).json()).papers.find((item) => item.id === paperId);
  assert.ok(paper, 'The unaudited starter paper is available.');

  // 1. An audit answers at once and reports progress while Codex works.
  let events = await openEvents(url);
  const started = await post(url, '/analyze', { paper, profile: {} });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.job.state, 'running');
  const duplicate = await post(url, '/analyze', { paper, profile: {} });
  assert.equal(duplicate.status, 409, 'A second audit of the same paper must be refused while one runs.');
  await events.next(
    jobIs('running', (job) => job.progress?.steps > 0),
    'progress',
  );
  await events.next(jobIs('ready'), 'a stored result');
  events.close();

  // 2. The finished result survives a bridge restart before any reader has used it.
  await stopBridge(bridge);
  bridge = await startBridge(port);
  const snapshot = await (await fetch(`${url}/vault`)).json();
  assert.equal(snapshot.auditJobs[paperId].state, 'ready');
  const stored = await (await fetch(`${url}/analyze/result?paperId=${paperId}`)).json();
  const audit = JSON.parse(stored.text);
  assert.ok(audit.nodes.some((node) => node.title === 'Scripted main result'));
  assert.ok(audit.sourceBlocks?.length > 0, 'The stored result is already enriched from the TeX source.');

  // 3. Saving the audit completes the job and removes the stored result.
  events = await openEvents(url);
  const saved = await post(url, '/vault/audit', { paper, audit: { ...audit, threadId: stored.threadId } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await events.next(jobIs('completed'), 'completion');
  assert.equal((await fetch(`${url}/analyze/result?paperId=${paperId}`)).status, 404);

  // 4. Stopping an audit interrupts the Codex turn and leaves a resumable job.
  const again = await post(url, '/analyze', { paper, profile: {} });
  assert.equal(again.status, 202);
  await events.next(
    jobIs('running', (job) => Boolean(job.threadId)),
    'a thread',
  );
  assert.equal((await post(url, '/analyze/cancel', { paperId })).status, 202);
  const paused = await events.next(jobIs('paused'), 'the stopped job');
  assert.match(paused.data.job.message, /Stopped by the reader/);
  events.close();
  const codexCalls = (await readFile(codexLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).method);
  assert.ok(codexCalls.includes('turn/interrupt'), 'Stopping must interrupt the running Codex turn.');
  assert.equal((await post(url, '/analyze/cancel', { paperId })).status, 409, 'Nothing is left to stop.');

  console.log(
    'Audit jobs: background start, progress events, restart-safe results, completion, and stopping verified.',
  );
} finally {
  if (bridge) await stopBridge(bridge);
  await rm(root, { recursive: true, force: true });
}
