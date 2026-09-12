import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';

const runFile = promisify(execFile);

function paper(arxivId, title) {
  return {
    id: `temporary-${arxivId}`,
    title,
    authors: 'Release Test Author',
    category: 'math.AG',
    arxivId,
    abstract: 'A local integration-test record.',
    state: 'To read',
    tags: ['math.AG'],
  };
}

function audit(nodeId, title) {
  return {
    threadId: '',
    centralQuestion: 'Does this local integration test preserve reader data?',
    mainContribution: 'It exercises the complete local vault API.',
    verificationWarnings: [],
    nodes: [{
      id: nodeId,
      kind: 'theorem',
      label: 'Theorem 1',
      title,
      statement: '$x=x$.',
      proofText: 'Immediate.',
      status: 'needs-review',
      anchor: { label: 'Theorem 1', page: 1, confidence: 'exact' },
      role: 'Release-test result',
      dependencies: [],
      proofSketch: ['Use reflexivity.'],
      whyItMatters: 'Provides a stable graph node.',
      expandable: true,
    }],
    sourceBlocks: [{
      id: `source-${nodeId}`,
      kind: 'result',
      level: 2,
      title: 'Theorem 1',
      content: '$x=x$.',
      proofText: 'Immediate.',
      nodeId,
      resultKind: 'theorem',
      citations: [],
      assetPaths: [],
      caption: '',
    }],
  };
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  probe.close();
  await once(probe, 'close');
  return port;
}

async function waitFor(url, child, output) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Bridge stopped before it was ready:\n${output()}`);
    try {
      const response = await fetch(`${url}/vault`);
      if (response.ok) return;
    } catch { /* The bridge is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Bridge did not become ready:\n${output()}`);
}

