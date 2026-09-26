import { readFile, readdir, realpath } from 'node:fs/promises';
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
async function readExpandedTex(
  entryFile,
  sourceRoot,
  seen = new Set(),
  depth = 0,
  mainDirectory = path.dirname(entryFile),
) {
  if (depth > 12 || seen.has(entryFile)) return '';
  const relative = path.relative(sourceRoot, entryFile);
  if (relativePathEscapes(relative)) return '';
  // Compare resolved paths too, so a symbolic link cannot lead outside the source.
  if (relativePathEscapes(path.relative(await realpath(sourceRoot), await realpath(entryFile)))) return '';
  seen.add(entryFile);
  let source = decodeSourceBuffer(await readFile(entryFile));
  // `\\include` needs braces; `\\input` also accepts a bare file name (`\\input macros`).
  const include = /\\(?:input|include)\s*\{([^}]+)\}|\\input\s+([A-Za-z0-9_./-]+)/g;
  const literalRanges = literalSourceRanges(source);
  let expanded = '';
  let cursor = 0;
  for (const match of source.matchAll(include)) {
    const start = match.index ?? 0;
    if (insideSourceRanges(start, literalRanges) || isLatexCommentedAt(source, start)) continue;
    expanded += source.slice(cursor, match.index);
    const requested = (match[1] ?? match[2]).trim();
    const filename = /\.[A-Za-z0-9]+$/.test(requested) ? requested : `${requested}.tex`;
    // TeX resolves every include against the main document's folder, even from
    // a nested file; also accept paths written relative to the including file.
    let included = null;
    for (const candidate of new Set([
      path.resolve(mainDirectory, filename),
      path.resolve(path.dirname(entryFile), filename),
    ])) {
      try {
        included = await readExpandedTex(candidate, sourceRoot, seen, depth + 1, mainDirectory);
        break;
      } catch {
        /* Try the next location. */
      }
    }
    expanded += included ?? `\n% arXivpecker could not resolve ${requested}\n`;
    cursor = start + match[0].length;
  }
  expanded += source.slice(cursor);
  return expanded;
}

async function sameExpandedTexSource(left, right) {
  const readableKind = (source) =>
    ['tex', 'ai-tex'].includes(source?.kind) && source?.entryFile && source?.sourceDirectory;
  if (!readableKind(left) || !readableKind(right)) return false;
  try {
    const [leftText, rightText] = await Promise.all([
      readExpandedTex(left.entryFile, left.sourceDirectory),
      readExpandedTex(right.entryFile, right.sourceDirectory),
    ]);
    return leftText.replace(/\r\n?/g, '\n') === rightText.replace(/\r\n?/g, '\n');
  } catch {
    return false;
  }
}

function stripLegacyFontMarkup(source) {
  let text = String(source || '');
  const groupStart = /\{\\(?:bf|it|rm|tt|sf|sl|sc)\b\s*/g;
  for (let pass = 0; pass < 4; pass += 1) {
    let output = '';
    let cursor = 0;
    let changed = false;
    for (const match of text.matchAll(groupStart)) {
      if ((match.index ?? 0) < cursor) continue;
      const group = balancedGroup(text, match.index ?? 0);
      if (!group) continue;
      const content = group.content.replace(/^\s*\\(?:bf|it|rm|tt|sf|sl|sc)\b\s*/, '');
      output += text.slice(cursor, match.index ?? 0) + content;
      cursor = group.end;
      changed = true;
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
    let output = '';
    let cursor = 0;
    let changed = false;
    for (const match of text.matchAll(command)) {
      if ((match.index ?? 0) < cursor) continue;
      const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
      if (!group) continue;
      let content = stripLegacyFontMarkup(group.content.trim())
        .replace(/^\{\\(?:normalfont|rm)\s*/, '')
        .replace(/\}\s*$/, '')
        .replace(/\\(?:normalfont|rm)\b\s*/g, '');
      if (match[1] === 'text' && !content.includes('$')) continue;
      const pieces = content
        .split(/\$([^$]*)\$/g)
        .map((piece, index) => (index % 2 ? piece.trim() : piece.replace(/\s+/g, ' ')));
      const replacement = pieces
        .map((piece, index) => {
          if (!piece) return '';
          return index % 2 ? piece : `\\text{${piece}}`;
        })
        .join('');
      output += text.slice(cursor, match.index ?? 0) + replacement;
      cursor = group.end;
      changed = true;
    }
    if (!changed) break;
    text = output + text.slice(cursor);
  }
  return text;
}

function unwrapLatexTextCommands(source) {
  let text = String(source || '');
  const command =
    /\\(footnote|footnotetext|caption|emph|textbf|textit|texttt|textsc|textrm|textsf|underline|centerline|mbox|url|path)(?:\[[^\]]*\])?\s*\{/g;
  for (let pass = 0; pass < 4; pass += 1) {
    let output = '';
    let cursor = 0;
    let changed = false;
    for (const match of text.matchAll(command)) {
      if ((match.index ?? 0) < cursor) continue;
      const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
      if (!group) continue;
      const replacement =
        match[1] === 'footnote' || match[1] === 'footnotetext'
          ? ` (Note: ${group.content})`
          : match[1] === 'caption'
            ? `\n${group.content}\n`
            : group.content;
      output += text.slice(cursor, match.index ?? 0) + replacement;
      cursor = group.end;
      changed = true;
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
    let output = '';
    let cursor = 0;
    let changed = false;
    for (const match of text.matchAll(command)) {
      if ((match.index ?? 0) < cursor) continue;
      const first = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
      if (!first) continue;
      let secondStart = first.end;
      while (/\s/.test(text[secondStart] || '')) secondStart += 1;
      const second = balancedGroup(text, secondStart);
      if (!second) continue;
      const decorativeRule = /^\\rule(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*\{[^{}]*\}\s*$/.test(second.content.trim());
      const replacement =
        match[1] === 'textcolor' && decorativeRule
          ? ''
          : match[1] === 'foreignlanguage' || match[1] === 'href' || match[1] === 'textcolor'
            ? second.content
            : first.content;
      output += text.slice(cursor, match.index ?? 0) + replacement;
      cursor = second.end;
      changed = true;
    }
    if (!changed) break;
    text = output + text.slice(cursor);
  }
  return text;
}

function normalizePrescriptCommands(source) {
  const text = String(source || '');
  const command = /\\prescript\s*\{/g;
  let output = '';
  let cursor = 0;
  for (const match of text.matchAll(command)) {
    if ((match.index ?? 0) < cursor) continue;
    const superscript = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    if (!superscript) continue;
    let position = superscript.end;
    while (/\s/.test(text[position] || '')) position += 1;
    const subscript = balancedGroup(text, position);
    if (!subscript) continue;
    position = subscript.end;
    while (/\s/.test(text[position] || '')) position += 1;
    const base = balancedGroup(text, position);
    if (!base) continue;
    output +=
      text.slice(cursor, match.index ?? 0) + `{}^{${superscript.content}}_{${subscript.content}}{${base.content}}`;
    cursor = base.end;
  }
  return output + text.slice(cursor);
}

function normalizeXyMatrices(source) {
  const text = String(source || '');
  const command = /\\xymatrix(?:@[^\s{]+)?\s*\{/g;
  let output = '';
  let cursor = 0;
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
  const text = String(source || '');
  let output = '';
  let cursor = 0;
  let math = '';
  while (cursor < text.length) {
    if (text.startsWith('\\verb', cursor)) {
      let delimiterIndex = cursor + '\\verb'.length;
      if (text[delimiterIndex] === '*') delimiterIndex += 1;
      const delimiter = text[delimiterIndex];
      if (delimiter && !/[A-Za-z0-9\s]/.test(delimiter)) {
        const literalEnd = text.indexOf(delimiter, delimiterIndex + 1);
        if (literalEnd >= 0) {
          output += text.slice(cursor, literalEnd + 1);
          cursor = literalEnd + 1;
          continue;
        }
      }
    }
    if (!math && text.startsWith('$$', cursor)) {
      math = '$$';
      output += '$$';
      cursor += 2;
      continue;
    }
    if (math === '$$' && text.startsWith('$$', cursor)) {
      math = '';
      output += '$$';
      cursor += 2;
      continue;
    }
    if (!math && text.startsWith('\\[', cursor)) {
      math = '\\]';
      output += '\\[';
      cursor += 2;
      continue;
    }
    if (math === '\\]' && text.startsWith('\\]', cursor)) {
      math = '';
      output += '\\]';
      cursor += 2;
      continue;
    }
    if (!math && text.startsWith('\\(', cursor)) {
      math = '\\)';
      output += '\\(';
      cursor += 2;
      continue;
    }
    if (math === '\\)' && text.startsWith('\\)', cursor)) {
      math = '';
      output += '\\)';
      cursor += 2;
      continue;
    }
    if (!math && text[cursor] === '$' && text[cursor - 1] !== '\\') {
      math = '$';
      output += '$';
      cursor += 1;
      continue;
    }
    if (math === '$' && text[cursor] === '$' && text[cursor - 1] !== '\\') {
      math = '';
      output += '$';
      cursor += 1;
      continue;
    }
    if (!math && text.startsWith('\\\\', cursor)) {
      output += '\n';
      cursor += 2;
      const optional = /^\[[^\]]*\]/.exec(text.slice(cursor));
      if (optional) cursor += optional[0].length;
      continue;
    }
    output += text[cursor];
    cursor += 1;
  }
  return output;
}

function escapedByBackslashes(value, index) {
  let slashes = 0;
  for (let previous = index - 1; previous >= 0 && value[previous] === '\\'; previous -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function stripLatexComments(source) {
  const value = String(source || '');
  if (!value.includes('%')) return value;
  // Percent signs are data inside literal source environments. Preserve them
  // while still treating the dedicated `comment` environment as invisible.
  const literalRanges = mergeSourceRanges(
    literalSourceRanges(value).filter(([start]) => !value.startsWith('\\begin{comment}', start)),
  );
  // Jump between percent signs and join the kept slices once; the ranges are
  // sorted, so one pointer tracks the literal range each sign could fall in.
  const pieces = [];
  let cursor = 0;
  let range = 0;
  for (let index = value.indexOf('%'); index >= 0; index = value.indexOf('%', index + 1)) {
    while (range < literalRanges.length && literalRanges[range][1] <= index) range += 1;
    if ((range < literalRanges.length && literalRanges[range][0] <= index) || escapedByBackslashes(value, index))
      continue;
    pieces.push(value.slice(cursor, index));
    while (index + 1 < value.length && value[index + 1] !== '\n' && value[index + 1] !== '\r') index += 1;
    cursor = index + 1;
  }
  pieces.push(value.slice(cursor));
  return pieces.join('');
}

// Positions of every `%` (and whether it starts a comment) and every line
// break, per long text, so a comment check is two binary searches instead of a
// walk back to the line start, which is quadratic on paragraph-long lines.
const commentIndexes = new Map();
function commentIndex(value) {
  let index = commentIndexes.get(value);
  if (index) return index;
  const percents = [];
  const active = [];
  for (let at = value.indexOf('%'); at >= 0; at = value.indexOf('%', at + 1)) {
    percents.push(at);
    active.push(!escapedByBackslashes(value, at));
  }
  const breaks = [];
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    if (code === 10 || code === 13) breaks.push(at);
  }
  index = { percents, active, breaks };
  if (commentIndexes.size >= 4) commentIndexes.delete(commentIndexes.keys().next().value);
  commentIndexes.set(value, index);
  return index;
}

function lastIndexBelow(sorted, limit) {
  let low = 0;
  let high = sorted.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < limit) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

// TeX reads a line as commented from the nearest `%` before `index` on the
// same line, unless that sign is escaped.
function isLatexCommentedAt(source, index) {
  const value = String(source || '');
  if (value.length < 4096) {
    for (let cursor = index - 1; cursor >= 0 && value[cursor] !== '\n' && value[cursor] !== '\r'; cursor -= 1)
      if (value[cursor] === '%') return !escapedByBackslashes(value, cursor);
    return false;
  }
  const { percents, active, breaks } = commentIndex(value);
  const percent = lastIndexBelow(percents, index);
  if (percent < 0) return false;
  const lineBreak = lastIndexBelow(breaks, index);
  return !(lineBreak >= 0 && breaks[lineBreak] > percents[percent]) && active[percent];
}

function readableLatex(source) {
  const withoutCommentEnvironments = String(source || '').replace(/\\begin\{comment\}[\s\S]*?\\end\{comment\}/g, '');
  const prepared = stripDocumentDeclarations(
    stripLatexComments(normalizeXyMatrices(normalizePrescriptCommands(withoutCommentEnvironments))),
  );
  const readable = unwrapLatexTwoArgumentCommands(unwrapLatexTextCommands(normalizeMathTextCommands(prepared)))
    .replace(/\\selectlanguage\s*\{[^}]*\}/g, '')
    .replace(/\\begin\{(?:otherlanguage\*?|thebibliography)\}(?:\{[^}]*\})?/g, '')
    .replace(/\\end\{(?:otherlanguage\*?|thebibliography)\}/g, '')
    .replace(/\\(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b/g, '')
    .replace(/\\label\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g, '')
    // A reference whose label is nowhere in the source prints as LaTeX prints it.
    .replace(/\\(?:crefrange|Crefrange|cpagerefrange|Cpagerefrange)\*?\s*\{[^}]*\}\s*\{[^}]*\}/g, '??')
    .replace(/\\vpageref\*?\s*(?:\[[^\]]*\]\s*)*\{[^}]*\}/g, '')
    .replace(
      new RegExp(`\\\\(?:${referenceCommands})(?![A-Za-z@])\\*?\\s*(?:\\[[^\\]]*\\]\\s*)*\\{[^}]*\\}`, 'g'),
      '??',
    )
    .replace(/\\hyperref\s*\[[^\]]*\]\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\cite\w*\s*(?:\[([^\]]*)\])?\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g, (_match, preNote, postNote, keys) => {
      const locator = [preNote, postNote]
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .join('; ');
      return String(keys)
        .split(',')
        .map((key) => `[[cite:${key.trim()}${locator ? `|${locator}` : ''}]]`)
        .join(' ');
    })
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
    .replace(
      /\\"\{?([aeiouAEIOU])\}?/g,
      (_match, letter) =>
        ({ a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' })[letter] || letter,
    )
    .replace(
      /\\~\{?([anoANO])\}?/g,
      (_match, letter) => ({ a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ' })[letter] || letter,
    )
    // `\\u` and `\\c` are also prefixes of control words such as `\\upsilon`, `\\csc`,
    // or an author's `\\cS`; accept only the braced or space-separated accent forms.
    .replace(
      /\\u(?:\{([aeiouAEIOU])\}|\s+([aeiouAEIOU])(?![A-Za-z]))/g,
      (_match, braced, spaced) =>
        ({ a: 'ă', e: 'ĕ', i: 'ĭ', o: 'ŏ', u: 'ŭ', A: 'Ă', E: 'Ĕ', I: 'Ĭ', O: 'Ŏ', U: 'Ŭ' })[braced || spaced],
    )
    .replace(
      /\\c(?:\{([cCtTsS])\}|\s+([cCtTsS])(?![A-Za-z]))/g,
      (_match, braced, spaced) => ({ c: 'ç', C: 'Ç', t: 'ţ', T: 'Ţ', s: 'ş', S: 'Ş' })[braced || spaced],
    )
    .replace(/\\v(?:\{([cszCSZ])\}|\s+([cszCSZ])\b)/g, (_match, braced, spaced) => {
      const letter = braced || spaced;
      return { c: 'č', s: 'š', z: 'ž', C: 'Č', S: 'Š', Z: 'Ž' }[letter] || letter;
    })
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
    .replace(
      /\\iddots(?![A-Za-z@])/g,
      '\\mathinner{\\raisebox{-.4em}{$\\cdot$}\\mkern2mu\\cdot\\mkern2mu\\raisebox{.4em}{$\\cdot$}}',
    )
    .replace(/\\\[\s*\\\]/g, '')
    .replace(/\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g, (_match, content) =>
      /\$/.test(content) ? `\n${content}\n` : `\n$$${content}$$\n`,
    )
    // `aligned` is an inner math environment and is commonly already wrapped
    // in \[...\]. Converting it to another pair of delimiters creates invalid
    // nested math such as \[$$...$$\]. Only promote top-level environments.
    .replace(
      /\\begin\{(?:align|align\*|gather|gather\*|multline|multline\*|eqnarray|eqnarray\*)\}/g,
      () => '$$\\begin{aligned}',
    )
    .replace(
      /\\end\{(?:align|align\*|gather|gather\*|multline|multline\*|eqnarray|eqnarray\*)\}/g,
      () => '\\end{aligned}$$',
    )
    .replace(/\\begin\{(?:enumerate|itemize|description)\}(?:\[[^\]]*\])?/g, '')
    .replace(/\\end\{(?:enumerate|itemize|description)\}/g, '')
    // A list item starts its own paragraph; a numbered or described item shows
    // its label in place of the bullet (marked until paragraphs are split).
    .replace(/\\item(?![A-Za-z@])\s*(?:\[([^\]]*)\])?/g, (_match, label) =>
      label === undefined ? '\n• ' : `\n• \u0007${label.trim()}\u0007 `,
    )
    // Subfigure wrappers are layout; their captions stay as text.
    .replace(/\\begin\{(?:subfigure|subtable)\}(?:\[[^\]]*\])?(?:\s*\{[^}]*\})?/g, '')
    .replace(/\\end\{(?:subfigure|subtable)\}/g, '')
    .replace(/\\subfloat(?![A-Za-z@])(?:\s*\[[^\]]*\])*/g, '')
    .replace(/\\sub(?:caption|captionbox)(?![A-Za-z@])\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g, '$1')
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
    .map((paragraph) =>
      paragraph
        .replace(/[ \t]*\n[ \t]*/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/^•\s*\u0007([^\u0007]*)\u0007\s*/, (_match, label) => (label ? `${label} ` : ''))
        .replace(/\u0007/g, '')
        .trim(),
    )
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
    for (const key of match[3]
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)) {
      const locator = [match[1], match[2]]
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .join('; ');
      if (!mentions.some((item) => item.key === key && item.locator === locator)) mentions.push({ key, locator });
    }
  }
  return mentions;
}

