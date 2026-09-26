import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cloudStatus, createCloudShare } from './cloud-share.mjs';
import { CodexAppServer } from './codex-app-server.mjs';
import { extractLatexDocument } from './codex-prompts.mjs';
import { PaperVault, relativePathEscapes } from './paper-vault.mjs';
import { decodeSourceBuffer, enrichAuditFromTex, sameExpandedTexSource } from './tex-source.mjs';

const PORT = Number(process.env.PROOFROOM_CODEX_PORT || 4318);
const HOST = '127.0.0.1';
const WORKDIR = process.cwd();
const vaultRoot = path.resolve(process.env.PROOFROOM_LIBRARY_DIR || path.join(WORKDIR, 'proofroom-library'));
const starterRoot =
  process.env.ARXIVPECKER_SKIP_STARTER_LIBRARY === '1'
    ? null
    : path.resolve(process.env.ARXIVPECKER_STARTER_LIBRARY_DIR || path.join(WORKDIR, 'examples', 'starter-library'));
const vault = new PaperVault(vaultRoot, { starterRoot });
const MAX_SOURCE_BYTES = 80 * 1024 * 1024;
const MAX_EXPANDED_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_SOURCE_ARCHIVE_ENTRIES = 2000;
const DEFAULT_JSON_BODY_CHARS = 1_000_000;
// An audit save contains the model report plus extracted TeX/source evidence.
// Give that endpoint its own generous ceiling without weakening small mutation
// endpoints, which should still reject unexpectedly large requests quickly.
const MAX_AUDIT_JSON_BODY_CHARS = 32_000_000;
const MAX_PAPER_UPDATE_JSON_BODY_CHARS = 24_000_000;
const MAX_SOURCE_UPLOAD_JSON_BODY_CHARS = 112_000_000;
// Reader state carries every saved AI answer and paper-chat transcript.
const MAX_READER_JSON_BODY_CHARS = 8_000_000;

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

function runProgram(command, args, maxOutput = MAX_SOURCE_BYTES, cwd = WORKDIR) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size <= maxOutput) stdout.push(chunk);
      else child.kill();
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (size > maxOutput) return reject(new Error('arXiv source archive expands beyond the local safety limit.'));
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `${command} exited with ${code}.`));
    });
  });
}

function hydrateSourceManifest(manifest, manifestFile) {
  const directory = path.dirname(manifestFile);
  const hydrated = { ...manifest };
  for (const key of ['entryFile', 'sourceDirectory', 'uploadedFile']) {
    if (!hydrated[key]) continue;
    if (!path.isAbsolute(hydrated[key])) hydrated[key] = path.resolve(directory, hydrated[key]);
    // Manifests share a folder with extracted arXiv files, so a source bundle can
    // ship its own. Never let one point the reader at files outside this paper.
    if (relativePathEscapes(path.relative(directory, hydrated[key])))
      throw new Error('The source manifest points outside its paper folder.');
  }
  return hydrated;
}

async function writeSourceManifest(manifestFile, manifest) {
  const directory = path.dirname(manifestFile);
  const portable = { ...manifest };
  for (const key of ['entryFile', 'sourceDirectory', 'uploadedFile']) {
    if (!portable[key] || !path.isAbsolute(portable[key])) continue;
    const relative = path.relative(directory, portable[key]);
    if (!relativePathEscapes(relative)) portable[key] = relative || '.';
  }
  await writeFile(manifestFile, `${JSON.stringify(portable, null, 2)}\n`, 'utf8');
}

async function collectTexFiles(directory, root = directory, depth = 0) {
  if (depth > 8) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['__MACOSX', 'auto'].includes(entry.name)) continue;
    // Version comparison caches live beside the active source tree. They are
    // never part of the current manuscript and must not affect main-file
    // selection or turn a single-file export into a huge multi-version ZIP.
    if (depth === 0 && entry.isDirectory() && entry.name === 'versions') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTexFiles(absolute, root, depth + 1)));
    else if (entry.isFile() && /\.(tex|ltx)$/i.test(entry.name))
      files.push({ absolute, relative: path.relative(root, absolute) });
    if (files.length >= 2000) break;
  }
  return files;
}

async function chooseMainTex(files) {
  const scored = [];
  for (const file of files) {
    const details = await stat(file.absolute);
    if (details.size > 12 * 1024 * 1024) continue;
    const text = decodeSourceBuffer(await readFile(file.absolute));
    const name = path.basename(file.relative).toLowerCase();
    const score =
      (/\\documentclass/.test(text) ? 100 : 0) +
      (/\\begin\{document\}/.test(text) ? 50 : 0) +
      (/^(main|paper|article|ms|manuscript)\.(tex|ltx)$/.test(name) ? 25 : 0) +
      Math.min(details.size / 50_000, 20);
    scored.push({ ...file, bytes: details.size, score });
  }
  return scored.sort((left, right) => right.score - left.score)[0] ?? null;
}

async function uploadedPaperSource(paper) {
  const sourceRoot = await vault.sourceDirectory(paper.id);
  const manifestFile = path.join(sourceRoot, 'proofroom-uploaded-source.json');
  const manifest = hydrateSourceManifest(JSON.parse(await readFile(manifestFile, 'utf8')), manifestFile);
  if (!manifest.entryFile || !manifest.sourceDirectory) throw new Error('The uploaded source manifest is incomplete.');
  await stat(manifest.entryFile);
  return { ...manifest, cached: true };
}

