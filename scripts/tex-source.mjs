import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { relativePathEscapes } from './paper-vault.mjs';

// Reads a paper's TeX tree and recovers its structure: expands \input files,
// author macros, and cross-references, then splits the source into theorem-like
// units and the reader's prose, proof, figure, table, and bibliography blocks.

function decodeSourceBuffer(payload) {
  const utf8 = Buffer.from(payload).toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  const legacy = new TextDecoder('windows-1252').decode(payload);
  const errors = (value) => (value.match(/\uFFFD/g) || []).length;
  return errors(legacy) < errors(utf8) ? legacy : utf8;
}
async function readExpandedTex(entryFile, sourceRoot, seen = new Set(), depth = 0) {
  if (depth > 12 || seen.has(entryFile)) return '';
  const relative = path.relative(sourceRoot, entryFile);
  if (relativePathEscapes(relative)) return '';
  // Compare resolved paths too, so a symbolic link cannot lead outside the source.
  if (relativePathEscapes(path.relative(await realpath(sourceRoot), await realpath(entryFile)))) return '';
  seen.add(entryFile);
  let source = decodeSourceBuffer(await readFile(entryFile));
  const include = /\\(?:input|include)\s*\{([^}]+)\}/g;
  const literalRanges = literalSourceRanges(source);
  let expanded = ''; let cursor = 0;
  for (const match of source.matchAll(include)) {
    const start = match.index ?? 0;
    if (insideSourceRanges(start, literalRanges) || isLatexCommentedAt(source, start)) continue;
    expanded += source.slice(cursor, match.index);
    const requested = match[1].trim();
    const candidate = path.resolve(path.dirname(entryFile), /\.[A-Za-z0-9]+$/.test(requested) ? requested : `${requested}.tex`);
    try { expanded += await readExpandedTex(candidate, sourceRoot, seen, depth + 1); }
    catch { expanded += `\n% arXivpecker could not resolve ${requested}\n`; }
    cursor = start + match[0].length;
  }
  expanded += source.slice(cursor);
  return expanded;
}

async function sameExpandedTexSource(left, right) {
  const readableKind = (source) => ['tex', 'ai-tex'].includes(source?.kind) && source?.entryFile && source?.sourceDirectory;
  if (!readableKind(left) || !readableKind(right)) return false;
  try {
    const [leftText, rightText] = await Promise.all([
      readExpandedTex(left.entryFile, left.sourceDirectory),
      readExpandedTex(right.entryFile, right.sourceDirectory),
    ]);
    return leftText.replace(/\r\n?/g, '\n') === rightText.replace(/\r\n?/g, '\n');
  } catch { return false; }
}