function cleanBibliographyFragment(value) {
  return readableLatex(
    String(value || '')
      .replace(/\\newblock\b/g, '\n')
      .replace(/\{\\(?:em|it|bf)\s+([^{}]*)\}/g, '$1')
      .replace(/\\(?:url|nolinkurl|path)\s*\{([^}]*)\}/g, '$1')
      .replace(/\\href\s*\{[^}]*\}\s*\{([^}]*)\}/g, '$1'),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBibliography(source) {
  const text = String(source || '');
  const literalRanges = literalSourceRanges(text);
  const matches = [...text.matchAll(/\\bibitem(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)].filter(
    (match) => !insideSourceRanges(match.index ?? 0, literalRanges) && !isLatexCommentedAt(text, match.index ?? 0),
  );
  const references = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const raw = text.slice(
      (match.index ?? 0) + match[0].length,
      matches[index + 1]?.index ?? text.indexOf('\\end{thebibliography}', (match.index ?? 0) + match[0].length),
    );
    const blocks = raw
      .split(/\\newblock\b/)
      .map(cleanBibliographyFragment)
      .filter(Boolean);
    const citationText = cleanBibliographyFragment(raw);
    const title = blocks[1] || blocks[0] || match[1];
    const authors = blocks.length > 1 ? blocks[0] : '';
    const href = /\\href\s*\{([^}]+)\}/.exec(raw)?.[1];
    const explicitUrl = /\\(?:url|nolinkurl|path)\s*\{([^}]+)\}/.exec(raw)?.[1] || /https?:\/\/[^\s}]+/.exec(raw)?.[0];
    const doi = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i.exec(raw)?.[0]?.replace(/[.,;]+$/, '') || '';
    const arxivId = /(?:arXiv\s*:\s*|arXiv\s+)([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i.exec(citationText)?.[1] || '';
    const searchQuery = [title, authors].filter(Boolean).join(' ');
    const searchUrl = `https://scholar.google.com/scholar?q=${encodeURIComponent(searchQuery)}`;
    const url =
      explicitUrl ||
      href ||
      (doi ? `https://doi.org/${doi}` : arxivId ? `https://arxiv.org/abs/${arxivId}` : searchUrl);
    references.set(match[1], {
      key: match[1],
      title,
      authors,
      text: citationText,
      url,
      searchUrl,
      doi,
      arxivId,
      direct: Boolean(explicitUrl || href || doi || arxivId),
    });
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
  return readableLatex(
    String(value || '')
      .replace(/[{}]/g, '')
      .replace(/\\&/g, '&'),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanBibtexUrl(value) {
  return String(value || '')
    .trim()
    .replace(/^\{+|\}+$/g, '')
    .replace(/\\([%#&_{}])/g, '$1');
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
    const url =
      explicitUrl || (doi ? `https://doi.org/${doi}` : arxivId ? `https://arxiv.org/abs/${arxivId}` : searchUrl);
    references.set(key, {
      key,
      title,
      authors,
      text,
      url,
      searchUrl,
      doi,
      arxivId,
      direct: Boolean(explicitUrl || doi || arxivId),
    });
  }
  return references;
}

async function extractBibliographyTree(source, sourceRoot, entryFile = '') {
  const references = extractBibliography(source);
  const value = String(source || '');
  const literalRanges = literalSourceRanges(value);
  const requested = [];
  for (const match of value.matchAll(/\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(value, match.index ?? 0)) continue;
    for (const name of match[1]
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean))
      requested.push(name);
  }
  for (const name of requested) {
    const filename = /\.bib$/i.test(name) ? name : `${name}.bib`;
    const candidate = path.resolve(sourceRoot, filename);
    const relative = path.relative(sourceRoot, candidate);
    if (relativePathEscapes(relative)) continue;
    try {
      for (const [key, reference] of extractBibtex(decodeSourceBuffer(await readFile(candidate))))
        references.set(key, reference);
    } catch {
      /* A missing bibliography remains a non-fatal, explicit lookup. */
    }
  }
  // arXiv does not run BibTeX, so most submissions ship the compiled <jobname>.bbl
  // and often no .bib at all. Use it for every key the .bib files did not supply.
  if (requested.length && entryFile) {
    const directory = path.dirname(entryFile);
    const candidates = [path.join(directory, `${path.basename(entryFile, path.extname(entryFile))}.bbl`)];
    try {
      candidates.push(
        ...(await readdir(directory))
          .filter((name) => /\.bbl$/i.test(name))
          .sort()
          .map((name) => path.join(directory, name)),
      );
    } catch {
      /* An unreadable directory leaves only the .bib records. */
    }
    for (const candidate of new Set(candidates)) {
      if (relativePathEscapes(path.relative(sourceRoot, candidate))) continue;
      let compiled;
      try {
        compiled = extractBibliography(decodeSourceBuffer(await readFile(candidate)));
      } catch {
        continue;
      }
      for (const [key, reference] of compiled) if (!references.has(key)) references.set(key, reference);
      if (compiled.size) break;
    }
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
  // Accept every form stripDocumentDeclarations removes: starred, brace-less
  // names (\\newcommand\\R{...}), \\providecommand, and \\DeclareRobustCommand.
  const declarations =
    /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))\s*(?:\[(\d+)\])?\s*(?:\[([^\]]*)\])?\s*\{/g;
  for (const match of text.matchAll(declarations)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(text, match.index ?? 0)) continue;
    const name = match[2] || match[3];
    if (match[1] === 'providecommand' && macros.has(name)) continue;
    const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    if (group) macros.set(name, { replacement: group.content, arity: Number(match[4] || 0), defaultArg: match[5] });
  }
  const pairedRanges = [];
  for (const match of text.matchAll(
    /\\DeclarePairedDelimiter(XPP|X)?\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))\s*(?:\[(\d)\])?/g,
  )) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(text, match.index ?? 0)) continue;
    // Delimiters are often single tokens: \\DeclarePairedDelimiter\\paren().
    const parts = readMacroArguments(text, (match.index ?? 0) + match[0].length, pairedDelimiterParts(match[1]));
    if (!parts) continue;
    pairedRanges.push([match.index ?? 0, parts.end]);
    const [pre, left, right, post, body] =
      match[1] === 'XPP'
        ? parts.contents
        : ['', parts.contents[0], parts.contents[1], '', match[1] ? parts.contents[2] : '#1'];
    macros.set(
      match[2] || match[3],
      pairedDelimiterMacro(pre, left, right, post, body, match[1] ? Number(match[4] || 0) : 1),
    );
  }
  for (const match of text.matchAll(/\\def\s*\\([A-Za-z@]+)\s*((?:#\d\s*)*)\{/g)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(text, match.index ?? 0)) continue;
    // A helper such as \\given defined inside a paired delimiter's body is
    // local to each use of that delimiter; pairedDelimiterMacro applies it.
    if (insideSourceRanges(match.index ?? 0, pairedRanges)) continue;
    const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    let arity = Math.max(0, ...[...String(match[2] || '').matchAll(/#(\d)/g)].map((item) => Number(item[1])));
    let replacement = group?.content || '';
    if (arity === 0 && /^\\(?:widehat|widetilde|overline|underline)$/.test(replacement.trim())) {
      arity = 1;
      replacement = `${replacement.trim()}{#1}`;
    }
    if (group) macros.set(match[1], { replacement, arity });
  }
  for (const match of text.matchAll(/\\DeclareMathOperator(\*?)\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))\s*\{/g)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(text, match.index ?? 0)) continue;
    const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    // The starred form places sub/superscripts as limits, like \\lim.
    if (group)
      macros.set(match[2] || match[3], { replacement: `\\operatorname${match[1]}{${group.content}}`, arity: 0 });
  }
  for (const match of text.matchAll(
    /\\(New|Renew|Provide|Declare)(?:Expandable)?DocumentCommand\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))\s*\{/g,
  )) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(text, match.index ?? 0)) continue;
    const name = match[2] || match[3];
    const spec = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    const body = spec && readMacroArgument(text, spec.end);
    if (!body || (match[1] === 'Provide' && macros.has(name))) continue;
    const macro = documentCommandMacro(spec.content, body.content);
    if (macro) macros.set(name, macro);
    // An argument type or conditional this reader cannot follow leaves the
    // command undefined rather than half-expanded.
    else macros.delete(name);
  }
  for (const match of text.matchAll(/\\let\s*\\([A-Za-z@]+)\s*(?:=\s*)?\\([A-Za-z@]+)/g)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(text, match.index ?? 0)) continue;
    const takesArgument = /^(?:widehat|widetilde|overline|underline)$/.test(match[2]);
    macros.set(match[1], {
      replacement: takesArgument ? `\\${match[2]}{#1}` : `\\${match[2]}`,
      arity: takesArgument ? 1 : 0,
    });
  }
  return macros;
}

// mathtools reads `\\abs{x}`, the scaling `\\abs*{x}`, and a fixed size
// `\\abs[\\big]{x}`. The reader scales the plain form too; inside the body,
// \\delimsize is the size of the delimiter it precedes.
function pairedDelimiterMacro(pre, left, right, post, body, arity) {
  const locals = [];
  const ownBody = body.replace(/\\def\s*\\([A-Za-z@]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_definition, name, value) => {
    locals.push([new RegExp(`\\\\${name}(?![A-Za-z@])`, 'g'), value]);
    return '';
  });
  const sized = (content, middle) =>
    content
      .replace(
        /\\delimsize(?![A-Za-z@])\s*(?=[|/]|\\(?:\||vert|Vert|lvert|rvert|lVert|rVert|backslash|langle|rangle)(?![A-Za-z@]))/g,
        () => middle,
      )
      .replace(/\\delimsize(?![A-Za-z@])\s*/g, '');
  const delimited = (open, middle, close) =>
    joinControlWords(pre, open, left.trim() || '.', sized(ownBody, middle), close, right.trim() || '.', post);
  return {
    replacement: delimited('\\left', '\\middle', '\\right'),
    signature: ['s', {}, ...Array.from({ length: arity }, () => 'm')],
    expand: ([, size, ...values]) => {
      const fixed = /^\s*\\(big|Big|bigg|Bigg)[lrm]?\s*$/.exec(size || '')?.[1];
      const [open, middle, close] = fixed
        ? [`\\${fixed}l`, `\\${fixed}`, `\\${fixed}r`]
        : ['\\left', '\\middle', '\\right'];
      return {
        template: delimited(open, middle, close),
        values: values.map((value) =>
          locals.reduce((result, [name, local]) => result.replace(name, () => sized(local, middle)), value),
        ),
      };
    },
  };
}

// xparse argument types that read like \\newcommand's: mandatory `m`, the
// optional `o` and `O{default}`, and the star `s`. `+` only allows paragraphs.
function documentCommandMacro(spec, body) {
  const signature = [];
  for (let index = 0; index < spec.length; index += 1) {
    const type = spec[index];
    if (/[\s+]/.test(type)) continue;
    if (type === 'm' || type === 's') signature.push(type);
    else if (type === 'o') signature.push({});
    else if (type === 'O') {
      const fallback = readMacroArgument(spec, index + 1);
      if (!fallback) return null;
      signature.push({ default: fallback.content });
      index = fallback.end - 1;
    } else return null;
  }
  // Every branch must resolve, whichever arguments a use supplies.
  const absent = signature.map((kind) => (kind === 's' ? false : kind === 'm' ? '' : kind.default));
  const present = signature.map((kind) => kind === 's' || '');
  if (resolveDocumentConditionals(body, absent) === null || resolveDocumentConditionals(body, present) === null)
    return null;
  return {
    replacement: body,
    signature,
    expand: (args) => {
      const template = resolveDocumentConditionals(body, args);
      // A star or an absent optional argument has no text of its own.
      return template === null
        ? null
        : { template, values: args.map((value) => (typeof value === 'string' ? value : '')) };
    },
  };
}

// Resolves \\IfNoValueTF, \\IfValueTF, and \\IfBooleanTF (and their T and F
// forms) on a bare argument. Returns null if any other xparse test remains.
function resolveDocumentConditionals(body, args) {
  let text = body;
  for (let guard = 0; guard < 256; guard += 1) {
    const match = /\\If(NoValue|Value|Boolean)(TF|T|F)(?![A-Za-z@])\s*/.exec(text);
    if (!match) break;
    const test = balancedGroup(text, match.index + match[0].length);
    const parameter = test && /^\s*#(\d)\s*$/.exec(test.content);
    if (!parameter) return null;
    const value = args[Number(parameter[1]) - 1];
    const holds = match[1] === 'Boolean' ? value === true : (value === undefined) === (match[1] === 'NoValue');
    let position = test.end;
    let chosen = '';
    for (const branch of match[2]) {
      while (/\s/.test(text[position] || '')) position += 1;
      const group = balancedGroup(text, position);
      if (!group) return null;
      if ((branch === 'T') === holds) chosen = group.content;
      position = group.end;
    }
    text = text.slice(0, match.index) + chosen + text.slice(position);
  }
  return /\\(?:If[A-Za-z]*(?:TF|T|F)|BooleanTrue|BooleanFalse|NoValue)(?![A-Za-z@])/.test(text) ? null : text;
}

// Joins TeX fragments, keeping a control word at the end of one fragment from
// absorbing a letter at the start of the next.
function joinControlWords(...parts) {
  return parts.reduce(
    (joined, part) => (/\\[A-Za-z@]+$/.test(joined) && /^[A-Za-z@]/.test(part) ? `${joined} ${part}` : joined + part),
    '',
  );
}

// A mandatory argument is a balanced group or, as in TeX, a single token.
function readMacroArgument(text, position) {
  while (/\s/.test(text[position] || '')) position += 1;
  const group = balancedGroup(text, position);
  if (group) return group;
  const token = text[position] === '\\' ? /^\\[A-Za-z@]+|^\\./.exec(text.slice(position))?.[0] : text[position];
  return token ? { content: token, end: position + token.length } : null;
}