async function inspectZipSource(archive) {
  const summary = (await runProgram('unzip', ['-Z', '-t', archive], 1024 * 1024)).toString('utf8');
  const totals = /(\d+) files?,\s+(\d+) bytes uncompressed\b/.exec(summary);
  if (!totals) throw new Error('The ZIP source project has unreadable size metadata.');
  const entryCount = Number(totals[1]);
  const expandedBytes = Number(totals[2]);
  if (!Number.isSafeInteger(entryCount) || entryCount < 1 || entryCount > MAX_SOURCE_ARCHIVE_ENTRIES)
    throw new Error(`ZIP source projects are limited to ${MAX_SOURCE_ARCHIVE_ENTRIES} entries.`);
  if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_EXPANDED_SOURCE_BYTES)
    throw new Error('The ZIP source project expands beyond the 256 MB safety limit.');
  const listing = (await runProgram('unzip', ['-Z1', archive], 4 * 1024 * 1024))
    .toString('utf8')
    .split('\n')
    .filter(Boolean);
  const unsafePath = listing.some((entry) => {
    const portable = entry.replace(/\\/g, '/');
    return (
      portable.startsWith('/') ||
      /^[A-Za-z]:\//.test(portable) ||
      portable.split('/').includes('..') ||
      portable.includes('\0')
    );
  });
  if (!listing.length || unsafePath) throw new Error('The ZIP source project contains an unsafe path.');
  if (!listing.some((entry) => /\.(?:tex|ltx)$/i.test(entry)))
    throw new Error('The ZIP source project does not contain a TeX file.');
  const detailedListing = (await runProgram('unzip', ['-Z', '-l', archive], 4 * 1024 * 1024)).toString('utf8');
  if (/^[lbcps][rwxStTs-]{9}\s/m.test(detailedListing))
    throw new Error('The ZIP source project contains a symbolic link or special file.');
  // Reading the central directory is insufficient for detecting a truncated or
  // corrupt member. Validate every member before the vault receives a record.
  await runProgram('unzip', ['-tqq', archive], 1024 * 1024);
  return listing;
}

async function saveUploadedPaperSource(paper, upload) {
  const encoded = typeof upload?.dataBase64 === 'string' ? upload.dataBase64 : '';
  const payload = Buffer.from(encoded, 'base64');
  if (!payload.length) throw new Error('The uploaded paper source is empty.');
  if (payload.length > MAX_SOURCE_BYTES) throw new Error('Paper source uploads are limited to 80 MB.');
  const requestedName = String(upload?.fileName || 'source.tex');
  const extension = path.extname(requestedName).toLowerCase();
  if (!['.tex', '.ltx', '.zip', '.pdf'].includes(extension))
    throw new Error('Upload one TeX file, one PDF, or one ZIP source project.');
  if (extension === '.pdf' && payload.subarray(0, 1024).indexOf(Buffer.from('%PDF-')) < 0)
    throw new Error('The uploaded PDF does not have a valid PDF header.');
  if (extension === '.zip') {
    // Validate the central directory before adding a paper record. A malformed,
    // traversal, or high-expansion archive must leave the user's vault untouched.
    const preflightDirectory = await mkdtemp(path.join(os.tmpdir(), 'arxivpecker-zip-check-'));
    try {
      const preflightArchive = path.join(preflightDirectory, 'source.zip');
      await writeFile(preflightArchive, payload);
      await inspectZipSource(preflightArchive);
    } finally {
      await rm(preflightDirectory, { recursive: true, force: true });
    }
  }
  const stored = await vault.upsertPaper(paper);
  const sourceRoot = await vault.sourceDirectory(stored.id);
  const sourceDirectory = path.join(sourceRoot, `reader-upload-${Date.now()}`);
  await mkdir(sourceDirectory, { recursive: true });
  const fileName =
    requestedName
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 140) || `source${extension}`;
  const uploadedFile = path.join(sourceDirectory, fileName);
  await writeFile(uploadedFile, payload);
  let entryFile = uploadedFile;
  let fileCount = 1;
  let kind = extension === '.pdf' ? 'uploaded-pdf' : 'tex';
  if (extension === '.zip') {
    const projectDirectory = path.join(sourceDirectory, 'project');
    await mkdir(projectDirectory, { recursive: true });
    await runProgram('unzip', ['-q', uploadedFile, '-d', projectDirectory], 8 * 1024 * 1024);
    const texFiles = await collectTexFiles(projectDirectory);
    const main = await chooseMainTex(texFiles);
    if (!main) throw new Error('No TeX file was found in the ZIP source project.');
    entryFile = main.absolute;
    fileCount = texFiles.length;
  }
  const manifest = {
    kind,
    origin: 'reader-upload',
    entryFile,
    sourceDirectory: extension === '.zip' ? path.dirname(entryFile) : sourceDirectory,
    fileCount,
    uploadedFile,
    uploadedAt: new Date().toISOString(),
    cached: false,
  };
  await writeSourceManifest(path.join(sourceRoot, 'proofroom-uploaded-source.json'), manifest);
  const source = await vault.saveSourceRecord(stored.id, {
    analysisFormat: kind === 'tex' ? 'tex' : 'pdf',
    sourceDirectory: manifest.sourceDirectory,
    mainTex: kind === 'tex' ? entryFile : '',
    localPdf: kind === 'uploaded-pdf' ? entryFile : '',
    sourceUploadedAt: manifest.uploadedAt,
  });
  return { paper: { ...stored, source }, primarySource: manifest };
}

