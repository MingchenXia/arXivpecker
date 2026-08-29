import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cloudStatus, createCloudShare } from './cloud-share.mjs';
import { PaperVault } from './paper-vault.mjs';

const PORT = Number(process.env.PROOFROOM_CODEX_PORT || 4318);
const HOST = '127.0.0.1';
const WORKDIR = process.cwd();
const vaultRoot = path.resolve(process.env.PROOFROOM_LIBRARY_DIR || path.join(WORKDIR, 'proofroom-library'));
const starterRoot = process.env.ARXIVPECKER_SKIP_STARTER_LIBRARY === '1' ? null : path.resolve(process.env.ARXIVPECKER_STARTER_LIBRARY_DIR || path.join(WORKDIR, 'examples', 'starter-library'));
const vault = new PaperVault(vaultRoot, { starterRoot });
const MAX_SOURCE_BYTES = 80 * 1024 * 1024;
const CODEX_TURN_TIMEOUT_MS = Math.max(60_000, Number(process.env.CODEX_TURN_TIMEOUT_MS) || 30 * 60 * 1000);

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

function hydrateSourceManifest(manifest, manifestFile) {
  const directory = path.dirname(manifestFile); const hydrated = { ...manifest };
  for (const key of ['entryFile', 'sourceDirectory', 'uploadedFile']) if (hydrated[key] && !path.isAbsolute(hydrated[key])) hydrated[key] = path.resolve(directory, hydrated[key]);
  return hydrated;
}

async function writeSourceManifest(manifestFile, manifest) {
  const directory = path.dirname(manifestFile); const portable = { ...manifest };
  for (const key of ['entryFile', 'sourceDirectory', 'uploadedFile']) {
    if (!portable[key] || !path.isAbsolute(portable[key])) continue;
    const relative = path.relative(directory, portable[key]);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) portable[key] = relative || '.';
  }
  await writeFile(manifestFile, `${JSON.stringify(portable, null, 2)}\n`, 'utf8');
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

async function uploadedPaperSource(paper) {
  const sourceRoot = await vault.sourceDirectory(paper.id);
  const manifestFile = path.join(sourceRoot, 'proofroom-uploaded-source.json');
  const manifest = hydrateSourceManifest(JSON.parse(await readFile(manifestFile, 'utf8')), manifestFile);
  if (!manifest.entryFile || !manifest.sourceDirectory) throw new Error('The uploaded source manifest is incomplete.');
  await stat(manifest.entryFile);
  return { ...manifest, cached: true };
}

async function saveUploadedPaperSource(paper, upload) {
  const encoded = typeof upload?.dataBase64 === 'string' ? upload.dataBase64 : '';
  const payload = Buffer.from(encoded, 'base64');
  if (!payload.length) throw new Error('The uploaded paper source is empty.');
  if (payload.length > MAX_SOURCE_BYTES) throw new Error('Paper source uploads are limited to 80 MB.');
  const requestedName = String(upload?.fileName || 'source.tex');
  const extension = path.extname(requestedName).toLowerCase();
  if (!['.tex', '.ltx', '.zip', '.pdf'].includes(extension)) throw new Error('Upload one TeX file, one PDF, or one ZIP source project.');
  const stored = await vault.upsertPaper(paper);
  const sourceRoot = await vault.sourceDirectory(stored.id);
  const sourceDirectory = path.join(sourceRoot, `reader-upload-${Date.now()}`);
  await mkdir(sourceDirectory, { recursive: true });
  const fileName = requestedName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+/, '').slice(0, 140) || `source${extension}`;
  const uploadedFile = path.join(sourceDirectory, fileName);
  await writeFile(uploadedFile, payload);
  let entryFile = uploadedFile; let fileCount = 1; let kind = extension === '.pdf' ? 'uploaded-pdf' : 'tex';
  if (extension === '.zip') {
    const listing = (await runProgram('unzip', ['-Z1', uploadedFile], 4 * 1024 * 1024)).toString('utf8').split('\n').filter(Boolean);
    if (!listing.length || listing.some((entry) => path.isAbsolute(entry) || path.normalize(entry).split(path.sep).includes('..'))) throw new Error('The ZIP source project contains an unsafe path.');
    const projectDirectory = path.join(sourceDirectory, 'project'); await mkdir(projectDirectory, { recursive: true });
    await runProgram('unzip', ['-q', uploadedFile, '-d', projectDirectory], 8 * 1024 * 1024);
    const texFiles = await collectTexFiles(projectDirectory); const main = await chooseMainTex(texFiles);
    if (!main) throw new Error('No TeX file was found in the ZIP source project.');
    entryFile = main.absolute; fileCount = texFiles.length;
  }
  const manifest = { kind, origin: 'reader-upload', entryFile, sourceDirectory: extension === '.zip' ? path.dirname(entryFile) : sourceDirectory, fileCount, uploadedFile, uploadedAt: new Date().toISOString(), cached: false };
  await writeSourceManifest(path.join(sourceRoot, 'proofroom-uploaded-source.json'), manifest);
  await vault.saveSourceRecord(stored.id, { analysisFormat: kind === 'tex' ? 'tex' : 'pdf', sourceDirectory: manifest.sourceDirectory, mainTex: kind === 'tex' ? entryFile : '', localPdf: kind === 'uploaded-pdf' ? entryFile : '', sourceUploadedAt: manifest.uploadedAt });
  return { paper: stored, primarySource: manifest };
}

async function saveCompleteLatexExport(paperId, exportRecord) {
  const content = typeof exportRecord?.content === 'string' ? exportRecord.content : '';
  if (!content.includes('\\begin{document}') || !content.includes('\\end{document}')) throw new Error('The complete LaTeX export is missing its document boundary.');
  if (Buffer.byteLength(content, 'utf8') > 16 * 1024 * 1024) throw new Error('The complete LaTeX export is too large.');
  const record = await vault.recordFor(String(paperId));
  const exportDirectory = path.join(vault.paperDirectory(record), 'exports'); await mkdir(exportDirectory, { recursive: true });
  const edition = exportRecord?.edition === 'original' ? 'author' : 'working';
  const sourceRoot = await vault.sourceDirectory(String(paperId));
  let texFiles = []; try { texFiles = await collectTexFiles(sourceRoot); } catch { /* A generated single-file export remains available. */ }
  if (texFiles.length <= 1) { const fileName = `arxivpecker-${edition}-edition.tex`; const file = path.join(exportDirectory, fileName); await writeFile(file, content, 'utf8'); return { fileName, relativePath: path.relative(vault.root, file), format: 'tex', bytes: Buffer.byteLength(content, 'utf8') }; }
  const fileName = `arxivpecker-${edition}-edition-source.zip`; const file = path.join(exportDirectory, fileName); const staging = await mkdtemp(path.join(exportDirectory, '.latex-export-'));
  try { await cp(sourceRoot, path.join(staging, 'original-source'), { recursive: true }); await writeFile(path.join(staging, `arxivpecker-${edition}-edition.tex`), content, 'utf8'); await runProgram('ditto', ['-c', '-k', '--sequesterRsrc', staging, file]); }
  finally { await rm(staging, { recursive: true, force: true }); }
  return { fileName, relativePath: path.relative(vault.root, file), format: 'zip', sourceFiles: texFiles.length };
}

async function acquireArxivSource(paper, requestedArxivId = paper.arxivId, versionCache = false) {
  if (!versionCache) {
    try { return await uploadedPaperSource(paper); } catch { /* No reader upload; continue with arXiv. */ }
  }
  const sourceRoot = await vault.sourceDirectory(paper.id);
  const cacheName = String(requestedArxivId).replace(/[^a-zA-Z0-9.-]+/g, '-');
  const sourceDirectory = versionCache ? path.join(sourceRoot, 'versions', cacheName) : sourceRoot;
  const manifestFile = path.join(sourceDirectory, 'proofroom-source.json');
  try {
    const cached = hydrateSourceManifest(JSON.parse(await readFile(manifestFile, 'utf8')), manifestFile);
    if (cached.kind === 'tex' && cached.entryFile && (!cached.arxivId || cached.arxivId === requestedArxivId)) { await stat(cached.entryFile); return { ...cached, cached: true }; }
  } catch { /* Download or repair the source cache below. */ }
  await mkdir(sourceDirectory, { recursive: true });
  const archive = path.join(sourceDirectory, 'arxiv-source.tar');
  const encodedArxivId = String(requestedArxivId).split('/').map(encodeURIComponent).join('/');
  let response = null; let sourceError = null;
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
        response = candidate; break;
      } catch (error) {
        sourceError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    if (response) break;
  }
  if (!response) throw new Error(`arXiv TeX source could not be retrieved${sourceError instanceof Error ? `: ${sourceError.message}` : '.'}`);
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
  await writeSourceManifest(manifestFile, manifest);
  return manifest;
}