function readMacroArguments(text, position, count) {
  const contents = [];
  let end = position;
  while (contents.length < count) {
    const argument = readMacroArgument(text, end);
    if (!argument) return null;
    contents.push(argument.content);
    end = argument.end;
  }
  return { contents, end };
}

// The plain, X, and XPP forms take 2, 3, and 5 arguments after the name.
function pairedDelimiterParts(form) {
  return form === 'XPP' ? 5 : form === 'X' ? 3 : 2;
}

// Reads a use of a macro with a star or optional arguments in its signature.
// An absent optional argument is undefined, xparse's NoValue.
function expandSignatureUse(text, position, macro) {
  const args = [];
  let end = position;
  for (const kind of macro.signature) {
    if (kind === 'm') {
      const argument = readMacroArgument(text, end);
      if (!argument) return null;
      args.push(argument.content);
      end = argument.end;
      continue;
    }
    // Look past spaces for `*` or `[`, but keep them when neither follows:
    // they may end the control word.
    let next = end;
    while (/\s/.test(text[next] || '')) next += 1;
    if (kind === 's') {
      args.push(text[next] === '*');
      if (text[next] === '*') end = next + 1;
      continue;
    }
    const optional = balancedGroup(text, next, '[', ']');
    args.push(optional ? optional.content : kind.default);
    if (optional) end = optional.end;
  }
  const expansion = macro.expand(args);
  return expansion && { replacement: substituteMacroArguments(expansion.template, expansion.values), end };
}

// Reads one use of an author macro whose name ends at `position`: its
// arguments, then the replacement text with the arguments substituted.
function expandMacroUse(text, position, macro) {
  const use = macro.signature ? expandSignatureUse(text, position, macro) : expandArityUse(text, position, macro);
  // A replacement ending in a control word must not absorb the letter after
  // the use: `\\norm{x}y` would otherwise become the undefined `\\rVerty`.
  if (use && /\\[A-Za-z@]+$/.test(use.replacement) && /[A-Za-z@]/.test(text[use.end] || '')) use.replacement += ' ';
  return use;
}

function expandArityUse(text, position, macro) {
  const args = [];
  // TeX uses whitespace to terminate a zero-argument control word. Preserve
  // that separator or `\\leq R` becomes the undefined command `\\leqslantR`.
  if (macro.arity > 0 || macro.defaultArg !== undefined) while (/\s/.test(text[position] || '')) position += 1;
  if (macro.defaultArg !== undefined) {
    const optional = balancedGroup(text, position, '[', ']');
    args.push(optional ? optional.content : macro.defaultArg);
    if (optional) position = optional.end;
  }
  for (let argIndex = args.length; argIndex < macro.arity; argIndex += 1) {
    const argument = readMacroArgument(text, position);
    if (!argument) return null;
    args.push(argument.content);
    position = argument.end;
  }
  return { replacement: substituteMacroArguments(macro.replacement, args), end: position };
}

function substituteMacroArguments(template, args) {
  let replacement = template;
  args.forEach((argument, index) => {
    replacement = replacement.replace(
      macroParameters[index] || new RegExp(`#${index + 1}`, 'g'),
      (_placeholder, offset, whole) => {
        // TeX tokenizes a control word before substituting macro parameters.
        // Preserve that boundary or `\\lVert#1` with `#1=A` becomes the
        // undefined reader command `\\lVertA`.
        const needsBoundary = /\\[A-Za-z@]+$/.test(whole.slice(0, offset)) && /^[A-Za-z@]/.test(argument);
        return needsBoundary ? ` ${argument}` : argument;
      },
    );
  });
  return replacement;
}

const macroParameters = Array.from({ length: 9 }, (_, index) => new RegExp(`#${index + 1}`, 'g'));

// One expansion pass: a single scan over control words with a table lookup,
// against this pass's literal ranges and comment index. Arguments are taken
// unexpanded, as TeX takes them, and are expanded by the next pass. Returns
// null once the output would outgrow `limit`.
function expandMacroPass(text, macros, limit) {
  const literalRanges = mergeSourceRanges(literalSourceRanges(text));
  const controlWord = /\\([A-Za-z@]+)/g;
  const pieces = [];
  let length = 0;
  let cursor = 0;
  let range = 0;
  for (let match = controlWord.exec(text); match; match = controlWord.exec(text)) {
    const macro = macros.get(match[1]);
    if (!macro) continue;
    const start = match.index;
    while (range < literalRanges.length && literalRanges[range][1] <= start) range += 1;
    if ((range < literalRanges.length && literalRanges[range][0] <= start) || isLatexCommentedAt(text, start)) continue;
    const use = expandMacroUse(text, start + match[0].length, macro);
    if (!use) continue;
    length += start - cursor + use.replacement.length;
    if (length + text.length - use.end > limit) return null;
    pieces.push(text.slice(cursor, start), use.replacement);
    cursor = use.end;
    controlWord.lastIndex = cursor;
  }
  if (!pieces.length) return text;
  pieces.push(text.slice(cursor));
  return pieces.join('');
}

function expandSimpleEnvironments(source) {
  const text = String(source || '');
  const literalRanges = literalSourceRanges(text);
  const definitions = [];
  for (const match of text.matchAll(/\\(?:newenvironment|renewenvironment)\s*\{([^}]+)\}(?!\s*\[)\s*\{/g)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(text, match.index ?? 0)) continue;
    const begin = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    if (!begin) continue;
    let position = begin.end;
    while (/\s/.test(text[position] || '')) position += 1;
    const end = balancedGroup(text, position);
    if (end) definitions.push({ name: match[1], begin: begin.content, end: end.content });
  }
  let expanded = text;
  for (const definition of definitions) {
    const escaped = definition.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expanded = expanded
      .replace(new RegExp(`\\\\begin\\{${escaped}\\}`, 'g'), () => definition.begin)
      .replace(new RegExp(`\\\\end\\{${escaped}\\}`, 'g'), () => definition.end);
  }
  return expanded;
}

let lastMacroExpansion = { source: null, expanded: '' };
function expandAuthorMacros(source) {
  const text = String(source || '');
  // One enrichment expands the same text several times; reuse the last result.
  if (lastMacroExpansion.source === text) return lastMacroExpansion.expanded;
  const macros = authorMacroTable(text);
  // Collect definitions before removing them, then expand only author-facing
  // uses. Expanding the command name inside its own `\newcommand` declaration
  // corrupts the declaration and can make it appear as proof text.
  let expanded = stripDocumentDeclarations(expandSimpleEnvironments(text));
  // A recursive definition such as \def\a{\a\a} doubles its uses every pass,
  // so stop expanding before the document outgrows this budget.
  const limit = Math.max(4 * text.length, text.length + 2 * 1024 * 1024);
  // Each pass expands one level. After four, only macros that cannot reach
  // themselves continue, so a deep but finite chain still resolves while a
  // recursive definition stops where it always did.
  let table = macros;
  for (let pass = 0; pass < 16 && table.size; pass += 1) {
    if (pass === 4) table = finiteMacros(macros);
    const next = expandMacroPass(expanded, table, limit);
    if (next === null || next === expanded) break;
    expanded = next;
  }
  lastMacroExpansion = { source: text, expanded };
  return expanded;
}

function finiteMacros(macros) {
  const references = new Map(
    [...macros].map(([name, macro]) => [
      name,
      [...macro.replacement.matchAll(/\\([A-Za-z@]+)/g)].map((match) => match[1]).filter((used) => macros.has(used)),
    ]),
  );
  const reachesItself = (name) => {
    const seen = new Set();
    const stack = [...references.get(name)];
    while (stack.length) {
      const next = stack.pop();
      if (next === name) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...references.get(next));
    }
    return false;
  };
  return new Map([...macros].filter(([name]) => !reachesItself(name)));
}

