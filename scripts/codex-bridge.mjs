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

function latexConversionPrompt({ paper }) {
  return `Convert the complete primary PDF at https://arxiv.org/pdf/${paper.arxivId} into a faithful standalone LaTeX document.

This is a transcription task, not a rewrite. Read every page. Preserve the title, authors, abstract, section hierarchy, theorem/definition/lemma/proposition environments, equation structure, labels, references, proofs, footnotes, bibliography, and mathematical notation. Do not improve, complete, or silently correct the mathematics. Mark illegible fragments explicitly with \\text{[unreadable in source]}. Add a short LaTeX comment before each page transition in the form "% PDF page N" when you can identify it.

Return only one complete compilable LaTeX document, beginning with \\documentclass and ending with \\end{document}. Do not use Markdown fences or add commentary outside the document.`;
}

function extractLatexDocument(text) {
  const clean = String(text || '').trim().replace(/^```(?:latex|tex)?\s*/i, '').replace(/\s*```$/i, '');
  const start = clean.indexOf('\\documentclass');
  const endMarker = '\\end{document}';
  const end = clean.lastIndexOf(endMarker);
  if (start < 0 || end < start) throw new Error('Codex did not return a complete LaTeX document.');
  const document = clean.slice(start, end + endMarker.length).trim();
  if (Buffer.byteLength(document, 'utf8') > 12 * 1024 * 1024) throw new Error('The AI-converted LaTeX document exceeds the local safety limit.');
  return `${document}\n`;
}