function latexConversionPrompt({ paper, pdfPath = '' }) {
  return `Convert the complete primary PDF at ${pdfPath || `https://arxiv.org/pdf/${paper.arxivId}`} into a faithful standalone LaTeX document.

This is a transcription task, not a rewrite. Read every page. Preserve the title, authors, abstract, section hierarchy, theorem/definition/lemma/proposition environments, equation structure, labels, references, proofs, footnotes, bibliography, and mathematical notation. Do not improve, complete, or silently correct the mathematics. Mark illegible fragments explicitly with \\text{[unreadable in source]}. Add a short LaTeX comment before each page transition in the form "% PDF page N" when you can identify it.

Return only one complete compilable LaTeX document, beginning with \\documentclass and ending with \\end{document}. Do not use Markdown fences or add commentary outside the document.`;
}

function extractLatexDocument(text, paper = null) {
  const clean = String(text || '').trim().replace(/^```(?:latex|tex)?\s*/i, '').replace(/\s*```$/i, '');
  const start = clean.indexOf('\\documentclass');
  const endMarker = '\\end{document}';
  const end = clean.lastIndexOf(endMarker);
  if (start < 0 || end < start) throw new Error('Codex did not return a complete LaTeX document.');
  const document = clean.slice(start, end + endMarker.length).trim();
  if (Buffer.byteLength(document, 'utf8') > 12 * 1024 * 1024) throw new Error('The AI-converted LaTeX document exceeds the local safety limit.');
  const body = document.match(/\\begin\{document\}([\s\S]*)\\end\{document\}/)?.[1]?.trim() ?? '';
  const refusal = /cannot (?:provide|transcribe|convert)|can't (?:provide|transcribe|convert)|copyright(?:ed)? paper|unable to (?:access|provide|transcribe)|I (?:can|could) help (?:with|you) (?:a )?(?:short|brief|summary)/i;
  const hasStructure = /\\(?:section|chapter|part)\*?\s*\{|\\begin\{(?:abstract|theorem|lemma|proposition|definition|proof)\}/.test(body);
  if (refusal.test(body) || Buffer.byteLength(body, 'utf8') < 2_000 || !hasStructure) {
    const label = paper?.arxivId ? `arXiv:${paper.arxivId}` : 'this paper';
    throw new Error(`AI could not create a complete LaTeX reading source for ${label}. Upload the author TeX (use ZIP for a multi-file project) or the original PDF and try again.`);
  }
  return `${document}\n`;
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
  const manifest = { kind: 'ai-tex', arxivId: paper.arxivId, entryFile, sourceDirectory, fileCount: 1, convertedAt: new Date().toISOString(), conversionThreadId: converted.threadId, cached: false };
  await writeSourceManifest(manifestFile, manifest);
  return manifest;
}

async function readExpandedTex(entryFile, sourceRoot, seen = new Set(), depth = 0) {
  if (depth > 12 || seen.has(entryFile)) return '';
  const relative = path.relative(sourceRoot, entryFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return '';
  seen.add(entryFile);
  let source = await readFile(entryFile, 'utf8');
  const include = /\\(?:input|include)\s*\{([^}]+)\}/g;
  let expanded = ''; let cursor = 0;
  for (const match of source.matchAll(include)) {
    expanded += source.slice(cursor, match.index);
    const requested = match[1].trim();
    const candidate = path.resolve(path.dirname(entryFile), /\.[A-Za-z0-9]+$/.test(requested) ? requested : `${requested}.tex`);
    try { expanded += await readExpandedTex(candidate, sourceRoot, seen, depth + 1); }
    catch { expanded += `\n% arXivpecker could not resolve ${requested}\n`; }
    cursor = (match.index ?? 0) + match[0].length;
  }
  expanded += source.slice(cursor);
  return expanded;
}

function normalizeMathTextCommands(source) {
  let text = String(source || '');
  const command = /\\(mbox|text)\s*\{/g;
  for (let pass = 0; pass < 3; pass += 1) {
    let output = ''; let cursor = 0; let changed = false;
    for (const match of text.matchAll(command)) {
      if ((match.index ?? 0) < cursor) continue;
      const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
      if (!group) continue;
      let content = group.content.trim().replace(/^\{\\(?:normalfont|rm)\s*/, '').replace(/\}\s*$/, '').replace(/\\(?:normalfont|rm)\b\s*/g, '');
      if (match[1] === 'text' && !content.includes('$')) continue;
      const pieces = content.split(/\$([^$]*)\$/g).map((piece, index) => index % 2 ? piece.trim() : piece.replace(/\s+/g, ' '));
      const replacement = pieces.map((piece, index) => {
        if (!piece) return '';
        return index % 2 ? piece : `\\text{${piece}}`;
      }).join('');
      output += text.slice(cursor, match.index ?? 0) + replacement;
      cursor = group.end; changed = true;
    }
    if (!changed) break;
    text = output + text.slice(cursor);
  }
  return text;
}

function unwrapLatexTextCommands(source) {
  let text = String(source || '');
  const command = /\\(footnote|footnotetext|caption|emph|textbf|textit|texttt|textsc|textrm|textsf|underline|centerline|mbox|url|path)(?:\[[^\]]*\])?\s*\{/g;
  for (let pass = 0; pass < 4; pass += 1) {
    let output = ''; let cursor = 0; let changed = false;
    for (const match of text.matchAll(command)) {
      if ((match.index ?? 0) < cursor) continue;
      const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
      if (!group) continue;
      const replacement = match[1] === 'footnote' || match[1] === 'footnotetext' ? ` (Note: ${group.content})` : match[1] === 'caption' ? `\n${group.content}\n` : group.content;
      output += text.slice(cursor, match.index ?? 0) + replacement;
      cursor = group.end; changed = true;
    }
    if (!changed) break;
    text = output + text.slice(cursor);
  }
  return text;
}

function unwrapLatexTwoArgumentCommands(source) {
  let text = String(source || '');
  const command = /\\(texorpdfstring|foreignlanguage|href)\s*\{/g;
  for (let pass = 0; pass < 3; pass += 1) {
    let output = ''; let cursor = 0; let changed = false;
    for (const match of text.matchAll(command)) {
      if ((match.index ?? 0) < cursor) continue;
      const first = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
      if (!first) continue;
      let secondStart = first.end; while (/\s/.test(text[secondStart] || '')) secondStart += 1;
      const second = balancedGroup(text, secondStart);
      if (!second) continue;
      const replacement = match[1] === 'foreignlanguage' || match[1] === 'href' ? second.content : first.content;
      output += text.slice(cursor, match.index ?? 0) + replacement;
      cursor = second.end; changed = true;
    }
    if (!changed) break;
    text = output + text.slice(cursor);
  }
  return text;
}

function normalizePrescriptCommands(source) {
  const text = String(source || ''); const command = /\\prescript\s*\{/g;
  let output = ''; let cursor = 0;
  for (const match of text.matchAll(command)) {
    if ((match.index ?? 0) < cursor) continue;
    const superscript = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    if (!superscript) continue;
    let position = superscript.end; while (/\s/.test(text[position] || '')) position += 1;
    const subscript = balancedGroup(text, position); if (!subscript) continue;
    position = subscript.end; while (/\s/.test(text[position] || '')) position += 1;
    const base = balancedGroup(text, position); if (!base) continue;
    output += text.slice(cursor, match.index ?? 0) + `{}^{${superscript.content}}_{${subscript.content}}{${base.content}}`;
    cursor = base.end;
  }
  return output + text.slice(cursor);
}

function normalizeXyMatrices(source) {
  const text = String(source || ''); const command = /\\xymatrix(?:@[^\s{]+)?\s*\{/g;
  let output = ''; let cursor = 0;
  for (const match of text.matchAll(command)) {
    if ((match.index ?? 0) < cursor) continue;
    const matrix = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    if (!matrix) continue;
    const content = matrix.content
      .replace(/@\{\|?->\}\[[^\]]*\]/g, '\\longmapsto ')
      .replace(/@\{[^}]*\}\[[^\]]*\]/g, '\\longrightarrow ')
      .replace(/\\cr\b/g, '\\\\');
    output += text.slice(cursor, match.index ?? 0) + `\\begin{array}{cccccccc}${content}\\end{array}`;
    cursor = matrix.end;
  }
  return output + text.slice(cursor);
}

function normalizeTextLineBreaks(source) {
  const text = String(source || ''); let output = ''; let cursor = 0; let math = '';
  while (cursor < text.length) {
    if (text.startsWith('\\verb', cursor)) {
      let delimiterIndex = cursor + '\\verb'.length;
      if (text[delimiterIndex] === '*') delimiterIndex += 1;
      const delimiter = text[delimiterIndex];
      if (delimiter && !/[A-Za-z0-9\s]/.test(delimiter)) {
        const literalEnd = text.indexOf(delimiter, delimiterIndex + 1);
        if (literalEnd >= 0) {
          output += text.slice(cursor, literalEnd + 1); cursor = literalEnd + 1; continue;
        }
      }
    }
    if (!math && text.startsWith('$$', cursor)) { math = '$$'; output += '$$'; cursor += 2; continue; }
    if (math === '$$' && text.startsWith('$$', cursor)) { math = ''; output += '$$'; cursor += 2; continue; }
    if (!math && text.startsWith('\\[', cursor)) { math = '\\]'; output += '\\['; cursor += 2; continue; }
    if (math === '\\]' && text.startsWith('\\]', cursor)) { math = ''; output += '\\]'; cursor += 2; continue; }
    if (!math && text.startsWith('\\(', cursor)) { math = '\\)'; output += '\\('; cursor += 2; continue; }
    if (math === '\\)' && text.startsWith('\\)', cursor)) { math = ''; output += '\\)'; cursor += 2; continue; }
    if (!math && text[cursor] === '$' && text[cursor - 1] !== '\\') { math = '$'; output += '$'; cursor += 1; continue; }
    if (math === '$' && text[cursor] === '$' && text[cursor - 1] !== '\\') { math = ''; output += '$'; cursor += 1; continue; }
    if (!math && text.startsWith('\\\\', cursor)) {
      output += '\n'; cursor += 2;
      const optional = /^\[[^\]]*\]/.exec(text.slice(cursor)); if (optional) cursor += optional[0].length;
      continue;
    }
    output += text[cursor]; cursor += 1;
  }
  return output;
}

function readableLatex(source) {
  const prepared = normalizeXyMatrices(normalizePrescriptCommands(String(source || '')));
  const readable = unwrapLatexTwoArgumentCommands(unwrapLatexTextCommands(normalizeMathTextCommands(prepared)))
    .replace(/(^|[^\\])%[^\n]*/g, '$1')
    .replace(/\\selectlanguage\s*\{[^}]*\}/g, '')
    .replace(/\\begin\{(?:otherlanguage\*?|thebibliography)\}(?:\{[^}]*\})?/g, '')
    .replace(/\\end\{(?:otherlanguage\*?|thebibliography)\}/g, '')
    .replace(/\\(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b/g, '')
    .replace(/\\label\s*\{[^}]*\}/g, '')
    .replace(/\\(?:eqref|ref|autoref|cref|Cref)\s*\{[^}]*\}/g, 'the referenced result')
    .replace(/\\cite\w*\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g, (_match, locator, keys) => String(keys).split(',').map((key) => `[[cite:${key.trim()}${locator ? `|${locator.trim()}` : ''}]]`).join(' '))
    .replace(/\\begin\{tikzcd\}(?:\[[^\]]*\])?/g, '\\begin{array}{cccccccccccc}')
    .replace(/\\end\{tikzcd\}/g, '\\end{array}')
    .replace(/\\ar(?:\[[^\]]*\])?(?:\s*\{[^}]*\})?/g, '')
    .replace(/\\footnotemark\b/g, '')
    .replace(/\\includegraphics(?:\[[^\]]*\])?\s*\{[^}]+\}/g, '')
    .replace(/\\hfil\b/g, '')
    .replace(/\\displaylimits(?![A-Za-z@])/g, '\\limits')
    .replace(/\\'\{?e\}?/g, 'é')
    .replace(/\\'\{?E\}?/g, 'É')
    .replace(/\\"\{?([aeiouAEIOU])\}?/g, (_match, letter) => ({ a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' }[letter] || letter))
    .replace(/\\~\{?([anoANO])\}?/g, (_match, letter) => ({ a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ' }[letter] || letter))
    .replace(/\\c\{?([cC])\}?/g, (_match, letter) => letter === 'C' ? 'Ç' : 'ç')
    .replace(/\\v\{?([cszCSZ])\}?/g, (_match, letter) => ({ c: 'č', s: 'š', z: 'ž', C: 'Č', S: 'Š', Z: 'Ž' }[letter] || letter))
    .replace(/\\o\{\}/g, 'ø')
    .replace(/\\O\{\}/g, 'Ø')
    .replace(/\\ss\b/g, 'ß')
    .replace(/\\ae\b/g, 'æ')
    .replace(/\\AE\b/g, 'Æ')
    .replace(/\\oe\b/g, 'œ')
    .replace(/\\OE\b/g, 'Œ')
    .replace(/\\aa\b/g, 'å')
    .replace(/\\AA\b/g, 'Å')
    .replace(/\\iddots(?![A-Za-z@])/g, '\\mathinner{\\raisebox{-.4em}{$\\cdot$}\\mkern2mu\\cdot\\mkern2mu\\raisebox{.4em}{$\\cdot$}}')
    .replace(/\\\[\s*\\\]/g, '')
    .replace(/\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g, (_match, content) => /\$/.test(content) ? `\n${content}\n` : `\n$$${content}$$\n`)
    // `aligned` is an inner math environment and is commonly already wrapped
    // in \[...\]. Converting it to another pair of delimiters creates invalid
    // nested math such as \[$$...$$\]. Only promote top-level environments.
    .replace(/\\begin\{(?:align|align\*|gather|gather\*|multline|multline\*)\}/g, () => '$$\\begin{aligned}')
    .replace(/\\end\{(?:align|align\*|gather|gather\*|multline|multline\*)\}/g, () => '\\end{aligned}$$')
    .replace(/\\begin\{(?:enumerate|itemize|description)\}(?:\[[^\]]*\])?/g, '')
    .replace(/\\end\{(?:enumerate|itemize|description)\}/g, '')
    .replace(/\\item(?:\[[^\]]*\])?/g, '\n• ')
    .replace(/\\(?:emph|textbf|textit|texttt|textsc|textrm|textsf|underline|centerline|mbox)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:medskip|smallskip|bigskip|noindent|par)\b/g, '\n')
    .replace(/~+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Author TeX is line-wrapped for source control, not for typography. Preserve
  // paragraph breaks and explicit TeX `\\`, but reflow soft source newlines so
  // proofs read like the typeset paper instead of a code listing.
  return normalizeTextLineBreaks(readable)
    .replace(/\n\s*•/g, '\n\n•')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

function citationKeys(source) {
  return citationMentions(source).map((mention) => mention.key);
}

function citationMentions(source) {
  const mentions = [];
  for (const match of String(source || '').matchAll(/\\cite\w*\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g)) {
    for (const key of match[2].split(',').map((item) => item.trim()).filter(Boolean)) {
      const locator = String(match[1] || '').trim();
      if (!mentions.some((item) => item.key === key && item.locator === locator)) mentions.push({ key, locator });
    }
  }
  return mentions;
}

function cleanBibliographyFragment(value) {
  return readableLatex(String(value || '')
    .replace(/\\newblock\b/g, '\n')
    .replace(/\{\\(?:em|it|bf)\s+([^{}]*)\}/g, '$1')
    .replace(/\\(?:url|path)\s*\{([^}]*)\}/g, '$1')
    .replace(/\\href\s*\{[^}]*\}\s*\{([^}]*)\}/g, '$1'))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBibliography(source) {
  const text = String(source || '');
  const matches = [...text.matchAll(/\\bibitem(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)];
  const references = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const raw = text.slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? text.indexOf('\\end{thebibliography}', (match.index ?? 0) + match[0].length));
    const blocks = raw.split(/\\newblock\b/).map(cleanBibliographyFragment).filter(Boolean);
    const citationText = cleanBibliographyFragment(raw);
    const title = blocks[1] || blocks[0] || match[1];
    const authors = blocks.length > 1 ? blocks[0] : '';
    const href = /\\href\s*\{([^}]+)\}/.exec(raw)?.[1];
    const explicitUrl = /\\url\s*\{([^}]+)\}/.exec(raw)?.[1] || /https?:\/\/[^\s}]+/.exec(raw)?.[0];
    const doi = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i.exec(raw)?.[0]?.replace(/[.,;]+$/, '') || '';
    const arxivId = /(?:arXiv\s*:\s*|arXiv\s+)([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i.exec(citationText)?.[1] || '';
    const searchQuery = [title, authors].filter(Boolean).join(' ');
    const searchUrl = `https://scholar.google.com/scholar?q=${encodeURIComponent(searchQuery)}`;
    const url = explicitUrl || href || (doi ? `https://doi.org/${doi}` : arxivId ? `https://arxiv.org/abs/${arxivId}` : searchUrl);
    references.set(match[1], { key: match[1], title, authors, text: citationText, url, searchUrl, doi, arxivId, direct: Boolean(explicitUrl || href || doi || arxivId) });
  }
  return references;
}