function theoremKind(title, environment) {
  const value = `${title} ${environment}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
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

const theoremLikeKinds = new Set([
  'theorem',
  'lemma',
  'proposition',
  'corollary',
  'conjecture',
  'definition',
  'assumption',
  'notation',
  'remark',
  'example',
]);

// Reads the printed number an AI label cites and the name written before it:
// "Lemma 2.3", "Theorem 1.2 (Main)", "Proposition A.1", or "Thm. 4".
function printedLabelNumber(label) {
  const match = /^\s*([^\d(]*?)[\s~.:]*(\d+(?:\.\d+)*[a-z]?|(?<![A-Za-z])[A-Z](?:\.\d+)*)(?![\w']|\.\d)/.exec(
    String(label || ''),
  );
  if (!match) return null;
  const name = match[1].replace(/[\s~.:]+$/, '').trim();
  // A lone capital without a name is prose ("A priori bound"), not "Theorem A".
  return /^\d/.test(match[2]) || name ? { name, number: match[2] } : null;
}

function labelNameFits(name, unit) {
  if (!name) return true;
  const normalize = (value) =>
    String(value || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[\s~.]+/g, ' ')
      .trim();
  const cited = normalize(name);
  const printed = normalize(unit.displayName);
  if (printed && (printed.startsWith(cited) || cited.endsWith(printed))) return true;
  // "Section 2.3" or "Equation (4)" cites document structure, never a result.
  if (
    /\b(?:sections?|subsections?|chapters?|parts?|appendix|equations?|eqs?|figures?|figs?|tables?|pages?)\b|§/.test(
      cited,
    )
  )
    return false;
  // Abbreviations such as "Thm." or "Prop." still identify the result kind.
  return theoremKind(cited, cited) === unit.kind;
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
    .filter(
      (match) => !insideSourceRanges(match.index ?? 0, literalRanges) && !isLatexCommentedAt(value, match.index ?? 0),
    )
    .map((match) => match[1].trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function literalSourceRanges(source) {
  const value = String(source || '');
  const ranges = [];
  for (const match of value.matchAll(
    /\\begin\{(verbatim\*?|Verbatim|lstlisting|minted|comment|alltt)\}(?:\[[^\]]*\])?(?:\{[^}]*\})?[\s\S]*?\\end\{\1\}/g,
  )) {
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

// Sorted, non-overlapping union of [start, end) ranges, for callers that walk
// increasing positions with a single pointer.
function mergeSourceRanges(ranges) {
  const merged = [];
  for (const [start, end] of [...ranges].sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function sourceProofEvents(source, units = [], declarationSource = source) {
  const value = String(source || '');
  const literalRanges = literalSourceRanges(value);
  const proofEnvironments = new Set(['proof']);
  const definitions = String(declarationSource || '');
  const definitionLiteralRanges = literalSourceRanges(definitions);
  for (const match of definitions.matchAll(/\\newenvironment\s*\{([^}]+)\}(?:\[(\d+)\])?(?:\[([^\]]*)\])?/g)) {
    if (
      insideSourceRanges(match.index ?? 0, definitionLiteralRanges) ||
      isLatexCommentedAt(definitions, match.index ?? 0)
    )
      continue;
    if (/^proof/i.test(match[1]) || /proof|preuve|démonstration/i.test(match[3] || '')) proofEnvironments.add(match[1]);
  }
  const proofNames = [...proofEnvironments].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!proofNames) return [];
  const pattern = new RegExp(`\\\\begin\\{(${proofNames})\\}(?:\\[([^\\]]*)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`, 'g');
  const events = [];
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (insideSourceRanges(start, literalRanges) || isLatexCommentedAt(value, start)) continue;
    const end = start + match[0].length;
    const linkedUnit =
      units.find((candidate) => candidate.proofStart === start) ||
      units.find((candidate) => candidate.start < start && start < candidate.end);
    const unit = linkedUnit || {
      proofText: readableLatex(match[3]),
      proofAssetPaths: graphicPaths(match[3]),
      citationMentions: citationMentions(match[3]),
      citations: [],
      nodeId: '',
      kind: 'theorem',
    };
    events.push({ type: 'proof', start, end, unit });
  }
  return events;
}

const defaultTheoremEnvironments = [
  ['theorem', 'theorem', 'Theorem'],
  ['thm', 'theorem', 'Theorem'],
  ['lemma', 'lemma', 'Lemma'],
  ['lem', 'lemma', 'Lemma'],
  ['proposition', 'proposition', 'Proposition'],
  ['prop', 'proposition', 'Proposition'],
  ['corollary', 'corollary', 'Corollary'],
  ['cor', 'corollary', 'Corollary'],
  ['conjecture', 'conjecture', 'Conjecture'],
  ['conj', 'conjecture', 'Conjecture'],
  ['definition', 'definition', 'Definition'],
  ['defn', 'definition', 'Definition'],
  ['assumption', 'assumption', 'Assumption'],
  ['notation', 'notation', 'Notation'],
  ['remark', 'remark', 'Remark'],
  ['rem', 'remark', 'Remark'],
  ['example', 'example', 'Example'],
];

// Splits a key=value list at top-level commas: `name={A, B}, sibling=theorem`.
function keyValueOptions(value) {
  const options = new Map();
  const text = String(value || '');
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const character = text[index];
    if (character === '{') depth += 1;
    else if (character === '}') depth = Math.max(0, depth - 1);
    else if (index === text.length || (character === ',' && !depth)) {
      const part = text.slice(start, index);
      start = index + 1;
      const equals = part.indexOf('=');
      const key = (equals < 0 ? part : part.slice(0, equals)).trim();
      let entry = equals < 0 ? '' : part.slice(equals + 1).trim();
      if (entry.startsWith('{') && entry.endsWith('}')) entry = entry.slice(1, -1).trim();
      if (key) options.set(key, entry);
    }
  }
  return options;
}

// The theorem environments llncs defines itself, as [environment, name, numbered].
const llncsTheorems = [
  ['theorem', 'Theorem', true],
  ['case', 'Case', true],
  ['claim', 'Claim', false],
  ['conjecture', 'Conjecture', true],
  ['corollary', 'Corollary', true],
  ['definition', 'Definition', true],
  ['example', 'Example', true],
  ['exercise', 'Exercise', true],
  ['lemma', 'Lemma', true],
  ['note', 'Note', true],
  ['problem', 'Problem', true],
  ['property', 'Property', true],
  ['proposition', 'Proposition', true],
  ['question', 'Question', true],
  ['solution', 'Solution', true],
  ['remark', 'Remark', true],
];

function theoremDeclarations(source) {
  const text = String(source || '');
  const literalRanges = literalSourceRanges(text);
  const active = (pattern) =>
    [...text.matchAll(pattern)].filter(
      (match) => !insideSourceRanges(match.index ?? 0, literalRanges) && !isLatexCommentedAt(text, match.index ?? 0),
    );
  const environments = new Map(defaultTheoremEnvironments.map(([name, kind]) => [name, kind]));
  const displayNames = new Map(defaultTheoremEnvironments.map(([name, , displayName]) => [name, displayName]));
  const counters = new Map();
  // Reference names a declaration gives its type (thmtools refname/Refname).
  const referenceNames = new Map();
  // \newaliascnt{lemma}{theorem}: a counter that is another counter under a new name.
  const aliases = new Map();
  const declare = (environment, displayName, counter) => {
    environments.set(environment, theoremKind(displayName, environment));
    displayNames.set(environment, displayName);
    counters.set(environment, counter);
  };
  // llncs declares its environments in the class, with separate counters unless
  // envcountsame, numbered within sections under envcountsect.
  const llncs = active(/\\documentclass\s*(?:\[([^\]]*)\])?\s*\{\s*llncs\s*\}/g)[0];
  if (llncs) {
    const shared = /\benvcountsame\b/.test(llncs[1] || '');
    const within = /\benvcountsect\b/.test(llncs[1] || '') ? 'section' : '';
    for (const [environment, displayName, numbered] of llncsTheorems)
      declare(environment, displayName, {
        start: llncs.index ?? 0,
        root: shared && numbered ? 'theorem' : environment,
        within: !shared || environment === 'theorem' ? within : '',
        numbered,
      });
  }
  // \newtheorem and llncs's \spnewtheorem (whose trailing font arguments do not matter here).
  for (const match of active(
    /\\(?:newtheorem|spnewtheorem)(\*)?\s*\{([^}]+)\}(?:\[([^\]]+)\])?\s*\{([^}]+)\}(?:\[([^\]]+)\])?/g,
  )) {
    const environment = match[2].trim();
    declare(environment, readableLatex(match[4]), {
      start: match.index ?? 0,
      root: String(match[3] || '').trim() || environment,
      within: String(match[5] || '').trim(),
      numbered: !match[1],
    });
  }
  // thmtools: \declaretheorem[options]{names} or \declaretheorem{names}[options].
  for (const match of active(/\\declaretheorem\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}(?:\s*\[([^\]]*)\])?/g)) {
    const options = keyValueOptions([match[1], match[3]].filter(Boolean).join(','));
    const names = (value) =>
      value
        ? value
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean)
        : null;
    for (const environment of names(match[2]) || []) {
      const name = options.get('name') || options.get('title') || options.get('heading');
      declare(environment, readableLatex(name || environment[0].toUpperCase() + environment.slice(1)), {
        start: match.index ?? 0,
        root: options.get('sibling') || options.get('numberlike') || options.get('sharenumber') || environment,
        within: options.get('parent') || options.get('numberwithin') || options.get('within') || '',
        numbered: !/^no$/i.test(options.get('numbered') || ''),
      });
      if (options.has('refname') || options.has('Refname'))
        referenceNames.set(environment, { cref: names(options.get('refname')), Cref: names(options.get('Refname')) });
    }
  }
  for (const match of active(/\\newaliascnt\s*\{([^}]+)\}\s*\{([^}]+)\}/g))
    aliases.set(match[1].trim(), match[2].trim());
  return { environments, displayNames, counters, referenceNames, aliases };
}

const nestedNumberedEnvironments =
  /\\begin\{(equation|align|gather|multline|flalign|alignat|eqnarray|subequations|figure|table)(\*?)\}[\s\S]*?\\end\{\1\2\}/g;
const bookLikeClasses = /^(?:book|report|amsbook|scrbook|scrreprt|memoir)$/;
const sectionDepths = {
  part: -1,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};
const equationEnvironments = /^(?:equation|align|gather|multline|flalign|alignat|xalignat|xxalignat|eqnarray)\*?$/;
const floatCounters = new Map([
  ['figure', 'figure'],
  ['figure*', 'figure'],
  ['wrapfigure', 'figure'],
  ['sidewaysfigure', 'figure'],
  ['table', 'table'],
  ['table*', 'table'],
  ['wraptable', 'table'],
  ['sidewaystable', 'table'],
]);

function romanNumeral(value) {
  let rest = Math.min(Math.max(0, Math.floor(value)), 9999);
  let output = '';
  for (const [amount, digits] of [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ])
    for (; rest >= amount; rest -= amount) output += digits;
  return output;
}

const counterFormats = {
  arabic: (value) => String(value),
  alph: (value) => (value > 0 && value <= 26 ? String.fromCharCode(96 + value) : String(value)),
  Alph: (value) => (value > 0 && value <= 26 ? String.fromCharCode(64 + value) : String(value)),
  roman: (value) => romanNumeral(value),
  Roman: (value) => romanNumeral(value).toUpperCase(),
};

// Parses a printed form such as \renewcommand{\theequation}{\thesection.\arabic{equation}}.
// Anything beyond \the<counter>, the counter formats, and plain text is ignored.
function counterTemplate(replacement) {
  const parts = [];
  let cursor = 0;
  const pattern =
    /\\the([A-Za-z]+)|\\@?(arabic|alph|Alph|roman|Roman)\s*(?:\{\s*([A-Za-z*]+)\s*\}|\\c@([A-Za-z]+))|([^\\{}]+)|[{}]/g;
  for (const match of replacement.matchAll(pattern)) {
    if (match.index !== cursor) return null;
    cursor += match[0].length;
    if (match[1]) parts.push({ the: match[1] });
    else if (match[2]) parts.push({ format: match[2], counter: match[3] || match[4] });
    else if (match[5]) parts.push({ text: match[5] });
  }
  return cursor === replacement.length && parts.length ? parts : null;
}

// Splits an align-like body into its rows at `\\` outside nested groups and
// environments, so `cases`, `aligned`, or `\substack` rows never add numbers.
function topLevelRows(text) {
  const rows = [];
  let start = 0;
  let braces = 0;
  let environments = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\\') {
      if (text[index + 1] === '\\' && !braces && !environments) {
        rows.push(text.slice(start, index));
        start = index + 2;
      } else if (text.startsWith('begin{', index + 1)) environments += 1;
      else if (text.startsWith('end{', index + 1)) environments = Math.max(0, environments - 1);
      index += 1;
    } else if (text[index] === '{') braces += 1;
    else if (text[index] === '}') braces = Math.max(0, braces - 1);
  }
  rows.push(text.slice(start));
  return rows;
}

// Replays the LaTeX counters that \ref prints, in document order: sectioning
// (with \appendix letters and secnumdepth), theorem counters, equation rows,
// subequations, and float captions. Declarations come from the author source;
// the walk runs on the macro-expanded body so macro-built displays count too.
function latexNumbering(declarationSource, body, declarations = theoremDeclarations(declarationSource)) {
  const config = String(declarationSource || '');
  const text = String(body || '');
  const configRanges = literalSourceRanges(config);
  const literalRanges = literalSourceRanges(text);
  const activeMatches = (source, ranges, pattern) =>
    [...source.matchAll(pattern)].filter(
      (match) => !insideSourceRanges(match.index ?? 0, ranges) && !isLatexCommentedAt(source, match.index ?? 0),
    );
  const documentClass = activeMatches(
    config,
    configRanges,
    /\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*([^}\s]+)\s*\}/g,
  )[0];
  const className = documentClass?.[1] || '';
  const hasChapters =
    bookLikeClasses.test(className) ||
    activeMatches(text, literalRanges, /\\chapter\*?(?:\[[^\]]*\])?\s*\{/g).length > 0;
  let secnumdepth = hasChapters && className !== 'amsbook' ? 2 : 3;

  const counters = new Map();
  const counter = (name) => {
    if (!counters.has(name))
      counters.set(name, { value: 0, format: 'arabic', within: '', resets: new Set(), template: null });
    return counters.get(name);
  };
  const numberWithin = (name, parent, printed = true) => {
    const state = counter(name);
    state.resets.add(parent);
    if (printed) Object.assign(state, { within: parent, template: null });
  };
  const the = (name, depth = 0) => {
    const state = counter(name);
    if (depth > 8) return '';
    if (state.template)
      return state.template
        .map((part) =>
          part.the
            ? the(part.the, depth + 1)
            : part.format
              ? counterFormats[part.format](counter(part.counter).value)
              : part.text,
        )
        .join('')
        .trim();
    const own = counterFormats[state.format](state.value);
    return state.within ? `${the(state.within, depth + 1)}.${own}` : own;
  };
  const resetWithin = (parent, depth = 0) => {
    for (const [name, state] of counters)
      if (state.resets.has(parent) && depth < 8) {
        state.value = 0;
        resetWithin(name, depth + 1);
      }
  };
  const step = (name) => {
    counter(name).value += 1;
    resetWithin(name);
  };

  counter('part').format = 'Roman';
  if (hasChapters) for (const name of ['section', 'equation', 'figure', 'table']) numberWithin(name, 'chapter');
  if (hasChapters) numberWithin('footnote', 'chapter', false);
  numberWithin('subsection', 'section');
  numberWithin('subsubsection', 'subsection');
  numberWithin('paragraph', 'subsubsection');
  numberWithin('subparagraph', 'paragraph');

  // Counter declarations apply in source order, so a later \numberwithin or
  // \renewcommand\thetheorem overrides a \newtheorem's [within] argument.
  const setup = [];
  for (const [environment, declared] of declarations.counters)
    if (declared.root === environment && declared.within)
      setup.push([declared.start, () => numberWithin(environment, declared.within)]);
  const withinPattern =
    /\\(numberwithin|counterwithin|counterwithout)(\*?)\s*(?:\[[^\]]*\])?\s*\{\s*([^}\s]+)\s*\}\s*\{\s*([^}\s]+)\s*\}/g;
  for (const match of activeMatches(config, configRanges, withinPattern)) {
    const [, command, star, name, parent] = match;
    setup.push([
      match.index ?? 0,
      () => {
        if (command !== 'counterwithout') return numberWithin(name, parent, command === 'numberwithin' || !star);
        counter(name).resets.delete(parent);
        if (!star) Object.assign(counter(name), { within: '', template: null });
      },
    ]);
  }
  for (const match of activeMatches(
    config,
    configRanges,
    /\\@(addtoreset|removefromreset)\s*\{([^}]+)\}\s*\{([^}]+)\}/g,
  ))
    setup.push([
      match.index ?? 0,
      () => counter(match[2].trim()).resets[match[1] === 'addtoreset' ? 'add' : 'delete'](match[3].trim()),
    ]);
  // Printed-form redefinitions count only in the preamble; one made inside a
  // group in the body would otherwise leak past its closing brace.
  const documentStart = activeMatches(config, configRanges, /\\begin\{document\}/g)[0]?.index ?? config.length;
  const redefinition =
    /\\(?:renewcommand|newcommand|providecommand|def|gdef|edef|xdef)\*?\s*(?:\{\s*\\the([A-Za-z]+)\s*\}|\\the([A-Za-z]+))\s*\{/g;
  for (const match of activeMatches(config, configRanges, redefinition)) {
    if ((match.index ?? 0) > documentStart) continue;
    const template = counterTemplate(balancedGroup(config, (match.index ?? 0) + match[0].length - 1)?.content || '');
    if (template) setup.push([match.index ?? 0, () => (counter(match[1] || match[2]).template = template)]);
  }
  for (const [, apply] of setup.sort((left, right) => left[0] - right[0])) apply();

  const events = [];
  const headingPattern =
    /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*)?\s*(?:\[[^\]]*\])?\s*\{/g;
  for (const match of activeMatches(text, literalRanges, headingPattern))
    events.push({ type: 'heading', start: match.index ?? 0, name: match[1], starred: Boolean(match[2]), match });
  for (const match of activeMatches(text, literalRanges, /\\appendix(?![A-Za-z@])/g))
    events.push({ type: 'appendix', start: match.index ?? 0 });
  const counterPattern =
    /\\(setcounter|addtocounter)\s*\{\s*([^}\s]+)\s*\}\s*\{\s*(-?\d+)\s*\}|\\(stepcounter|refstepcounter)\s*\{\s*([^}\s]+)\s*\}/g;
  for (const match of activeMatches(text, literalRanges, counterPattern))
    events.push({
      type: 'counter',
      start: match.index ?? 0,
      command: match[1] || match[4],
      name: match[2] || match[5],
      value: Number(match[3] || 0),
    });
  // \footnote steps the footnote counter unless it gives its own [number];
  // a \label inside the note names that number.
  for (const match of activeMatches(
    text,
    literalRanges,
    /\\footnote(?:mark)?(?![A-Za-z@])\s*(?:\[\s*(\d+)\s*\])?\s*(\{)?/g,
  )) {
    const note = match[2] ? balancedGroup(text, (match.index ?? 0) + match[0].length - 1) : null;
    events.push({ type: 'footnote', start: match.index ?? 0, fixed: match[1] || '', content: note?.content || '' });
  }
  // Once an environment has no \end after some \begin, no later one has either.
  const unclosed = new Set();
  for (const match of activeMatches(text, literalRanges, /\\begin\s*\{([^}]+)\}/g)) {
    const start = match.index ?? 0;
    const environment = match[1];
    const closing = (name) => {
      const end = unclosed.has(name) ? -1 : text.indexOf(`\\end{${name}}`, start + match[0].length);
      if (end < 0) unclosed.add(name);
      return end < 0 ? null : { end: end + `\\end{${name}}`.length, content: text.slice(start + match[0].length, end) };
    };
    if (declarations.environments.has(environment)) events.push({ type: 'theorem', start, environment });
    else if (environment === 'appendix' || environment === 'appendices') events.push({ type: 'appendix', start });
    else if (
      equationEnvironments.test(environment) ||
      environment === 'subequations' ||
      floatCounters.has(environment)
    ) {
      const range = closing(environment);
      const type = equationEnvironments.test(environment)
        ? 'equation'
        : floatCounters.has(environment)
          ? 'float'
          : 'group';
      if (range) events.push({ type, start, environment, ...range });
      if (range && type === 'group') events.push({ type: 'group-end', start: range.end - 1 });
    } else if (/^longtable\*?$/.test(environment)) {
      const range = closing(environment);
      if (range) events.push({ type: 'longtable', start, environment, ...range });
    }
  }
  events.sort((left, right) => left.start - right.start);

  const labels = new Map();
  // What each label names, for references that print more than the number:
  // the type (cleveref's and hyperref's name for it) and a title for \nameref.
  const targets = new Map();
  const theoremNumbers = new Map();
  const labelKeys = (fragment) => [...fragment.matchAll(labelPattern)].map((match) => match[2].trim());
  const setLabels = (keys, number, type = '', title = '', extra = {}) => {
    for (const key of keys) {
      if (number) labels.set(key, number);
      if (number || title) targets.set(key, { number: number || '', type, title, ...extra });
    }
  };
  const equationRanges = [];
  const groups = [];
  let group = null;
  let skipUntil = -1;
  let inAppendix = false;
  // The innermost numbered heading, which a label in an unnumbered display names, as in LaTeX.
  let heading = { number: '', type: '' };
  for (const event of events) {
    if (event.type === 'heading') {
      const title = balancedGroup(text, event.start + event.match[0].length - 1);
      const immediate = title
        ? /^\s*\\label\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(text.slice(title.end, title.end + 240))
        : null;
      const keys = [...labelKeys(title?.content || ''), ...(immediate ? [immediate[1].trim()] : [])];
      const type = inAppendix && event.name === (hasChapters ? 'chapter' : 'section') ? 'appendix' : event.name;
      const readableTitle = readableLatex(title?.content || '');
      // An unnumbered heading has no number to print; references to it show its title.
      if (event.starred || sectionDepths[event.name] > secnumdepth) {
        setLabels(keys, '', type, readableTitle);
        continue;
      }
      step(event.name);
      heading = { number: the(event.name), type };
      setLabels(keys, the(event.name), type, readableTitle);
    } else if (event.type === 'appendix') {
      // \appendix restarts the top sectioning counter and prints it as A, B, ...
      const [top, next] = hasChapters ? ['chapter', 'section'] : ['section', 'subsection'];
      Object.assign(counter(top), { value: 0, format: 'Alph', template: null });
      counter(next).value = 0;
      inAppendix = true;
    } else if (event.type === 'footnote') {
      if (!event.fixed) step('footnote');
      setLabels(labelKeys(event.content), event.fixed || the('footnote'), 'footnote');
    } else if (event.type === 'counter') {
      if (event.name === 'secnumdepth') {
        if (event.command === 'setcounter') secnumdepth = event.value;
        else if (event.command === 'addtocounter') secnumdepth += event.value;
      } else if (event.command === 'setcounter') counter(event.name).value = event.value;
      else if (event.command === 'addtocounter') counter(event.name).value += event.value;
      else step(event.name);
    } else if (event.type === 'theorem') {
      const declared = declarations.counters.get(event.environment);
      if (declared?.numbered === false) {
        theoremNumbers.set(event.start, '');
        continue;
      }
      let root = declared?.root || event.environment;
      for (let depth = 0; depth < 8; depth += 1) {
        const shared = declarations.aliases?.get(root) || declarations.counters.get(root)?.root;
        if (!shared || shared === root) break;
        root = shared;
      }
      // A theorem that shares a sectioning counter shows the current number
      // without stepping it, so results never renumber the paper's sections.
      if (sectionDepths[root] === undefined) step(root);
      theoremNumbers.set(event.start, the(root));
    } else if (event.type === 'equation') {
      // A display nested in another one is malformed; count the outer one only.
      if (event.start < skipUntil) continue;
      skipUntil = event.end;
      equationRanges.push([event.start, event.end]);
      const starred = event.environment.endsWith('*');
      const content = stripLatexComments(event.content);
      // equation and multline print one number; the others number every row.
      // A label in an unnumbered row takes the next numbered row's number, as
      // eqnarray's pre-stepped counter and amsmath's deferred \label both do.
      let pending = [];
      for (const row of /^(?:equation|multline)\*?$/.test(event.environment) ? [content] : topLevelRows(content)) {
        const tag = /\\tag\*?\s*\{/.exec(row);
        let number = tag ? balancedGroup(row, tag.index + tag[0].length - 1)?.content.trim() || '' : '';
        if (!tag && !starred && !/\\(?:nonumber|notag)(?![A-Za-z@])/.test(row)) {
          step('equation');
          number = the('equation');
        }
        pending.push(...labelKeys(row));
        if (!number) continue;
        setLabels(pending, number, 'equation');
        pending = [];
      }
      // A label in a display with no numbered row names the enclosing heading, as in LaTeX.
      setLabels(pending, heading.number, heading.type);
    } else if (event.type === 'group') {
      // subequations steps equation once, then prints (Na), (Nb), ... inside.
      step('equation');
      const state = counter('equation');
      const number = the('equation');
      group = { value: state.value, template: state.template };
      groups.push({ start: event.start, end: event.end, number });
      Object.assign(state, { value: 0, template: [{ text: number }, { format: 'alph', counter: 'equation' }] });
    } else if (event.type === 'group-end' && group) {
      Object.assign(counter('equation'), group);
      group = null;
    } else if (event.type === 'float') {
      // Floats step their counter at each \caption; a label takes the caption
      // before it, or the first caption when it precedes all of them. Captions
      // of subfigures and subtables step their own counter (a, b, ...) and print
      // after the float's number, as subcaption and subfig do.
      const name = floatCounters.get(event.environment);
      const content = stripLatexComments(event.content);
      const subparts = subfloatParts(content);
      const insideSubpart = (index) => subparts.some((part) => part.start <= index && index < part.end);
      const captions = [...content.matchAll(/\\caption(?![A-Za-z@])\s*(\*)?/g)]
        .filter((match) => !match[1] && !insideSubpart(match.index ?? 0))
        .map((match) => {
          step(name);
          return { index: match.index ?? 0, number: the(name), title: floatCaption(content, match.index ?? 0) };
        });
      const floatNumber = captions[0]?.number || the(name);
      const subType = name === 'table' ? 'subtable' : 'subfigure';
      for (const [position, part] of subparts.entries()) {
        const letter = counterFormats.alph(position + 1);
        part.number = `${floatNumber}${letter}`;
        setLabels(labelKeys(part.labels), part.number, subType, part.caption, { subref: `(${letter})` });
      }
      for (const match of content.matchAll(labelPattern)) {
        const index = match.index ?? 0;
        if (insideSubpart(index)) continue;
        // A \subcaption outside any subfigure environment names the labels that follow it.
        const loose = subparts.filter((part) => part.loose && part.start <= index).at(-1);
        const caption = captions.filter((item) => item.index < index).at(-1) || captions[0];
        if (loose && (!caption || caption.index < loose.start)) continue;
        setLabels([match[2].trim()], caption?.number, name, caption?.title || '');
      }
    } else if (event.type === 'longtable' && !event.environment.endsWith('*')) {
      step('table');
      setLabels(labelKeys(stripLatexComments(event.content)), the('table'), 'table');
    }
  }
  // A \label directly inside subequations, outside its equations, names the group.
  for (const { start, end, number } of groups)
    for (const match of text.slice(start, end).matchAll(labelPattern)) {
      const index = start + (match.index ?? 0);
      if (insideSourceRanges(index, equationRanges) || insideSourceRanges(index, literalRanges)) continue;
      if (!isLatexCommentedAt(text, index)) setLabels([match[2].trim()], number, 'equation');
    }
  return { labels, targets, theoremNumbers };
}

// \label{key}, or cleveref's \label[type]{key}, which also names the reference type.
const labelPattern = /\\label\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g;

const listLevelNames = ['i', 'ii', 'iii', 'iv'];

// The text a list label or reference template prints for the current item:
// enumitem's \arabic* forms, LaTeX's \roman{enumii} and \theenumi forms, and
// literal text, with font and spacing commands dropped.
function listTemplateText(template, value, stack) {
  return String(template || '')
    .replace(/\\(arabic|alph|Alph|roman|Roman)\*/g, (_match, format) => counterFormats[format](value))
    .replace(/\\@?(arabic|alph|Alph|roman|Roman)\s*\{\s*enum(iv|i{1,3})\s*\}/g, (_match, format, level) =>
      counterFormats[format](stack[listLevelNames.indexOf(level)]?.value ?? 0),
    )
    .replace(/\\theenum(iv|i{1,3})(?![a-z])/g, (_match, level) => stack[listLevelNames.indexOf(level)]?.the ?? '')
    .replace(/\\(?:text(?:up|bf|it|rm|sf|sc|normal)|emph|mbox)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:upshape|bfseries|itshape|normalfont|rmfamily|sffamily|scshape|mdseries|em)(?![A-Za-z@])\s*/g, '')
    .replace(/\\[ ,;]|~/g, ' ')
    .replace(/[{}]/g, '')
    .trim();
}

// enumerate's short form ([(i)], [1.], [a)]) marks the counter with the first
// 1, a, A, i, or I outside braces; the rest is printed as written.
function shortListTemplate(value) {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '{') depth += 1;
    else if (character === '}') depth = Math.max(0, depth - 1);
    else if (character === '\\') {
      index += /^\\[A-Za-z@]*/.exec(value.slice(index))?.[0].length - 1 || 1;
    } else if (!depth && '1aAiI'.includes(character)) {
      const format = { 1: 'arabic', a: 'alph', A: 'Alph', i: 'roman', I: 'Roman' }[character];
      return `${value.slice(0, index)}\\${format}*${value.slice(index + 1)}`;
    }
  }
  return value;
}

/**
 * The numbers LaTeX gives enumerate items: the label each item prints and what
 * \ref prints for a \label inside it. Covers the class defaults (amsart's
 * "(1)", article's "1."), enumitem's label/ref/start/resume keys and \setlist,
 * enumerate's short form, \newlist, and \labelenumi/\theenumi redefinitions.
 */
function listNumbering(source) {
  const text = String(source || '');
  const literalRanges = literalSourceRanges(text);
  const active = (pattern) =>
    [...text.matchAll(pattern)].filter(
      (match) => !insideSourceRanges(match.index ?? 0, literalRanges) && !isLatexCommentedAt(text, match.index ?? 0),
    );
  const className = active(/\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*([^}\s]+)\s*\}/g)[0]?.[1] || '';
  const ams = /^ams(?:art|book|proc)$/.test(className);
  const listTypes = new Map([
    ['enumerate', 'enumerate'],
    ['itemize', 'itemize'],
    ['description', 'description'],
  ]);
  for (const match of active(/\\newlist\s*\{([^}]+)\}\s*\{(enumerate|itemize|description)\}/g))
    listTypes.set(match[1].trim(), match[2]);
  const settings = [];
  for (const match of active(/\\setlist\*?\s*(?:\[([^\]]*)\])?\s*\{/g)) {
    const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    if (!group) continue;
    const scope = String(match[1] || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const names = scope.filter((item) => !/^\d+$/.test(item));
    const levels = scope.filter((item) => /^\d+$/.test(item)).map(Number);
    settings.push({ names, levels, options: keyValueOptions(group.content) });
  }
  const labelOverrides = new Map();
  const theOverrides = new Map();
  for (const match of active(/\\(?:renewcommand|def)\*?\s*\{?\\(label|the)enum(iv|i{1,3})\}?\s*\{/g)) {
    const group = balancedGroup(text, (match.index ?? 0) + match[0].length - 1);
    if (group)
      (match[1] === 'label' ? labelOverrides : theOverrides).set(listLevelNames.indexOf(match[2]), group.content);
  }
  const defaultFormats = ['arabic', 'alph', 'roman', 'Alph'];
  const defaultLabels = ams
    ? ['(\\theenumi)', '(\\theenumii)', '(\\theenumiii)', '(\\theenumiv)']
    : ['\\theenumi.', '(\\theenumii)', '\\theenumiii.', '\\theenumiv.'];
  // What \ref prints by default: \p@enumii is \theenumi, \p@enumiii is \theenumi(\theenumii), ...
  const defaultRefs = [
    '\\theenumi',
    '\\theenumi\\theenumii',
    '\\theenumi(\\theenumii)\\theenumiii',
    '\\theenumi(\\theenumii)\\theenumiii\\theenumiv',
  ];

  const targets = new Map();
  const items = [];
  // A \newlist environment is written as its base list, so the reader treats it as one.
  const renames = [];
  const stack = [];
  const lastValues = new Map();
  const tokens = active(/\\(begin|end)\s*\{([^}]+)\}|\\item(?![A-Za-z@])|\\label\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g);
  for (const token of tokens) {
    const start = token.index ?? 0;
    if (listTypes.has(token[2]) && listTypes.get(token[2]) !== token[2])
      renames.push({ index: start, length: token[0].length, text: `\\${token[1]}{${listTypes.get(token[2])}}` });
    if (token[1] === 'begin' && listTypes.has(token[2])) {
      const type = listTypes.get(token[2]);
      const optionMatch = /^\s*\[/.exec(text.slice(start + token[0].length));
      const optionGroup = optionMatch
        ? balancedGroup(text, start + token[0].length + optionMatch[0].length - 1, '[', ']')
        : null;
      const raw = optionGroup?.content.trim() || '';
      const levelIndex = stack.filter((entry) => entry.type === 'enumerate').length;
      if (type !== 'enumerate' || levelIndex > 3) {
        stack.push({ name: token[2], type, item: null });
        continue;
      }
      const options = new Map();
      for (const setting of settings)
        if (
          // \setlist[name] configures that list only; a \newlist keeps its own settings.
          (!setting.names.length || setting.names.includes(token[2])) &&
          (!setting.levels.length || setting.levels.includes(levelIndex + 1))
        )
          for (const [key, value] of setting.options) options.set(key, value);
      // enumitem's keys, or enumerate's short form ([(i)], [a], [1.]). Keys are
      // words of three or more letters (resume, nosep, wide, label=...).
      const keyed = raw.split(',').every((part) => /=/.test(part) || /^\s*[A-Za-z]{3,}\*?\s*$/.test(part));
      if (raw && !keyed) options.set('label', shortListTemplate(raw));
      else for (const [key, value] of keyValueOptions(raw)) options.set(key, value);
      const format =
        /\\(arabic|alph|Alph|roman|Roman)\*/.exec(options.get('label') || '')?.[1] || defaultFormats[levelIndex];
      const label = options.get('label') ?? labelOverrides.get(levelIndex) ?? defaultLabels[levelIndex];
      // enumitem prints a reference like the label unless ref= says otherwise.
      const ref = options.get('ref') ?? (options.has('label') ? options.get('label') : defaultRefs[levelIndex]);
      const resume = options.has('resume') || options.has('resume*');
      const startValue = Number(options.get('start'));
      stack.push({
        name: token[2],
        type,
        levelIndex,
        format,
        label,
        ref,
        value: resume ? (lastValues.get(levelIndex) ?? 0) : Number.isFinite(startValue) ? startValue - 1 : 0,
        the: '',
        item: null,
      });
    } else if (token[1] === 'end' && listTypes.has(token[2])) {
      const index = stack.map((entry) => entry.name).lastIndexOf(token[2]);
      if (index < 0) continue;
      const [closed] = stack.splice(index);
      if (closed.type === 'enumerate') lastValues.set(closed.levelIndex, closed.value);
    } else if (token[0].startsWith('\\item')) {
      const list = stack.at(-1);
      if (!list) continue;
      if (list.type !== 'enumerate') {
        list.item = null;
        continue;
      }
      // \item[label] prints its own label and does not step the counter.
      const explicit = /^\s*\[/.exec(text.slice(start + token[0].length));
      if (explicit) {
        const group = balancedGroup(text, start + token[0].length + explicit[0].length - 1, '[', ']');
        list.item = { ref: listTemplateText(group?.content || '', list.value, stack) };
        continue;
      }
      list.value += 1;
      const enumerates = stack.filter((entry) => entry.type === 'enumerate');
      list.the = theOverrides.has(list.levelIndex)
        ? listTemplateText(theOverrides.get(list.levelIndex), list.value, enumerates)
        : counterFormats[list.format](list.value);
      const printed = listTemplateText(list.label, list.value, enumerates);
      list.item = { ref: listTemplateText(list.ref, list.value, enumerates) };
      if (printed && !printed.includes(']')) items.push({ index: start, length: token[0].length, label: printed });
    } else if (token[3]) {
      // A label names the innermost numbered item it sits in.
      const owner = [...stack].reverse().find((entry) => entry.type === 'enumerate' && entry.item);
      if (owner?.item.ref) targets.set(token[3].trim(), { number: owner.item.ref, type: 'item', title: '' });
    }
  }
  return { targets, items, renames };
}

// The readable caption whose \caption command starts at `index` in `content`.
function floatCaption(content, index) {
  const match = /^\\caption(?![A-Za-z@])\s*(?:\[[^\]]*\])?\s*\{/.exec(content.slice(index));
  return match ? readableLatex(balancedGroup(content, index + match[0].length - 1)?.content || '') : '';
}

// The subfigures and subtables of one float, in order: subfigure/subtable
// environments with a \caption, \subfloat and \subcaptionbox (subfig and
// subcaption), and a bare \subcaption, which covers what follows it up to the
// next caption. Each part keeps the text its labels live in and its caption.
function subfloatParts(content) {
  const parts = [];
  for (const match of content.matchAll(/\\begin\{(subfigure|subtable)\}/g)) {
    const start = match.index ?? 0;
    const close = content.indexOf(`\\end{${match[1]}}`, start);
    if (close < 0) continue;
    const inner = content.slice(start, close);
    const caption = /\\caption(?![A-Za-z@])/.exec(inner);
    if (!caption) continue;
    parts.push({ start, end: close, labels: inner, caption: floatCaption(inner, caption.index) });
  }
  const covered = (index) => parts.some((part) => part.start <= index && index < part.end);
  for (const match of content.matchAll(/\\(subfloat|subcaptionbox)(?![A-Za-z@])/g)) {
    const start = match.index ?? 0;
    if (covered(start)) continue;
    let cursor = start + match[0].length;
    const groups = [];
    for (let guard = 0; guard < 5; guard += 1) {
      const next = /^\s*([[{])/.exec(content.slice(cursor));
      if (!next) break;
      const open = cursor + next[0].length - 1;
      const group = balancedGroup(content, open, next[1], next[1] === '[' ? ']' : '}');
      if (!group) break;
      groups.push({ bracket: next[1], content: group.content });
      cursor = group.end;
      if (next[1] === '{' && (match[1] === 'subfloat' || groups.filter((item) => item.bracket === '{').length === 2))
        break;
    }
    // \subfloat[list entry][caption]{body}: the last optional argument is the caption.
    const caption =
      match[1] === 'subfloat'
        ? groups.filter((item) => item.bracket === '[').at(-1)?.content || ''
        : groups.find((item) => item.bracket === '{')?.content || '';
    parts.push({ start, end: cursor, labels: content.slice(start, cursor), caption: readableLatex(caption) });
  }
  const captions = [...content.matchAll(/\\(?:sub)?caption(?![A-Za-z@])/g)].map((match) => match.index ?? 0);
  for (const match of content.matchAll(/\\subcaption(?![A-Za-z@*])\s*(?:\[[^\]]*\])?\s*\{/g)) {
    const start = match.index ?? 0;
    if (covered(start)) continue;
    const end = captions.find((index) => index > start) ?? content.length;
    const group = balancedGroup(content, start + match[0].length - 1);
    parts.push({
      start,
      end,
      loose: true,
      labels: content.slice(start, end),
      caption: readableLatex(group?.content || ''),
    });
  }
  return parts.sort((left, right) => left.start - right.start);
}

// The \label that names a result itself. One inside a nested display or float
// names that display, and one inside a list names an item.
function ownLabel(statement) {
  const text = String(statement || '').replace(nestedNumberedEnvironments, '');
  const lists = [];
  const open = [];
  for (const match of text.matchAll(/\\(begin|end)\s*\{(enumerate|itemize|description)\}/g)) {
    if (match[1] === 'begin') open.push(match.index ?? 0);
    else if (open.length) {
      const start = open.pop();
      if (!open.length) lists.push([start, (match.index ?? 0) + match[0].length]);
    }
  }
  if (open.length) lists.push([open[0], text.length]);
  for (const match of text.matchAll(labelPattern))
    if (!insideSourceRanges(match.index ?? 0, lists))
      return { key: match[2].trim(), type: String(match[1] || '').trim() };
  return { key: '', type: '' };
}

function extractSourceUnits(source) {
  const originalSource = String(source || '');
  const normalizedSource = expandAuthorMacros(originalSource);
  const originalLiteralRanges = literalSourceRanges(originalSource);
  const literalRanges = literalSourceRanges(normalizedSource);
  const declarations = theoremDeclarations(originalSource);
  const { environments, displayNames } = declarations;
  const proofEnvironments = new Set(['proof']);
  for (const match of originalSource.matchAll(/\\newenvironment\s*\{([^}]+)\}(?:\[(\d+)\])?(?:\[([^\]]*)\])?/g)) {
    if (
      insideSourceRanges(match.index ?? 0, originalLiteralRanges) ||
      isLatexCommentedAt(originalSource, match.index ?? 0)
    )
      continue;
    if (/^proof/i.test(match[1]) || /proof|preuve|démonstration/i.test(match[3] || '')) proofEnvironments.add(match[1]);
  }
  const names = [...environments.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  if (!names) return [];
  const unitPattern = new RegExp(`\\\\begin\\{(${names})\\}(?:\\[([^\\]]*)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`, 'g');
  const proofNames = [...proofEnvironments].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const embeddedProofPattern = new RegExp(
    `\\\\begin\\{(${proofNames})\\}(?:\\[([^\\]]*)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`,
    'g',
  );
  const { theoremNumbers } = latexNumbering(originalSource, normalizedSource, declarations);
  const units = [];
  for (const match of normalizedSource.matchAll(unitPattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (insideSourceRanges(start, literalRanges) || isLatexCommentedAt(normalizedSource, start)) continue;
    const label = ownLabel(match[3]);
    const embeddedProofs = [...match[3].matchAll(embeddedProofPattern)];
    const statementSource = match[3].replace(embeddedProofPattern, '');
    units.push({
      environment: match[1],
      kind: environments.get(match[1]),
      displayName: displayNames.get(match[1]) || readableLatex(match[1]),
      printedNumber: theoremNumbers.get(start) ?? '',
      title: match[2] || '',
      texLabel: label.key,
      texLabelType: label.type,
      start,
      end,
      statement: readableLatex(statementSource),
      proofText: embeddedProofs
        .map((proof) => readableLatex(proof[3]))
        .filter(Boolean)
        .join('\n\n'),
      assetPaths: graphicPaths(statementSource),
      proofAssetPaths: embeddedProofs.flatMap((proof) => graphicPaths(proof[3])),
      embeddedProof: embeddedProofs.length > 0,
      citationMentions: citationMentions(`${match[2] || ''} ${match[3]}`),
      citationKeys: citationKeys(`${match[2] || ''} ${match[3]}`),
    });
  }
  const byLabel = new Map(units.filter((unit) => unit.texLabel).map((unit) => [unit.texLabel, unit]));
  // Once references are resolved, "the proof of Theorem~\ref{main}" reads
  // "the proof of Theorem~1.3", so also accept a unit's printed name and number.
  // Only pairs that exist are matched, so an unrelated "Lemma 2 of [5]" cannot
  // hide a later \ref from the same sentence.
  const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const printedSeparator = /(?:\s|~| |\\[ ,;])+/g;
  const printedNumbers = new Map();
  for (const unit of units) {
    const name = unit.displayName.trim();
    if (unit.printedNumber && name) printedNumbers.set(name, [...(printedNumbers.get(name) || []), unit.printedNumber]);
  }
  const printedPattern = [...printedNumbers]
    .sort((left, right) => right[0].length - left[0].length)
    .map(
      ([name, numbers]) =>
        `${escapePattern(name)}(?:\\s|~|\\u00a0|\\\\[ ,;])*(?:${[...new Set(numbers)]
          .sort((left, right) => right.length - left.length)
          .map(escapePattern)
          .join('|')})`,
    )
    .join('|');
  const printedKey = (value) => value.replace(printedSeparator, '').toLowerCase();
  const printedTarget = (reference) =>
    units.find(
      (unit) => unit.printedNumber && printedKey(`${unit.displayName}${unit.printedNumber}`) === printedKey(reference),
    );
  const explicitProofPattern = new RegExp(
    `(?:proof\\s+of|prove|complet(?:e|es|ed)\\s+the\\s+proof\\s+of|preuve\\s+(?:de|du|des)|d[ée]monstration\\s+(?:de|du|des))[\\s\\S]{0,180}?(?:\\\\(?:ref|cref|Cref|autoref|Autoref|thref)\\*?\\s*\\{([^},]+)[^}]*\\}|\\\\hyperref\\s*\\[([^\\]]+)\\]${
      printedPattern ? `|(${printedPattern})(?![\\w']|\\.\\d)` : ''
    })`,
    'gi',
  );
  const proofPattern = new RegExp(
    `\\\\begin\\{(${proofNames})\\}(?:\\[([^\\]]*)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`,
    'g',
  );
  for (const proof of normalizedSource.matchAll(proofPattern)) {
    const proofStart = proof.index ?? 0;
    if (insideSourceRanges(proofStart, literalRanges) || isLatexCommentedAt(normalizedSource, proofStart)) continue;
    if (units.some((unit) => unit.start < proofStart && proofStart < unit.end)) continue;
    const nearest = units.filter((unit) => unit.end <= proofStart).at(-1) || null;
    const prelude = normalizedSource.slice(Math.max(nearest?.end ?? 0, proofStart - 2200), proofStart);
    const proofLead = `${proof[2] || ''} ${prelude}`;
    const explicitMatch = [...proofLead.matchAll(explicitProofPattern)].at(-1);
    const explicit = explicitMatch?.[1] || explicitMatch?.[2];
    let target = explicit ? byLabel.get(explicit) : explicitMatch?.[3] ? printedTarget(explicitMatch[3]) : null;
    if (!target && nearest && !nearest.proofText) target = nearest;
    if (target && !target.proofText) {
      target.proofText = readableLatex(proof[3]);
      target.proofAssetPaths = graphicPaths(proof[3]);
      for (const mention of citationMentions(proof[3]))
        if (!target.citationMentions.some((item) => item.key === mention.key && item.locator === mention.locator))
          target.citationMentions.push(mention);
      target.citationKeys = target.citationMentions.map((mention) => mention.key);
      target.proofStart = proofStart;
      target.proofEnd = proofStart + proof[0].length;
    }
  }
  return units;
}

// Default reference names: cleveref's \cref forms (lowercase, abbreviated for
// equations and figures) and hyperref's \autoref forms.
const crefDefaults = {
  equation: ['eq.', 'eqs.'],
  figure: ['fig.', 'figs.'],
  subfigure: ['fig.', 'figs.'],
  table: ['table', 'tables'],
  subtable: ['table', 'tables'],
  part: ['part', 'parts'],
  chapter: ['chapter', 'chapters'],
  section: ['section', 'sections'],
  subsection: ['section', 'sections'],
  subsubsection: ['section', 'sections'],
  paragraph: ['paragraph', 'paragraphs'],
  subparagraph: ['subparagraph', 'subparagraphs'],
  appendix: ['appendix', 'appendices'],
  item: ['item', 'items'],
  footnote: ['footnote', 'footnotes'],
  theorem: ['theorem', 'theorems'],
  lemma: ['lemma', 'lemmas'],
  corollary: ['corollary', 'corollaries'],
  proposition: ['proposition', 'propositions'],
  definition: ['definition', 'definitions'],
  result: ['result', 'results'],
  example: ['example', 'examples'],
  remark: ['remark', 'remarks'],
  note: ['note', 'notes'],
};
const crefUnabbreviated = { equation: ['equation', 'equations'], figure: ['figure', 'figures'] };
const autorefDefaults = {
  equation: 'Equation',
  footnote: 'footnote',
  item: 'item',
  figure: 'Figure',
  subfigure: 'Figure',
  table: 'Table',
  subtable: 'Table',
  part: 'Part',
  appendix: 'Appendix',
  chapter: 'chapter',
  section: 'section',
  subsection: 'subsection',
  subsubsection: 'subsubsection',
  paragraph: 'paragraph',
  subparagraph: 'subparagraph',
  theorem: 'Theorem',
};
const capitalized = (value) => (value ? value[0].toUpperCase() + value.slice(1) : value);

// Splits "1.2.3" into its prefix and final number, so consecutive references
// (1.2, 1.3, 1.4) can be printed as a range, as cleveref does.
function numberParts(number) {
  const match = /^(.*?)(\d+)$/.exec(String(number));
  return match ? { prefix: match[1], value: Number(match[2]) } : null;
}

function joinReferences(parts) {
  return parts.length <= 1 ? parts[0] || '' : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * Prints references as the paper's packages would: cleveref (\cref, \Cref,
 * ranges, \labelcref, \namecref, with the capitalise and noabbrev options,
 * \crefname, \Crefname, \crefalias, and thmtools' refname), hyperref's
 * \autoref (and \...autorefname), \nameref, \subref, and \eqref. Page
 * references name their target, since a reflowed paper has no pages.
 */
function referenceFormatter(source, declarations) {
  const text = String(source || '');
  const cleveref = /\\usepackage\s*(?:\[([^\]]*)\])?\s*\{[^}]*\bcleveref\b[^}]*\}/.exec(text);
  const capitalise = /\bcapitali[sz]e\b/.test(cleveref?.[1] || '');
  const noabbrev = /\bnoabbrev\b/.test(cleveref?.[1] || '');
  const crefNames = new Map();
  const CrefNames = new Map();
  for (const match of text.matchAll(/\\(crefname|Crefname)\s*\{([^}]+)\}\s*\{([^}]*)\}\s*\{([^}]*)\}/g))
    (match[1] === 'crefname' ? crefNames : CrefNames).set(match[2].trim(), [
      readableLatex(match[3]),
      readableLatex(match[4]),
    ]);
  for (const [environment, names] of declarations.referenceNames || []) {
    if (names.cref?.[0]) crefNames.set(environment, [names.cref[0], names.cref[1] || `${names.cref[0]}s`]);
    if (names.Cref?.[0]) CrefNames.set(environment, [names.Cref[0], names.Cref[1] || `${names.Cref[0]}s`]);
  }
  const aliases = new Map();
  for (const match of text.matchAll(/\\crefalias\s*\{([^}]+)\}\s*\{([^}]+)\}/g))
    aliases.set(match[1].trim(), match[2].trim());
  const autorefNames = new Map(Object.entries(autorefDefaults));
  for (const match of text.matchAll(
    /\\(?:renewcommand|newcommand|providecommand|def)\*?\s*\{?\\([A-Za-z]+)autorefname\}?\s*\{([^}]*)\}/g,
  ))
    autorefNames.set(match[1], readableLatex(match[2]));

  // cleveref's type for a target: an explicit \label[type], else its counter's
  // type (items are enumi, whatever their level), after \crefalias.
  const typeOf = (target) => {
    const type = target.labelType || (target.type === 'item' ? 'enumi' : target.type);
    return aliases.get(type) || type;
  };
  const names = (target, capital) => {
    const type = typeOf(target);
    const key = type === 'enumi' ? 'item' : type;
    const lower = crefNames.get(type) || (noabbrev && crefUnabbreviated[key]) || crefDefaults[key];
    const upper = CrefNames.get(type);
    // Environments cleveref has no name for fall back to their printed name.
    const fallback = target.name ? [target.name, `${target.name}s`] : null;
    if (capital) {
      if (upper) return upper;
      if (crefNames.get(type)) return crefNames.get(type).map(capitalized);
      if (key === 'equation' || key === 'figure' || key === 'subfigure')
        return key === 'equation' ? ['Equation', 'Equations'] : ['Figure', 'Figures'];
      return lower ? lower.map(capitalized) : fallback || ['', ''];
    }
    if (lower) return capitalise ? lower.map(capitalized) : lower;
    if (upper) return capitalise ? upper : upper.map((name) => name[0].toLowerCase() + name.slice(1));
    return fallback || ['', ''];
  };
  const isEquation = (target) => typeOf(target) === 'equation';
  const numberText = (target) => (isEquation(target) ? `(${target.number})` : target.number);
  // An unnumbered target (a starred section, an unnumbered theorem) is named instead.
  const unnumbered = (target) => target.title || target.name || '??';

  const cref = (targets, capital) => {
    const groups = [];
    for (const target of targets) {
      const type = target ? typeOf(target) : '';
      const last = groups.at(-1);
      if (target && last && last.type === type && last.targets[0]) last.targets.push(target);
      else groups.push({ type, targets: [target] });
    }
    return joinReferences(
      groups.map(({ targets: members }) => {
        const [first] = members;
        if (!first) return '??';
        if (members.length === 1 && !first.number) return unnumbered(first);
        const numbered = members.filter((target) => target.number);
        // Consecutive numbers of three or more print as "1.2 to 1.4".
        const printed = [];
        for (let index = 0; index < numbered.length;) {
          let end = index;
          const start = numberParts(numbered[index].number);
          while (
            start &&
            end + 1 < numbered.length &&
            numberParts(numbered[end + 1].number)?.prefix === start.prefix &&
            numberParts(numbered[end + 1].number)?.value === numberParts(numbered[end].number).value + 1
          )
            end += 1;
          if (end - index >= 2) {
            printed.push(`${numberText(numbered[index])} to ${numberText(numbered[end])}`);
          } else for (let item = index; item <= end; item += 1) printed.push(numberText(numbered[item]));
          index = end + 1;
        }
        const [singular, plural] = names(first, capital);
        const numbers = joinReferences(printed);
        const many = numbered.length > 1;
        return `${many ? plural : singular}${singular ? ' ' : ''}${numbers}`.trim();
      }),
    );
  };
  const autoref = (target, capital) => {
    if (!target.number) return unnumbered(target);
    const name = autorefNames.get(target.counter || target.type) ?? target.name ?? '';
    const shown = capital ? capitalized(name || target.name || '') : name || target.name || '';
    return `${shown}${shown ? ' ' : ''}${target.number}`;
  };
  return (command, targets) => {
    const [target] = targets;
    switch (command) {
      case 'ref':
        return target.number || unnumbered(target);
      case 'eqref':
        return target.number ? `(${target.number})` : unnumbered(target);
      case 'autoref':
      case 'Autoref':
        return autoref(target, command === 'Autoref');
      case 'thref':
      case 'Thref':
        return target.number
          ? `${target.name || autorefNames.get(target.type) || ''} ${target.number}`.trim()
          : unnumbered(target);
      case 'cref':
      case 'Cref':
      case 'vref':
      case 'Vref':
      case 'cpageref':
      case 'Cpageref':
      case 'pageref':
        return cref(targets, command[0] === 'C' || command[0] === 'V' || command === 'pageref');
      case 'crefrange':
      case 'Crefrange':
      case 'cpagerefrange':
      case 'Cpagerefrange': {
        const [first, last] = targets;
        const [, plural] = names(first, command[0] === 'C');
        return `${plural}${plural ? ' ' : ''}${numberText(first)} to ${numberText(last)}`;
      }
      case 'labelcref':
        return joinReferences(targets.map((item) => (item ? numberText(item) : '??')));
      case 'namecref':
      case 'nameCref':
      case 'lcnamecref':
      case 'namecrefs':
      case 'nameCrefs':
      case 'lcnamecrefs': {
        const [singular, plural] = names(target, command.startsWith('nameC'));
        const name = command.endsWith('s') ? plural : singular;
        return command.startsWith('lc') ? name.toLowerCase() : name;
      }
      case 'nameref':
      case 'Nameref':
        return target.title || cref([target], true);
      case 'subref':
        return target.subref || target.number || unnumbered(target);
      case 'vpageref':
        return '';
      default:
        return null;
    }
  };
}

const referenceCommands =
  'ref|eqref|autoref|Autoref|thref|Thref|cref|Cref|crefrange|Crefrange|cpageref|Cpageref|cpagerefrange|Cpagerefrange|labelcref|namecref|nameCref|lcnamecref|namecrefs|nameCrefs|lcnamecrefs|pageref|vref|Vref|vpageref|nameref|Nameref|subref';
const rangeReferenceCommands = new Set(['crefrange', 'Crefrange', 'cpagerefrange', 'Cpagerefrange']);
const multiReferenceCommands = new Set(['cref', 'Cref', 'cpageref', 'Cpageref', 'labelcref', 'vref', 'Vref']);

function resolveLatexReferences(source, sourceUnits = []) {
  const value = String(source || '');
  const literalRanges = literalSourceRanges(value);
  const declarations = theoremDeclarations(value);
  // Every label's target. Items come first so a result or display inside an
  // item keeps its own number; structure (sections, equations, floats) last.
  const lists = listNumbering(value);
  const targets = new Map(lists.targets);
  for (const unit of sourceUnits) {
    if (!unit.texLabel) continue;
    targets.set(unit.texLabel, {
      number: unit.printedNumber || '',
      type: unit.environment,
      counter: declarations.counters.get(unit.environment)?.root || unit.environment,
      name: unit.displayName || '',
      title: readableLatex(unit.title || ''),
    });
  }
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
  // Number displays on the macro-expanded text, the same text extractSourceUnits
  // numbers theorems on, so a theorem sharing the equation counter and an
  // equation built by an author macro both count exactly once.
  for (const [key, target] of latexNumbering(value, expandAuthorMacros(value)).targets) targets.set(key, target);
  for (const match of value.matchAll(labelPattern))
    if (match[1] && targets.has(match[2].trim())) targets.get(match[2].trim()).labelType = match[1].trim();
  const format = referenceFormatter(value, declarations);

  // Edits on the original text, applied back to front: enumerate items gain
  // their printed label, and references become what the paper prints.
  const edits = [];
  for (const item of lists.items) {
    if (insideSourceRanges(item.index, proofHeaderRanges)) continue;
    edits.push({ start: item.index, end: item.index + item.length, text: `\\item[${item.label}]` });
  }
  for (const rename of lists.renames)
    edits.push({ start: rename.index, end: rename.index + rename.length, text: rename.text });
  const pattern = new RegExp(
    `\\\\(${referenceCommands})(?![A-Za-z@])(\\*?)\\s*((?:\\[[^\\]]*\\]\\s*)*)\\{([^}]*)\\}`,
    'g',
  );
  for (const match of value.matchAll(pattern)) {
    let start = match.index ?? 0;
    let end = start + match[0].length;
    if (insideSourceRanges(start, literalRanges) || insideSourceRanges(start, proofHeaderRanges)) continue;
    if (isLatexCommentedAt(value, start)) continue;
    const command = match[1];
    let keys = [match[4]];
    if (rangeReferenceCommands.has(command)) {
      const second = /^\s*\{([^}]*)\}/.exec(value.slice(end));
      if (!second) continue;
      keys.push(second[1]);
      end += second[0].length;
    } else if (multiReferenceCommands.has(command)) keys = match[4].split(',');
    const found = keys.map((key) => targets.get(key.trim()));
    // A single unresolved label stays for readableLatex to mark; in a list, only it is marked.
    if (!found.some(Boolean) || (keys.length === 1 && !found[0])) continue;
    if (command !== 'labelcref' && !multiReferenceCommands.has(command) && found.some((target) => !target)) continue;
    // "page~\pageref{x}" or "p.~\pageref{x}" becomes the target's name.
    if (command === 'pageref') {
      const before = /(?:\b(?:on\s+)?(?:pages?|pp?\.))(?:\s|~|\\ )*$/i.exec(
        value.slice(Math.max(0, start - 24), start),
      );
      if (before) start -= before[0].length;
    }
    const printed = format(command, found);
    if (printed === null) continue;
    edits.push({ start, end, text: printed });
  }
  // One pass over the text, so the cost stays linear in the paper's length.
  const pieces = [];
  let cursor = 0;
  for (const edit of edits.sort((left, right) => left.start - right.start)) {
    if (edit.start < cursor) continue;
    pieces.push(value.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  pieces.push(value.slice(cursor));
  return pieces.join('');
}

function citationReference(mention, bibliography, aiCitations = []) {
  const { key, locator = '' } = mention;
  const reference = bibliography.get(key) || {
    key,
    title: 'Bibliographic record not cached yet',
    authors: '',
    text: '',
    url: `https://scholar.google.com/scholar?q=${encodeURIComponent(key)}`,
    searchUrl: `https://scholar.google.com/scholar?q=${encodeURIComponent(key)}`,
    doi: '',
    arxivId: '',
    direct: false,
  };
  const aiDetail =
    aiCitations.find((citation) => citation && citation.key === key && String(citation.locator || '') === locator) ||
    aiCitations.find((citation) => citation && citation.key === key);
  return {
    ...reference,
    locator,
    statement: typeof aiDetail?.statement === 'string' ? aiDetail.statement : '',
    definitions: Array.isArray(aiDetail?.definitions)
      ? aiDetail.definitions
          .filter((item) => item && typeof item.notation === 'string' && typeof item.definition === 'string')
          .map((item) => ({
            notation: item.notation,
            definition: item.definition,
            source: typeof item.source === 'string' ? item.source : '',
          }))
      : [],
  };
}