async function saveAiLatexSource(paper, converted) {
  const sourceRoot = await vault.sourceDirectory(paper.id);
  const sourceDirectory = path.join(sourceRoot, 'ai-converted');
  await mkdir(sourceDirectory, { recursive: true });
  const entryFile = path.join(sourceDirectory, 'main.tex');
  const manifestFile = path.join(sourceDirectory, 'proofroom-ai-source.json');
  const latex = extractLatexDocument(converted.text);
  await writeFile(entryFile, latex, 'utf8');
  const manifest = { kind: 'ai-tex', arxivId: paper.arxivId, entryFile, sourceDirectory, fileCount: 1, convertedAt: new Date().toISOString(), conversionThreadId: converted.threadId, cached: false };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
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
    catch { expanded += `\n% Proofroom could not resolve ${requested}\n`; }
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
  const command = /\\(footnote|emph|textbf|textit|textrm)\s*\{/g;
  for (let pass = 0; pass < 4; pass += 1) {
    let output = ''; let cursor = 0; let changed = false;
    for (const match of text.matchAll(command)) {
      if ((match.index ?? 0) < cursor) continue;
      const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
      if (!group) continue;
      const replacement = match[1] === 'footnote' ? ` (Note: ${group.content})` : group.content;
      output += text.slice(cursor, match.index ?? 0) + replacement;
      cursor = group.end; changed = true;
    }
    if (!changed) break;
    text = output + text.slice(cursor);
  }
  return text;
}

function readableLatex(source) {
  return unwrapLatexTextCommands(normalizeMathTextCommands(String(source || '')))
    .replace(/(^|[^\\])%[^\n]*/g, '$1')
    .replace(/\\label\s*\{[^}]*\}/g, '')
    .replace(/\\(?:eqref|ref|autoref|cref|Cref)\s*\{[^}]*\}/g, 'the referenced result')
    .replace(/\\cite\w*\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g, (_match, locator, keys) => String(keys).split(',').map((key) => `[[cite:${key.trim()}${locator ? `|${locator.trim()}` : ''}]]`).join(' '))
    .replace(/\\begin\{tikzcd\}(?:\[[^\]]*\])?/g, '\\begin{array}{cccccccccccc}')
    .replace(/\\end\{tikzcd\}/g, '\\end{array}')
    .replace(/\\ar(?:\[[^\]]*\])?\s*\{[^}]*\}/g, '')
    .replace(/\\footnotemark\b/g, '')
    .replace(/\\hfil\b/g, '')
    .replace(/\\'\{?e\}?/g, 'é')
    .replace(/\\'\{?E\}?/g, 'É')
    .replace(/\\begin\{(?:equation|equation\*)\}/g, () => '$$')
    .replace(/\\end\{(?:equation|equation\*)\}/g, () => '$$')
    // `aligned` is an inner math environment and is commonly already wrapped
    // in \[...\]. Converting it to another pair of delimiters creates invalid
    // nested math such as \[$$...$$\]. Only promote top-level environments.
    .replace(/\\begin\{(?:align|align\*|gather|gather\*|multline|multline\*)\}/g, () => '$$\\begin{aligned}')
    .replace(/\\end\{(?:align|align\*|gather|gather\*|multline|multline\*)\}/g, () => '\\end{aligned}$$')
    .replace(/\\begin\{(?:enumerate|itemize|description)\}(?:\[[^\]]*\])?/g, '')
    .replace(/\\end\{(?:enumerate|itemize|description)\}/g, '')
    .replace(/\\item(?:\[[^\]]*\])?/g, '\n• ')
    .replace(/\\(?:emph|textbf|textit|textrm)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:medskip|smallskip|bigskip|noindent|par)\b/g, '\n')
    .replace(/~+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    const arity = Math.max(0, ...[...String(match[2] || '').matchAll(/#(\d)/g)].map((item) => Number(item[1])));
    if (group) macros.set(match[1], { replacement: group.content, arity });
  }
  for (const match of text.matchAll(/\\DeclareMathOperator\*?\s*\{\\([A-Za-z@]+)\}\s*\{/g)) {
    const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    if (group) macros.set(match[1], { replacement: `\\operatorname{${group.content}}`, arity: 0 });
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
  const value = `${title} ${environment}`.toLowerCase();
  if (value.includes('theorem') || /(^|-)thm/.test(value)) return 'theorem';
  if (value.includes('lemma') || /(^|-)lem/.test(value)) return 'lemma';
  if (value.includes('proposition') || /(^|-)prop/.test(value)) return 'proposition';
  if (value.includes('corollary') || /(^|-)cor/.test(value)) return 'corollary';
  if (value.includes('definition') || /(^|-)def/.test(value)) return 'definition';
  if (value.includes('remark') || /(^|-)rem/.test(value)) return 'remark';
  if (value.includes('example') || /(^|-)ex/.test(value)) return 'example';
  return null;
}

function extractSourceUnits(source) {
  const originalSource = String(source || '');
  const normalizedSource = expandAuthorMacros(originalSource);
  const environments = new Map([
    ['theorem', 'theorem'], ['thm', 'theorem'], ['lemma', 'lemma'], ['lem', 'lemma'],
    ['proposition', 'proposition'], ['prop', 'proposition'], ['corollary', 'corollary'], ['cor', 'corollary'],
    ['definition', 'definition'], ['defn', 'definition'], ['remark', 'remark'], ['rem', 'remark'], ['example', 'example'],
  ]);
  const declarations = /\\newtheorem\*?\s*\{([^}]+)\}(?:\[[^\]]+\])?\s*\{([^}]+)\}(?:\[[^\]]+\])?/g;
  for (const match of originalSource.matchAll(declarations)) {
    const kind = theoremKind(match[2], match[1]);
    if (kind) environments.set(match[1], kind);
  }
  const names = [...environments.keys()].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!names) return [];
  const unitPattern = new RegExp(`\\\\begin\\{(${names})\\}(?:\\[([^\\]]*)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`, 'g');
  const embeddedProofPattern = /\\begin\{proof\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{proof\}/g;
  const units = [];
  for (const match of normalizedSource.matchAll(unitPattern)) {
    const start = match.index ?? 0; const end = start + match[0].length;
    const label = /\\label\s*\{([^}]+)\}/.exec(match[3])?.[1] || '';
    const embeddedProofs = [...match[3].matchAll(embeddedProofPattern)];
    const statementSource = match[3].replace(embeddedProofPattern, '');
    units.push({ environment: match[1], kind: environments.get(match[1]), title: match[2] || '', texLabel: label, start, end, statement: readableLatex(statementSource), proofText: embeddedProofs.map((proof) => readableLatex(proof[1])).filter(Boolean).join('\n\n'), citationMentions: citationMentions(`${match[2] || ''} ${match[3]}`), citationKeys: citationKeys(`${match[2] || ''} ${match[3]}`) });
  }
  const byLabel = new Map(units.filter((unit) => unit.texLabel).map((unit) => [unit.texLabel, unit]));
  const proofPattern = /\\begin\{proof\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{proof\}/g;
  for (const proof of normalizedSource.matchAll(proofPattern)) {
    const proofStart = proof.index ?? 0;
    if (units.some((unit) => unit.start < proofStart && proofStart < unit.end)) continue;
    const nearest = units.filter((unit) => unit.end <= proofStart).at(-1) || null;
    const prelude = normalizedSource.slice(Math.max(nearest?.end ?? 0, proofStart - 2200), proofStart);
    const explicitMatch = [...prelude.matchAll(/(?:proof\s+of|prove|complet(?:e|es|ed)\s+the\s+proof\s+of)[\s\S]{0,180}?(?:\\ref\s*\{([^}]+)\}|\\hyperref\s*\[([^\]]+)\])/gi)].at(-1);
    const explicit = explicitMatch?.[1] || explicitMatch?.[2];
    let target = explicit ? byLabel.get(explicit) : null;
    if (!target && nearest && !nearest.proofText) target = nearest;
    if (target && !target.proofText) target.proofText = readableLatex(proof[1]);
  }
  return units;
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
  const bibliography = extractBibliography(expanded);
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
    // The TeX tree is authoritative here. Clearing an absent proof matters when
    // re-enriching an older audit: otherwise a stale, positionally misassigned
    // proof can survive forever on an externally quoted result.
    node.proofText = sourceUnit.proofText || '';
    node.citations = sourceUnit.citationMentions.map(({ key, locator }) => {
      const reference = bibliography.get(key) || { key, title: key, authors: '', text: `Bibliography entry ${key} was cited here but could not be extracted from the available TeX tree.`, url: `https://scholar.google.com/scholar?q=${encodeURIComponent(key)}`, searchUrl: `https://scholar.google.com/scholar?q=${encodeURIComponent(key)}`, doi: '', arxivId: '', direct: false };
      const aiDetail = aiCitations.find((citation) => citation && citation.key === key && String(citation.locator || '') === locator) || aiCitations.find((citation) => citation && citation.key === key);
      return { ...reference, locator, statement: typeof aiDetail?.statement === 'string' ? aiDetail.statement : '' };
    });
  }
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
      kind: { enum: ['definition', 'assumption', 'notation', 'lemma', 'proposition', 'theorem', 'corollary', 'proof', 'equation', 'remark', 'example', 'section', 'external-result'] },
      label: { type: 'string' },
      title: { type: 'string' },
      statement: { type: 'string' },
      proofText: { type: 'string' },
      citations: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['key', 'locator', 'statement'],
          properties: { key: { type: 'string' }, locator: { type: 'string' }, statement: { type: 'string' } },
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
    : primarySource?.kind === 'ai-tex'
      ? `The arXiv source bundle had no usable TeX. At the reader's request, local AI transcribed the complete PDF into an editable LaTeX working source.
- AI-generated LaTeX entry: ${primarySource.entryFile}
- source directory: ${primarySource.sourceDirectory}

Read that local LaTeX document first, but treat the original PDF at https://arxiv.org/pdf/${paper.arxivId} as authoritative. Verify statements against the PDF whenever the conversion may be ambiguous. State clearly in sourceSummary that the LaTeX is an AI transcription, not author-supplied source.`
      : `The arXiv TeX source could not be used (${primarySource?.error || 'unavailable'}). Fall back to the primary PDF at https://arxiv.org/pdf/${paper.arxivId}.`;
  const proofCaptureInstructions = primarySource?.kind === 'tex' || primarySource?.kind === 'ai-tex'
    ? `The host application deterministically attaches complete theorem statements and proof environments from the local LaTeX tree after your turn. Set proofText to an empty string for every node; spend the response budget on accurate dependency analysis and proofSketch explanations. Do not warn about proof payload length.`
    : `For every theorem, lemma, proposition, corollary, and proof node, statement must be a source-faithful transcription of the complete printed statement, not a summary, and proofText must contain the complete proof from the PDF, including all equations, cases, and cited intermediate results. Do not shorten a proof. Use an empty proofText only when the source genuinely has no proof or the complete proof cannot be accessed, and explain that limitation in the verification warnings.`;
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