async function saveCompleteLatexExport(paperId, exportRecord) {
  const content = typeof exportRecord?.content === 'string' ? exportRecord.content : '';
  if (!content.includes('\\begin{document}') || !content.includes('\\end{document}'))
    throw new Error('The complete LaTeX export is missing its document boundary.');
  if (Buffer.byteLength(content, 'utf8') > 16 * 1024 * 1024) throw new Error('The complete LaTeX export is too large.');
  const record = await vault.recordFor(String(paperId));
  const paperDirectory = vault.paperDirectory(record);
  const exportDirectory = path.join(paperDirectory, 'exports');
  await mkdir(exportDirectory, { recursive: true });
  const edition = exportRecord?.edition === 'original' ? 'author' : 'working';
  const sourceRoot = await vault.sourceDirectory(String(paperId));
  const savedPaper = JSON.parse(await readFile(path.join(paperDirectory, 'paper.json'), 'utf8'));
  const configuredSource =
    typeof savedPaper?.source?.sourceDirectory === 'string'
      ? path.resolve(paperDirectory, savedPaper.source.sourceDirectory)
      : sourceRoot;
  const configuredRelative = path.relative(sourceRoot, configuredSource);
  const currentSourceRoot = relativePathEscapes(configuredRelative) ? sourceRoot : configuredSource;
  let texFiles = [];
  try {
    texFiles = await collectTexFiles(currentSourceRoot);
  } catch {
    /* A generated single-file export remains available. */
  }
  if (texFiles.length <= 1) {
    const fileName = `arxivpecker-${edition}-edition.tex`;
    const file = path.join(exportDirectory, fileName);
    await writeFile(file, content, 'utf8');
    return {
      fileName,
      relativePath: path.relative(vault.root, file),
      format: 'tex',
      bytes: Buffer.byteLength(content, 'utf8'),
    };
  }
  const fileName = `arxivpecker-${edition}-edition-source.zip`;
  const file = path.join(exportDirectory, fileName);
  const staging = await mkdtemp(path.join(exportDirectory, '.latex-export-'));
  try {
    const versionCache = path.join(sourceRoot, 'versions');
    await cp(currentSourceRoot, path.join(staging, 'original-source'), {
      recursive: true,
      filter: (candidate) => candidate !== versionCache && !candidate.startsWith(`${versionCache}${path.sep}`),
    });
    await writeFile(path.join(staging, `arxivpecker-${edition}-edition.tex`), content, 'utf8');
    // `ditto` is macOS-only. `zip` is available on both supported developer
    // platforms and in CI, so multi-file LaTeX exports remain portable.
    await runProgram('zip', ['-qr', file, '.'], 8 * 1024 * 1024, staging);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { fileName, relativePath: path.relative(vault.root, file), format: 'zip', sourceFiles: texFiles.length };
}

async function acquireArxivSource(paper, requestedArxivId = paper.arxivId, versionCache = false) {
  if (!versionCache) {
    try {
      return await uploadedPaperSource(paper);
    } catch {
      /* No reader upload; continue with arXiv. */
    }
  }
  const sourceRoot = await vault.sourceDirectory(paper.id);
  const cacheName = String(requestedArxivId).replace(/[^a-zA-Z0-9.-]+/g, '-');
  const sourceDirectory = versionCache ? path.join(sourceRoot, 'versions', cacheName) : sourceRoot;
  const manifestFile = path.join(sourceDirectory, 'proofroom-source.json');
  try {
    const cached = hydrateSourceManifest(JSON.parse(await readFile(manifestFile, 'utf8')), manifestFile);
    if (cached.kind === 'tex' && cached.entryFile && (!cached.arxivId || cached.arxivId === requestedArxivId)) {
      await stat(cached.entryFile);
      return { ...cached, cached: true };
    }
  } catch {
    /* Download or repair the source cache below. */
  }
  await mkdir(sourceDirectory, { recursive: true });
  const archive = path.join(sourceDirectory, 'arxiv-source.tar');
  const encodedArxivId = String(requestedArxivId).split('/').map(encodeURIComponent).join('/');
  let response = null;
  let sourceError = null;
  const sourceUrls = [
    `https://export.arxiv.org/e-print/${encodedArxivId}`,
    `https://arxiv.org/e-print/${encodedArxivId}`,
    `https://arxiv.org/src/${encodedArxivId}`,
    `https://browse.arxiv.org/e-print/${encodedArxivId}`,
  ];
  for (const sourceUrl of sourceUrls) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const candidate = await fetch(sourceUrl, {
          redirect: 'follow',
          signal: AbortSignal.timeout(90_000),
          headers: { 'User-Agent': 'arXivpecker/0.2 (local mathematics paper reader; TeX-first)' },
        });
        if (!candidate.ok) throw new Error(`returned ${candidate.status}`);
        response = candidate;
        break;
      } catch (error) {
        sourceError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    if (response) break;
  }
  if (!response)
    throw new Error(
      `arXiv TeX source could not be retrieved${sourceError instanceof Error ? `: ${sourceError.message}` : '.'}`,
    );
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_SOURCE_BYTES) throw new Error('arXiv TeX source is larger than the local safety limit.');
  const payload = Buffer.from(await response.arrayBuffer());
  if (!payload.length || payload.length > MAX_SOURCE_BYTES) throw new Error('arXiv TeX source is empty or too large.');
  await writeFile(archive, payload);
  let listing = null;
  try {
    listing = (await runProgram('tar', ['-tf', archive], 4 * 1024 * 1024)).toString('utf8').split('\n').filter(Boolean);
  } catch {
    /* Not a tar archive: single-file submissions are served as gzip-compressed TeX. */
  }
  if (listing) {
    // Validation failures must stop here rather than fall through to the gzip
    // path, which would save the raw tar bytes as main.tex.
    if (listing.some((entry) => path.isAbsolute(entry) || path.normalize(entry).split(path.sep).includes('..')))
      throw new Error('arXiv source archive contains an unsafe path.');
    const detailedListing = (await runProgram('tar', ['-tvf', archive], 8 * 1024 * 1024)).toString('utf8');
    if (/^[lhbcps]/m.test(detailedListing))
      throw new Error('arXiv source archive contains a symbolic link or special file.');
    await runProgram('tar', ['-xf', archive, '-C', sourceDirectory], 4 * 1024 * 1024);
  } else {
    try {
      await writeFile(path.join(sourceDirectory, 'main.tex'), await runProgram('gzip', ['-dc', archive]));
    } catch {
      throw new Error('arXiv did not provide a readable TeX source archive for this paper.');
    }
  }
  const texFiles = await collectTexFiles(sourceDirectory);
  const main = await chooseMainTex(texFiles);
  if (!main || main.score < 50) throw new Error('No reliable main TeX document was found in the arXiv source bundle.');
  const manifest = {
    kind: 'tex',
    arxivId: requestedArxivId,
    entryFile: main.absolute,
    sourceDirectory,
    fileCount: texFiles.length,
    archiveBytes: payload.length,
    fetchedAt: new Date().toISOString(),
    cached: false,
  };
  await writeSourceManifest(manifestFile, manifest);
  return manifest;
}