function sectionEvents(source) {
  const events = [];
  const literalRanges = literalSourceRanges(source);
  const pattern = /\\(part|chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\s*\{/g;
  const hasChapters = [...String(source || '').matchAll(/\\chapter\*?(?:\[[^\]]*\])?\s*\{/g)].some(
    (match) => !insideSourceRanges(match.index ?? 0, literalRanges) && !isLatexCommentedAt(source, match.index ?? 0),
  );
  const levels = {
    part: 0,
    chapter: 1,
    section: hasChapters ? 2 : 1,
    subsection: hasChapters ? 3 : 2,
    subsubsection: hasChapters ? 4 : 3,
  };
  for (const match of String(source || '').matchAll(pattern)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(source, match.index ?? 0)) continue;
    const title = balancedGroup(source, (match.index ?? 0) + match[0].length - 1);
    if (!title) continue;
    events.push({
      type: 'section',
      start: match.index ?? 0,
      end: title.end,
      level: levels[match[1]] ?? 1,
      title: readableLatex(title.content),
    });
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
  const commandPattern =
    /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|DeclarePairedDelimiter(?:XPP|X)?|(?:New|Renew|Provide|Declare)(?:Expandable)?DocumentCommand|newenvironment|renewenvironment|newtheorem|renewtheorem|def|gdef|edef|xdef|mathchardef|chardef|let|theoremstyle|numberwithin|counterwithin|counterwithout)\*?/g;
  const skipSpace = (position) => {
    while (/\s/.test(text[position] || '')) position += 1;
    return position;
  };
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
      const arity = takeOptional(position);
      if (arity) position = arity.end;
      const fallback = takeOptional(position);
      if (fallback) position = fallback.end;
      const replacement = takeGroup(position);
      if (!replacement) continue;
      position = replacement.end;
    } else if (command === 'DeclareMathOperator') {
      position = takeMacroName(position);
      if (position < 0) continue;
      const replacement = takeGroup(position);
      if (!replacement) continue;
      position = replacement.end;
    } else if (command.startsWith('DeclarePairedDelimiter')) {
      position = takeMacroName(position);
      if (position < 0) continue;
      const arity = takeOptional(position);
      if (arity) position = arity.end;
      const parts = readMacroArguments(
        text,
        position,
        pairedDelimiterParts(command.replace('DeclarePairedDelimiter', '')),
      );
      if (!parts) continue;
      position = parts.end;
    } else if (command.endsWith('DocumentCommand')) {
      position = takeMacroName(position);
      if (position < 0) continue;
      const spec = takeGroup(position);
      if (!spec) continue;
      const replacement = takeGroup(spec.end);
      if (!replacement) continue;
      position = replacement.end;
    } else if (/^(?:newenvironment|renewenvironment)$/.test(command)) {
      const name = takeGroup(position);
      if (!name) continue;
      position = name.end;
      const arity = takeOptional(position);
      if (arity) position = arity.end;
      const fallback = takeOptional(position);
      if (fallback) position = fallback.end;
      const begin = takeGroup(position);
      if (!begin) continue;
      const end = takeGroup(begin.end);
      if (!end) continue;
      position = end.end;
    } else if (/^(?:newtheorem|renewtheorem)$/.test(command)) {
      const name = takeGroup(position);
      if (!name) continue;
      position = name.end;
      const shared = takeOptional(position);
      if (shared) position = shared.end;
      const title = takeGroup(position);
      if (!title) continue;
      position = title.end;
      const within = takeOptional(position);
      if (within) position = within.end;
    } else if (/^(?:def|gdef|edef|xdef)$/.test(command)) {
      position = takeMacroName(position);
      if (position < 0) continue;
      const replacementStart = text.indexOf('{', position);
      const lineEnd = text.indexOf('\n', position);
      if (replacementStart < 0 || (lineEnd >= 0 && replacementStart > lineEnd)) continue;
      const replacement = balancedGroup(text, replacementStart);
      if (!replacement) continue;
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
      const style = takeGroup(position);
      if (!style) continue;
      position = style.end;
    } else {
      const counter = takeGroup(position);
      if (!counter) continue;
      const owner = takeGroup(counter.end);
      if (!owner) continue;
      position = owner.end;
    }
    ranges.push([start, position]);
  }
  // Blank every declaration in one pass over the text; rebuilding the whole
  // string per declaration was quadratic in long papers.
  const pieces = [];
  let cursor = 0;
  for (const [start, end] of mergeSourceRanges(ranges)) {
    pieces.push(text.slice(cursor, start), text.slice(start, end).replace(/[^\r\n]/g, ' '));
    cursor = end;
  }
  pieces.push(text.slice(cursor));
  return pieces.join('');
}