function stripLegacyFontMarkup(source) {
  let text = String(source || '');
  const groupStart = /\{\\(?:bf|it|rm|tt|sf|sl|sc)\b\s*/g;
  for (let pass = 0; pass < 4; pass += 1) {
    let output = ''; let cursor = 0; let changed = false;
    for (const match of text.matchAll(groupStart)) {
      if ((match.index ?? 0) < cursor) continue;
      const group = balancedGroup(text, match.index ?? 0);
      if (!group) continue;
      const content = group.content.replace(/^\s*\\(?:bf|it|rm|tt|sf|sl|sc)\b\s*/, '');
      output += text.slice(cursor, match.index ?? 0) + content;
      cursor = group.end; changed = true;
    }
    if (!changed) break;
    text = output + text.slice(cursor);
  }
  return text.replace(/\\(?:bf|it|rm|tt|sf|sl|sc)\b\s*/g, '');
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
      let content = stripLegacyFontMarkup(group.content.trim()).replace(/^\{\\(?:normalfont|rm)\s*/, '').replace(/\}\s*$/, '').replace(/\\(?:normalfont|rm)\b\s*/g, '');
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
  const command = /\\(texorpdfstring|foreignlanguage|href|textcolor)\s*\{/g;
  for (let pass = 0; pass < 3; pass += 1) {
    let output = ''; let cursor = 0; let changed = false;
    for (const match of text.matchAll(command)) {
      if ((match.index ?? 0) < cursor) continue;
      const first = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
      if (!first) continue;
      let secondStart = first.end; while (/\s/.test(text[secondStart] || '')) secondStart += 1;
      const second = balancedGroup(text, secondStart);
      if (!second) continue;
      const decorativeRule = /^\\rule(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*\{[^{}]*\}\s*$/.test(second.content.trim());
      const replacement = match[1] === 'textcolor' && decorativeRule ? '' : match[1] === 'foreignlanguage' || match[1] === 'href' || match[1] === 'textcolor' ? second.content : first.content;
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

function stripLatexComments(source) {
  const value = String(source || ''); let output = '';
  // Percent signs are data inside literal source environments. Preserve them
  // while still treating the dedicated `comment` environment as invisible.
  const literalRanges = literalSourceRanges(value).filter(([start]) => !/^\\begin\{comment\}/.test(value.slice(start)));
  for (let index = 0; index < value.length; index += 1) {
    if (insideSourceRanges(index, literalRanges)) { output += value[index]; continue; }
    if (value[index] !== '%') { output += value[index]; continue; }
    let slashes = 0;
    for (let previous = index - 1; previous >= 0 && value[previous] === '\\'; previous -= 1) slashes += 1;
    if (slashes % 2 === 1) { output += value[index]; continue; }
    while (index + 1 < value.length && value[index + 1] !== '\n' && value[index + 1] !== '\r') index += 1;
  }
  return output;
}

function isLatexCommentedAt(source, index) {
  const value = String(source || '');
  for (let cursor = index - 1; cursor >= 0 && value[cursor] !== '\n' && value[cursor] !== '\r'; cursor -= 1) {
    if (value[cursor] !== '%') continue;
    let slashes = 0;
    for (let previous = cursor - 1; previous >= 0 && value[previous] === '\\'; previous -= 1) slashes += 1;
    return slashes % 2 === 0;
  }
  return false;
}

function readableLatex(source) {
  const withoutCommentEnvironments = String(source || '').replace(/\\begin\{comment\}[\s\S]*?\\end\{comment\}/g, '');
  const prepared = stripDocumentDeclarations(stripLatexComments(normalizeXyMatrices(normalizePrescriptCommands(withoutCommentEnvironments))));
  const readable = unwrapLatexTwoArgumentCommands(unwrapLatexTextCommands(normalizeMathTextCommands(prepared)))
    .replace(/\\selectlanguage\s*\{[^}]*\}/g, '')
    .replace(/\\begin\{(?:otherlanguage\*?|thebibliography)\}(?:\{[^}]*\})?/g, '')
    .replace(/\\end\{(?:otherlanguage\*?|thebibliography)\}/g, '')
    .replace(/\\(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b/g, '')
    .replace(/\\label\s*\{[^}]*\}/g, '')
    .replace(/\\(?:eqref|ref|autoref|cref|Cref)\s*\{[^}]*\}/g, 'the referenced result')
    .replace(/\\cite\w*\s*(?:\[([^\]]*)\])?\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g, (_match, preNote, postNote, keys) => { const locator = [preNote, postNote].map((item) => String(item || '').trim()).filter(Boolean).join('; '); return String(keys).split(',').map((key) => `[[cite:${key.trim()}${locator ? `|${locator}` : ''}]]`).join(' '); })
    .replace(/\\begin\{tikzcd\}(?:\[[^\]]*\])?/g, '\\begin{array}{cccccccccccc}')
    .replace(/\\end\{tikzcd\}/g, '\\end{array}')
    .replace(/\\ar(?:\[[^\]]*\])?(?:\s*\{[^}]*\})?/g, '')
    .replace(/\\footnotemark\b/g, '')
    .replace(/\\includegraphics(?:\[[^\]]*\])?\s*\{[^}]+\}/g, '')
    .replace(/\\(?:url|nolinkurl|path)\s*\{([^}]*)\}/g, '$1')
    // Horizontal fill is page-layout glue. It has no readable equivalent and
    // KaTeX does not support it consistently, so never expose it as prose.
    .replace(/\\hfil(?:l)?\b/g, '')
    .replace(/\\displaylimits(?![A-Za-z@])/g, '\\limits')
    .replace(/\\'\{?e\}?/g, 'é')
    .replace(/\\'\{?E\}?/g, 'É')
    .replace(/\\"\{?([aeiouAEIOU])\}?/g, (_match, letter) => ({ a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' }[letter] || letter))
    .replace(/\\~\{?([anoANO])\}?/g, (_match, letter) => ({ a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ' }[letter] || letter))
    .replace(/\\u\{?([aeiouAEIOU])\}?/g, (_match, letter) => ({ a: 'ă', e: 'ĕ', i: 'ĭ', o: 'ŏ', u: 'ŭ', A: 'Ă', E: 'Ĕ', I: 'Ĭ', O: 'Ŏ', U: 'Ŭ' }[letter] || letter))
    .replace(/\\c\{?([cCtTsS])\}?/g, (_match, letter) => ({ c: 'ç', C: 'Ç', t: 'ţ', T: 'Ţ', s: 'ş', S: 'Ş' }[letter] || letter))
    .replace(/\\v(?:\{([cszCSZ])\}|\s+([cszCSZ])\b)/g, (_match, braced, spaced) => { const letter = braced || spaced; return ({ c: 'č', s: 'š', z: 'ž', C: 'Č', S: 'Š', Z: 'Ž' }[letter] || letter); })
    // `\\l` and `\\L` are Polish letter macros, but they are also prefixes of
    // ordinary TeX commands such as `\\left` and `\\Lambda`. Only convert the
    // standalone, non-letter commands; otherwise math is silently corrupted.
    .replace(/\\l(?![A-Za-z@])(?:\{\})?\s?/g, 'ł')
    .replace(/\\L(?![A-Za-z@])(?:\{\})?\s?/g, 'Ł')
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
    .replace(/\\begin\{(?:align|align\*|gather|gather\*|multline|multline\*|eqnarray|eqnarray\*)\}/g, () => '$$\\begin{aligned}')
    .replace(/\\end\{(?:align|align\*|gather|gather\*|multline|multline\*|eqnarray|eqnarray\*)\}/g, () => '\\end{aligned}$$')
    .replace(/\\begin\{(?:enumerate|itemize|description)\}(?:\[[^\]]*\])?/g, '')
    .replace(/\\end\{(?:enumerate|itemize|description)\}/g, '')
    .replace(/\\item(?:\[[^\]]*\])?/g, '\n• ')
    .replace(/\\(?:emph|textbf|textit|texttt|textsc|textrm|textsf|underline|centerline|mbox)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:vspace|hspace)\*?\s*\{[^}]*\}/g, ' ')
    .replace(/\\(?:medskip|smallskip|bigskip|noindent|par)\b/g, '\n')
    .replace(/~+/g, '\u00a0')
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
  const value = String(source || '');
  const literalRanges = literalSourceRanges(value);
  const mentions = [];
  for (const match of value.matchAll(/\\cite\w*\s*(?:\[([^\]]*)\])?\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(value, match.index ?? 0)) continue;
    for (const key of match[3].split(',').map((item) => item.trim()).filter(Boolean)) {
      const locator = [match[1], match[2]].map((item) => String(item || '').trim()).filter(Boolean).join('; ');
      if (!mentions.some((item) => item.key === key && item.locator === locator)) mentions.push({ key, locator });
    }
  }
  return mentions;
}