function bibtexField(entry, name) {
  const match = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*`, 'i').exec(entry);
  if (!match) return '';
  let cursor = (match.index ?? 0) + match[0].length;
  while (/\s/.test(entry[cursor] || '')) cursor += 1;
  if (entry[cursor] === '{') return balancedGroup(entry, cursor)?.content || '';
  if (entry[cursor] === '"') {
    let end = cursor + 1;
    while (end < entry.length && (entry[end] !== '"' || entry[end - 1] === '\\')) end += 1;
    return entry.slice(cursor + 1, end);
  }
  return entry.slice(cursor).split(',')[0]?.trim() || '';
}

function cleanBibtexField(value) {
  return readableLatex(String(value || '').replace(/[{}]/g, '').replace(/\\&/g, '&')).replace(/\s+/g, ' ').trim();
}

function cleanBibtexUrl(value) {
  return String(value || '').trim().replace(/^\{+|\}+$/g, '').replace(/\\([%#&_{}])/g, '$1');
}

function extractBibtex(source) {
  const references = new Map();
  const pattern = /@(?!comment|preamble|string)([A-Za-z]+)\s*\{/gi;
  for (const match of String(source || '').matchAll(pattern)) {
    const group = balancedGroup(source, (match.index ?? 0) + match[0].length - 1);
    if (!group) continue;
    const comma = group.content.indexOf(',');
    if (comma < 0) continue;
    const key = group.content.slice(0, comma).trim();
    const entry = group.content.slice(comma + 1);
    const title = cleanBibtexField(bibtexField(entry, 'title')) || 'Untitled cited source';
    const authors = cleanBibtexField(bibtexField(entry, 'author')).replace(/\s+and\s+/gi, ' · ');
    const year = cleanBibtexField(bibtexField(entry, 'year'));
    const journal = cleanBibtexField(bibtexField(entry, 'journal') || bibtexField(entry, 'booktitle'));
    const doi = cleanBibtexField(bibtexField(entry, 'doi'));
    const eprint = cleanBibtexField(bibtexField(entry, 'eprint'));
    const explicitUrl = cleanBibtexUrl(bibtexField(entry, 'url'));
    const arxivId = /^(?:[a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?$/i.test(eprint) ? eprint.replace(/v\d+$/i, '') : '';
    const text = [authors, title, journal, year].filter(Boolean).join('. ');
    const searchUrl = `https://scholar.google.com/scholar?q=${encodeURIComponent([title, authors].filter(Boolean).join(' '))}`;
    const url = explicitUrl || (doi ? `https://doi.org/${doi}` : arxivId ? `https://arxiv.org/abs/${arxivId}` : searchUrl);
    references.set(key, { key, title, authors, text, url, searchUrl, doi, arxivId, direct: Boolean(explicitUrl || doi || arxivId) });
  }
  return references;
}