function readableBodyFragment(source) {
  const cleaned = stripDocumentDeclarations(source)
    .replace(/\\begin\{abstract\}[\s\S]*?\\end\{abstract\}/g, '')
    .replace(
      /\\(?:title|author|address|email|subjclass|date|dedicatory|keywords|thanks)(?:\[[^\]]*\])?\s*\{(?:[^{}]|\{[^{}]*\})*\}/g,
      '',
    )
    .replace(/\\(?:maketitle|tableofcontents|clearpage|newpage|printbibliography|centering)\b/g, '')
    .replace(/\\selectlanguage\s*\{[^}]*\}/g, '')
    .replace(/\\begin\{otherlanguage\*?\}\s*\{[^}]*\}|\\end\{otherlanguage\*?\}/g, '')
    .replace(/\\(?:nocite|label|pagestyle|thispagestyle|pagenumbering)\s*\{[^}]*\}/g, '')
    .replace(/\\setcounter\s*\{[^}]*\}\s*\{[^}]*\}/g, '')
    .replace(/\\(?:bibliography|bibliographystyle|addbibresource)\s*\{[^}]*\}/g, '')
    .replace(
      /\\includegraphics(?:\[[^\]]*\])?\s*\{([^}]*)\}/g,
      (_match, file) => `\n[Figure from the original source: ${file}]\n`,
    )
    .replace(/\\begin\{wrapfigure\}(?:\[[^\]]*\])?\s*\{[^}]*\}\s*\{[^}]*\}|\\end\{wrapfigure\}/g, '')
    .replace(
      /\\begin\{(?:center|flushleft|flushright|quote|quotation|figure\*?|table\*?|minipage)\}(?:\[[^\]]*\])?(?:\{[^}]*\})?/g,
      '',
    )
    .replace(/\\end\{(?:center|flushleft|flushright|quote|quotation|figure\*?|table\*?|minipage)\}/g, '')
    .replace(/\\begin\{tcolorbox\}(?:\[[^\]]*\])?|\\end\{tcolorbox\}/g, '')
    .replace(/\\begin\{tabular\}(?:\[[^\]]*\])?\s*\{[^}]*\}/g, '\n')
    .replace(/\\end\{tabular\}/g, '\n')
    .replace(/\\&/g, '&');
  return readableLatex(cleaned)
    .replace(/\\(?:vspace|hspace)\*?\s*\{[^}]*\}/g, ' ')
    .trim();
}