function cleanBibliographyFragment(value) {
  return readableLatex(String(value || '')
    .replace(/\\newblock\b/g, '\n')
    .replace(/\{\\(?:em|it|bf)\s+([^{}]*)\}/g, '$1')
    .replace(/\\(?:url|nolinkurl|path)\s*\{([^}]*)\}/g, '$1')
    .replace(/\\href\s*\{[^}]*\}\s*\{([^}]*)\}/g, '$1'))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBibliography(source) {
  const text = String(source || '');
  const literalRanges = literalSourceRanges(text);
  const matches = [...text.matchAll(/\\bibitem(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)].filter((match) => !insideSourceRanges(match.index ?? 0, literalRanges) && !isLatexCommentedAt(text, match.index ?? 0));
  const references = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const raw = text.slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? text.indexOf('\\end{thebibliography}', (match.index ?? 0) + match[0].length));
    const blocks = raw.split(/\\newblock\b/).map(cleanBibliographyFragment).filter(Boolean);
    const citationText = cleanBibliographyFragment(raw);
    const title = blocks[1] || blocks[0] || match[1];
    const authors = blocks.length > 1 ? blocks[0] : '';
    const href = /\\href\s*\{([^}]+)\}/.exec(raw)?.[1];
    const explicitUrl = /\\(?:url|nolinkurl|path)\s*\{([^}]+)\}/.exec(raw)?.[1] || /https?:\/\/[^\s}]+/.exec(raw)?.[0];
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
  const value = String(source || '');
  const literalRanges = literalSourceRanges(value);
  const requested = [];
  for (const match of value.matchAll(/\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(value, match.index ?? 0)) continue;
    for (const name of match[1].split(',').map((value) => value.trim()).filter(Boolean)) requested.push(name);
  }
  for (const name of requested) {
    const filename = /\.bib$/i.test(name) ? name : `${name}.bib`;
    const candidate = path.resolve(sourceRoot, filename);
    const relative = path.relative(sourceRoot, candidate);
    if (relativePathEscapes(relative)) continue;
    try { for (const [key, reference] of extractBibtex(decodeSourceBuffer(await readFile(candidate)))) references.set(key, reference); }
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
  const literalRanges = literalSourceRanges(text);
  const macros = new Map();
  const declarations = /\\(?:newcommand|renewcommand)\s*\{\\([A-Za-z@]+)\}\s*(?:\[(\d+)\])?\s*(?:\[([^\]]*)\])?\s*\{/g;
  for (const match of text.matchAll(declarations)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(text, match.index ?? 0)) continue;
    const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    if (group) macros.set(match[1], { replacement: group.content, arity: Number(match[2] || 0), defaultArg: match[3] });
  }
  for (const match of text.matchAll(/\\def\s*\\([A-Za-z@]+)\s*((?:#\d\s*)*)\{/g)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(text, match.index ?? 0)) continue;
    const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    let arity = Math.max(0, ...[...String(match[2] || '').matchAll(/#(\d)/g)].map((item) => Number(item[1])));
    let replacement = group?.content || '';
    if (arity === 0 && /^\\(?:widehat|widetilde|overline|underline)$/.test(replacement.trim())) { arity = 1; replacement = `${replacement.trim()}{#1}`; }
    if (group) macros.set(match[1], { replacement, arity });
  }
  for (const match of text.matchAll(/\\DeclareMathOperator\*?\s*\{\\([A-Za-z@]+)\}\s*\{/g)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(text, match.index ?? 0)) continue;
    const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    if (group) macros.set(match[1], { replacement: `\\operatorname{${group.content}}`, arity: 0 });
  }
  for (const match of text.matchAll(/\\let\s*\\([A-Za-z@]+)\s*(?:=\s*)?\\([A-Za-z@]+)/g)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(text, match.index ?? 0)) continue;
    const takesArgument = /^(?:widehat|widetilde|overline|underline)$/.test(match[2]);
    macros.set(match[1], { replacement: takesArgument ? `\\${match[2]}{#1}` : `\\${match[2]}`, arity: takesArgument ? 1 : 0 });
  }
  return macros;
}

function expandMacroUse(text, name, macro) {
  const pattern = new RegExp(`\\\\${name}(?![A-Za-z@])`, 'g');
  const literalRanges = literalSourceRanges(text);
  let output = ''; let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(text, match.index ?? 0)) continue;
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
    args.forEach((argument, index) => {
      replacement = replacement.replace(new RegExp(`#${index + 1}`, 'g'), (_placeholder, offset, whole) => {
        // TeX tokenizes a control word before substituting macro parameters.
        // Preserve that boundary or `\\lVert#1` with `#1=A` becomes the
        // undefined reader command `\\lVertA`.
        const needsBoundary = /\\[A-Za-z@]+$/.test(whole.slice(0, offset)) && /^[A-Za-z@]/.test(argument);
        return needsBoundary ? ` ${argument}` : argument;
      });
    });
    output += text.slice(cursor, match.index ?? 0) + replacement;
    cursor = position;
  }
  return output + text.slice(cursor);
}

function expandSimpleEnvironments(source) {
  const text = String(source || '');
  const literalRanges = literalSourceRanges(text);
  const definitions = [];
  for (const match of text.matchAll(/\\(?:newenvironment|renewenvironment)\s*\{([^}]+)\}(?!\s*\[)\s*\{/g)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(text, match.index ?? 0)) continue;
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
  // Collect definitions before removing them, then expand only author-facing
  // uses. Expanding the command name inside its own `\newcommand` declaration
  // corrupts the declaration and can make it appear as proof text.
  let expanded = stripDocumentDeclarations(expandSimpleEnvironments(source));
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
  const value = String(source || '');
  const literalRanges = literalSourceRanges(value);
  return [...value.matchAll(/\\includegraphics(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)]
    .filter((match) => !insideSourceRanges(match.index ?? 0, literalRanges) && !isLatexCommentedAt(value, match.index ?? 0))
    .map((match) => match[1].trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function literalSourceRanges(source) {
  const value = String(source || ''); const ranges = [];
  for (const match of value.matchAll(/\\begin\{(verbatim\*?|Verbatim|lstlisting|minted|comment|alltt)\}(?:\[[^\]]*\])?(?:\{[^}]*\})?[\s\S]*?\\end\{\1\}/g)) {
    const start = match.index ?? 0;
    if (!isLatexCommentedAt(value, start)) ranges.push([start, start + match[0].length]);
  }
  for (const match of value.matchAll(/\\verb\*?([^A-Za-z0-9\s])[\s\S]*?\1/g)) {
    const start = match.index ?? 0;
    if (!isLatexCommentedAt(value, start)) ranges.push([start, start + match[0].length]);
  }
  return ranges;
}

function insideSourceRanges(index, ranges) {
  return ranges.some(([start, end]) => start <= index && index < end);
}

function sourceProofEvents(source, units = [], declarationSource = source) {
  const value = String(source || '');
  const literalRanges = literalSourceRanges(value);
  const proofEnvironments = new Set(['proof']);
  const definitions = String(declarationSource || '');
  const definitionLiteralRanges = literalSourceRanges(definitions);
  for (const match of definitions.matchAll(/\\newenvironment\s*\{([^}]+)\}(?:\[(\d+)\])?(?:\[([^\]]*)\])?/g)) {
    if (insideSourceRanges(match.index ?? 0, definitionLiteralRanges) || isLatexCommentedAt(definitions, match.index ?? 0)) continue;
    if (/^proof/i.test(match[1]) || /proof|preuve|démonstration/i.test(match[3] || '')) proofEnvironments.add(match[1]);
  }
  const proofNames = [...proofEnvironments].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!proofNames) return [];
  const pattern = new RegExp(`\\\\begin\\{(${proofNames})\\}(?:\\[([^\\]]*)\\])?([\\s\\S]*?)\\\\end\\{\\1`, 'g');
  const events = [];
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (insideSourceRanges(start, literalRanges) || isLatexCommentedAt(value, start)) continue;
    const end = start + match[0].length;
    const linkedUnit = units.find((candidate) => candidate.proofStart === start) || units.find((candidate) => candidate.start < start && start < candidate.end);
    const unit = linkedUnit || { proofText: readableLatex(match[3]), proofAssetPaths: graphicPaths(match[3]), citationMentions: citationMentions(match[3]), citations: [], nodeId: '', kind: 'theorem' };
    events.push({ type: 'proof', start, end, unit });
  }
  return events;
}