async function saveAiLatexSource(paper, converted) {
  // Validate before creating or replacing any local source files. A provider
  // refusal can contain a syntactically complete, tiny LaTeX wrapper; saving
  // that wrapper would make the reader treat an error message as the paper.
  const latex = extractLatexDocument(converted.text, paper);
  const sourceRoot = await vault.sourceDirectory(paper.id);
  const sourceDirectory = path.join(sourceRoot, 'ai-converted');
  await mkdir(sourceDirectory, { recursive: true });
  const entryFile = path.join(sourceDirectory, 'main.tex');
  const manifestFile = path.join(sourceDirectory, 'proofroom-ai-source.json');
  await writeFile(entryFile, latex, 'utf8');
  const manifest = {
    kind: 'ai-tex',
    arxivId: paper.arxivId,
    entryFile,
    sourceDirectory,
    fileCount: 1,
    convertedAt: new Date().toISOString(),
    conversionThreadId: converted.threadId,
    cached: false,
  };
  await writeSourceManifest(manifestFile, manifest);
  return manifest;
}

function normalizeArxivVersion(value) {
  return (
    decodeURIComponent(String(value || '').trim())
      .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
      .replace(/\.pdf(?:\?.*)?$/i, '')
      .replace(/[?#].*$/, '')
      .match(/(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i)?.[0] ?? ''
  );
}

const codex = new CodexAppServer();
const threadQueues = new Map();
let vaultMutationQueue = Promise.resolve();
const activeAuditPaperIds = new Set();

function validatePaper(value) {
  return (
    value && typeof value.title === 'string' && typeof value.arxivId === 'string' && typeof value.abstract === 'string'
  );
}

async function vaultSnapshotWithAuditStatus() {
  const snapshot = await vault.snapshot();
  const auditJobs = Object.fromEntries(
    Object.entries(snapshot.auditJobs ?? {}).map(([paperId, job]) => {
      const active = activeAuditPaperIds.has(paperId);
      const state = active ? 'running' : ['preparing', 'running'].includes(job.state) ? 'paused' : job.state;
      return [paperId, { ...job, state }];
    }),
  );
  return { ...snapshot, auditJobs };
}

function normalizeProfile(value) {
  const areas = Array.isArray(value?.areas)
    ? value.areas.map(String).filter((area) => /^math\.[A-Z]{2}$/.test(area))
    : typeof value?.area === 'string'
      ? [value.area]
      : ['math.AP'];
  return {
    level: typeof value?.level === 'string' ? value.level : 'Graduate student',
    areas: areas.length ? areas : ['math.AP'],
    goal: typeof value?.goal === 'string' ? value.goal : 'Understand proofs',
    model: typeof value?.model === 'string' ? value.model : '',
    reasoning: typeof value?.reasoning === 'string' && value.reasoning.trim() ? value.reasoning : 'xhigh',
  };
}

function bodyLimitFor(pathname) {
  if (['/vault/source-upload', '/vault/citation-asset'].includes(pathname)) return MAX_SOURCE_UPLOAD_JSON_BODY_CHARS;
  if (pathname === '/vault/audit') return MAX_AUDIT_JSON_BODY_CHARS;
  if (pathname === '/vault/reader') return MAX_READER_JSON_BODY_CHARS;
  if (['/vault/latex-export', '/vault/paper/update-commit'].includes(pathname)) return MAX_PAPER_UPDATE_JSON_BODY_CHARS;
  return DEFAULT_JSON_BODY_CHARS;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readBody(request, maxChars = DEFAULT_JSON_BODY_CHARS) {
  return new Promise((resolve, reject) => {
    // Decode the whole stream as UTF-8. Appending raw Buffer chunks decodes each
    // chunk separately and corrupts characters (≤, ℝ, CJK notes) split between them.
    request.setEncoding('utf8');
    let body = '';
    let tooLarge = false;
    request.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > maxChars) {
        tooLarge = true;
        body = '';
        reject(httpError(413, 'Request body is too large.'));
      }
    });
    request.on('end', () => {
      if (tooLarge) return;
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        return reject(httpError(400, 'Request body must be JSON.'));
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return reject(httpError(400, 'Request body must be a JSON object.'));
      resolve(parsed);
    });
    request.on('error', reject);
  });
}

function enqueueThread(threadId, work) {
  const previous = threadQueues.get(threadId) ?? Promise.resolve();
  const scheduled = previous.then(work, work);
  const tail = scheduled.catch(() => {});
  threadQueues.set(threadId, tail);
  void tail.finally(() => {
    if (threadQueues.get(threadId) === tail) threadQueues.delete(threadId);
  });
  return scheduled;
}

function enqueueVaultMutation(work) {
  const scheduled = vaultMutationQueue.then(work, work);
  vaultMutationQueue = scheduled.catch(() => {});
  return scheduled;
}

const figureExtensions = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.pdf',
  '.eps',
  '.ps',
  '.tif',
  '.tiff',
  '.bmp',
];
const MAX_FIGURE_BYTES = 20 * 1024 * 1024;

function ar5ivFigureUrl(arxivId, requestedPath) {
  const normalizedId = normalizeArxivVersion(arxivId).replace(/v\d+$/i, '');
  const requested = String(requestedPath || '')
    .replaceAll('\\', '/')
    .trim();
  const filename = path.basename(requested);
  const stem = filename.slice(0, filename.length - path.extname(filename).length).trim();
  if (!normalizedId || !stem || normalizedId.startsWith('local-') || /[\0\r\n]/.test(stem)) return '';
  const encodedId = normalizedId.split('/').map(encodeURIComponent).join('/');
  return `https://ar5iv.labs.arxiv.org/html/${encodedId}/assets/${encodeURIComponent(stem)}.png`;
}