function tableEvents(source) {
  const events = [];
  const covered = [];
  const literalRanges = literalSourceRanges(source);
  // The table's own caption, not the first subtable's.
  const caption = (fragment) => {
    const subparts = subfloatParts(fragment);
    const match = [...fragment.matchAll(/\\caption(?![A-Za-z@])/g)].find(
      (candidate) =>
        !subparts.some((part) => part.start <= (candidate.index ?? 0) && (candidate.index ?? 0) < part.end),
    );
    return match ? floatCaption(fragment, match.index ?? 0) : '';
  };
  const tabular = (fragment) =>
    /\\begin\{(?:tabular\*?|tabularx)\}[\s\S]*?\\end\{(?:tabular\*?|tabularx)\}/.exec(fragment)?.[0] || '';
  for (const match of String(source || '').matchAll(/\\begin\{(table\*?|longtable)\}([\s\S]*?)\\end\{\1\}/g)) {
    const start = match.index ?? 0;
    if (insideSourceRanges(start, literalRanges) || isLatexCommentedAt(source, start)) continue;
    const content = match[1] === 'longtable' ? match[0] : tabular(match[0]);
    if (!content) continue;
    const end = start + match[0].length;
    covered.push([start, end]);
    events.push({
      type: 'table',
      start,
      end,
      content,
      caption: caption(match[0]),
      citations: citationMentions(match[0]),
    });
  }
  for (const match of String(source || '').matchAll(
    /\\begin\{(?:tabular\*?|tabularx|longtable)\}[\s\S]*?\\end\{(?:tabular\*?|tabularx|longtable)\}/g,
  )) {
    const start = match.index ?? 0;
    if (
      insideSourceRanges(start, literalRanges) ||
      isLatexCommentedAt(source, start) ||
      covered.some(([left, right]) => left <= start && start < right)
    )
      continue;
    events.push({
      type: 'table',
      start,
      end: start + match[0].length,
      content: match[0],
      caption: '',
      citations: citationMentions(match[0]),
    });
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
    const entries = items
      .map((item, index) => {
        const raw = body.slice((item.index ?? 0) + item[0].length, items[index + 1]?.index ?? body.length);
        return { key: item[1].trim(), content: cleanBibliographyFragment(raw) || item[1].trim() };
      })
      .filter((entry) => entry.key);
    if (entries.length) events.push({ type: 'bibliography', start, end: start + match[0].length, entries });
  }
  if (events.length || !bibliography?.size) return events;
  const external = /\\(?:printbibliography|bibliography)\b(?:\[[^\]]*\])?(?:\s*\{[^}]*\})?/.exec(value);
  if (
    !external ||
    insideSourceRanges(external.index ?? 0, literalRanges) ||
    isLatexCommentedAt(value, external.index ?? 0)
  )
    return events;
  const entries = [...bibliography.values()]
    .map((reference) => ({
      key: String(reference.key || ''),
      content: String(
        reference.text || [reference.authors, reference.title].filter(Boolean).join('. ') || reference.key || '',
      ),
    }))
    .filter((entry) => entry.key && entry.content);
  if (entries.length)
    events.push({
      type: 'bibliography',
      start: external.index ?? 0,
      end: (external.index ?? 0) + external[0].length,
      entries,
    });
  return events;
}