function extractSourceUnits(source) {
  const originalSource = String(source || '');
  const normalizedSource = expandAuthorMacros(originalSource);
  const originalLiteralRanges = literalSourceRanges(originalSource);
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
    if (insideSourceRanges(match.index ?? 0, originalLiteralRanges) || isLatexCommentedAt(originalSource, match.index ?? 0)) continue;
    const environment = match[2]; const sharedCounter = String(match[3] || '').trim(); const displayName = readableLatex(match[4]); const within = String(match[5] || '').trim();
    const kind = theoremKind(displayName, environment);
    environments.set(environment, kind);
    displayNames.set(environment, displayName);
    theoremCounters.set(environment, { root: sharedCounter || environment, within, numbered: !match[1] });
  }
  const proofEnvironments = new Set(['proof']);
  for (const match of originalSource.matchAll(/\\newenvironment\s*\{([^}]+)\}(?:\[(\d+)\])?(?:\[([^\]]*)\])?/g)) {
    if (insideSourceRanges(match.index ?? 0, originalLiteralRanges) || isLatexCommentedAt(originalSource, match.index ?? 0)) continue;
    if (/^proof/i.test(match[1]) || /proof|preuve|démonstration/i.test(match[3] || '')) proofEnvironments.add(match[1]);
  }
  const names = [...environments.keys()].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!names) return [];
  const unitPattern = new RegExp(`\\\\begin\\{(${names})\\}(?:\\[([^\\]]*)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`, 'g');
  const proofNames = [...proofEnvironments].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const embeddedProofPattern = new RegExp(`\\\\begin\\{(${proofNames})\\}(?:\\[([^\\]]*)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`, 'g');
  const headingLevels = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4 };
  const headingEvents = [];
  const headingCounters = [0, 0, 0, 0, 0];
  const headingPattern = /\\(part|chapter|section|subsection|subsubsection)(?!\*)\s*(?:\[[^\]]*\])?\s*\{/g;
  for (const match of normalizedSource.matchAll(headingPattern)) {
    const start = match.index ?? 0;
    if (insideSourceRanges(start, literalRanges) || isLatexCommentedAt(normalizedSource, start)) continue;
    const level = headingLevels[match[1]];
    headingCounters[level] += 1;
    for (let index = level + 1; index < headingCounters.length; index += 1) headingCounters[index] = 0;
    headingEvents.push({ start, counters: [...headingCounters] });
  }
  const structuralCounterNumber = (counterName, position) => {
    const level = headingLevels[counterName];
    if (level === undefined) return '';
    const state = headingEvents.filter((event) => event.start < position).at(-1)?.counters || headingCounters.map(() => 0);
    if (!state[level]) return '0';
    if (counterName === 'part' || counterName === 'chapter') return String(state[level]);
    const first = state[1] ? 1 : 2;
    return state.slice(first, level + 1).filter(Boolean).join('.') || '0';
  };
  const counterValues = new Map();
  const units = [];
  for (const match of normalizedSource.matchAll(unitPattern)) {
    const start = match.index ?? 0; const end = start + match[0].length;
    if (insideSourceRanges(start, literalRanges) || isLatexCommentedAt(normalizedSource, start)) continue;
    const label = /\\label\s*\{([^}]+)\}/.exec(match[3])?.[1] || '';
    const embeddedProofs = [...match[3].matchAll(embeddedProofPattern)];
    const statementSource = match[3].replace(embeddedProofPattern, '');
    const counter = theoremCounters.get(match[1]); const owner = theoremCounters.get(counter?.root) || counter; const sharedStructuralCounter = counter?.root && headingLevels[counter.root] !== undefined ? counter.root : ''; const withinStructuralCounter = owner?.within && headingLevels[owner.within] !== undefined ? owner.within : ''; const scopeNumber = withinStructuralCounter ? structuralCounterNumber(withinStructuralCounter, start) : ''; const counterKey = `${counter?.root || match[1]}:${scopeNumber || 'global'}`; const nextNumber = (counterValues.get(counterKey) || 0) + 1; if (counter?.numbered !== false && !sharedStructuralCounter) counterValues.set(counterKey, nextNumber); const printedNumber = counter?.numbered === false ? '' : sharedStructuralCounter ? structuralCounterNumber(sharedStructuralCounter, start) : withinStructuralCounter ? `${scopeNumber}.${nextNumber}` : `${nextNumber}`;
    units.push({ environment: match[1], kind: environments.get(match[1]), displayName: displayNames.get(match[1]) || readableLatex(match[1]), printedNumber, title: match[2] || '', texLabel: label, start, end, statement: readableLatex(statementSource), proofText: embeddedProofs.map((proof) => readableLatex(proof[3])).filter(Boolean).join('\n\n'), assetPaths: graphicPaths(statementSource), proofAssetPaths: embeddedProofs.flatMap((proof) => graphicPaths(proof[3])), embeddedProof: embeddedProofs.length > 0, citationMentions: citationMentions(`${match[2] || ''} ${match[3]}`), citationKeys: citationKeys(`${match[2] || ''} ${match[3]}`) });
  }
  const byLabel = new Map(units.filter((unit) => unit.texLabel).map((unit) => [unit.texLabel, unit]));
  const proofPattern = new RegExp(`\\\\begin\\{(${proofNames})\\}(?:\\[([^\\]]*)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`, 'g');
  for (const proof of normalizedSource.matchAll(proofPattern)) {
    const proofStart = proof.index ?? 0;
    if (insideSourceRanges(proofStart, literalRanges) || isLatexCommentedAt(normalizedSource, proofStart)) continue;
    if (units.some((unit) => unit.start < proofStart && proofStart < unit.end)) continue;
    const nearest = units.filter((unit) => unit.end <= proofStart).at(-1) || null;
    const prelude = normalizedSource.slice(Math.max(nearest?.end ?? 0, proofStart - 2200), proofStart);
    const proofLead = `${proof[2] || ''} ${prelude}`;
    const explicitMatch = [...proofLead.matchAll(/(?:proof\s+of|prove|complet(?:e|es|ed)\s+the\s+proof\s+of|preuve\s+(?:de|du|des)|d[ée]monstration\s+(?:de|du|des))[\s\S]{0,180}?(?:\\ref\s*\{([^}]+)\}|\\hyperref\s*\[([^\]]+)\])/gi)].at(-1);
    const explicit = explicitMatch?.[1] || explicitMatch?.[2];
    let target = explicit ? byLabel.get(explicit) : null;
    if (!target && nearest && !nearest.proofText) target = nearest;
    if (target && !target.proofText) {
      target.proofText = readableLatex(proof[3]);
      target.proofAssetPaths = graphicPaths(proof[3]);
      for (const mention of citationMentions(proof[3])) if (!target.citationMentions.some((item) => item.key === mention.key && item.locator === mention.locator)) target.citationMentions.push(mention);
      target.citationKeys = target.citationMentions.map((mention) => mention.key);
      target.proofStart = proofStart;
      target.proofEnd = proofStart + proof[0].length;
    }
  }
  return units;
}