THEN: Produce a source-anchored audit that will become the durable context for later questions about individual theorems. Each node must be a distinct clickable document unit. Include the exact printed label and page whenever available. The id is internal only; never copy a TeX \\label slug such as thm101 into the reader-facing label or title. Mark a statement verified only when you saw it in the primary source. Dependencies must reference other internal node ids and point only from a result to prerequisites. Include no made-up formulas, theorem statements, page numbers, or citations.

${proofCaptureInstructions}

The proofSketch is a separate short AI explanation of the proof route; it never substitutes for the complete source proof shown to the reader.

For every explicit \\cite in a node's statement or proof, add a citations entry using the exact bibliography key and optional locator text. If the locator names a specific Theorem, Lemma, Proposition, Corollary, Definition, or numbered result, use primary-source access to verify and transcribe that cited result's complete statement into citations.statement. A general paper citation has an empty statement; the reader will preview its bibliographic title. Never invent an external theorem statement. If a specifically located result cannot be verified, leave statement empty and add a verification warning naming the key and locator.

In every JSON string, wrap complete inline mathematical expressions in $...$ and display expressions in $$...$$. Keep each expression together: for example $\\chi|\\det|^s$ and $L_v(\\chi_v,s+n-(k+1)/2)^{-1}$. Never emit a formula partly as prose and partly as LaTeX.