function sourceParagraphBlocks(source, bibliography, state) {
  const readable = readableBodyFragment(source);
  if (!readable) return [];
  const paragraphs = [];
  let cursor = 0;
  let start = 0;
  let math = '';
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
        if (literalEnd >= 0) {
          cursor = literalEnd + 1;
          continue;
        }
      }
    }
    if (!math && readable.startsWith('$$', cursor)) {
      math = '$$';
      cursor += 2;
      continue;
    }
    if (math === '$$' && readable.startsWith('$$', cursor)) {
      math = '';
      cursor += 2;
      continue;
    }
    if (!math && readable.startsWith('\\[', cursor)) {
      math = '\\]';
      cursor += 2;
      continue;
    }
    if (math === '\\]' && readable.startsWith('\\]', cursor)) {
      math = '';
      cursor += 2;
      continue;
    }
    if (!math && readable.startsWith('\\(', cursor)) {
      math = '\\)';
      cursor += 2;
      continue;
    }
    if (math === '\\)' && readable.startsWith('\\)', cursor)) {
      math = '';
      cursor += 2;
      continue;
    }
    if (!math && readable[cursor] === '$' && readable[cursor - 1] !== '\\') {
      math = '$';
      cursor += 1;
      continue;
    }
    if (math === '$' && readable[cursor] === '$' && readable[cursor - 1] !== '\\') {
      math = '';
      cursor += 1;
      continue;
    }
    if (!math && readable[cursor] === '\n' && /^\n\s*\n/.test(readable.slice(cursor))) {
      paragraphs.push(readable.slice(start, cursor));
      const separator = /^\n\s*\n+/.exec(readable.slice(cursor))?.[0] || '\n\n';
      cursor += separator.length;
      start = cursor;
      continue;
    }
    cursor += 1;
  }
  paragraphs.push(readable.slice(start));
  return paragraphs
    .map((content) => content.trim())
    .filter((content) => content && !/^\\(?:begin|end)\{document\}/.test(content))
    .map((content) => {
      state.paragraph += 1;
      const mentions = [...content.matchAll(/\[\[cite:([^|\]]+)(?:\|([^\]]*))?\]\]/g)].map((match) => ({
        key: match[1],
        locator: match[2] || '',
      }));
      return {
        id: `source-paragraph-${state.paragraph}`,
        kind: 'paragraph',
        level: 4,
        title: '',
        content,
        proofText: '',
        nodeId: '',
        resultKind: '',
        citations: mentions.map((mention) => citationReference(mention, bibliography)),
      };
    });
}

function buildSourceBlocks(source, units, bibliography) {
  const original = String(source || '');
  const normalized = expandAuthorMacros(original);
  const literalRanges = literalSourceRanges(normalized);
  const activeMatches = (pattern) =>
    [...normalized.matchAll(pattern)].filter(
      (match) =>
        !insideSourceRanges(match.index ?? 0, literalRanges) && !isLatexCommentedAt(normalized, match.index ?? 0),
    );
  const beginMatch = activeMatches(/\\begin\{document\}/g)[0];
  const documentBegin = beginMatch?.index ?? -1;
  let bodyStart = documentBegin >= 0 ? documentBegin + (beginMatch?.[0].length ?? '\\begin{document}'.length) : 0;
  const sections = sectionEvents(normalized);
  const firstSectionStart = sections.find((event) => event.start >= bodyStart)?.start ?? -1;
  const abstractStart =
    activeMatches(/\\begin\{abstract\}/g).find((match) => (match.index ?? 0) >= bodyStart)?.index ?? -1;
  if (firstSectionStart >= bodyStart) {
    // The reader header already renders paper metadata. Starting the source flow
    // at the first section avoids a second title, author, and abstract when an
    // author formats that front matter manually instead of using \maketitle.
    bodyStart = firstSectionStart;
  } else if (abstractStart >= bodyStart) {
    const abstractEnd =
      activeMatches(/\\end\{abstract\}/g).find((match) => (match.index ?? 0) > abstractStart)?.index ?? -1;
    if (abstractEnd >= abstractStart) bodyStart = abstractEnd + '\\end{abstract}'.length;
  }
  const documentEnd = activeMatches(/\\end\{document\}/g).find((match) => (match.index ?? 0) > bodyStart)?.index ?? -1;
  const bodyEnd = documentEnd > bodyStart ? documentEnd : normalized.length;
  const events = [
    ...sections.filter((event) => event.start >= bodyStart && event.start < bodyEnd),
    ...figureEvents(normalized).filter((event) => event.start >= bodyStart && event.start < bodyEnd),
    ...tableEvents(normalized).filter((event) => event.start >= bodyStart && event.start < bodyEnd),
    ...bibliographyEvents(normalized, bibliography).filter(
      (event) => event.start >= bodyStart && event.start < bodyEnd,
    ),
    ...units
      .filter((unit) => unit.start >= bodyStart && unit.start < bodyEnd)
      .map((unit) => ({ type: 'result', start: unit.start, end: unit.end, unit })),
    // Preserve every proof in source order. A semantic link to a theorem
    // enriches the reader, but never decides whether the proof is rendered.
    ...sourceProofEvents(normalized, units, original).filter(
      (event) => event.start >= bodyStart && event.start < bodyEnd,
    ),
  ].sort((left, right) => left.start - right.start || (left.type === 'section' ? -1 : 1));
  const blocks = [];
  const state = { paragraph: 0, section: 0, result: 0, proof: 0, table: 0, bibliography: 0 };
  let cursor = bodyStart;
  for (const event of events) {
    if (event.start < cursor) continue;
    blocks.push(...sourceParagraphBlocks(normalized.slice(cursor, event.start), bibliography, state));
    if (event.type === 'section') {
      state.section += 1;
      blocks.push({
        id: `source-section-${state.section}`,
        kind: 'section',
        level: event.level,
        title: event.title,
        content: '',
        proofText: '',
        nodeId: '',
        resultKind: '',
        citations: [],
      });
    } else if (event.type === 'figure') {
      state.figure = (state.figure || 0) + 1;
      blocks.push({
        id: `source-figure-${state.figure}`,
        kind: 'figure',
        level: 4,
        title: '',
        content: '',
        proofText: '',
        nodeId: '',
        resultKind: '',
        citations: event.citations || [],
        assetPaths: event.assetPaths,
        caption: event.caption,
      });
    } else if (event.type === 'bibliography') {
      const previous = blocks.at(-1);
      if (previous?.kind !== 'section' || !/^(?:references|bibliography)$/i.test(previous.title.trim())) {
        state.section += 1;
        blocks.push({
          id: 'source-section-' + state.section,
          kind: 'section',
          level: 1,
          title: 'References',
          content: '',
          proofText: '',
          nodeId: '',
          resultKind: '',
          citations: [],
        });
      }
      for (const entry of event.entries) {
        state.bibliography += 1;
        blocks.push({
          id: 'source-bibliography-' + state.bibliography,
          kind: 'bibliography',
          level: 4,
          title: entry.key,
          content: entry.content,
          proofText: '',
          nodeId: '',
          resultKind: '',
          citations: [citationReference({ key: entry.key, locator: '' }, bibliography)],
          assetPaths: [],
          caption: '',
        });
      }
    } else if (event.type === 'table') {
      state.table += 1;
      blocks.push({
        id: `source-table-${state.table}`,
        kind: 'table',
        level: 4,
        title: '',
        content: event.content,
        proofText: '',
        nodeId: '',
        resultKind: '',
        citations: event.citations || [],
        assetPaths: [],
        caption: event.caption,
      });
    } else if (event.type === 'result') {
      state.result += 1;
      blocks.push({
        id: `source-result-${state.result}`,
        kind: 'result',
        level: 4,
        title: readableLatex(event.unit.title),
        content: event.unit.statement,
        proofText: '',
        nodeId: event.unit.nodeId || '',
        resultKind: event.unit.displayName || event.unit.kind || 'Theorem',
        citations: event.unit.citations || [],
        assetPaths: event.unit.assetPaths || [],
        caption: '',
      });
      if (event.unit.proofText && event.unit.embeddedProof) {
        state.proof += 1;
        blocks.push({
          id: `source-proof-${state.proof}`,
          kind: 'proof',
          level: 4,
          title: '',
          content: '',
          proofText: event.unit.proofText,
          nodeId: event.unit.nodeId || '',
          resultKind: event.unit.kind || 'theorem',
          citations: event.unit.citations || [],
          assetPaths: event.unit.proofAssetPaths || [],
          caption: '',
        });
      }
    } else if (event.type === 'proof') {
      state.proof += 1;
      blocks.push({
        id: `source-proof-${state.proof}`,
        kind: 'proof',
        level: 4,
        title: '',
        content: '',
        proofText: event.unit.proofText || '',
        nodeId: event.unit.nodeId || '',
        resultKind: event.unit.kind || 'theorem',
        citations: event.unit.citations || [],
        assetPaths: event.unit.proofAssetPaths || [],
        caption: '',
      });
    }
    cursor = event.end;
  }
  blocks.push(...sourceParagraphBlocks(normalized.slice(cursor, bodyEnd), bibliography, state));
  return blocks;
}

function figureEvents(source) {
  const events = [];
  const covered = [];
  const literalRanges = literalSourceRanges(source);
  const images = (fragment) => graphicPaths(fragment);
  // The figure's own caption, not the first subfigure's.
  const caption = (fragment) => {
    const subparts = subfloatParts(fragment);
    const match = [...fragment.matchAll(/\\caption(?![A-Za-z@])/g)].find(
      (candidate) =>
        !subparts.some((part) => part.start <= (candidate.index ?? 0) && (candidate.index ?? 0) < part.end),
    );
    return match ? floatCaption(fragment, match.index ?? 0) : '';
  };
  for (const match of String(source || '').matchAll(/\\begin\{figure\*?\}([\s\S]*?)\\end\{figure\*?\}/g)) {
    if (insideSourceRanges(match.index ?? 0, literalRanges) || isLatexCommentedAt(source, match.index ?? 0)) continue;
    const assetPaths = images(match[0]);
    if (!assetPaths.length) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    covered.push([start, end]);
    events.push({
      type: 'figure',
      start,
      end,
      assetPaths,
      caption: caption(match[0]),
      citations: citationMentions(match[0]),
    });
  }
  for (const match of String(source || '').matchAll(/\\includegraphics(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    const start = match.index ?? 0;
    if (
      insideSourceRanges(start, literalRanges) ||
      isLatexCommentedAt(source, start) ||
      covered.some(([left, right]) => left <= start && start < right)
    )
      continue;
    events.push({
      type: 'figure',
      start,
      end: start + match[0].length,
      assetPaths: [match[1].trim().replace(/^["']|["']$/g, '')],
      caption: '',
      citations: [],
    });
  }
  return events;
}

async function enrichAuditFromTex(rawText, primarySource) {
  if (!primarySource?.entryFile || !primarySource?.sourceDirectory) return rawText;
  const clean = String(rawText || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first < 0 || last <= first) return rawText;
  let audit;
  try {
    audit = JSON.parse(clean.slice(first, last + 1));
  } catch {
    return rawText;
  }
  if (!Array.isArray(audit.nodes)) return rawText;
  const unresolved = await readExpandedTex(primarySource.entryFile, primarySource.sourceDirectory);
  const expanded = resolveLatexReferences(unresolved, extractSourceUnits(unresolved));
  const sourceUnits = extractSourceUnits(expanded);
  const bibliography = await extractBibliographyTree(expanded, primarySource.sourceDirectory, primarySource.entryFile);
  // Match nodes by the printed number in their label first, so an AI audit that
  // skips one lemma cannot shift every later lemma onto its neighbour's
  // statement and proof. Only unnumbered or unmatched nodes then take the first
  // unclaimed unit of their kind, in source order.
  const nodes = audit.nodes.filter((node) => node && typeof node === 'object' && theoremLikeKinds.has(node.kind));
  const claimed = new Set();
  const matches = new Map();
  for (const node of nodes) {
    const cited = printedLabelNumber(node.label);
    if (!cited) continue;
    const numbered = sourceUnits.filter((unit) => unit.printedNumber === cited.number && !claimed.has(unit));
    const unit =
      numbered.find((candidate) => candidate.kind === node.kind && labelNameFits(cited.name, candidate)) ||
      (cited.name ? numbered.find((candidate) => labelNameFits(cited.name, candidate)) : undefined);
    if (!unit) continue;
    claimed.add(unit);
    matches.set(node, unit);
  }
  for (const node of nodes) {
    if (matches.has(node)) continue;
    const unit = sourceUnits.find((candidate) => candidate.kind === node.kind && !claimed.has(candidate));
    if (!unit) continue;
    claimed.add(unit);
    matches.set(node, unit);
  }
  for (const node of audit.nodes) {
    if (!node || typeof node !== 'object') continue;
    const aiCitations = Array.isArray(node.citations) ? node.citations : [];
    node.citations = [];
    const sourceUnit = matches.get(node);
    if (!sourceUnit) continue;
    if (sourceUnit.statement) node.statement = sourceUnit.statement;
    node.displayName = sourceUnit.displayName || '';
    node.label = environmentDisplayLabel(node.label, sourceUnit.displayName, sourceUnit.printedNumber);
    // The TeX tree is authoritative here. Clearing an absent proof matters when
    // re-enriching an older audit: otherwise a stale, positionally misassigned
    // proof can survive forever on an externally quoted result.
    node.proofText = sourceUnit.proofText || '';
    sourceUnit.nodeId = node.id;
    sourceUnit.citations = sourceUnit.citationMentions.map((mention) =>
      citationReference(mention, bibliography, aiCitations),
    );
    node.citations = sourceUnit.citations;
  }
  for (const [index, sourceUnit] of sourceUnits.entries()) {
    if (sourceUnit.nodeId) continue;
    const id = `source-unit-${index + 1}`;
    sourceUnit.nodeId = id;
    sourceUnit.citations = sourceUnit.citationMentions.map((mention) => citationReference(mention, bibliography));
    audit.nodes.push({
      id,
      kind: sourceUnit.kind || 'proposition',
      displayName: sourceUnit.displayName || '',
      label: environmentDisplayLabel('', sourceUnit.displayName, sourceUnit.printedNumber) || 'Result',
      title: readableLatex(sourceUnit.title) || sourceUnit.displayName || 'Result',
      statement: sourceUnit.statement,
      proofText: sourceUnit.proofText || '',
      citations: sourceUnit.citations,
      status: 'verified',
      anchor: { label: 'Author TeX source', page: null, confidence: 'verified' },
      role: 'Source result preserved by the deterministic document parser.',
      dependencies: [],
      proofSketch: [],
      whyItMatters:
        'This result belongs to the complete original document structure and was retained even though the AI audit did not create a separate analytical node for it.',
      expandable: true,
    });
  }
  audit.sourceBlocks = buildSourceBlocks(expanded, sourceUnits, bibliography);
  const captured = audit.nodes.filter((node) => typeof node.proofText === 'string' && node.proofText.trim()).length;
  if (audit.audit && Array.isArray(audit.audit.verificationWarnings)) {
    audit.audit.verificationWarnings = audit.audit.verificationWarnings.filter(
      (warning) => !/payload|reproduc(?:e|ing).*entire proof|proof-text capture/i.test(String(warning)),
    );
    const proofCaptureNote = `Complete attached proof environments were captured directly from the local TeX tree (${captured} proofs), independently of the AI explanation payload.`;
    const baseSummary = String(audit.audit.sourceSummary || '')
      .replace(
        /\s*Complete attached proof environments were captured directly from the local TeX tree \(\d+ proofs\), independently of the AI explanation payload\./g,
        '',
      )
      .trim();
    audit.audit.sourceSummary = `${baseSummary} ${proofCaptureNote}`.trim();
  }
  return JSON.stringify(audit);
}

export {
  buildSourceBlocks,
  decodeSourceBuffer,
  enrichAuditFromTex,
  expandAuthorMacros,
  extractBibliography,
  extractBibliographyTree,
  extractSourceUnits,
  readExpandedTex,
  readableLatex,
  resolveLatexReferences,
  sameExpandedTexSource,
};