function resolveLatexReferences(source, sourceUnits = []) {
  const value = String(source || '');
  const labels = new Map(sourceUnits.filter((unit) => unit.texLabel && unit.printedNumber).map((unit) => [unit.texLabel, unit.printedNumber]));
  const literalRanges = literalSourceRanges(value);
  const proofNames = new Set(['proof']);
  for (const match of value.matchAll(/\\newenvironment\s*\{([^}]+)\}(?:\[(\d+)\])?(?:\[([^\]]*)\])?/g)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(value, match.index ?? 0)) continue;
    if (/^proof/i.test(match[1]) || /proof|preuve|démonstration/i.test(match[3] || '')) proofNames.add(match[1]);
  }
  const proofNamePattern = [...proofNames].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const proofHeaderRanges = [];
  for (const match of value.matchAll(new RegExp(`\\\\begin\\{(?:${proofNamePattern})\\}\\s*\\[`, 'g'))) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(value, match.index ?? 0)) continue;
    const group = balancedGroup(value, (match.index ?? 0) + match[0].length - 1, '[', ']');
    if (group) proofHeaderRanges.push([match.index ?? 0, group.end]);
  }
  const sectionAt = [];
  const sectionCounters = [0, 0, 0, 0, 0];
  const sectionPattern = /\\(part|chapter|section|subsection|subsubsection)(\*)?(?:\[[^\]]*\])?\s*\{/g;
  const hasChapters = [...value.matchAll(/\\chapter\*?(?:\[[^\]]*\])?\s*\{/g)].some((match) => !insideSourceRanges(match.index ?? 0, literalRanges) && !isLatexCommentedAt(value, match.index ?? 0));
  const sectionLevels = { part: 0, chapter: 1, section: hasChapters ? 2 : 1, subsection: hasChapters ? 3 : 2, subsubsection: hasChapters ? 4 : 3 };
  for (const match of value.matchAll(sectionPattern)) {
    const start = match.index ?? 0;
    if (match[2] || insideSourceRanges(start, literalRanges) || isLatexCommentedAt(value, start)) continue;
    const level = sectionLevels[match[1]] ?? 1;
    sectionCounters[level] += 1;
    for (let index = level + 1; index < sectionCounters.length; index += 1) sectionCounters[index] = 0;
    const number = sectionCounters.slice(match[1] === 'part' ? 0 : 1, level + 1).filter(Boolean).join('.');
    const title = balancedGroup(value, start + match[0].length - 1);
    const immediateLabel = title ? /^\s*\\label\s*\{([^}]+)\}/.exec(value.slice(title.end, title.end + 240)) : null;
    if (immediateLabel?.[1] && number) labels.set(immediateLabel[1], number);
    if (match[1] === 'section') sectionAt.push({ start, number });
  }

  for (const environment of ['figure', 'table']) {
    let counter = 0;
    const pattern = environment === 'table' ? /\\begin\{(table\*?|longtable)\}([\s\S]*?)\\end\{\1\}/g : /\\begin\{(figure\*?)\}([\s\S]*?)\\end\{\1\}/g;
    for (const match of value.matchAll(pattern)) {
      if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(value, match.index ?? 0)) continue;
      counter += 1;
      for (const label of match[2].matchAll(/\\label\s*\{([^}]+)\}/g)) labels.set(label[1], String(counter));
    }
  }

  const sectionalEquations = /\\(?:numberwithin|counterwithin)\s*\{equation\}\s*\{section\}/.test(value);
  let equationCounter = 0; let equationSection = 0;
  const equationPattern = /\\begin\{(equation|align|gather|multline|eqnarray)(\*)?\}([\s\S]*?)\\end\{\1\2\}/g;
  for (const match of value.matchAll(equationPattern)) {
    if (match[2] || insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(value, match.index ?? 0)) continue;
    const currentSection = sectionAt.filter((section) => section.start < (match.index ?? 0)).at(-1)?.number || 0;
    if (sectionalEquations && currentSection !== equationSection) { equationSection = currentSection; equationCounter = 0; }
    const equationLabels = [...match[3].matchAll(/\\label\s*\{([^}]+)\}/g)].map((item) => item[1]);
    if (!equationLabels.length) { equationCounter += 1; continue; }
    const tag = /\\tag\*?\s*\{([^}]+)\}/.exec(match[3])?.[1];
    for (const label of equationLabels) {
      equationCounter += 1;
      labels.set(label, tag || (sectionalEquations && currentSection ? `${currentSection}.${equationCounter}` : String(equationCounter)));
    }
  }

  return value.replace(/\\(eqref|ref|autoref|cref|Cref)\s*\{([^}]+)\}/g, (match, command, key, offset) => {
    if (insideSourceRanges(offset, literalRanges) || insideSourceRanges(offset, proofHeaderRanges)) return match;
    const number = labels.get(String(key).trim());
    if (!number) return match;
    return command === 'eqref' ? `(${number})` : number;
  });
}