async function fetchAr5ivFigurePreview(arxivId, requestedPath, destination) {
  const url = ar5ivFigureUrl(arxivId, requestedPath);
  if (!url) throw new Error('No arXiv figure fallback is available for this paper.');
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
    headers: { 'User-Agent': 'arXivpecker/0.2 (local mathematics paper reader; figure fallback)' },
  });
  if (!response.ok) throw new Error(`The arXiv figure fallback returned ${response.status}.`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_FIGURE_BYTES) throw new Error('The arXiv figure fallback is too large.');
  const payload = Buffer.from(await response.arrayBuffer());
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!payload.length || payload.length > MAX_FIGURE_BYTES || !payload.subarray(0, 8).equals(pngSignature))
    throw new Error('The arXiv figure fallback did not return a valid PNG image.');
  await writeFile(destination, payload);
  return destination;
}

async function collectFigureFiles(directory, root = directory, depth = 0) {
  if (depth > 8) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.proofroom-previews') continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute);
    if (entry.isDirectory()) files.push(...(await collectFigureFiles(absolute, root, depth + 1)));
    else if (figureExtensions.includes(path.extname(entry.name).toLowerCase())) files.push({ absolute, relative });
  }
  return files;
}

function previewName(key) {
  return createHash('sha256').update(key).digest('base64url');
}

async function realPathIsInside(root, candidate) {
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  const relative = path.relative(realRoot, realCandidate);
  return !relativePathEscapes(relative);
}

async function figureAsset(paperId, requestedPath) {
  const sourceRoot = await vault.sourceDirectory(paperId);
  const record = await vault.recordFor(paperId);
  const savedPaper = JSON.parse(await readFile(path.join(vault.paperDirectory(record), 'paper.json'), 'utf8'));
  const paperRoot = vault.paperDirectory(record);
  const configuredSource =
    typeof savedPaper?.source?.sourceDirectory === 'string'
      ? path.resolve(paperRoot, savedPaper.source.sourceDirectory)
      : sourceRoot;
  const configuredRelative = path.relative(sourceRoot, configuredSource);
  const currentSourceRoot = relativePathEscapes(configuredRelative) ? sourceRoot : configuredSource;
  const requested = String(requestedPath || '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .trim();
  if (!requested || requested.includes('\0')) throw new Error('A valid figure path is required.');
  const extension = path.extname(requested).toLowerCase();
  const alternatives = extension ? [requested] : figureExtensions.map((suffix) => `${requested}${suffix}`);
  let candidate = null;
  for (const root of [...new Set([currentSourceRoot, sourceRoot])]) {
    for (const alternative of alternatives) {
      const absolute = path.resolve(root, alternative);
      const relative = path.relative(root, absolute);
      if (relativePathEscapes(relative)) continue;
      try {
        if ((await stat(absolute)).isFile()) {
          candidate = absolute;
          break;
        }
      } catch {
        /* Search by suffix below. */
      }
    }
    if (candidate) break;
  }
  if (!candidate) {
    const files = [
      ...(await collectFigureFiles(currentSourceRoot)),
      ...(currentSourceRoot === sourceRoot ? [] : await collectFigureFiles(sourceRoot)),
    ];
    const normalized = requested.toLowerCase();
    const basename = path.basename(normalized);
    const found =
      files.find((file) =>
        alternatives.some((alternative) => file.relative.toLowerCase().endsWith(alternative.toLowerCase())),
      ) ||
      files.find(
        (file) =>
          path.basename(file.relative, path.extname(file.relative)).toLowerCase() ===
          path.basename(basename, path.extname(basename)),
      );
    candidate = found?.absolute || null;
  }
  const previewDirectory = path.join(sourceRoot, '.proofroom-previews');
  const previewToken = previewName(`remote:${requested}`);
  const remotePreview = path.join(previewDirectory, `${previewToken}.png`);
  if (!candidate) {
    await mkdir(previewDirectory, { recursive: true });
    try {
      if (!(await stat(remotePreview)).isFile()) throw new Error('Not a file.');
    } catch {
      await fetchAr5ivFigurePreview(savedPaper.arxivId, requested, remotePreview);
    }
    return { payload: await readFile(remotePreview), mime: 'image/png' };
  }
  if (!(await realPathIsInside(sourceRoot, candidate)))
    throw new Error('The requested figure resolves outside this paper source folder.');
  const sourceExtension = path.extname(candidate).toLowerCase();
  if (['.pdf', '.eps', '.ps', '.tif', '.tiff', '.bmp'].includes(sourceExtension)) {
    await mkdir(previewDirectory, { recursive: true });
    const token = previewName(path.relative(sourceRoot, candidate));
    const preview = path.join(previewDirectory, `${token}.png`);
    try {
      await stat(preview);
    } catch {
      try {
        if (sourceExtension === '.pdf')
          await runProgram('pdftoppm', ['-png', '-singlefile', '-r', '180', candidate, preview.slice(0, -4)]);
        else if (sourceExtension === '.eps' || sourceExtension === '.ps')
          await runProgram('gs', [
            '-dSAFER',
            '-dBATCH',
            '-dNOPAUSE',
            '-sDEVICE=pngalpha',
            '-r180',
            `-sOutputFile=${preview}`,
            candidate,
          ]);
        else await runProgram('sips', ['-s', 'format', 'png', candidate, '--out', preview]);
      } catch {
        // TeX-first arXiv bundles often contain EPS figures, while a tester's
        // machine may not have Ghostscript. ar5iv already publishes safe PNG
        // renderings of those same primary-source assets, so cache that image
        // rather than leaving a permanent placeholder in the reader.
        await fetchAr5ivFigurePreview(savedPaper.arxivId, requested, preview);
      }
    }
    candidate = preview;
  }
  const mime =
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
    }[path.extname(candidate).toLowerCase()] || 'application/octet-stream';
  return { payload: await readFile(candidate), mime };
}