async function extractBibliographyTree(source, sourceRoot) {
  const references = extractBibliography(source);
  const requested = [];
  for (const match of String(source || '').matchAll(/\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    for (const name of match[1].split(',').map((value) => value.trim()).filter(Boolean)) requested.push(name);
  }
  for (const name of requested) {
    const filename = /\.bib$/i.test(name) ? name : `${name}.bib`;
    const candidate = path.resolve(sourceRoot, filename);
    const relative = path.relative(sourceRoot, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    try { for (const [key, reference] of extractBibtex(await readFile(candidate, 'utf8'))) references.set(key, reference); }
    catch { /* A missing bibliography remains a non-fatal, explicit lookup. */ }
  }
  return references;
}

function balancedGroup(text, start, openToken = '{', closeToken = '}') {
  if (text[start] !== openToken) return null;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === openToken && text[index - 1] !== '\\') depth += 1;
    else if (text[index] === closeToken && text[index - 1] !== '\\') {
      depth -= 1;
      if (depth === 0) return { content: text.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

function authorMacroTable(source) {
  const text = String(source || '');
  const macros = new Map();
  const declarations = /\\(?:newcommand|renewcommand)\s*\{\\([A-Za-z@]+)\}\s*(?:\[(\d+)\])?\s*(?:\[([^\]]*)\])?\s*\{/g;
  for (const match of text.matchAll(declarations)) {
    const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    if (group) macros.set(match[1], { replacement: group.content, arity: Number(match[2] || 0), defaultArg: match[3] });
  }
  for (const match of text.matchAll(/\\def\s*\\([A-Za-z@]+)\s*((?:#\d\s*)*)\{/g)) {
    const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    let arity = Math.max(0, ...[...String(match[2] || '').matchAll(/#(\d)/g)].map((item) => Number(item[1])));
    let replacement = group?.content || '';
    if (arity === 0 && /^\\(?:widehat|widetilde|overline|underline)$/.test(replacement.trim())) { arity = 1; replacement = `${replacement.trim()}{#1}`; }
    if (group) macros.set(match[1], { replacement, arity });
  }
  for (const match of text.matchAll(/\\DeclareMathOperator\*?\s*\{\\([A-Za-z@]+)\}\s*\{/g)) {
    const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    if (group) macros.set(match[1], { replacement: `\\operatorname{${group.content}}`, arity: 0 });
  }
  for (const match of text.matchAll(/\\let\s*\\([A-Za-z@]+)\s*(?:=\s*)?\\([A-Za-z@]+)/g)) {
    const takesArgument = /^(?:widehat|widetilde|overline|underline)$/.test(match[2]);
    macros.set(match[1], { replacement: takesArgument ? `\\${match[2]}{#1}` : `\\${match[2]}`, arity: takesArgument ? 1 : 0 });
  }
  return macros;
}

function expandMacroUse(text, name, macro) {
  const pattern = new RegExp(`\\\\${name}(?![A-Za-z@])`, 'g');
  let output = ''; let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    let position = (match.index ?? 0) + match[0].length;
    const args = [];
    // TeX uses whitespace to terminate a zero-argument control word. Preserve
    // that separator or `\\leq R` becomes the undefined command `\\leqslantR`.
    if (macro.arity > 0 || macro.defaultArg !== undefined) while (/\s/.test(text[position] || '')) position += 1;
    if (macro.defaultArg !== undefined) {
      const optional = balancedGroup(text, position, '[', ']');
      args.push(optional ? optional.content : macro.defaultArg);
      if (optional) position = optional.end;
    }
    let complete = true;
    for (let argIndex = args.length; argIndex < macro.arity; argIndex += 1) {
      while (/\s/.test(text[position] || '')) position += 1;
      const group = balancedGroup(text, position);
      if (group) { args.push(group.content); position = group.end; continue; }
      const token = text[position] === '\\' ? /^\\[A-Za-z@]+|^\\./.exec(text.slice(position))?.[0] : text[position];
      if (!token) { complete = false; break; }
      args.push(token); position += token.length;
    }
    if (!complete) continue;
    let replacement = macro.replacement;
    args.forEach((argument, index) => { replacement = replacement.replace(new RegExp(`#${index + 1}`, 'g'), () => argument); });
    output += text.slice(cursor, match.index ?? 0) + replacement;
    cursor = position;
  }
  return output + text.slice(cursor);
}

function expandSimpleEnvironments(source) {
  const text = String(source || '');
  const definitions = [];
  for (const match of text.matchAll(/\\(?:newenvironment|renewenvironment)\s*\{([^}]+)\}(?!\s*\[)\s*\{/g)) {
    const begin = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    if (!begin) continue;
    let position = begin.end; while (/\s/.test(text[position] || '')) position += 1;
    const end = balancedGroup(text, position);
    if (end) definitions.push({ name: match[1], begin: begin.content, end: end.content });
  }
  let expanded = text;
  for (const definition of definitions) {
    const escaped = definition.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expanded = expanded.replace(new RegExp(`\\\\begin\\{${escaped}\\}`, 'g'), () => definition.begin).replace(new RegExp(`\\\\end\\{${escaped}\\}`, 'g'), () => definition.end);
  }
  return expanded;
}

function expandAuthorMacros(source) {
  const macros = authorMacroTable(source);
  let expanded = expandSimpleEnvironments(source);
  const entries = [...macros.entries()].sort((a, b) => b[0].length - a[0].length);
  for (let pass = 0; pass < 4; pass += 1) for (const [name, macro] of entries) expanded = expandMacroUse(expanded, name, macro);
  return expanded;
}

function theoremKind(title, environment) {
  const value = `${title} ${environment}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const environmentName = String(environment || '').toLowerCase();
  if (/theorem|theoreme|satz/.test(value) || /^thm/.test(environmentName)) return 'theorem';
  if (/lemma|lemme/.test(value) || /^lem/.test(environmentName)) return 'lemma';
  if (/proposition/.test(value) || /^prop/.test(environmentName)) return 'proposition';
  if (/corollary|corollaire|korollar/.test(value) || /^cor/.test(environmentName)) return 'corollary';
  if (/conjecture|conjecture|vermutung/.test(value) || /^conj/.test(environmentName)) return 'conjecture';
  if (/definition/.test(value) || /^def/.test(environmentName)) return 'definition';
  if (/assumption|hypothesis|hypothese|annahme/.test(value) || /^assum/.test(environmentName)) return 'assumption';
  if (/notation|convention/.test(value) || /^nota/.test(environmentName)) return 'notation';
  if (/remark|remarque|bemerkung/.test(value) || /^rem/.test(environmentName)) return 'remark';
  if (/example|exemple|beispiel/.test(value) || /^ex/.test(environmentName)) return 'example';
  if (/axiom|postulate|condition/.test(value)) return 'assumption';
  if (/claim|fact|observation|problem|question|exercise/.test(value)) return 'proposition';
  // A command declared through \newtheorem is theorem-like even when its
  // author-facing name is domain-specific. Keep it as a formal proposition
  // while retaining the exact printed name separately for the reader.
  return 'proposition';
}

function environmentDisplayLabel(label, displayName, printedNumber = '') {
  const name = readableLatex(displayName || '').trim();
  if (!name) return String(label || '');
  const number = printedNumber || /\b(?:\d+(?:\.\d+)*|[IVX]+(?:\.[IVX]+)*)\b/i.exec(String(label || ''))?.[0] || '';
  return number ? `${name} ${number}` : name;
}

function graphicPaths(source) {
  return [...String(source || '').matchAll(/\\includegraphics(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)].map((match) => match[1].trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function literalSourceRanges(source) {
  const value = String(source || ''); const ranges = [];
  for (const match of value.matchAll(/\\begin\{(verbatim\*?|Verbatim|lstlisting|minted|comment|alltt)\}(?:\[[^\]]*\])?(?:\{[^}]*\})?[\s\S]*?\\end\{\1\}/g)) {
    const start = match.index ?? 0; ranges.push([start, start + match[0].length]);
  }
  for (const match of value.matchAll(/\\verb\*?([^A-Za-z0-9\s])[\s\S]*?\1/g)) {
    const start = match.index ?? 0; ranges.push([start, start + match[0].length]);
  }
  return ranges;
}

function insideSourceRanges(index, ranges) {
  return ranges.some(([start, end]) => start <= index && index < end);
}

function extractSourceUnits(source) {
  const originalSource = String(source || '');
  const normalizedSource = expandAuthorMacros(originalSource);
  const literalRanges = literalSourceRanges(normalizedSource);
  const environments = new Map([
    ['theorem', 'theorem'], ['thm', 'theorem'], ['lemma', 'lemma'], ['lem', 'lemma'],
    ['proposition', 'proposition'], ['prop', 'proposition'], ['corollary', 'corollary'], ['cor', 'corollary'],
    ['conjecture', 'conjecture'], ['conj', 'conjecture'], ['definition', 'definition'], ['defn', 'definition'],
    ['assumption', 'assumption'], ['notation', 'notation'], ['remark', 'remark'], ['rem', 'remark'], ['example', 'example'],
  ]);
  const displayNames = new Map([
    ['theorem', 'Theorem'], ['thm', 'Theorem'], ['lemma', 'Lemma'], ['lem', 'Lemma'],
    ['proposition', 'Proposition'], ['prop', 'Proposition'], ['corollary', 'Corollary'], ['cor', 'Corollary'],
    ['conjecture', 'Conjecture'], ['conj', 'Conjecture'], ['definition', 'Definition'], ['defn', 'Definition'],
    ['assumption', 'Assumption'], ['notation', 'Notation'], ['remark', 'Remark'], ['rem', 'Remark'], ['example', 'Example'],
  ]);
  const theoremCounters = new Map();
  const declarations = /\\newtheorem(\*)?\s*\{([^}]+)\}(?:\[([^\]]+)\])?\s*\{([^}]+)\}(?:\[([^\]]+)\])?/g;
  for (const match of originalSource.matchAll(declarations)) {
    const environment = match[2]; const sharedCounter = String(match[3] || '').trim(); const displayName = readableLatex(match[4]); const within = String(match[5] || '').trim();
    const kind = theoremKind(displayName, environment);
    environments.set(environment, kind);
    displayNames.set(environment, displayName);
    theoremCounters.set(environment, { root: sharedCounter || environment, within, numbered: !match[1] });
  }
  const names = [...environments.keys()].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!names) return [];
  const unitPattern = new RegExp(`\\\\begin\\{(${names})\\}(?:\\[([^\\]]*)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`, 'g');
  const embeddedProofPattern = /\\begin\{proof\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{proof\}/g;
  const sectionStarts = [...normalizedSource.matchAll(/\\section(?!\*)\s*(?:\[[^\]]*\])?\s*\{/g)].filter((match) => !insideSourceRanges(match.index ?? 0, literalRanges)).map((match) => match.index ?? 0);
  const counterValues = new Map();
  const units = [];
  for (const match of normalizedSource.matchAll(unitPattern)) {
    const start = match.index ?? 0; const end = start + match[0].length;
    if (insideSourceRanges(start, literalRanges)) continue;
    const label = /\\label\s*\{([^}]+)\}/.exec(match[3])?.[1] || '';
    const embeddedProofs = [...match[3].matchAll(embeddedProofPattern)];
    const statementSource = match[3].replace(embeddedProofPattern, '');
    const counter = theoremCounters.get(match[1]); const owner = theoremCounters.get(counter?.root) || counter; const sectionNumber = sectionStarts.filter((sectionStart) => sectionStart < start).length; const scope = owner?.within === 'section' ? sectionNumber : 0; const counterKey = `${counter?.root || match[1]}:${scope}`; const nextNumber = (counterValues.get(counterKey) || 0) + 1; if (counter?.numbered !== false) counterValues.set(counterKey, nextNumber); const printedNumber = counter?.numbered === false ? '' : owner?.within === 'section' ? `${sectionNumber}.${nextNumber}` : `${nextNumber}`;
    units.push({ environment: match[1], kind: environments.get(match[1]), displayName: displayNames.get(match[1]) || readableLatex(match[1]), printedNumber, title: match[2] || '', texLabel: label, start, end, statement: readableLatex(statementSource), proofText: embeddedProofs.map((proof) => readableLatex(proof[1])).filter(Boolean).join('\n\n'), assetPaths: graphicPaths(statementSource), proofAssetPaths: embeddedProofs.flatMap((proof) => graphicPaths(proof[1])), embeddedProof: embeddedProofs.length > 0, citationMentions: citationMentions(`${match[2] || ''} ${match[3]}`), citationKeys: citationKeys(`${match[2] || ''} ${match[3]}`) });
  }
  const byLabel = new Map(units.filter((unit) => unit.texLabel).map((unit) => [unit.texLabel, unit]));
  const proofPattern = /\\begin\{proof\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{proof\}/g;
  for (const proof of normalizedSource.matchAll(proofPattern)) {
    const proofStart = proof.index ?? 0;
    if (insideSourceRanges(proofStart, literalRanges)) continue;
    if (units.some((unit) => unit.start < proofStart && proofStart < unit.end)) continue;
    const nearest = units.filter((unit) => unit.end <= proofStart).at(-1) || null;
    const prelude = normalizedSource.slice(Math.max(nearest?.end ?? 0, proofStart - 2200), proofStart);
    const explicitMatch = [...prelude.matchAll(/(?:proof\s+of|prove|complet(?:e|es|ed)\s+the\s+proof\s+of)[\s\S]{0,180}?(?:\\ref\s*\{([^}]+)\}|\\hyperref\s*\[([^\]]+)\])/gi)].at(-1);
    const explicit = explicitMatch?.[1] || explicitMatch?.[2];
    let target = explicit ? byLabel.get(explicit) : null;
    if (!target && nearest && !nearest.proofText) target = nearest;
    if (target && !target.proofText) {
      target.proofText = readableLatex(proof[1]);
      target.proofAssetPaths = graphicPaths(proof[1]);
      for (const mention of citationMentions(proof[1])) if (!target.citationMentions.some((item) => item.key === mention.key && item.locator === mention.locator)) target.citationMentions.push(mention);
      target.citationKeys = target.citationMentions.map((mention) => mention.key);
      target.proofStart = proofStart;
      target.proofEnd = proofStart + proof[0].length;
    }
  }
  return units;
}

function citationReference(mention, bibliography, aiCitations = []) {
  const { key, locator = '' } = mention;
  const reference = bibliography.get(key) || { key, title: 'Bibliographic record not cached yet', authors: '', text: '', url: `https://scholar.google.com/scholar?q=${encodeURIComponent(key)}`, searchUrl: `https://scholar.google.com/scholar?q=${encodeURIComponent(key)}`, doi: '', arxivId: '', direct: false };
  const aiDetail = aiCitations.find((citation) => citation && citation.key === key && String(citation.locator || '') === locator) || aiCitations.find((citation) => citation && citation.key === key);
  return { ...reference, locator, statement: typeof aiDetail?.statement === 'string' ? aiDetail.statement : '', definitions: Array.isArray(aiDetail?.definitions) ? aiDetail.definitions.filter((item) => item && typeof item.notation === 'string' && typeof item.definition === 'string').map((item) => ({ notation: item.notation, definition: item.definition, source: typeof item.source === 'string' ? item.source : '' })) : [] };
}

function sectionEvents(source) {
  const events = []; const literalRanges = literalSourceRanges(source);
  const pattern = /\\(part|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\s*\{/g;
  const levels = { part: 0, section: 1, subsection: 2, subsubsection: 3 };
  for (const match of String(source || '').matchAll(pattern)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges)) continue;
    const title = balancedGroup(source, (match.index ?? 0) + match[0].length - 1);
    if (!title) continue;
    events.push({ type: 'section', start: match.index ?? 0, end: title.end, level: levels[match[1]] ?? 1, title: readableLatex(title.content) });
  }
  return events;
}

function readableBodyFragment(source) {
  const cleaned = String(source || '')
    .replace(/\\begin\{abstract\}[\s\S]*?\\end\{abstract\}/g, '')
    .replace(/\\(?:title|author|address|email|subjclass|date|dedicatory|keywords|thanks)(?:\[[^\]]*\])?\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '')
    .replace(/\\(?:maketitle|tableofcontents|clearpage|newpage|printbibliography|centering)\b/g, '')
    .replace(/\\selectlanguage\s*\{[^}]*\}/g, '')
    .replace(/\\begin\{otherlanguage\*?\}\s*\{[^}]*\}|\\end\{otherlanguage\*?\}/g, '')
    .replace(/\\(?:nocite|label|pagestyle|thispagestyle|pagenumbering)\s*\{[^}]*\}/g, '')
    .replace(/\\setcounter\s*\{[^}]*\}\s*\{[^}]*\}/g, '')
    .replace(/\\(?:bibliography|bibliographystyle|addbibresource)\s*\{[^}]*\}/g, '')
    .replace(/\\includegraphics(?:\[[^\]]*\])?\s*\{([^}]*)\}/g, (_match, file) => `\n[Figure from the original source: ${file}]\n`)
    .replace(/\\begin\{(?:center|flushleft|flushright|quote|quotation|figure\*?|table\*?|minipage)\}(?:\[[^\]]*\])?(?:\{[^}]*\})?/g, '')
    .replace(/\\end\{(?:center|flushleft|flushright|quote|quotation|figure\*?|table\*?|minipage)\}/g, '')
    .replace(/\\begin\{tabular\}(?:\[[^\]]*\])?\s*\{[^}]*\}/g, '\n')
    .replace(/\\end\{tabular\}/g, '\n')
    .replace(/\\&/g, '&');
  return readableLatex(cleaned).replace(/\\(?:vspace|hspace)\*?\s*\{[^}]*\}/g, ' ').trim();
}