Cross-paper links are optional but useful. Return one only when this paper explicitly uses, extends, contrasts with, or needs background from a unit listed in the existing local vault. Use the exact paperId and node id supplied above; never guess a link. Otherwise return an empty crossPaperLinks array.

Return JSON only, matching the supplied schema. The source summary must state exactly what was read and any limitations.`;
}

function nodeQuestionPrompt({ paper, node, question }) {
  return `The full-paper audit from the previous turn is the controlling context. The reader selected this audited document unit:
${JSON.stringify(node)}

Paper: ${paper.title} (arXiv:${paper.arxivId})
Reader question: ${question}

Answer only about this selected unit and its declared dependency chain. Refer to results by their printed names (for example, “Theorem 3.5”), never by internal ids or TeX label slugs. Start with the source anchor and verification status. Preserve uncertainty: if the audit does not establish a claim, say what needs checking in the primary paper. Explain at the reader's configured level; use the complete proofText as the source when expanding a proof. Do not silently replace the paper's theorem by a stronger or simpler statement.`;
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
        // Do not leave a provider retry consuming the local subscription after
        // the reader has already reported a timeout. Interruption is best-effort
        // because older app-server builds may finish between these two calls.
        void this.call('turn/interrupt', { threadId: params.threadId, turnId }, 10000).catch(() => {});
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

  async convertPdfToLatex({ paper, profile }) {
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
      input: [{ type: 'text', text: latexConversionPrompt({ paper }), text_elements: [] }],
      model,
      effort: profile.reasoning,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
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
          if (body.convertPdfToLatex) {
            const converted = await codex.convertPdfToLatex({ paper, profile });
            primarySource = await saveAiLatexSource(paper, converted);
            await vault.saveSourceRecord(paper.id, { analysisFormat: 'ai-tex', sourceDirectory: primarySource.sourceDirectory, mainTex: primarySource.entryFile, sourceFetchedAt: primarySource.convertedAt, sourceError: 'Author TeX unavailable; saved AI transcription from the primary PDF.' });
          } else await vault.saveSourceRecord(paper.id, { analysisFormat: 'pdf', sourceError: primarySource.error });
        }
        const analyzed = await codex.analyze({ paper, profile, primarySource, localInventory: localInventory.filter((item) => item.paperId !== paper.id) });
        const text = primarySource.kind === 'tex' || primarySource.kind === 'ai-tex' ? await enrichAuditFromTex(analyzed.text, primarySource) : analyzed.text;
        return { ...analyzed, text, paper, primarySource: { kind: primarySource.kind, fileCount: primarySource.fileCount ?? 0, cached: Boolean(primarySource.cached), error: primarySource.error ?? null } };
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

export { enrichAuditFromTex, expandAuthorMacros, extractBibliography, extractSourceUnits, readExpandedTex };