function citationReference(mention, bibliography, aiCitations = []) {
  const { key, locator = '' } = mention;
  const reference = bibliography.get(key) || { key, title: 'Bibliographic record not cached yet', authors: '', text: '', url: `https://scholar.google.com/scholar?q=${encodeURIComponent(key)}`, searchUrl: `https://scholar.google.com/scholar?q=${encodeURIComponent(key)}`, doi: '', arxivId: '', direct: false };
  const aiDetail = aiCitations.find((citation) => citation && citation.key === key && String(citation.locator || '') === locator) || aiCitations.find((citation) => citation && citation.key === key);
  return { ...reference, locator, statement: typeof aiDetail?.statement === 'string' ? aiDetail.statement : '', definitions: Array.isArray(aiDetail?.definitions) ? aiDetail.definitions.filter((item) => item && typeof item.notation === 'string' && typeof item.definition === 'string').map((item) => ({ notation: item.notation, definition: item.definition, source: typeof item.source === 'string' ? item.source : '' })) : [] };
}

function sectionEvents(source) {
  const events = []; const literalRanges = literalSourceRanges(source);
  const pattern = /\\(part|chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\s*\{/g;
  const hasChapters = [...String(source || '').matchAll(/\\chapter\*?(?:\[[^\]]*\])?\s*\{/g)].some((match) => !insideSourceRanges(match.index ?? 0, literalRanges) && !isLatexCommentedAt(source, match.index ?? 0));
  const levels = { part: 0, chapter: 1, section: hasChapters ? 2 : 1, subsection: hasChapters ? 3 : 2, subsubsection: hasChapters ? 4 : 3 };
  for (const match of String(source || '').matchAll(pattern)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(source, match.index ?? 0)) continue;
    const title = balancedGroup(source, (match.index ?? 0) + match[0].length - 1);
    if (!title) continue;
    events.push({ type: 'section', start: match.index ?? 0, end: title.end, level: levels[match[1]] ?? 1, title: readableLatex(title.content) });
  }
  return events;
}

function stripDocumentDeclarations(source) {
  // Some author sources place theorem and macro declarations immediately after
  // \begin{document}, and local macro declarations may also occur inside a
  // proof. They configure TeX but render no paper content. Parse balanced
  // declarations first so a multi-line replacement body cannot leak into the
  // reader, then remove the remaining one-line counter/style declarations.
  const text = String(source || '');
  const literalRanges = literalSourceRanges(text);
  const ranges = [];
  const commandPattern = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|newenvironment|renewenvironment|newtheorem|renewtheorem|def|gdef|edef|xdef|mathchardef|chardef|let|theoremstyle|numberwithin|counterwithin|counterwithout)\*?/g;
  const skipSpace = (position) => { while (/\s/.test(text[position] || '')) position += 1; return position; };
  const takeGroup = (position, open = '{', close = '}') => {
    const start = skipSpace(position);
    const group = balancedGroup(text, start, open, close);
    return group ? { ...group, start } : null;
  };
  const takeOptional = (position) => takeGroup(position, '[', ']');
  const takeMacroName = (position) => {
    const start = skipSpace(position);
    const grouped = balancedGroup(text, start);
    if (grouped) return grouped.end;
    const token = /^\\(?:[A-Za-z@]+|.)/.exec(text.slice(start))?.[0];
    return token ? start + token.length : -1;
  };
  for (const match of text.matchAll(commandPattern)) {
    const start = match.index ?? 0;
    if (insideSourceRanges(start, literalRanges) || isLatexCommentedAt(text, start)) continue;
    const command = match[1];
    let position = start + match[0].length;
    if (/^(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)$/.test(command)) {
      position = takeMacroName(position);
      if (position < 0) continue;
      const arity = takeOptional(position); if (arity) position = arity.end;
      const fallback = takeOptional(position); if (fallback) position = fallback.end;
      const replacement = takeGroup(position); if (!replacement) continue;
      position = replacement.end;
    } else if (command === 'DeclareMathOperator') {
      const name = takeGroup(position); if (!name) continue;
      const replacement = takeGroup(name.end); if (!replacement) continue;
      position = replacement.end;
    } else if (/^(?:newenvironment|renewenvironment)$/.test(command)) {
      const name = takeGroup(position); if (!name) continue; position = name.end;
      const arity = takeOptional(position); if (arity) position = arity.end;
      const fallback = takeOptional(position); if (fallback) position = fallback.end;
      const begin = takeGroup(position); if (!begin) continue;
      const end = takeGroup(begin.end); if (!end) continue;
      position = end.end;
    } else if (/^(?:newtheorem|renewtheorem)$/.test(command)) {
      const name = takeGroup(position); if (!name) continue; position = name.end;
      const shared = takeOptional(position); if (shared) position = shared.end;
      const title = takeGroup(position); if (!title) continue; position = title.end;
      const within = takeOptional(position); if (within) position = within.end;
    } else if (/^(?:def|gdef|edef|xdef)$/.test(command)) {
      position = takeMacroName(position);
      if (position < 0) continue;
      const replacementStart = text.indexOf('{', position);
      const lineEnd = text.indexOf('\n', position);
      if (replacementStart < 0 || (lineEnd >= 0 && replacementStart > lineEnd)) continue;
      const replacement = balancedGroup(text, replacementStart); if (!replacement) continue;
      position = replacement.end;
    } else if (/^(?:mathchardef|chardef)$/.test(command)) {
      position = takeMacroName(position);
      if (position < 0) continue;
      const value = /^\s*=?\s*(?:"[0-9A-Fa-f]+|[0-9]+)/.exec(text.slice(position));
      if (!value) continue;
      position += value[0].length;
    } else if (command === 'let') {
      position = takeMacroName(position);
      if (position < 0) continue;
      position = skipSpace(position);
      if (text[position] === '=') position = skipSpace(position + 1);
      position = takeMacroName(position);
      if (position < 0) continue;
    } else if (command === 'theoremstyle') {
      const style = takeGroup(position); if (!style) continue;
      position = style.end;
    } else {
      const counter = takeGroup(position); if (!counter) continue;
      const owner = takeGroup(counter.end); if (!owner) continue;
      position = owner.end;
    }
    ranges.push([start, position]);
  }
  let balancedCleaned = text;
  for (const [start, end] of ranges.sort((left, right) => right[0] - left[0])) {
    balancedCleaned = balancedCleaned.slice(0, start) + balancedCleaned.slice(start, end).replace(/[^\r\n]/g, ' ') + balancedCleaned.slice(end);
  }
  return balancedCleaned;
}

function readableBodyFragment(source) {
  const cleaned = stripDocumentDeclarations(source)
    .replace(/\\begin\{abstract\}[\s\S]*?\\end\{abstract\}/g, '')
    .replace(/\\(?:title|author|address|email|subjclass|date|dedicatory|keywords|thanks)(?:\[[^\]]*\])?\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '')
    .replace(/\\(?:maketitle|tableofcontents|clearpage|newpage|printbibliography|centering)\b/g, '')
    .replace(/\\selectlanguage\s*\{[^}]*\}/g, '')
    .replace(/\\begin\{otherlanguage\*?\}\s*\{[^}]*\}|\\end\{otherlanguage\*?\}/g, '')
    .replace(/\\(?:nocite|label|pagestyle|thispagestyle|pagenumbering)\s*\{[^}]*\}/g, '')
    .replace(/\\setcounter\s*\{[^}]*\}\s*\{[^}]*\}/g, '')
    .replace(/\\(?:bibliography|bibliographystyle|addbibresource)\s*\{[^}]*\}/g, '')
    .replace(/\\includegraphics(?:\[[^\]]*\])?\s*\{([^}]*)\}/g, (_match, file) => `\n[Figure from the original source: ${file}]\n`)
    .replace(/\\begin\{wrapfigure\}(?:\[[^\]]*\])?\s*\{[^}]*\}\s*\{[^}]*\}|\\end\{wrapfigure\}/g, '')
    .replace(/\\begin\{(?:center|flushleft|flushright|quote|quotation|figure\*?|table\*?|minipage)\}(?:\[[^\]]*\])?(?:\{[^}]*\})?/g, '')
    .replace(/\\end\{(?:center|flushleft|flushright|quote|quotation|figure\*?|table\*?|minipage)\}/g, '')
    .replace(/\\begin\{tcolorbox\}(?:\[[^\]]*\])?|\\end\{tcolorbox\}/g, '')
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
  for (const match of String(source || '').matchAll(/\\begin\{(table\*?|longtable)\}([\s\S]*?)\\end\{\1\}/g)) {
    const start = match.index ?? 0;
    if (insideSourceRanges(start, literalRanges) || isLatexCommentedAt(source, start)) continue;
    const content = match[1] === 'longtable' ? match[0] : tabular(match[0]);
    if (!content) continue;
    const end = start + match[0].length; covered.push([start, end]);
    events.push({ type: 'table', start, end, content, caption: caption(match[0]), citations: citationMentions(match[0]) });
  }
  for (const match of String(source || '').matchAll(/\\begin\{(?:tabular\*?|tabularx|longtable)\}[\s\S]*?\\end\{(?:tabular\*?|tabularx|longtable)\}/g)) {
    const start = match.index ?? 0;
    if (insideSourceRanges(start, literalRanges) || isLatexCommentedAt(source, start) || covered.some(([left, right]) => left <= start && start < right)) continue;
    events.push({ type: 'table', start, end: start + match[0].length, content: match[0], caption: '', citations: citationMentions(match[0]) });
  }
  return events;
}