function tableEvents(source) {
  const events = []; const covered = []; const literalRanges = literalSourceRanges(source);
  const caption = (fragment) => {
    const match = /\\caption(?:\[[^\]]*\])?\s*\{/.exec(fragment);
    if (!match) return '';
    return readableLatex(balancedGroup(fragment, (match.index ?? 0) + match[0].length - 1)?.content || '');
  };
  const tabular = (fragment) => /\\begin\{(?:tabular\*?|tabularx)\}[\s\S]*?\\end\{(?:tabular\*?|tabularx)\}/.exec(fragment)?.[0] || '';
  for (const match of String(source || '').matchAll(/\\begin\{table\*?\}([\s\S]*?)\\end\{table\*?\}/g)) {
    const start = match.index ?? 0;
    if (insideSourceRanges(start, literalRanges)) continue;
    const content = tabular(match[0]);
    if (!content) continue;
    const end = start + match[0].length; covered.push([start, end]);
    events.push({ type: 'table', start, end, content, caption: caption(match[0]), citations: citationMentions(match[0]) });
  }
  for (const match of String(source || '').matchAll(/\\begin\{(?:tabular\*?|tabularx)\}[\s\S]*?\\end\{(?:tabular\*?|tabularx)\}/g)) {
    const start = match.index ?? 0;
    if (insideSourceRanges(start, literalRanges) || covered.some(([left, right]) => left <= start && start < right)) continue;
    events.push({ type: 'table', start, end: start + match[0].length, content: match[0], caption: '', citations: citationMentions(match[0]) });
  }
  return events;
}

function sourceParagraphBlocks(source, bibliography, state) {
  const readable = readableBodyFragment(source);
  if (!readable) return [];
  const paragraphs = []; let cursor = 0; let start = 0; let math = '';
  while (cursor < readable.length) {
    // Literal examples such as \verb|$$...$$| are prose, not delimiters. Skip
    // their payload while tracking math state so tutorial-style papers cannot
    // split an actual display equation into several malformed paragraphs.
    if (readable.startsWith('\\verb', cursor)) {
      let delimiterIndex = cursor + '\\verb'.length;
      if (readable[delimiterIndex] === '*') delimiterIndex += 1;
      const delimiter = readable[delimiterIndex];
      if (delimiter && !/[A-Za-z0-9\s]/.test(delimiter)) {
        const literalEnd = readable.indexOf(delimiter, delimiterIndex + 1);
        if (literalEnd >= 0) { cursor = literalEnd + 1; continue; }
      }
    }
    if (!math && readable.startsWith('$$', cursor)) { math = '$$'; cursor += 2; continue; }
    if (math === '$$' && readable.startsWith('$$', cursor)) { math = ''; cursor += 2; continue; }
    if (!math && readable.startsWith('\\[', cursor)) { math = '\\]'; cursor += 2; continue; }
    if (math === '\\]' && readable.startsWith('\\]', cursor)) { math = ''; cursor += 2; continue; }
    if (!math && readable.startsWith('\\(', cursor)) { math = '\\)'; cursor += 2; continue; }
    if (math === '\\)' && readable.startsWith('\\)', cursor)) { math = ''; cursor += 2; continue; }
    if (!math && readable[cursor] === '$' && readable[cursor - 1] !== '\\') { math = '$'; cursor += 1; continue; }
    if (math === '$' && readable[cursor] === '$' && readable[cursor - 1] !== '\\') { math = ''; cursor += 1; continue; }
    if (!math && readable[cursor] === '\n' && /^\n\s*\n/.test(readable.slice(cursor))) {
      paragraphs.push(readable.slice(start, cursor));
      const separator = /^\n\s*\n+/.exec(readable.slice(cursor))?.[0] || '\n\n';
      cursor += separator.length; start = cursor; continue;
    }
    cursor += 1;
  }
  paragraphs.push(readable.slice(start));
  return paragraphs.map((content) => content.trim()).filter((content) => content && !/^\\(?:begin|end)\{document\}/.test(content)).map((content) => {
    state.paragraph += 1;
    const mentions = [...content.matchAll(/\[\[cite:([^|\]]+)(?:\|([^\]]*))?\]\]/g)].map((match) => ({ key: match[1], locator: match[2] || '' }));
    return { id: `source-paragraph-${state.paragraph}`, kind: 'paragraph', level: 4, title: '', content, proofText: '', nodeId: '', resultKind: '', citations: mentions.map((mention) => citationReference(mention, bibliography)) };
  });
}

function buildSourceBlocks(source, units, bibliography) {
  const normalized = expandAuthorMacros(String(source || ''));
  const beginMatch = /^[ \t]*\\begin\{document\}[ \t]*(?:%[^\r\n]*)?/m.exec(normalized);
  const documentBegin = beginMatch?.index ?? -1;
  let bodyStart = documentBegin >= 0 ? documentBegin + (beginMatch?.[0].length ?? '\\begin{document}'.length) : 0;
  const firstSection = /\\(?:part|section|chapter)\*?(?:\[[^\]]*\])?\s*\{/.exec(normalized.slice(bodyStart));
  const abstractStart = normalized.indexOf('\\begin{abstract}', bodyStart);
  if (abstractStart >= bodyStart && (!firstSection || abstractStart < bodyStart + (firstSection.index ?? 0))) {
    const abstractEnd = normalized.indexOf('\\end{abstract}', abstractStart);
    if (abstractEnd >= abstractStart) bodyStart = abstractEnd + '\\end{abstract}'.length;
  }
  const endMatches = [...normalized.matchAll(/^[ \t]*\\end\{document\}[ \t]*(?:%[^\r\n]*)?/gm)];
  const documentEnd = endMatches.at(-1)?.index ?? -1;
  const bodyEnd = documentEnd > bodyStart ? documentEnd : normalized.length;
  const events = [
    ...sectionEvents(normalized).filter((event) => event.start >= bodyStart && event.start < bodyEnd),
    ...figureEvents(normalized).filter((event) => event.start >= bodyStart && event.start < bodyEnd),
    ...tableEvents(normalized).filter((event) => event.start >= bodyStart && event.start < bodyEnd),
    ...units.filter((unit) => unit.start >= bodyStart && unit.start < bodyEnd).map((unit) => ({ type: 'result', start: unit.start, end: unit.end, unit })),
    ...units.filter((unit) => Number.isFinite(unit.proofStart)).map((unit) => ({ type: 'proof-skip', start: unit.proofStart, end: unit.proofEnd, unit })),
  ].sort((left, right) => left.start - right.start || (left.type === 'section' ? -1 : 1));
  const blocks = []; const state = { paragraph: 0, section: 0, result: 0, proof: 0, table: 0 };
  let cursor = bodyStart;
  for (const event of events) {
    if (event.start < cursor) continue;
    blocks.push(...sourceParagraphBlocks(normalized.slice(cursor, event.start), bibliography, state));
    if (event.type === 'section') {
      state.section += 1;
      blocks.push({ id: `source-section-${state.section}`, kind: 'section', level: event.level, title: event.title, content: '', proofText: '', nodeId: '', resultKind: '', citations: [] });
    } else if (event.type === 'figure') {
      state.figure = (state.figure || 0) + 1;
      blocks.push({ id: `source-figure-${state.figure}`, kind: 'figure', level: 4, title: '', content: '', proofText: '', nodeId: '', resultKind: '', citations: event.citations || [], assetPaths: event.assetPaths, caption: event.caption });
    } else if (event.type === 'table') {
      state.table += 1;
      blocks.push({ id: `source-table-${state.table}`, kind: 'table', level: 4, title: '', content: event.content, proofText: '', nodeId: '', resultKind: '', citations: event.citations || [], assetPaths: [], caption: event.caption });
    } else if (event.type === 'result') {
      state.result += 1;
      blocks.push({ id: `source-result-${state.result}`, kind: 'result', level: 4, title: readableLatex(event.unit.title), content: event.unit.statement, proofText: '', nodeId: event.unit.nodeId || '', resultKind: event.unit.displayName || event.unit.kind || 'Theorem', citations: event.unit.citations || [], assetPaths: event.unit.assetPaths || [], caption: '' });
      if (event.unit.proofText) {
        state.proof += 1;
        blocks.push({ id: `source-proof-${state.proof}`, kind: 'proof', level: 4, title: '', content: '', proofText: event.unit.proofText, nodeId: event.unit.nodeId || '', resultKind: event.unit.kind || 'theorem', citations: event.unit.citations || [], assetPaths: event.unit.proofAssetPaths || [], caption: '' });
      }
    }
    cursor = event.end;
  }
  blocks.push(...sourceParagraphBlocks(normalized.slice(cursor, bodyEnd), bibliography, state));
  return blocks;
}