async function originalPaperAsset(paperId) {
  const record = await vault.recordFor(String(paperId || ''));
  const paperRoot = vault.paperDirectory(record);
  const savedPaper = JSON.parse(await readFile(path.join(paperRoot, 'paper.json'), 'utf8'));
  const configured = typeof savedPaper?.source?.localPdf === 'string' ? savedPaper.source.localPdf.trim() : '';
  if (!configured) throw new Error('This local paper does not have an uploaded PDF.');
  const sourceRoot = await vault.sourceDirectory(record.id);
  const candidate = path.resolve(paperRoot, configured);
  const relative = path.relative(sourceRoot, candidate);
  if (relativePathEscapes(relative) || path.extname(candidate).toLowerCase() !== '.pdf')
    throw new Error('The saved PDF path is outside this paper source folder.');
  if (!(await realPathIsInside(sourceRoot, candidate)))
    throw new Error('The saved PDF resolves outside this paper source folder.');
  const details = await stat(candidate);
  if (!details.isFile() || details.size < 5 || details.size > MAX_SOURCE_BYTES)
    throw new Error('The saved PDF is missing or outside the upload size limit.');
  const payload = await readFile(candidate);
  if (payload.subarray(0, 1024).indexOf(Buffer.from('%PDF-')) < 0)
    throw new Error('The saved file is not a valid PDF.');
  return payload;
}