async function jsonRequest(url, pathname, body) {
  const response = await fetch(`${url}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function post(url, pathname, body) {
  const result = await jsonRequest(url, pathname, body);
  assert.equal(result.response.status, 200, `${pathname} failed: ${result.body.error || result.response.statusText}`);
  return result.body;
}

const root = await mkdtemp(path.join(os.tmpdir(), 'arxivpecker-bridge-test-'));
const project = path.join(root, 'multi-source');
const archive = path.join(root, 'multi-source.zip');
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const output = [];
const child = spawn(process.execPath, ['scripts/codex-bridge.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PROOFROOM_LIBRARY_DIR: path.join(root, 'library'),
    PROOFROOM_CODEX_PORT: String(port),
    ARXIVPECKER_SKIP_STARTER_LIBRARY: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
child.stdout.on('data', (chunk) => output.push(chunk.toString()));
child.stderr.on('data', (chunk) => output.push(chunk.toString()));

try {
  await waitFor(url, child, () => output.join(''));

  const rejectedOrigin = await fetch(`${url}/vault`, { headers: { Origin: 'https://example.test' } });
  assert.equal(rejectedOrigin.status, 403, 'The local bridge must reject non-local origins.');

  const profile = await post(url, '/vault/profile', { profile: { level: 'Researcher', areas: ['math.AG', 'not-an-area'], goal: 'Reproduce a proof', reasoning: 'high' } });
  assert.deepEqual(profile.profile.areas, ['math.AG'], 'Profile normalization must preserve only valid mathematics areas.');

  const first = (await post(url, '/vault/paper', { paper: paper('2601.00001v1', 'First release-test paper') })).paper;
  const second = (await post(url, '/vault/paper', { paper: paper('2601.00002v1', 'Second release-test paper') })).paper;
  assert.equal(first.id, 'arxiv-2601.00001');
  assert.equal(second.id, 'arxiv-2601.00002');

  const directTex = String.raw`\documentclass{article}\begin{document}\section{Direct upload} $\left(\lambda+1\right)$\end{document}`;
  const direct = await post(url, '/vault/source-upload', {
    paper: paper('local-direct-upload', 'Direct TeX upload'),
    upload: { fileName: 'main.tex', dataBase64: Buffer.from(directTex).toString('base64') },
  });
  assert.equal(direct.primarySource.kind, 'tex');
  assert.equal(direct.primarySource.fileCount, 1);

  await (await import('node:fs/promises')).mkdir(project, { recursive: true });
  await Promise.all([
    writeFile(path.join(project, 'main.tex'), String.raw`\documentclass{article}\begin{document}\input{appendix}\includegraphics{figure}\end{document}`),
    writeFile(path.join(project, 'appendix.tex'), String.raw`\section{Appendix} $\int_0^1 x\,dx=\frac12$`),
    writeFile(path.join(project, 'figure.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
  ]);
  await runFile('zip', ['-qr', archive, 'main.tex', 'appendix.tex', 'figure.svg'], { cwd: project });
  const zipped = await post(url, '/vault/source-upload', {
    paper: paper('local-zip-upload', 'ZIP TeX upload'),
    upload: { fileName: 'project.zip', dataBase64: (await readFile(archive)).toString('base64') },
  });
  assert.equal(zipped.primarySource.kind, 'tex');
  assert.equal(zipped.primarySource.fileCount, 2, 'ZIP upload must discover every TeX file and choose its main document.');

  const badUpload = await jsonRequest(url, '/vault/source-upload', {
    paper: paper('local-invalid-upload', 'Invalid upload'),
    upload: { fileName: 'unsupported.txt', dataBase64: Buffer.from('not TeX').toString('base64') },
  });
  assert.equal(badUpload.response.status, 500, 'Unsupported upload types must be rejected.');

  const firstAudit = await post(url, '/vault/audit', { paper: first, audit: audit('first-result', 'First release-test theorem') });
  await post(url, '/vault/audit', { paper: second, audit: audit('second-result', 'Second release-test theorem') });
  await post(url, '/vault/audit', { paper: zipped.paper, audit: audit('zip-result', 'ZIP release-test theorem') });
  assert.equal(firstAudit.paper.id, first.id);

  const reader = await post(url, '/vault/reader', {
    paperId: first.id,
    reader: { notes: [{ id: 'note-1', paperId: first.id, text: 'Keep this note.', createdAt: '2026-01-01T00:00:00.000Z' }], nodeNotes: { 'first-result': 'Reader note' }, nodeAnswers: { 'first-result': 'Reader answer' }, expanded: { section: true }, marks: { 'first-result': 'understood', invalid: 'ignored' } },
  });
  assert.deepEqual(reader.reader.marks, { 'first-result': 'understood' });

  const patched = await post(url, '/vault/patches', {
    paperId: first.id,
    patches: [{ kind: 'replace', nodeId: 'first-result', nodeKind: 'theorem', title: 'Edited theorem', statement: '$x=x$.', proofText: 'Still immediate.', dependencies: [], proofSketch: [], source: 'manual' }, { kind: 'add', afterNodeId: 'first-result', nodeKind: 'remark', title: 'Reader addition', statement: 'A reversible local addition.', proofText: '', dependencies: ['first-result'], proofSketch: [], source: 'manual' }],
  });
  assert.equal(patched.patches.length, 2);

  const link = await post(url, '/vault/link', { link: { from: { paperId: first.id, nodeId: 'first-result' }, to: { paperId: second.id, nodeId: 'second-result' }, relation: 'extends', note: 'Cross-paper release-test relation.' } });
  assert.equal(link.link.relation, 'extends');
  assert.ok(link.graph.edges.some((edge) => edge.source === 'manual'));

  const asset = await fetch(`${url}/asset?paperId=${encodeURIComponent(zipped.paper.id)}&file=figure.svg`, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'image/svg+xml');

  const citation = await post(url, '/vault/citation-asset', { paperId: first.id, upload: { citation: { key: 'test-ref', title: 'Reference asset' }, fileName: 'reference.txt', dataBase64: Buffer.from('reference attachment').toString('base64') } });
  assert.equal(citation.saved.bytes, Buffer.byteLength('reference attachment'));
  await stat(path.join(root, 'library', citation.saved.relativePath));

  const markdown = await post(url, '/vault/export', { paperId: first.id, export: { fileName: 'release-test.md', content: '# Release test\n', selection: { prose: true } } });
  assert.match(markdown.saved.relativePath, /release-test\.md$/);
  await stat(path.join(root, 'library', markdown.saved.relativePath));

  const latex = await post(url, '/vault/latex-export', { paperId: zipped.paper.id, export: { edition: 'working', content: String.raw`\documentclass{article}\begin{document}Release test\end{document}` } });
  assert.equal(latex.saved.format, 'zip', 'Multi-file TeX sources must export a portable ZIP edition.');
  const exportedArchive = path.join(root, 'library', latex.saved.relativePath);
  await stat(exportedArchive);
  const { stdout: listing } = await runFile('unzip', ['-Z1', exportedArchive]);
  assert.match(listing, /original-source\/.*main\.tex/);
  assert.match(listing, /arxivpecker-working-edition\.tex/);

  const started = await post(url, '/vault/audit', { paper: direct.paper, audit: audit('direct-result', 'Direct upload theorem') });
  assert.equal(started.paper.id, direct.paper.id);
  const resumeStart = await post(url, '/vault/paper/order', { paperIds: [second.id, first.id, zipped.paper.id, direct.paper.id] });
  assert.equal(resumeStart.order[0], second.id);

  const update = await post(url, '/vault/paper/update-commit', {
    paper: { ...first, arxivId: '2601.00001v2', title: 'First release-test paper, revised' },
    audit: audit('first-result-v2', 'Revised release-test theorem'),
    reader: { notes: [], nodeNotes: {}, nodeAnswers: {}, expanded: {}, marks: {} },
    patches: [],
    update: { fromVersion: '2601.00001v1', toVersion: '2601.00001v2', comparison: { summary: 'Release-test revision.' } },
    nodeMap: { 'first-result': 'first-result-v2' },
  });
  assert.equal(update.update.toVersion, '2601.00001v2');

  await post(url, '/vault/link/delete', { linkId: link.link.id });
  const deletion = await post(url, '/vault/paper/delete', { paperId: second.id });
  assert.equal(deletion.removed.paperId, second.id);

  const snapshot = await (await fetch(`${url}/vault`, { headers: { Origin: 'http://localhost:3000' } })).json();
  assert.ok(snapshot.papers.some((item) => item.id === first.id && item.arxivId === '2601.00001v2'));
  assert.ok(!snapshot.papers.some((item) => item.id === second.id));
  assert.ok(snapshot.updates[first.id].some((item) => item.toVersion === '2601.00001v2'));
  assert.ok(snapshot.graph.nodes.some((item) => item.nodeId === 'first-result-v2'));

  console.log('Bridge and vault integration: imports, source assets, reader state, exports, updates, graph links, and recoverable removal verified.');
} finally {
  child.kill('SIGTERM');
  await exited;
  await rm(root, { recursive: true, force: true });
}