function figureEvents(source) {
  const events = []; const covered = []; const literalRanges = literalSourceRanges(source);
  const images = (fragment) => graphicPaths(fragment);
  const caption = (fragment) => {
    const match = /\\caption(?:\[[^\]]*\])?\s*\{/.exec(fragment);
    if (!match) return '';
    return readableLatex(balancedGroup(fragment, (match.index ?? 0) + match[0].length - 1)?.content || '');
  };
  for (const match of String(source || '').matchAll(/\\begin\{figure\*?\}([\s\S]*?)\\end\{figure\*?\}/g)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges)) continue;
    const assetPaths = images(match[0]); if (!assetPaths.length) continue;
    const start = match.index ?? 0; const end = start + match[0].length; covered.push([start, end]);
    events.push({ type: 'figure', start, end, assetPaths, caption: caption(match[0]), citations: citationMentions(match[0]) });
  }
  for (const match of String(source || '').matchAll(/\\includegraphics(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    const start = match.index ?? 0; if (insideSourceRanges(start, literalRanges) || covered.some(([left, right]) => left <= start && start < right)) continue;
    events.push({ type: 'figure', start, end: start + match[0].length, assetPaths: [match[1].trim().replace(/^["']|["']$/g, '')], caption: '', citations: [] });
  }
  return events;
}

async function enrichAuditFromTex(rawText, primarySource) {
  if (!primarySource?.entryFile || !primarySource?.sourceDirectory) return rawText;
  const clean = String(rawText || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const first = clean.indexOf('{'); const last = clean.lastIndexOf('}');
  if (first < 0 || last <= first) return rawText;
  let audit;
  try { audit = JSON.parse(clean.slice(first, last + 1)); }
  catch { return rawText; }
  if (!Array.isArray(audit.nodes)) return rawText;
  const expanded = await readExpandedTex(primarySource.entryFile, primarySource.sourceDirectory);
  const sourceUnits = extractSourceUnits(expanded);
  const bibliography = await extractBibliographyTree(expanded, primarySource.sourceDirectory);
  const cursors = new Map();
  for (const node of audit.nodes) {
    if (!node || typeof node !== 'object') continue;
    const aiCitations = Array.isArray(node.citations) ? node.citations : [];
    node.citations = [];
    const kind = String(node.kind || '');
    const sameKind = sourceUnits.filter((unit) => unit.kind === kind);
    const index = cursors.get(kind) || 0;
    const sourceUnit = sameKind[index];
    if (!sourceUnit) continue;
    cursors.set(kind, index + 1);
    if (sourceUnit.statement) node.statement = sourceUnit.statement;
    node.displayName = sourceUnit.displayName || '';
    node.label = environmentDisplayLabel(node.label, sourceUnit.displayName, sourceUnit.printedNumber);
    // The TeX tree is authoritative here. Clearing an absent proof matters when
    // re-enriching an older audit: otherwise a stale, positionally misassigned
    // proof can survive forever on an externally quoted result.
    node.proofText = sourceUnit.proofText || '';
    sourceUnit.nodeId = node.id;
    sourceUnit.citations = sourceUnit.citationMentions.map((mention) => citationReference(mention, bibliography, aiCitations));
    node.citations = sourceUnit.citations;
  }
  for (const [index, sourceUnit] of sourceUnits.entries()) {
    if (sourceUnit.nodeId) continue;
    const id = `source-unit-${index + 1}`;
    sourceUnit.nodeId = id;
    sourceUnit.citations = sourceUnit.citationMentions.map((mention) => citationReference(mention, bibliography));
    audit.nodes.push({ id, kind: sourceUnit.kind || 'proposition', displayName: sourceUnit.displayName || '', label: environmentDisplayLabel('', sourceUnit.displayName, sourceUnit.printedNumber) || 'Result', title: readableLatex(sourceUnit.title) || sourceUnit.displayName || 'Result', statement: sourceUnit.statement, proofText: sourceUnit.proofText || '', citations: sourceUnit.citations, status: 'verified', anchor: { label: 'Author TeX source', page: null, confidence: 'verified' }, role: 'Source result preserved by the deterministic document parser.', dependencies: [], proofSketch: [], whyItMatters: 'This result belongs to the complete original document structure and was retained even though the AI audit did not create a separate analytical node for it.', expandable: true });
  }
  audit.sourceBlocks = buildSourceBlocks(expanded, sourceUnits, bibliography);
  const captured = audit.nodes.filter((node) => typeof node.proofText === 'string' && node.proofText.trim()).length;
  if (audit.audit && Array.isArray(audit.audit.verificationWarnings)) {
    audit.audit.verificationWarnings = audit.audit.verificationWarnings.filter((warning) => !/payload|reproduc(?:e|ing).*entire proof|proof-text capture/i.test(String(warning)));
    const proofCaptureNote = `Complete attached proof environments were captured directly from the local TeX tree (${captured} proofs), independently of the AI explanation payload.`;
    const baseSummary = String(audit.audit.sourceSummary || '').replace(/\s*Complete attached proof environments were captured directly from the local TeX tree \(\d+ proofs\), independently of the AI explanation payload\./g, '').trim();
    audit.audit.sourceSummary = `${baseSummary} ${proofCaptureNote}`.trim();
  }
  return JSON.stringify(audit);
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
    required: ['id', 'kind', 'label', 'title', 'statement', 'proofText', 'citations', 'status', 'anchor', 'role', 'dependencies', 'proofSketch', 'whyItMatters', 'expandable'],
    properties: {
      id: { type: 'string' },
      kind: { enum: ['definition', 'assumption', 'notation', 'lemma', 'proposition', 'theorem', 'corollary', 'conjecture', 'proof', 'equation', 'remark', 'example', 'section', 'external-result'] },
      label: { type: 'string' },
      title: { type: 'string' },
      statement: { type: 'string' },
      proofText: { type: 'string' },
      citations: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['key', 'locator', 'statement', 'definitions'],
          properties: { key: { type: 'string' }, locator: { type: 'string' }, statement: { type: 'string' }, definitions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['notation', 'definition', 'source'], properties: { notation: { type: 'string' }, definition: { type: 'string' }, source: { type: 'string' } } } } },
        },
      },
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
    required: ['audit', 'nodes', 'readingPaths', 'crossPaperLinks', 'openQuestions', 'editorialCorrections'],
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
      editorialCorrections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['nodeId', 'field', 'original', 'replacement', 'rationale', 'confidence'], properties: { nodeId: { type: 'string' }, field: { enum: ['statement', 'proofText'] }, original: { type: 'string' }, replacement: { type: 'string' }, rationale: { type: 'string' }, confidence: { enum: ['high', 'medium', 'low'] } } } },
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

function auditPrompt({ paper, profile, localInventory, primarySource, correctnessAudit = true, detailedAudit = true, updateContext = null }) {
  const libraryContext = localInventory.length
    ? JSON.stringify(localInventory, null, 2)
    : 'No other audited papers are available in the local vault yet.';
  const sourceInstructions = primarySource?.kind === 'tex'
    ? `A local ${primarySource.origin === 'reader-upload' ? 'reader-supplied' : 'arXiv'} TeX source bundle has already been acquired. Read it before doing anything else.
- main TeX entry: ${primarySource.entryFile}
- source directory: ${primarySource.sourceDirectory}
- TeX files available: ${primarySource.fileCount}

Prefer these local TeX files over the PDF: preserve theorem environment labels, \\label/\\ref relationships, section structure, equations, and \\input/\\include dependencies. Use the PDF only to verify pagination or material absent from the source bundle.`
    : primarySource?.kind === 'ai-tex'
      ? `The arXiv source bundle had no usable TeX. At the reader's request, local AI transcribed the complete PDF into an editable LaTeX working source.
- AI-generated LaTeX entry: ${primarySource.entryFile}
- source directory: ${primarySource.sourceDirectory}

Read that local LaTeX document first, but treat the original PDF at https://arxiv.org/pdf/${paper.arxivId} as authoritative. Verify statements against the PDF whenever the conversion may be ambiguous. State clearly in sourceSummary that the LaTeX is an AI transcription, not author-supplied source.`
      : primarySource?.kind === 'uploaded-pdf'
        ? `The reader supplied the primary PDF directly. Read the complete local PDF at ${primarySource.entryFile}. Treat this uploaded file as authoritative and do not attempt to substitute an arXiv document.`
        : `The arXiv TeX source could not be used (${primarySource?.error || 'unavailable'}). Fall back to the primary PDF at https://arxiv.org/pdf/${paper.arxivId}.`;
  const proofCaptureInstructions = primarySource?.kind === 'tex' || primarySource?.kind === 'ai-tex'
    ? `The host application deterministically attaches complete theorem statements and proof environments from the local LaTeX tree after your turn. Set proofText to an empty string for every node; spend the response budget on accurate dependency analysis and proofSketch explanations. Do not warn about proof payload length.`
    : `For every theorem, lemma, proposition, corollary, and proof node, statement must be a source-faithful transcription of the complete printed statement, not a summary, and proofText must contain the complete proof from the PDF, including all equations, cases, and cited intermediate results. Do not shorten a proof. Use an empty proofText only when the source genuinely has no proof or the complete proof cannot be accessed, and explain that limitation in the verification warnings.`;
  const correctnessInstructions = correctnessAudit
    ? `CORRECTNESS AUDIT REQUESTED: Treat this as an adversarial mathematical referee pass, not a summary. For every formal environment, actively check whether the statement is well-formed under the declared hypotheses and whether its proof supports the exact conclusion. Try the smallest natural examples and counterexamples against universal claims. Check every division, normalization, extension across a singular set, change of quantifiers, use of compactness or a maximum principle, and transition between pointwise, local, and global assertions. In geometry and sheaf theory, explicitly distinguish a locally free sheaf from a subbundle, a sheaf injection from a fibrewise injection or nowhere-vanishing section, and an arbitrary subsheaf from a saturated one; verify that any quotient has the regularity the proof uses. Trace dependencies, inspect cited prerequisites when accessible, and use status "verified" only when this check succeeds. Use "needs-verification" for a specific gap, ambiguity, unchecked external dependency, or possible error, explain the exact failure and a concrete test case in role or verificationWarnings, and propagate the warning to downstream results that use it. Never repair or silently strengthen an argument.`
    : `CORRECTNESS AUDIT NOT REQUESTED: Preserve the complete document structure and source text, build logical dependencies, and mark source-transcribed environments as verified only in the limited sense that their text was located in the primary source. Do not claim that the mathematics or proof has been checked for correctness.`;
  const depthInstructions = detailedAudit
    ? `DETAILED AUDIT MODE: Build a retrieval queue for every citation locator that names a theorem, lemma, proposition, corollary, definition, equation, section, or numbered result. For each queue item, resolve the cited paper from its bibliography record, fetch the cited paper's primary TeX source when it is on arXiv (use its PDF only when TeX is unavailable), search that source for the exact locator, and recover the complete statement before finishing this audit. Also recover every nearby definition needed to interpret its nonstandard notation and hypotheses. Populate citations.statement and citations.definitions only with material verified in that cited primary source. Continue through the full queue within the available audit time instead of deferring retrieval to a later question. Do not return a placeholder saying that a record is not cached; either provide verified source detail or leave the field empty and give a precise verification warning naming what access or locator failed.`
    : `STANDARD AUDIT MODE: Preserve citation keys, locators, titles, and direct primary-source links, but do not spend the audit budget following every external theorem.`;
  const versionInstructions = updateContext
    ? `VERSION UPDATE CONTEXT: This paper is replacing an earlier locally audited arXiv version. Read and audit the new primary source independently, then use this compact comparison only to make sure changed assumptions, results, proofs, notation, citations, and downstream dependencies receive special scrutiny. Do not copy stale statements or proof text from the previous audit. Do not discard a new source unit merely because it has no predecessor.\n${JSON.stringify(updateContext, null, 2)}`
    : '';
  return `You are arXivpecker's mathematical-paper audit engine. Work for a ${profile.level} interested in ${profile.areas.join(', ')}, whose goal is "${profile.goal}".

FIRST: Read the WHOLE primary source before making a guide. Inspect the introduction, every section heading, all named definitions, assumptions, propositions, lemmas, theorems, corollaries, conjectures, and the proof architecture. Do not use only the abstract. If full text is unavailable, report partial-text-read or blocked and do not invent missing mathematical statements.

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

THEN: Produce a source-anchored audit that will become the durable context for later questions about individual theorems. Each node must be a distinct clickable document unit. Include the exact printed label and page whenever available. The id is internal only; never copy a TeX \\label slug such as thm101 into the reader-facing label or title. Mark a statement verified only when you saw it in the primary source. Dependencies must reference other internal node ids and point only from a result to prerequisites. Include no made-up formulas, theorem statements, page numbers, or citations.

${proofCaptureInstructions}

${correctnessInstructions}

${depthInstructions}

${versionInstructions}

The proofSketch is a separate short AI explanation of the proof route; it never substitutes for the complete source proof shown to the reader.

Perform a conservative editorial pass during this same initial audit. Put only obvious, source-verifiable typographical corrections in editorialCorrections: malformed notation, a clear misspelling, an inconsistent symbol, or an unmistakable local reference typo. Each correction must name an existing nodeId and either statement or proofText, preserve the exact original fragment, supply the complete corrected field, and explain the evidence. Never use this mechanism for stylistic rewriting, proof completion, strengthening a claim, changing hypotheses, or uncertain mathematics. When doubt remains, make no correction and add a verification warning instead. These corrections become reversible highlighted working-layer edits; the author source remains preserved.

For every explicit \\cite in a node's statement or proof, add a citations entry using the exact bibliography key and optional locator text. During this initial audit—not deferred until a later reader question—resolve every citation that names a specific Theorem, Lemma, Proposition, Corollary, Definition, or numbered result whenever primary-source access makes that possible. Transcribe the complete exact cited statement into citations.statement. Then inspect the cited source's surrounding definitions and notation sections: add one citations.definitions item for every nonstandard symbol, object, map, space, hypothesis abbreviation, or convention needed to understand that statement. Each item contains notation, its precise definition, and a source locator such as “Definition 2.1” or “p. 7”. Do not infer a definition from the current paper when the cited paper defines it differently. A general paper citation has an empty statement and an empty definitions array; the reader will preview its bibliographic title. Never invent an external theorem statement or notation definition. If a specifically located result or necessary definition cannot be verified, leave the unavailable field empty and add a verification warning naming the key and locator.

In every JSON string, wrap complete inline mathematical expressions in $...$ and display expressions in $$...$$. Keep each expression together: for example $\\chi|\\det|^s$ and $L_v(\\chi_v,s+n-(k+1)/2)^{-1}$. Never emit a formula partly as prose and partly as LaTeX.

Cross-paper links are optional but useful. Return one only when this paper explicitly uses, extends, contrasts with, or needs background from a unit listed in the existing local vault. Use the exact paperId and node id supplied above; never guess a link. Otherwise return an empty crossPaperLinks array.

Return JSON only, matching the supplied schema. The source summary must state exactly what was read and any limitations.`;
}

function nodeQuestionPrompt({ paper, node, question }) {
  return `The full-paper audit from the previous turn is the controlling context. The reader selected this audited document unit:
${JSON.stringify(node)}

Paper: ${paper.title} (arXiv:${paper.arxivId})
${paper.folder ? `Local reader folder: proofroom-library/${paper.folder}. Check attachments/references for reader-supplied PDFs, TeX, or BibTeX before treating a cited source as unavailable.` : ''}
Reader question: ${question}

Answer only about this selected unit and its declared dependency chain. Refer to results by their printed names (for example, “Theorem 3.5”), never by internal ids or TeX label slugs. Start with the source anchor and verification status. Preserve uncertainty: if the audit does not establish a claim, say what needs checking in the primary paper. Explain at the reader's configured level; use the complete proofText as the source when expanding a proof. Do not silently replace the paper's theorem by a stronger or simpler statement.

If the reader asks to retrieve or expand a cited result, follow the citation URL or exact-title lookup in the selected unit, locate the named theorem/lemma/proposition in the cited primary paper, and return: (1) the complete cited statement, (2) the complete original proof when accessible, and (3) a clearly separated reader-level explanation. Never invent a missing proof. Say exactly which primary source and result locator you verified.`;
}

function paperQuestionPrompt({ paper, currentNode, question }) {
  const sourceHint = paper.folder ? `The local paper folder is proofroom-library/${paper.folder}; prefer its attachments/source TeX tree over the PDF whenever it is present, and inspect attachments/references for reader-supplied cited sources.` : `Use the primary source already inspected in the full-paper audit.`;
  return `The complete paper and the durable full-paper audit from the first turn are the controlling context for this conversation.

Paper: ${paper.title} (arXiv:${paper.arxivId})
${sourceHint}
${currentNode ? `The reader is currently near this unit, but the question may concern any part of the paper:\n${JSON.stringify(currentNode)}` : ''}

Reader question: ${question}

Answer across the whole paper, not merely the current unit. Use the author text, its definitions, theorem statements, complete proofs, bibliography, and audited logical dependencies as context. Re-open the local TeX source when exact wording or a proof step matters. Distinguish verbatim source content from your explanation, refer to results by printed names rather than internal ids or TeX labels, preserve uncertainty, and render mathematics in LaTeX. If the answer depends on an external cited result, identify the exact source and locator; retrieve its original statement and proof when the reader asks for expansion, and never invent inaccessible material.`;
}

function editorialPrompt({ paper, node }) {
  return `The full-paper audit from the previous turn is controlling context. Inspect the primary source again at this selected unit before suggesting any change.\n\nPaper: ${paper.title} (arXiv:${paper.arxivId})\nSelected unit: ${JSON.stringify(node)}\n\nAct as a source-preserving mathematical editor. Identify only a genuine typo, notation inconsistency, or unambiguous local wording error. Do not rewrite for style, strengthen a claim, fill in a proof, or change a theorem's mathematics. Return JSON only with keys: hasIssue (boolean), replacement (string), rationale (string), confidence ("high"|"medium"|"low"). If no clear error is verifiable from the primary source, use hasIssue:false and an empty replacement.`;
}

function comparisonPrompt({ paper, fromVersion, toVersion, fromSource, toSource, profile, readerContext = null }) {
  const describe = (version, source) => source?.kind === 'tex'
    ? `${version}: local TeX entry ${source.entryFile} (source directory ${source.sourceDirectory})`
    : `${version}: TeX unavailable; inspect https://arxiv.org/pdf/${version} (${source?.error || 'PDF fallback'})`;
  return `You are comparing two primary-source versions of the same mathematical paper for a ${profile.level} reader whose goal is "${profile.goal}".

Paper: ${paper.title}
Version A: ${describe(fromVersion, fromSource)}
Version B: ${describe(toVersion, toSource)}

Read both complete sources before reporting differences. Prefer the local TeX trees. Resolve \\input and \\include files, theorem environments, labels, references, equations, and bibliography changes. Use a structural mathematical comparison, not a raw line-by-line diff.

${readerContext ? `The reader has durable work attached to Version A. Use it only to prioritize the comparison and explicitly mention changed units that could affect these notes, marks, or edits; never reinterpret the reader's text as author text:\n${JSON.stringify(readerContext, null, 2)}` : ''}

Prioritize changes to definitions, assumptions, theorem/lemma/proposition statements, proof steps, counterexamples, hypotheses, conclusions, and logical dependencies. Distinguish a genuine strengthening or weakening from wording, renumbering, or moved text. For each changed unit, provide a compact before/after paraphrase and explain how its prerequisite or downstream dependency chain changes. Every change array must contain actual changes only: when a category is unchanged, return an empty array rather than an item saying "none" or "unchanged". Never infer a mathematical change from formatting alone. Put uncertain cases in warnings.

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
            clientInfo: { name: 'arxivpecker_local_reader', title: 'arXivpecker local reader', version: '0.2.0' },
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
        // Do not leave a provider retry consuming the local subscription after
        // the reader has already reported a timeout. Interruption is best-effort
        // because older app-server builds may finish between these two calls.
        void this.call('turn/interrupt', { threadId: params.threadId, turnId }, 10000).catch(() => {});
        reject(new Error(`Codex analysis exceeded the ${Math.round(CODEX_TURN_TIMEOUT_MS / 60_000)}-minute local wait limit.`));
      }, CODEX_TURN_TIMEOUT_MS);
      this.turns.set(turnId, {
        messages: [],
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  async analyze({ paper, profile, localInventory = [], primarySource = null, correctnessAudit = true, detailedAudit = true, updateContext = null }) {
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
      input: [{ type: 'text', text: auditPrompt({ paper, profile, localInventory, primarySource, correctnessAudit, detailedAudit, updateContext }), text_elements: [] }],
      model,
      effort: profile.reasoning,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
      outputSchema: makeAuditSchema(),
    });
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
      developerInstructions: 'You are a source-faithful mathematical transcription assistant. Do not modify files or invent missing mathematics.',
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
      developerInstructions: 'You are a source-critical mathematical version comparison assistant. Do not modify files. Distinguish mathematical changes from TeX or formatting changes.',
    });
    const threadId = created.thread?.id;
    if (!threadId) throw new Error('Codex did not create a comparison thread.');
    this.loadedThreads.add(threadId);
    const output = await this.runTurn({
      threadId,
      input: [{ type: 'text', text: comparisonPrompt({ paper, fromVersion, toVersion, fromSource, toSource, profile, readerContext }), text_elements: [] }],
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

  async answerPaper({ paper, profile, currentNode, question, threadId }) {
    await this.start();
    if (!this.loadedThreads.has(threadId)) {
      await this.call('thread/resume', { threadId });
      this.loadedThreads.add(threadId);
    }
    return this.runTurn({
      threadId,
      input: [{ type: 'text', text: paperQuestionPrompt({ paper, currentNode, question }), text_elements: [] }],
      model: profile.model || undefined,
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
const threadQueues = new Map();
let vaultMutationQueue = Promise.resolve();

function validatePaper(value) {
  return value && typeof value.title === 'string' && typeof value.arxivId === 'string' && typeof value.abstract === 'string';
}

function normalizeProfile(value) {
  const areas = Array.isArray(value?.areas) ? value.areas.map(String).filter((area) => /^math\.[A-Z]{2}$/.test(area)) : typeof value?.area === 'string' ? [value.area] : ['math.AP'];
  return {
    level: typeof value?.level === 'string' ? value.level : 'Graduate student',
    areas: areas.length ? areas : ['math.AP'],
    goal: typeof value?.goal === 'string' ? value.goal : 'Understand proofs',
    model: typeof value?.model === 'string' ? value.model : '',
    reasoning: typeof value?.reasoning === 'string' && value.reasoning.trim() ? value.reasoning : 'xhigh',
  };
}

function readBody(request, maxChars = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxChars) reject(new Error('Request body is too large.'));
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Request body must be JSON.')); }
    });
    request.on('error', reject);
  });
}

function enqueueThread(threadId, work) {
  const previous = threadQueues.get(threadId) ?? Promise.resolve();
  const scheduled = previous.then(work, work);
  const tail = scheduled.catch(() => {});
  threadQueues.set(threadId, tail);
  void tail.finally(() => { if (threadQueues.get(threadId) === tail) threadQueues.delete(threadId); });
  return scheduled;
}

function enqueueVaultMutation(work) {
  const scheduled = vaultMutationQueue.then(work, work);
  vaultMutationQueue = scheduled.catch(() => {});
  return scheduled;
}

const figureExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.eps', '.ps', '.tif', '.tiff', '.bmp'];

async function collectFigureFiles(directory, root = directory, depth = 0) {
  if (depth > 8) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.proofroom-previews') continue;
    const absolute = path.join(directory, entry.name); const relative = path.relative(root, absolute);
    if (entry.isDirectory()) files.push(...await collectFigureFiles(absolute, root, depth + 1));
    else if (figureExtensions.includes(path.extname(entry.name).toLowerCase())) files.push({ absolute, relative });
  }
  return files;
}