// A DNS-rebound page reaches 127.0.0.1 under its own host name and sends no
// Origin header on same-origin GETs, so the Host header must be checked too.
const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (!isAllowedOrigin(origin))
    return sendJson(response, 403, { error: 'This local bridge accepts only localhost origins.' }, origin);
  if (!allowedHosts.has(String(request.headers.host || '').toLowerCase()))
    return sendJson(response, 403, { error: 'This local bridge accepts only localhost host names.' }, origin);
  let pathname;
  try {
    pathname = new URL(request.url || '/', `http://${HOST}:${PORT}`).pathname;
  } catch {
    return sendJson(response, 400, { error: 'Malformed request URL.' }, origin);
  }
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
    if (request.method === 'GET' && pathname === '/asset') {
      const url = new URL(request.url || '/', `http://${HOST}:${PORT}`);
      const paperId = url.searchParams.get('paperId') || '';
      const file = url.searchParams.get('file') || '';
      const asset = await figureAsset(paperId, file);
      response.writeHead(200, {
        'Content-Type': asset.mime,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        ...(asset.mime === 'image/svg+xml'
          ? { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'" }
          : {}),
        ...(origin && isAllowedOrigin(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
      });
      return response.end(asset.payload);
    }
    if (request.method === 'GET' && pathname === '/paper-pdf') {
      const url = new URL(request.url || '/', `http://${HOST}:${PORT}`);
      const payload = await originalPaperAsset(url.searchParams.get('paperId') || '');
      response.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': payload.length,
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=3600',
        ...(origin && isAllowedOrigin(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
      });
      return response.end(payload);
    }
    if (request.method === 'GET' && pathname === '/vault')
      return sendJson(response, 200, await vaultSnapshotWithAuditStatus(), origin);
    if (request.method === 'GET' && pathname === '/cloud/status')
      return sendJson(response, 200, await cloudStatus(vault), origin);
    if (request.method === 'GET' && pathname === '/vault/graph') {
      const snapshot = await vault.snapshot();
      return sendJson(response, 200, { graph: snapshot.graph, links: snapshot.links, vault: snapshot.vault }, origin);
    }
    if (request.method === 'GET' && pathname === '/status') {
      try {
        await codex.start();
      } catch {
        /* status returns useful error below */
      }
      return sendJson(response, 200, codex.status(), origin);
    }
    if (
      request.method !== 'POST' ||
      ![
        '/analyze',
        '/compare-versions',
        '/paper-question',
        '/node-question',
        '/node-edit/suggest',
        '/vault/paper',
        '/vault/paper/update',
        '/vault/paper/update-commit',
        '/vault/paper/delete',
        '/vault/paper/order',
        '/vault/audit',
        '/vault/reader',
        '/vault/patches',
        '/vault/profile',
        '/vault/link',
        '/vault/link/delete',
        '/vault/export',
        '/vault/latex-export',
        '/vault/citation-asset',
        '/vault/source-upload',
        '/cloud/share',
      ].includes(pathname)
    ) {
      return sendJson(response, 404, { error: 'Not found.' }, origin);
    }
    const body = await readBody(request, bodyLimitFor(pathname));
    if (pathname === '/cloud/share')
      return sendJson(response, 200, { share: await createCloudShare(vault, body) }, origin);
    if (pathname === '/vault/profile')
      return sendJson(
        response,
        200,
        { profile: await enqueueVaultMutation(() => vault.saveProfile(normalizeProfile(body.profile))) },
        origin,
      );
    if (pathname === '/vault/link')
      return sendJson(
        response,
        200,
        await enqueueVaultMutation(async () => ({
          link: await vault.addLink(body.link),
          graph: await vault.rebuildGraph(),
        })),
        origin,
      );
    if (pathname === '/vault/link/delete')
      return sendJson(
        response,
        200,
        await enqueueVaultMutation(async () => {
          await vault.removeLink(String(body.linkId || ''));
          return { graph: await vault.rebuildGraph() };
        }),
        origin,
      );
    if (pathname === '/vault/paper/delete') {
      if (!body.paperId) return sendJson(response, 400, { error: 'paperId is required.' }, origin);
      const removed = await enqueueVaultMutation(async () => {
        const record = await vault.removePaper(String(body.paperId));
        return { removed: record, snapshot: await vault.snapshot() };
      });
      return sendJson(response, 200, removed, origin);
    }
    if (pathname === '/vault/paper/order')
      return sendJson(
        response,
        200,
        { order: await enqueueVaultMutation(() => vault.reorderPapers(body.paperIds)) },
        origin,
      );
    if (pathname === '/vault/reader') {
      if (!body.paperId) return sendJson(response, 400, { error: 'paperId is required.' }, origin);
      return sendJson(
        response,
        200,
        { reader: await enqueueVaultMutation(() => vault.saveReader(String(body.paperId), body.reader ?? {})) },
        origin,
      );
    }
    if (pathname === '/vault/patches') {
      if (!body.paperId) return sendJson(response, 400, { error: 'paperId is required.' }, origin);
      const saved = await enqueueVaultMutation(async () => {
        const patches = await vault.savePatches(String(body.paperId), body.patches ?? []);
        const snapshot = await vault.snapshot();
        return { patches, graph: snapshot.graph };
      });
      return sendJson(response, 200, saved, origin);
    }
    if (pathname === '/vault/export') {
      if (!body.paperId) return sendJson(response, 400, { error: 'paperId is required.' }, origin);
      return sendJson(
        response,
        200,
        { saved: await enqueueVaultMutation(() => vault.saveExport(String(body.paperId), body.export ?? {})) },
        origin,
      );
    }
    if (pathname === '/vault/latex-export') {
      if (!body.paperId) return sendJson(response, 400, { error: 'paperId is required.' }, origin);
      return sendJson(
        response,
        200,
        { saved: await saveCompleteLatexExport(String(body.paperId), body.export ?? {}) },
        origin,
      );
    }
    if (pathname === '/vault/citation-asset') {
      if (!body.paperId) return sendJson(response, 400, { error: 'paperId is required.' }, origin);
      return sendJson(
        response,
        200,
        { saved: await enqueueVaultMutation(() => vault.saveCitationAsset(String(body.paperId), body.upload ?? {})) },
        origin,
      );
    }
    if (pathname === '/vault/source-upload') {
      if (!validatePaper(body.paper))
        return sendJson(response, 400, { error: 'A paper title and local source record are required.' }, origin);
      return sendJson(
        response,
        200,
        await enqueueVaultMutation(() => saveUploadedPaperSource(body.paper, body.upload ?? {})),
        origin,
      );
    }
    if (!validatePaper(body.paper))
      return sendJson(response, 400, { error: 'A paper with title, arXiv id, and abstract is required.' }, origin);
    if (pathname === '/vault/paper/update-commit')
      return sendJson(response, 200, await enqueueVaultMutation(() => vault.commitPaperUpdate(body)), origin);
    if (pathname === '/vault/paper' || pathname === '/vault/paper/update')
      return sendJson(
        response,
        200,
        { paper: await enqueueVaultMutation(() => vault.upsertPaper(body.paper)) },
        origin,
      );
    if (pathname === '/vault/audit') {
      if (!body.audit || !Array.isArray(body.audit.nodes))
        return sendJson(response, 400, { error: 'A structured audit is required.' }, origin);
      const saved = await enqueueVaultMutation(async () => {
        const paper = await vault.saveAudit(body.paper, body.audit);
        await vault.completeAuditJob(paper.id);
        const snapshot = await vault.snapshot();
        return { paper, graph: snapshot.graph, links: snapshot.links };
      });
      return sendJson(response, 200, saved, origin);
    }
    const profile = normalizeProfile(body.profile);
    const runAiWork = async () => {
      if (pathname === '/compare-versions') {
        const paper = { ...body.paper, id: String(body.paper.id) };
        await vault.recordFor(paper.id);
        const fromVersion = normalizeArxivVersion(body.fromVersion);
        const toVersion = normalizeArxivVersion(body.toVersion);
        if (!fromVersion || !toVersion) throw new Error('Two valid arXiv versions are required.');
        if (fromVersion.replace(/v\d+$/i, '') !== toVersion.replace(/v\d+$/i, ''))
          throw new Error('Version comparison requires two versions of the same arXiv paper.');
        const load = async (version) => {
          try {
            return await acquireArxivSource(paper, version, true);
          } catch (error) {
            return { kind: 'pdf', error: error instanceof Error ? error.message : 'TeX source unavailable' };
          }
        };
        const [fromSource, toSource] = await Promise.all([load(fromVersion), load(toVersion)]);
        const identical = await sameExpandedTexSource(fromSource, toSource);
        const compared = identical
          ? {
              threadId: '',
              text: JSON.stringify({
                summary: `${fromVersion} and ${toVersion} resolve to identical complete TeX source.`,
                changedUnits: [],
                proofChanges: [],
                notationChanges: [],
                editorialChanges: [],
                dependencyImpact: [],
                readingRecommendation: 'No source changes require rereading.',
                warnings: [],
              }),
            }
          : await codex.compareVersions({
              paper,
              profile,
              fromVersion,
              toVersion,
              fromSource,
              toSource,
              readerContext: body.readerContext ?? null,
            });
        return { ...compared, fromVersion, toVersion, sources: { from: fromSource.kind, to: toSource.kind } };
      }
      if (pathname === '/analyze') {
        const paper = { ...body.paper, id: String(body.paper.id) };
        const checkpointing = !body.updateMode;
        if (checkpointing && activeAuditPaperIds.has(paper.id))
          throw httpError(
            409,
            'An AI audit for this paper is already running. Wait for it to finish or reload the page to see its saved status.',
          );
        // Claim the slot before any await: a double click must not start two audits.
        if (checkpointing) activeAuditPaperIds.add(paper.id);
        let auditJob = null;
        try {
          await vault.recordFor(paper.id);
          const requestedOptions = {
            convertPdfToLatex: Boolean(body.convertPdfToLatex),
            correctnessAudit: body.correctnessAudit !== false,
            detailedAudit: body.detailedAudit !== false,
          };
          auditJob = checkpointing
            ? await vault.startAuditJob(paper.id, requestedOptions, { resume: Boolean(body.resumeAudit) })
            : null;
        } catch (error) {
          if (checkpointing) activeAuditPaperIds.delete(paper.id);
          throw error;
        }
        try {
          const localInventory = await vault.compactInventory();
          let primarySource;
          try {
            primarySource = await acquireArxivSource(paper, paper.arxivId, Boolean(body.updateMode));
            if (!body.updateMode)
              await vault.saveSourceRecord(paper.id, {
                analysisFormat: 'tex',
                sourceDirectory: primarySource.sourceDirectory,
                mainTex: primarySource.entryFile,
                sourceFetchedAt: primarySource.fetchedAt,
              });
            if (primarySource.kind === 'uploaded-pdf' && body.convertPdfToLatex) {
              const converted = await codex.convertPdfToLatex({ paper, profile, pdfPath: primarySource.entryFile });
              primarySource = await saveAiLatexSource(paper, converted);
              const sourceRoot = await vault.sourceDirectory(paper.id);
              await writeSourceManifest(path.join(sourceRoot, 'proofroom-uploaded-source.json'), primarySource);
              await vault.saveSourceRecord(paper.id, {
                analysisFormat: 'ai-tex',
                sourceDirectory: primarySource.sourceDirectory,
                mainTex: primarySource.entryFile,
                sourceFetchedAt: primarySource.convertedAt,
                sourceError: 'Reader-supplied PDF converted to an editable LaTeX working source.',
              });
            }
          } catch (error) {
            primarySource = { kind: 'pdf', error: error instanceof Error ? error.message : 'TeX source unavailable' };
            if (body.convertPdfToLatex) {
              const converted = await codex.convertPdfToLatex({ paper, profile });
              primarySource = await saveAiLatexSource(paper, converted);
              await vault.saveSourceRecord(paper.id, {
                analysisFormat: 'ai-tex',
                sourceDirectory: primarySource.sourceDirectory,
                mainTex: primarySource.entryFile,
                sourceFetchedAt: primarySource.convertedAt,
                sourceError: 'Author TeX unavailable; saved AI transcription from the primary PDF.',
              });
            } else if (!body.updateMode)
              await vault.saveSourceRecord(paper.id, { analysisFormat: 'pdf', sourceError: primarySource.error });
          }
          const analyzed = await codex.analyze({
            paper,
            profile,
            primarySource,
            correctnessAudit: body.correctnessAudit !== false,
            detailedAudit: body.detailedAudit !== false,
            localInventory: localInventory.filter((item) => item.paperId !== paper.id),
            updateContext: body.updateContext ?? null,
            resumeThreadId: auditJob?.threadId ?? '',
            onThreadReady: checkpointing
              ? async (threadId) =>
                  vault.saveAuditJob(paper.id, {
                    state: 'running',
                    threadId,
                    message: 'AI audit in progress. This thread can be resumed after a restart.',
                  })
              : null,
          });
          const text =
            primarySource.kind === 'tex' || primarySource.kind === 'ai-tex'
              ? await enrichAuditFromTex(analyzed.text, primarySource)
              : analyzed.text;
          return {
            ...analyzed,
            text,
            paper,
            primarySource: {
              kind: primarySource.kind,
              fileCount: primarySource.fileCount ?? 0,
              cached: Boolean(primarySource.cached),
              error: primarySource.error ?? null,
            },
            ...(body.updateMode
              ? {
                  sourceRecord: {
                    analysisFormat: primarySource.kind === 'tex' ? 'tex' : primarySource.kind,
                    sourceDirectory: primarySource.sourceDirectory ?? '',
                    mainTex: primarySource.entryFile ?? '',
                    sourceFetchedAt: primarySource.fetchedAt ?? primarySource.convertedAt ?? new Date().toISOString(),
                    sourceError: primarySource.error ?? '',
                  },
                }
              : {}),
          };
        } catch (error) {
          if (checkpointing)
            await vault.pauseAuditJob(paper.id, error instanceof Error ? error.message : 'The audit was interrupted.');
          throw error;
        } finally {
          if (checkpointing) activeAuditPaperIds.delete(paper.id);
        }
      }
      if (pathname === '/paper-question') {
        if (typeof body.question !== 'string') throw new Error('A question is required.');
        const answered = await codex.answerPaper({
          paper: body.paper,
          profile,
          currentNode: body.node,
          question: body.question,
          threadId: body.threadId,
        });
        if (!body.threadId) await enqueueVaultMutation(() => vault.saveAuditThread(body.paper.id, answered.threadId));
        return answered;
      }
      if (!body.node) throw new Error('A node is required.');
      if (pathname === '/node-edit/suggest') {
        if (!body.threadId) throw new Error('Run the full-paper audit before requesting an editorial suggestion.');
        return codex.suggestEditorialPatch({ paper: body.paper, profile, node: body.node, threadId: body.threadId });
      }
      if (typeof body.question !== 'string') throw new Error('A question is required.');
      const answered = await codex.answerNode({
        paper: body.paper,
        profile,
        node: body.node,
        question: body.question,
        threadId: body.threadId,
      });
      if (!body.threadId) await enqueueVaultMutation(() => vault.saveAuditThread(body.paper.id, answered.threadId));
      return answered;
    };
    // Independent audits and version comparisons each create their own Codex
    // thread and may run concurrently. Continuations on one existing paper
    // thread stay ordered so two questions cannot corrupt that thread's context.
    const continuingThread =
      Boolean(body.threadId) && ['/paper-question', '/node-question', '/node-edit/suggest'].includes(pathname);
    const output = continuingThread ? await enqueueThread(String(body.threadId), runAiWork) : await runAiWork();
    return sendJson(response, 200, output, origin);
  } catch (error) {
    return sendJson(
      response,
      Number.isInteger(error?.status) ? error.status : 500,
      { error: error instanceof Error ? error.message : 'Local Codex bridge failed.' },
      origin,
    );
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, HOST, () => {
    console.log(`arXivpecker Codex bridge listening on http://${HOST}:${PORT}`);
    console.log('Uses your local Codex/ChatGPT sign-in. No OpenAI API key is used.');
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close();
      codex.process?.kill();
      process.exit(0);
    });
  }
}

export { ar5ivFigureUrl, bodyLimitFor, readBody };
