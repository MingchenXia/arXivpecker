import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
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
    threadId: 'local-private-reader-thread',
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
const unsafeArchive = path.join(root, 'unsafe-source.zip');
const portableUnsafeArchive = path.join(root, 'portable-unsafe-source.zip');
const symlinkArchive = path.join(root, 'symlink-source.zip');
const expandingArchive = path.join(root, 'expanding-source.zip');
const noTexArchive = path.join(root, 'no-tex-source.zip');
const cloudDirectory = path.join(root, 'cloud-drive');
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
    ARXIVPECKER_CLOUD_TEST_DIR: cloudDirectory,
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

  const preflight = await fetch(`${url}/vault`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');

  const missingRoute = await fetch(`${url}/not-a-route`, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(missingRoute.status, 404, 'Unknown bridge routes must return a bounded JSON 404.');

  const malformed = await fetch(`${url}/vault/paper`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' }, body: '{broken' });
  assert.equal(malformed.status, 500);
  assert.match((await malformed.json()).error, /must be JSON/);

  const missingPaper = await jsonRequest(url, '/vault/paper', { paper: { title: '' } });
  assert.equal(missingPaper.response.status, 400, 'Incomplete paper metadata must be rejected before writing to the vault.');

  const cloudStatus = await (await fetch(`${url}/cloud/status`, { headers: { Origin: 'http://localhost:3000' } })).json();
  assert.equal(cloudStatus.providers.find((provider) => provider.id === 'icloud')?.available, true, 'The configured cloud provider must be discoverable.');

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

  const invalidPdf = await jsonRequest(url, '/vault/source-upload', {
    paper: paper('local-invalid-pdf', 'Invalid PDF upload'),
    upload: { fileName: 'paper.pdf', dataBase64: Buffer.from('not actually a PDF').toString('base64') },
  });
  assert.equal(invalidPdf.response.status, 500, 'A file renamed to .pdf must not be served as a PDF.');
  assert.match(invalidPdf.body.error, /valid PDF header/);

  const pdfPayload = Buffer.from('%PDF-1.4\n% local integration fixture\n%%EOF\n');
  const uploadedPdf = await post(url, '/vault/source-upload', {
    paper: paper('local-pdf-upload', 'Local PDF upload'),
    upload: { fileName: 'paper.pdf', dataBase64: pdfPayload.toString('base64') },
  });
  assert.match(uploadedPdf.paper.source.localPdf, /paper\.pdf$/);
  const localPdf = await fetch(`${url}/paper-pdf?paperId=${encodeURIComponent(uploadedPdf.paper.id)}`, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(localPdf.status, 200);
  assert.equal(localPdf.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await localPdf.arrayBuffer()), pdfPayload);
  const texAsPdf = await fetch(`${url}/paper-pdf?paperId=${encodeURIComponent(direct.paper.id)}`, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(texAsPdf.status, 500, 'A local TeX source must not expose a fabricated original PDF.');

  await mkdir(project, { recursive: true });
  await Promise.all([
    writeFile(path.join(project, 'main.tex'), String.raw`\documentclass{article}\begin{document}\input{appendix}\includegraphics{figure}\end{document}`),
    writeFile(path.join(project, 'appendix.tex'), String.raw`\section{Appendix} $\int_0^1 x\,dx=\frac12$`),
    writeFile(path.join(project, 'figure.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
    writeFile(path.join(project, '..valid.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'),
  ]);
  await runFile('zip', ['-qr', archive, 'main.tex', 'appendix.tex', 'figure.svg', '..valid.svg'], { cwd: project });
  const zipped = await post(url, '/vault/source-upload', {
    paper: paper('local-zip-upload', 'ZIP TeX upload'),
    upload: { fileName: 'project.zip', dataBase64: (await readFile(archive)).toString('base64') },
  });
  assert.equal(zipped.primarySource.kind, 'tex');
  assert.equal(zipped.primarySource.fileCount, 2, 'ZIP upload must discover every TeX file and choose its main document.');

  await writeFile(path.join(root, 'escape.tex'), String.raw`\documentclass{article}\begin{document}Unsafe archive entry.\end{document}`);
  await runFile('zip', ['-q', unsafeArchive, '../escape.tex'], { cwd: project });
  const unsafeUpload = await jsonRequest(url, '/vault/source-upload', {
    paper: paper('local-unsafe-zip', 'Unsafe ZIP upload'),
    upload: { fileName: 'unsafe.zip', dataBase64: (await readFile(unsafeArchive)).toString('base64') },
  });
  assert.equal(unsafeUpload.response.status, 500, 'ZIP entries that escape the project directory must be rejected before extraction.');
  assert.match(unsafeUpload.body.error, /unsafe path/);

  const portableUnsafeName = '..\\portable-escape.tex';
  await writeFile(path.join(project, portableUnsafeName), String.raw`\documentclass{article}\begin{document}Portable traversal.\end{document}`);
  await runFile('zip', ['-q', portableUnsafeArchive, portableUnsafeName], { cwd: project });
  const portableUnsafeUpload = await jsonRequest(url, '/vault/source-upload', {
    paper: paper('local-portable-unsafe-zip', 'Portable unsafe ZIP upload'),
    upload: { fileName: 'portable-unsafe.zip', dataBase64: (await readFile(portableUnsafeArchive)).toString('base64') },
  });
  assert.equal(portableUnsafeUpload.response.status, 500, 'Backslash traversal must be rejected even when the bridge runs on a POSIX host.');
  assert.match(portableUnsafeUpload.body.error, /unsafe path/);

  if (process.platform !== 'win32') {
    const symlinkName = 'linked-source.tex';
    await symlink('/etc/passwd', path.join(project, symlinkName));
    await runFile('zip', ['-qy', symlinkArchive, symlinkName], { cwd: project });
    const symlinkUpload = await jsonRequest(url, '/vault/source-upload', {
      paper: paper('local-symlink-zip', 'Symbolic-link ZIP upload'),
      upload: { fileName: 'symlink.zip', dataBase64: (await readFile(symlinkArchive)).toString('base64') },
    });
    assert.equal(symlinkUpload.response.status, 500, 'A ZIP symbolic link must be rejected before extraction.');
    assert.match(symlinkUpload.body.error, /symbolic link or special file/);
  }

  const archivePayload = await readFile(archive);
  const corruptUpload = await jsonRequest(url, '/vault/source-upload', {
    paper: paper('local-corrupt-zip', 'Truncated ZIP upload'),
    upload: { fileName: 'corrupt.zip', dataBase64: archivePayload.subarray(0, Math.max(1, archivePayload.length - 32)).toString('base64') },
  });
  assert.equal(corruptUpload.response.status, 500, 'A truncated ZIP must fail integrity checks before writing a vault record.');

  await runFile('zip', ['-q', noTexArchive, 'figure.svg'], { cwd: project });
  const noTexUpload = await jsonRequest(url, '/vault/source-upload', {
    paper: paper('local-no-tex-zip', 'ZIP upload without TeX'),
    upload: { fileName: 'no-tex.zip', dataBase64: (await readFile(noTexArchive)).toString('base64') },
  });
  assert.equal(noTexUpload.response.status, 500, 'A ZIP without any TeX source must be rejected before writing a vault record.');
  assert.match(noTexUpload.body.error, /does not contain a TeX file/);

  const expandingFile = path.join(project, 'expanding-source.tex');
  await writeFile(expandingFile, '');
  await truncate(expandingFile, 256 * 1024 * 1024 + 1);
  await runFile('zip', ['-q', expandingArchive, 'expanding-source.tex'], { cwd: project });
  const expandingUpload = await jsonRequest(url, '/vault/source-upload', {
    paper: paper('local-expanding-zip', 'Expanding ZIP upload'),
    upload: { fileName: 'expanding.zip', dataBase64: (await readFile(expandingArchive)).toString('base64') },
  });
  assert.equal(expandingUpload.response.status, 500, 'A highly compressible ZIP must be rejected using its expanded size, not its small upload size.');
  assert.match(expandingUpload.body.error, /256 MB safety limit/);

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
  const dottedAsset = await fetch(`${url}/asset?paperId=${encodeURIComponent(zipped.paper.id)}&file=${encodeURIComponent('..valid.svg')}`, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(dottedAsset.status, 200, 'A legitimate filename beginning with two dots must not be mistaken for parent traversal.');

  if (process.platform !== 'win32') {
    await symlink('/etc/passwd', path.join(zipped.primarySource.sourceDirectory, 'outside.svg'));
    const linkedAsset = await fetch(`${url}/asset?paperId=${encodeURIComponent(zipped.paper.id)}&file=outside.svg`, { headers: { Origin: 'http://localhost:3000' } });
    assert.equal(linkedAsset.status, 500, 'Figure lookup must reject a symbolic link that resolves outside the paper source tree.');
  }

  const escapedAsset = await fetch(`${url}/asset?paperId=${encodeURIComponent(zipped.paper.id)}&file=${encodeURIComponent('../../../../etc/passwd')}`, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(escapedAsset.status, 500, 'Figure lookup must not read files outside the paper source tree.');

  const citation = await post(url, '/vault/citation-asset', { paperId: first.id, upload: { citation: { key: 'test-ref', title: 'Reference asset' }, fileName: 'reference.txt', dataBase64: Buffer.from('reference attachment').toString('base64') } });
  assert.equal(citation.saved.bytes, Buffer.byteLength('reference attachment'));
  await stat(path.join(root, 'library', citation.saved.relativePath));

  const markdown = await post(url, '/vault/export', { paperId: first.id, export: { fileName: 'release-test.md', content: '# Release test\n', selection: { prose: true } } });
  assert.match(markdown.saved.relativePath, /release-test\.md$/);
  await stat(path.join(root, 'library', markdown.saved.relativePath));

  const generatedVersionCache = path.join(root, 'library', zipped.paper.folder, 'attachments', 'source', 'versions', 'old-release');
  await mkdir(generatedVersionCache, { recursive: true });
  await writeFile(path.join(generatedVersionCache, 'stale.tex'), String.raw`\documentclass{article}\begin{document}Stale cached version.\end{document}`);
  const latex = await post(url, '/vault/latex-export', { paperId: zipped.paper.id, export: { edition: 'working', content: String.raw`\documentclass{article}\begin{document}Release test\end{document}` } });
  assert.equal(latex.saved.format, 'zip', 'Multi-file TeX sources must export a portable ZIP edition.');
  assert.equal(latex.saved.sourceFiles, 2, 'Generated version-comparison caches must not count as active source files.');
  const exportedArchive = path.join(root, 'library', latex.saved.relativePath);
  await stat(exportedArchive);
  const { stdout: listing } = await runFile('unzip', ['-Z1', exportedArchive]);
  assert.match(listing, /original-source\/.*main\.tex/);
  assert.match(listing, /arxivpecker-working-edition\.tex/);
  assert.doesNotMatch(listing, /original-source\/versions\//, 'Version-comparison caches must not leak into a working-edition source export.');

  if (process.platform === 'darwin') {
    const shared = await post(url, '/cloud/share', { provider: 'icloud', title: 'Release test share', paperIds: [first.id], selection: { source: false, audit: true, notes: true, edits: true, references: false, preferences: true }, uiPreferences: { density: 'comfortable' } });
    assert.equal(shared.share.paperCount, 1);
    const sharedArchive = path.join(cloudDirectory, 'arXivpecker', 'Shares', shared.share.fileName);
    await stat(sharedArchive);
    const { stdout: sharedAuditText } = await runFile('unzip', ['-p', sharedArchive, '*/papers/*/audit.json']);
    assert.equal(JSON.parse(sharedAuditText).threadId, '', 'Portable cloud shares must not disclose a machine-local Codex thread identifier.');
  }

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
  assert.ok(!snapshot.papers.some((item) => ['local-unsafe-zip', 'local-portable-unsafe-zip', 'local-symlink-zip', 'local-corrupt-zip', 'local-expanding-zip', 'local-no-tex-zip'].includes(item.arxivId)), 'Rejected ZIP uploads must not leave empty paper records in the vault.');

  const graphSnapshot = await (await fetch(`${url}/vault/graph`, { headers: { Origin: 'http://localhost:3000' } })).json();
  assert.deepEqual(graphSnapshot.graph, snapshot.graph, 'The graph-only endpoint must agree with the complete vault snapshot.');

  console.log('Bridge and vault integration: origin and route safety, imports, source assets, reader state, exports, cloud sharing, updates, graph links, and recoverable removal verified.');
} finally {
  child.kill('SIGTERM');
  await exited;
  await rm(root, { recursive: true, force: true });
}