async function figureAsset(paperId, requestedPath) {
  const sourceRoot = await vault.sourceDirectory(paperId);
  const record = await vault.recordFor(paperId); const savedPaper = JSON.parse(await readFile(path.join(vault.paperDirectory(record), 'paper.json'), 'utf8'));
  const paperRoot = vault.paperDirectory(record);
  const configuredSource = typeof savedPaper?.source?.sourceDirectory === 'string' ? path.resolve(paperRoot, savedPaper.source.sourceDirectory) : sourceRoot;
  const configuredRelative = path.relative(sourceRoot, configuredSource); const currentSourceRoot = configuredRelative.startsWith('..') || path.isAbsolute(configuredRelative) ? sourceRoot : configuredSource;
  const requested = String(requestedPath || '').replaceAll('\\', '/').replace(/^\.\//, '').trim();
  if (!requested || requested.includes('\0')) throw new Error('A valid figure path is required.');
  const extension = path.extname(requested).toLowerCase();
  const alternatives = extension ? [requested] : figureExtensions.map((suffix) => `${requested}${suffix}`);
  let candidate = null;
  for (const root of [...new Set([currentSourceRoot, sourceRoot])]) {
    for (const alternative of alternatives) {
      const absolute = path.resolve(root, alternative); const relative = path.relative(root, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      try { if ((await stat(absolute)).isFile()) { candidate = absolute; break; } } catch { /* Search by suffix below. */ }
    }
    if (candidate) break;
  }
  if (!candidate) {
    const files = [...await collectFigureFiles(currentSourceRoot), ...(currentSourceRoot === sourceRoot ? [] : await collectFigureFiles(sourceRoot))]; const normalized = requested.toLowerCase(); const basename = path.basename(normalized);
    const found = files.find((file) => alternatives.some((alternative) => file.relative.toLowerCase().endsWith(alternative.toLowerCase()))) || files.find((file) => path.basename(file.relative, path.extname(file.relative)).toLowerCase() === path.basename(basename, path.extname(basename)));
    candidate = found?.absolute || null;
  }
  if (!candidate) throw new Error('The referenced figure asset is not present in this paper source.');
  const sourceExtension = path.extname(candidate).toLowerCase();
  if (['.pdf', '.eps', '.ps', '.tif', '.tiff', '.bmp'].includes(sourceExtension)) {
    const previewDirectory = path.join(sourceRoot, '.proofroom-previews'); await mkdir(previewDirectory, { recursive: true });
    const token = Buffer.from(path.relative(sourceRoot, candidate)).toString('base64url').slice(0, 72); const preview = path.join(previewDirectory, `${token}.png`);
    try { await stat(preview); }
    catch {
      if (sourceExtension === '.pdf') await runProgram('pdftoppm', ['-png', '-singlefile', '-r', '180', candidate, preview.slice(0, -4)]);
      else if (sourceExtension === '.eps' || sourceExtension === '.ps') await runProgram('gs', ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pngalpha', '-r180', `-sOutputFile=${preview}`, candidate]);
      else await runProgram('sips', ['-s', 'format', 'png', candidate, '--out', preview]);
    }
    candidate = preview;
  }
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[path.extname(candidate).toLowerCase()] || 'application/octet-stream';
  return { payload: await readFile(candidate), mime };
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
    if (request.method === 'GET' && pathname === '/asset') {
      const url = new URL(request.url || '/', `http://${HOST}:${PORT}`); const paperId = url.searchParams.get('paperId') || ''; const file = url.searchParams.get('file') || '';
      const asset = await figureAsset(paperId, file);
      response.writeHead(200, { 'Content-Type': asset.mime, 'Cache-Control': 'private, max-age=3600', ...(origin && isAllowedOrigin(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}) });
      return response.end(asset.payload);
    }
    if (request.method === 'GET' && pathname === '/vault') return sendJson(response, 200, await vault.snapshot(), origin);
    if (request.method === 'GET' && pathname === '/cloud/status') return sendJson(response, 200, await cloudStatus(vault), origin);
    if (request.method === 'GET' && pathname === '/vault/graph') {
      const snapshot = await vault.snapshot();
      return sendJson(response, 200, { graph: snapshot.graph, links: snapshot.links, vault: snapshot.vault }, origin);
    }
    if (request.method === 'GET' && pathname === '/status') {
      try { await codex.start(); } catch { /* status returns useful error below */ }
      return sendJson(response, 200, codex.status(), origin);
    }
    if (request.method !== 'POST' || !['/analyze', '/compare-versions', '/paper-question', '/node-question', '/node-edit/suggest', '/vault/paper', '/vault/paper/update', '/vault/paper/update-commit', '/vault/paper/delete', '/vault/paper/order', '/vault/audit', '/vault/reader', '/vault/patches', '/vault/profile', '/vault/link', '/vault/link/delete', '/vault/export', '/vault/latex-export', '/vault/citation-asset', '/vault/source-upload', '/cloud/share'].includes(pathname)) {
      return sendJson(response, 404, { error: 'Not found.' }, origin);
    }
    const body = await readBody(request, ['/vault/source-upload', '/vault/citation-asset'].includes(pathname) ? 112_000_000 : ['/vault/latex-export', '/vault/paper/update-commit'].includes(pathname) ? 24_000_000 : 1_000_000);
    if (pathname === '/cloud/share') return sendJson(response, 200, { share: await createCloudShare(vault, body) }, origin);
    if (pathname === '/vault/profile') return sendJson(response, 200, { profile: await vault.saveProfile(normalizeProfile(body.profile)) }, origin);
    if (pathname === '/vault/link') return sendJson(response, 200, await enqueueVaultMutation(async () => ({ link: await vault.addLink(body.link), graph: await vault.rebuildGraph() })), origin);
    if (pathname === '/vault/link/delete') return sendJson(response, 200, await enqueueVaultMutation(async () => { await vault.removeLink(String(body.linkId || '')); return { graph: await vault.rebuildGraph() }; }), origin);
    if (pathname === '/vault/paper/delete') {
      if (!body.paperId) return sendJson(response, 400, { error: 'paperId is required.' }, origin);
      const removed = await enqueueVaultMutation(async () => { const record = await vault.removePaper(String(body.paperId)); return { removed: record, snapshot: await vault.snapshot() }; });
      return sendJson(response, 200, removed, origin);
    }
    if (pathname === '/vault/paper/order') return sendJson(response, 200, { order: await enqueueVaultMutation(() => vault.reorderPapers(body.paperIds)) }, origin);
    if (pathname === '/vault/reader') {
      if (!body.paperId) return sendJson(response, 400, { error: 'paperId is required.' }, origin);
      return sendJson(response, 200, { reader: await vault.saveReader(String(body.paperId), body.reader ?? {}) }, origin);
    }
    if (pathname === '/vault/patches') {
      if (!body.paperId) return sendJson(response, 400, { error: 'paperId is required.' }, origin);
      const saved = await enqueueVaultMutation(async () => { const patches = await vault.savePatches(String(body.paperId), body.patches ?? []); const snapshot = await vault.snapshot(); return { patches, graph: snapshot.graph }; });
      return sendJson(response, 200, saved, origin);
    }
    if (pathname === '/vault/export') {
      if (!body.paperId) return sendJson(response, 400, { error: 'paperId is required.' }, origin);
      return sendJson(response, 200, { saved: await vault.saveExport(String(body.paperId), body.export ?? {}) }, origin);
    }
    if (pathname === '/vault/latex-export') {
      if (!body.paperId) return sendJson(response, 400, { error: 'paperId is required.' }, origin);
      return sendJson(response, 200, { saved: await saveCompleteLatexExport(String(body.paperId), body.export ?? {}) }, origin);
    }
    if (pathname === '/vault/citation-asset') {
      if (!body.paperId) return sendJson(response, 400, { error: 'paperId is required.' }, origin);
      return sendJson(response, 200, { saved: await vault.saveCitationAsset(String(body.paperId), body.upload ?? {}) }, origin);
    }
    if (pathname === '/vault/source-upload') {
      if (!validatePaper(body.paper)) return sendJson(response, 400, { error: 'A paper title and local source record are required.' }, origin);
      return sendJson(response, 200, await enqueueVaultMutation(() => saveUploadedPaperSource(body.paper, body.upload ?? {})), origin);
    }
    if (!validatePaper(body.paper)) return sendJson(response, 400, { error: 'A paper with title, arXiv id, and abstract is required.' }, origin);
    if (pathname === '/vault/paper/update-commit') return sendJson(response, 200, await enqueueVaultMutation(() => vault.commitPaperUpdate(body)), origin);
    if (pathname === '/vault/paper' || pathname === '/vault/paper/update') return sendJson(response, 200, { paper: await enqueueVaultMutation(() => vault.upsertPaper(body.paper)) }, origin);
    if (pathname === '/vault/audit') {
      if (!body.audit || !Array.isArray(body.audit.nodes)) return sendJson(response, 400, { error: 'A structured audit is required.' }, origin);
      const saved = await enqueueVaultMutation(async () => { const paper = await vault.saveAudit(body.paper, body.audit); const snapshot = await vault.snapshot(); return { paper, graph: snapshot.graph, links: snapshot.links }; });
      return sendJson(response, 200, saved, origin);
    }
    const profile = normalizeProfile(body.profile);
    const runAiWork = async () => {
      if (pathname === '/compare-versions') {
        const paper = { ...body.paper, id: String(body.paper.id) }; await vault.recordFor(paper.id);
        const fromVersion = normalizeArxivVersion(body.fromVersion);
        const toVersion = normalizeArxivVersion(body.toVersion);
        if (!fromVersion || !toVersion) throw new Error('Two valid arXiv versions are required.');
        if (fromVersion.replace(/v\d+$/i, '') !== toVersion.replace(/v\d+$/i, '')) throw new Error('Version comparison requires two versions of the same arXiv paper.');
        const load = async (version) => { try { return await acquireArxivSource(paper, version, true); } catch (error) { return { kind: 'pdf', error: error instanceof Error ? error.message : 'TeX source unavailable' }; } };
        const [fromSource, toSource] = await Promise.all([load(fromVersion), load(toVersion)]);
        const compared = await codex.compareVersions({ paper, profile, fromVersion, toVersion, fromSource, toSource, readerContext: body.readerContext ?? null });
        return { ...compared, fromVersion, toVersion, sources: { from: fromSource.kind, to: toSource.kind } };
      }
      if (pathname === '/analyze') {
        const paper = { ...body.paper, id: String(body.paper.id) }; await vault.recordFor(paper.id);
        const localInventory = await vault.compactInventory();
        let primarySource;
        try {
          primarySource = await acquireArxivSource(paper, paper.arxivId, Boolean(body.updateMode));
          if (!body.updateMode) await vault.saveSourceRecord(paper.id, { analysisFormat: 'tex', sourceDirectory: primarySource.sourceDirectory, mainTex: primarySource.entryFile, sourceFetchedAt: primarySource.fetchedAt });
          if (primarySource.kind === 'uploaded-pdf' && body.convertPdfToLatex) {
            const converted = await codex.convertPdfToLatex({ paper, profile, pdfPath: primarySource.entryFile });
            primarySource = await saveAiLatexSource(paper, converted);
            const sourceRoot = await vault.sourceDirectory(paper.id);
            await writeSourceManifest(path.join(sourceRoot, 'proofroom-uploaded-source.json'), primarySource);
            await vault.saveSourceRecord(paper.id, { analysisFormat: 'ai-tex', sourceDirectory: primarySource.sourceDirectory, mainTex: primarySource.entryFile, sourceFetchedAt: primarySource.convertedAt, sourceError: 'Reader-supplied PDF converted to an editable LaTeX working source.' });
          }
        } catch (error) {
          primarySource = { kind: 'pdf', error: error instanceof Error ? error.message : 'TeX source unavailable' };
          if (body.convertPdfToLatex) {
            const converted = await codex.convertPdfToLatex({ paper, profile });
            primarySource = await saveAiLatexSource(paper, converted);
            await vault.saveSourceRecord(paper.id, { analysisFormat: 'ai-tex', sourceDirectory: primarySource.sourceDirectory, mainTex: primarySource.entryFile, sourceFetchedAt: primarySource.convertedAt, sourceError: 'Author TeX unavailable; saved AI transcription from the primary PDF.' });
          } else if (!body.updateMode) await vault.saveSourceRecord(paper.id, { analysisFormat: 'pdf', sourceError: primarySource.error });
        }
        const analyzed = await codex.analyze({ paper, profile, primarySource, correctnessAudit: body.correctnessAudit !== false, detailedAudit: body.detailedAudit !== false, localInventory: localInventory.filter((item) => item.paperId !== paper.id), updateContext: body.updateContext ?? null });
        const text = primarySource.kind === 'tex' || primarySource.kind === 'ai-tex' ? await enrichAuditFromTex(analyzed.text, primarySource) : analyzed.text;
        return { ...analyzed, text, paper, primarySource: { kind: primarySource.kind, fileCount: primarySource.fileCount ?? 0, cached: Boolean(primarySource.cached), error: primarySource.error ?? null }, ...(body.updateMode ? { sourceRecord: { analysisFormat: primarySource.kind === 'tex' ? 'tex' : primarySource.kind, sourceDirectory: primarySource.sourceDirectory ?? '', mainTex: primarySource.entryFile ?? '', sourceFetchedAt: primarySource.fetchedAt ?? primarySource.convertedAt ?? new Date().toISOString(), sourceError: primarySource.error ?? '' } } : {}) };
      }
      if (pathname === '/paper-question') {
        if (!body.threadId || typeof body.question !== 'string') throw new Error('threadId and a question are required.');
        return codex.answerPaper({ paper: body.paper, profile, currentNode: body.node, question: body.question, threadId: body.threadId });
      }
      if (!body.threadId || !body.node) throw new Error('threadId and node are required.');
      if (pathname === '/node-edit/suggest') return codex.suggestEditorialPatch({ paper: body.paper, profile, node: body.node, threadId: body.threadId });
      if (typeof body.question !== 'string') throw new Error('A question is required.');
      return codex.answerNode({ paper: body.paper, profile, node: body.node, question: body.question, threadId: body.threadId });
    };
    // Independent audits and version comparisons each create their own Codex
    // thread and may run concurrently. Continuations on one existing paper
    // thread stay ordered so two questions cannot corrupt that thread's context.
    const continuingThread = ['/paper-question', '/node-question', '/node-edit/suggest'].includes(pathname);
    const output = continuingThread ? await enqueueThread(String(body.threadId || ''), runAiWork) : await runAiWork();
    return sendJson(response, 200, output, origin);
  } catch (error) {
    return sendJson(response, 500, { error: error instanceof Error ? error.message : 'Local Codex bridge failed.' }, origin);
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

export { enrichAuditFromTex, expandAuthorMacros, extractBibliography, extractBibliographyTree, extractLatexDocument, extractSourceUnits, readExpandedTex };