function bibliographyEvents(source, bibliography) {
  const value = String(source || '');
  const literalRanges = literalSourceRanges(value);
  const events = [];
  const inlinePattern = /\\begin\{thebibliography\}(?:\{[^}]*\})?([\s\S]*?)\\end\{thebibliography\}/g;
  for (const match of value.matchAll(inlinePattern)) {
    const start = match.index ?? 0;
    if (insideSourceRanges(start, literalRanges) || isLatexCommentedAt(value, start)) continue;
    const body = match[1] || '';
    const items = [...body.matchAll(/\\bibitem(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)];
    const entries = items.map((item, index) => {
      const raw = body.slice((item.index ?? 0) + item[0].length, items[index + 1]?.index ?? body.length);
      return { key: item[1].trim(), content: cleanBibliographyFragment(raw) || item[1].trim() };
    }).filter((entry) => entry.key);
    if (entries.length) events.push({ type: 'bibliography', start, end: start + match[0].length, entries });
  }
  if (events.length || !bibliography?.size) return events;
  const external = /\\(?:printbibliography|bibliography)\b(?:\[[^\]]*\])?(?:\s*\{[^}]*\})?/.exec(value);
  if (!external || insideSourceRanges(external.index ?? 0, literalRanges) || isLatexCommentedAt(value, external.index ?? 0)) return events;
  const entries = [...bibliography.values()].map((reference) => ({ key: String(reference.key || ''), content: String(reference.text || [reference.authors, reference.title].filter(Boolean).join('. ') || reference.key || '') })).filter((entry) => entry.key && entry.content);
  if (entries.length) events.push({ type: 'bibliography', start: external.index ?? 0, end: (external.index ?? 0) + external[0].length, entries });
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
  const original = String(source || '');
  const normalized = expandAuthorMacros(original);
  const literalRanges = literalSourceRanges(normalized);
  const activeMatches = (pattern) => [...normalized.matchAll(pattern)].filter((match) => !insideSourceRanges(match.index ?? 0, literalRanges) && !isLatexCommentedAt(normalized, match.index ?? 0));
  const beginMatch = activeMatches(/\\begin\{document\}/g)[0];
  const documentBegin = beginMatch?.index ?? -1;
  let bodyStart = documentBegin >= 0 ? documentBegin + (beginMatch?.[0].length ?? '\\begin{document}'.length) : 0;
  const sections = sectionEvents(normalized);
  const firstSectionStart = sections.find((event) => event.start >= bodyStart)?.start ?? -1;
  const abstractStart = activeMatches(/\\begin\{abstract\}/g).find((match) => (match.index ?? 0) >= bodyStart)?.index ?? -1;
  if (firstSectionStart >= bodyStart) {
    // The reader header already renders paper metadata. Starting the source flow
    // at the first section avoids a second title, author, and abstract when an
    // author formats that front matter manually instead of using \maketitle.
    bodyStart = firstSectionStart;
  } else if (abstractStart >= bodyStart) {
    const abstractEnd = activeMatches(/\\end\{abstract\}/g).find((match) => (match.index ?? 0) > abstractStart)?.index ?? -1;
    if (abstractEnd >= abstractStart) bodyStart = abstractEnd + '\\end{abstract}'.length;
  }
  const documentEnd = activeMatches(/\\end\{document\}/g).find((match) => (match.index ?? 0) > bodyStart)?.index ?? -1;
  const bodyEnd = documentEnd > bodyStart ? documentEnd : normalized.length;
  const events = [
    ...sections.filter((event) => event.start >= bodyStart && event.start < bodyEnd),
    ...figureEvents(normalized).filter((event) => event.start >= bodyStart && event.start < bodyEnd),
    ...tableEvents(normalized).filter((event) => event.start >= bodyStart && event.start < bodyEnd),
    ...bibliographyEvents(normalized, bibliography).filter((event) => event.start >= bodyStart && event.start < bodyEnd),
    ...units.filter((unit) => unit.start >= bodyStart && unit.start < bodyEnd).map((unit) => ({ type: 'result', start: unit.start, end: unit.end, unit })),
    // Preserve every proof in source order. A semantic link to a theorem
    // enriches the reader, but never decides whether the proof is rendered.
    ...sourceProofEvents(normalized, units, original).filter((event) => event.start >= bodyStart && event.start < bodyEnd),
  ].sort((left, right) => left.start - right.start || (left.type === 'section' ? -1 : 1));
  const blocks = []; const state = { paragraph: 0, section: 0, result: 0, proof: 0, table: 0, bibliography: 0 };
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
    } else if (event.type === 'bibliography') {
      const previous = blocks.at(-1);
      if (previous?.kind !== 'section' || !/^(?:references|bibliography)$/i.test(previous.title.trim())) {
        state.section += 1;
        blocks.push({ id: 'source-section-' + state.section, kind: 'section', level: 1, title: 'References', content: '', proofText: '', nodeId: '', resultKind: '', citations: [] });
      }
      for (const entry of event.entries) {
        state.bibliography += 1;
        blocks.push({ id: 'source-bibliography-' + state.bibliography, kind: 'bibliography', level: 4, title: entry.key, content: entry.content, proofText: '', nodeId: '', resultKind: '', citations: [citationReference({ key: entry.key, locator: '' }, bibliography)], assetPaths: [], caption: '' });
      }
    } else if (event.type === 'table') {
      state.table += 1;
      blocks.push({ id: `source-table-${state.table}`, kind: 'table', level: 4, title: '', content: event.content, proofText: '', nodeId: '', resultKind: '', citations: event.citations || [], assetPaths: [], caption: event.caption });
    } else if (event.type === 'result') {
      state.result += 1;
      blocks.push({ id: `source-result-${state.result}`, kind: 'result', level: 4, title: readableLatex(event.unit.title), content: event.unit.statement, proofText: '', nodeId: event.unit.nodeId || '', resultKind: event.unit.displayName || event.unit.kind || 'Theorem', citations: event.unit.citations || [], assetPaths: event.unit.assetPaths || [], caption: '' });
      if (event.unit.proofText && event.unit.embeddedProof) {
        state.proof += 1;
        blocks.push({ id: `source-proof-${state.proof}`, kind: 'proof', level: 4, title: '', content: '', proofText: event.unit.proofText, nodeId: event.unit.nodeId || '', resultKind: event.unit.kind || 'theorem', citations: event.unit.citations || [], assetPaths: event.unit.proofAssetPaths || [], caption: '' });
      }
    } else if (event.type === 'proof') {
      state.proof += 1;
      blocks.push({ id: `source-proof-${state.proof}`, kind: 'proof', level: 4, title: '', content: '', proofText: event.unit.proofText || '', nodeId: event.unit.nodeId || '', resultKind: event.unit.kind || 'theorem', citations: event.unit.citations || [], assetPaths: event.unit.proofAssetPaths || [], caption: '' });
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
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(source, match.index ?? 0)) continue;
    const assetPaths = images(match[0]); if (!assetPaths.length) continue;
    const start = match.index ?? 0; const end = start + match[0].length; covered.push([start, end]);
    events.push({ type: 'figure', start, end, assetPaths, caption: caption(match[0]), citations: citationMentions(match[0]) });
  }
  for (const match of String(source || '').matchAll(/\\includegraphics(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    const start = match.index ?? 0; if (insideSourceRanges(start, literalRanges) || isLatexCommentedAt(source, start) || covered.some(([left, right]) => left <= start && start < right)) continue;
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
  const unresolved = await readExpandedTex(primarySource.entryFile, primarySource.sourceDirectory);
  const expanded = resolveLatexReferences(unresolved, extractSourceUnits(unresolved));
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

export { buildSourceBlocks, decodeSourceBuffer, enrichAuditFromTex, expandAuthorMacros, extractBibliography, extractBibliographyTree, extractSourceUnits, readExpandedTex, readableLatex, resolveLatexReferences, sameExpandedTexSource };
