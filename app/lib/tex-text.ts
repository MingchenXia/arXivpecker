import katex from 'katex';
import type { CitationReference } from './types';

const readerKatexMacros = { '\\qed': '\\square', '\\qedsymbol': '\\square', '\\qedhere': '\\square', '\\mbox': '\\text{#1}' };

function unknownMathMacroFallback(command: string) {
  const name = command.slice(1).replace(/[^A-Za-z]/g, '');
  if (!name) return '';
  const letter = name.at(-1) ?? '';
  if (/^(?:bb|Bbb)[A-Z]$/.test(name)) return `\\mathbb{${letter}}`;
  if (/^(?:cal|c)[A-Z]$/.test(name)) return `\\mathcal{${letter}}`;
  if (/^(?:bf|b)[A-Z]$/.test(name)) return `\\mathbf{${letter}}`;
  if (/^[a-z]{1,4}[A-Z]$/.test(name)) return `\\mathrm{${letter}}`;
  if (/^([A-Z])\1$/.test(name)) return `\\mathbb{${letter}}`;
  return `\\operatorname{${name}}`;
}

// KaTeX output depends only on the expression and display mode. A paper repeats
// many short formulas, and switching papers or reader modes remounts every
// MathText, so typeset each formula once and reuse the HTML (LRU, bounded by size).
const typesetCache = new Map<string, string | null>();
const typesetCacheCharBudget = 6_000_000;
let typesetCacheChars = 0;

export function renderMath(expression: string, displayMode: boolean) {
  const key = `${displayMode ? 'D' : 'I'}${expression}`;
  const cached = typesetCache.get(key);
  if (cached !== undefined) { typesetCache.delete(key); typesetCache.set(key, cached); return cached; }
  const html = typesetMath(expression, displayMode);
  typesetCache.set(key, html); typesetCacheChars += key.length + (html?.length ?? 0);
  for (const [oldKey, oldHtml] of typesetCache) {
    if (typesetCacheChars <= typesetCacheCharBudget || oldKey === key) break;
    typesetCache.delete(oldKey); typesetCacheChars -= oldKey.length + (oldHtml?.length ?? 0);
  }
  return html;
}

function typesetMath(expression: string, displayMode: boolean) {
  const normalized =expression.replace(/\uE000/g, '\\text{\\$}').replace(/\\eqno\s*\{([^{}]*)\}/g, '\\tag{$1}');
  let candidate = normalized;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try { return katex.renderToString(candidate, { throwOnError: true, strict: 'ignore', displayMode, macros: readerKatexMacros }); }
    catch (error) {
      const command = /Undefined control sequence:\s*(\\[A-Za-z@]+)/.exec(error instanceof Error ? error.message : '')?.[1];
      if (!command) return null;
      // Replace only the whole control word: an unknown \eps must not rewrite \epsilon.
      const replacement = unknownMathMacroFallback(command);
      candidate = candidate.replace(new RegExp(`${command.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}(?![A-Za-z@])`, 'g'), () => replacement);
    }
  }
  return null;
}

function decodeTeXText(value: string) {
  const accents: Record<string, string> = { "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307', u: '\u0306', v: '\u030c', H: '\u030b', c: '\u0327', k: '\u0328', r: '\u030a', b: '\u0331', d: '\u0323' };
  const specials: Record<string, string> = { ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', ss: 'ß', i: 'ı', j: 'ȷ' };
  return value
    .replace(/\{\\(['`^"~=\.uvHckrbd])\s*\{?([A-Za-z])\}?\}/g, (_match, accent, letter) => `${letter}${accents[accent] ?? ''}`.normalize('NFC'))
    .replace(/\\(['`^"~=\.])\s*\{?([A-Za-z])\}?/g, (_match, accent, letter) => `${letter}${accents[accent] ?? ''}`.normalize('NFC'))
    .replace(/\\([uvHckrbd])\s*\{([A-Za-z])\}/g, (_match, accent, letter) => `${letter}${accents[accent] ?? ''}`.normalize('NFC'))
    .replace(/\{\\(ae|AE|oe|OE|aa|AA|o|O|l|L|ss|i|j)\}/g, (_match, name) => specials[name] ?? _match)
    .replace(/\\(ae|AE|oe|OE|aa|AA|o|O|l|L|ss)\b/g, (_match, name) => specials[name] ?? _match);
}

function unwrapTextColorCommands(source: string) {
  let text = source;
  for (let pass = 0; pass < 4; pass += 1) {
    let output = ''; let cursor = 0; let changed = false;
    for (const match of text.matchAll(/\\textcolor\s*\{/g)) {
      const start = match.index ?? 0;
      if (start < cursor) continue;
      const color = readTeXGroup(text, start + match[0].length - 1);
      if (!color) continue;
      let contentStart = color.end;
      while (/\s/.test(text[contentStart] || '')) contentStart += 1;
      const content = readTeXGroup(text, contentStart);
      if (!content) continue;
      const decorativeRule = /^\\rule(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*\{[^{}]*\}\s*$/.test(content.value.trim());
      output += text.slice(cursor, start) + (decorativeRule ? '' : content.value);
      cursor = content.end; changed = true;
    }
    if (!changed) break;
    text = output + text.slice(cursor);
  }
  return text;
}

function normalizeDisplayMathEnvironments(source: string) {
  return source
    .replace(/\\begin\{(equation\*?|displaymath)\}([\s\S]*?)\\end\{\1\}/g, (_match, _environment: string, body: string) => `\\[${body}\\]`)
    .replace(/\\begin\{(align\*?)\}([\s\S]*?)\\end\{\1\}/g, (_match, _environment: string, body: string) => `\\[\\begin{aligned}${body}\\end{aligned}\\]`)
    .replace(/\\begin\{(gather\*?|multline\*?|eqnarray\*?)\}([\s\S]*?)\\end\{\1\}/g, (_match, _environment: string, body: string) => `\\[\\begin{gathered}${body.replace(/&/g, '')}\\end{gathered}\\]`);
}

export function cleanTeXProse(value: string) {
  return normalizeDisplayMathEnvironments(unwrapTextColorCommands(decodeTeXText(value)))
    .replace(/\$\\cite\w*\s*(?:\[([^\]]*)\])?\s*(?:\[([^\]]*)\])?\s*\{([^{}]+)\}\$/g, (_match, preNote: string | undefined, postNote: string | undefined, keys: string) => { const locator = [preNote, postNote].map((item) => item?.trim()).filter(Boolean).join('; '); return keys.split(',').map((key) => `[${key.trim()}${locator ? `, ${locator}` : ''}]`).join(' '); })
    .replace(/\\cite\w*\s*(?:\[([^\]]*)\])?\s*(?:\[([^\]]*)\])?\s*\{([^{}]+)\}/g, (_match, preNote: string | undefined, postNote: string | undefined, keys: string) => { const locator = [preNote, postNote].map((item) => item?.trim()).filter(Boolean).join('; '); return keys.split(',').map((key) => `[${key.trim()}${locator ? `, ${locator}` : ''}]`).join(' '); })
    .replace(/\\\[\s*\\(?:textbf|textit|text)\s*\{([^{}]*)\}\s*\\\]/g, '\n\n$1\n\n')
    .replace(/\\\[\s*\\\]/g, '')
    .replace(/\\begin\{thebibliography\}\{[^{}]*\}|\\end\{thebibliography\}/g, '')
    .replace(/\\begin\{(?:verbatim\*?|Verbatim|lstlisting|alltt)\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{(?:verbatim\*?|Verbatim|lstlisting|alltt)\}/g, (_match, content: string) => content.replace(/\$/g, '\uE000'))
    .replace(/\\verb\*?([^A-Za-z0-9\s])([\s\S]*?)\1/g, (_match, _delimiter, content: string) => content.replace(/\$/g, '\uE000'))
    .replace(/\\hyperref\[[^\]]*\]\{([^{}]*)\}/g, '$1')
    .replace(/\\href\{[^{}]*\}\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:url|nolinkurl|path)\{([^{}]*)\}/g, '$1')
    .replace(/\\paragraph\{([^{}]*)\}/g, '$1.')
    .replace(/\\bibitem(?:\[[^\]]*\])?\{[^{}]*\}\s*/g, '')
    .replace(/\\newblock\s*/g, ' ')
    .replace(/\{\\(?:em|it|bf)\s+([^{}]*)\}/g, '$1')
    .replace(/\\(?:emph|textit|textbf|texttt|textsc|textrm|textsf)\{([^{}]*)\}/g, '$1')
    .replace(/\\begin\{tcolorbox\}(?:\[[^\]]*\])?|\\end\{tcolorbox\}/g, '')
    .replace(/\\(?:emph|textit|textbf|texttt|textsc|textrm|textsf)\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:emph|textit|textbf|texttt|textsc|textrm|textsf)\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:em|it|bf)\b\s*/g, '')
    .replace(/\\(?:noindent|quad|qquad)\b/g, ' ')
    .replace(/\\hfil(?:l)?\b/g, '')
    .replace(/\\label\{[^{}]*\}/g, '')
    .replace(/\\(LaTeX|TeX)\b\\?/g, '$1')
    .replace(/\\\$/g, '\uE000')
    .replace(/\\([%&#_])/g, '$1');
}
export function cleanBibliographicText(value: string) {
  const parts = cleanTeXProse(value).split(/(\$\$[\s\S]*?\$\$|\$[^$]*?\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g);
  return parts.map((part, index) => index % 2 ? part : part.replace(/[{}]/g, '').replace(/\uE000/g, '$')).join('');
}

export function searchablePaperText(value: string) {
  return cleanTeXProse(value || '')
    .replace(/\$+/g, ' ')
    .replace(/\\(?:\(|\)|\[|\])/g, ' ')
    .replace(/\\[A-Za-z@]+\*?/g, ' ')
    .replace(/[{}_^]/g, ' ')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

export function cleanRenderedTextFragment(value: string) {
  // Braces group letters in TeX/BibTeX; they are not author-facing prose. Keep
  // deliberately escaped braces while removing grouping braces outside math.
  return value
    .replace(/\\\{/g, '\uE001')
    .replace(/\\\}/g, '\uE002')
    .replace(/[{}]/g, '')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/~/g, '\u00a0')
    .replace(/\uE001/g, '{')
    .replace(/\uE002/g, '}')
    .replace(/\uE000/g, '$');
}

export function citationTitle(citation: CitationReference | undefined, key: string) {
  return cleanBibliographicText(citation?.title && citation.title !== key ? citation.title : `Cited source [${citationAlphaLabel(citation, key)}]`);
}

export function citationAlphaLabel(citation: CitationReference | undefined, key: string) {
  const authorText = citation?.authors || '';
  const people = authorText.split(/\s+(?:and|·)\s+/i).map((person) => person.trim()).filter(Boolean);
  const surnames = people.map((person) => {
    const commaName = person.split(',')[0]?.trim() || '';
    const naturalName = person.replace(/[{}]/g, '').split(/\s+/).filter((part) => !/^[A-ZÀ-ÖØ-Þ](?:\.?-[A-ZÀ-ÖØ-Þ])?\.?$/i.test(part)).at(-1) || '';
    return (person.includes(',') ? commaName : naturalName).replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, '');
  }).filter(Boolean);
  const year = /\b(?:19|20)(\d{2})\b/.exec(`${citation?.text || ''} ${key}`)?.[1] || '';
  if (surnames.length === 1) return `${surnames[0].slice(0, 3)}${year}`;
  if (surnames.length > 1) return `${surnames.slice(0, 3).map((name) => name[0]?.toUpperCase()).join('')}${surnames.length > 3 ? '+' : ''}${year}`;
  const beforeYear = key.split(/(?:19|20)\d{2}/)[0];
  const words = beforeYear.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g)?.filter(Boolean) ?? [];
  if (words.length > 1) return `${words.slice(0, 3).map((word) => word[0]?.toUpperCase()).join('')}${words.length > 3 ? '+' : ''}${year}`;
  const stem = (words[0] || beforeYear).replace(/[^A-Za-z]/g, '');
  return `${stem ? `${stem[0]?.toUpperCase()}${stem.slice(1, 3).toLowerCase()}` : 'Ref'}${year}`;
}

type ParsedTableCell = { value: string; colSpan: number; literal?: boolean };
type ParsedSourceTable = { alignments: ('left' | 'center' | 'right')[]; rows: ParsedTableCell[][] };

function readTeXGroup(source: string, opening: number) {
  if (source[opening] !== '{') return null;
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === '{' && source[index - 1] !== '\\') depth += 1;
    if (source[index] === '}' && source[index - 1] !== '\\') {
      depth -= 1;
      if (depth === 0) return { value: source.slice(opening + 1, index), end: index + 1 };
    }
  }
  return null;
}

function stripGroupedTeXCommands(source: string, pattern: RegExp) {
  let output = ''; let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start < cursor) continue;
    const group = readTeXGroup(source, start + match[0].length - 1);
    if (!group) continue;
    output += source.slice(cursor, start); cursor = group.end;
  }
  return `${output}${source.slice(cursor)}`;
}

function tableAlignments(specification: string) {
  const result: ('left' | 'center' | 'right')[] = [];
  for (let index = 0; index < specification.length; index += 1) {
    const token = specification[index];
    if ('@!><'.includes(token) && specification[index + 1] === '{') { const group = readTeXGroup(specification, index + 1); if (group) index = group.end - 1; continue; }
    if ('pmb'.includes(token) && specification[index + 1] === '{') { result.push('left'); const group = readTeXGroup(specification, index + 1); if (group) index = group.end - 1; continue; }
    if (token === 'l' || token === 'X') result.push('left');
    if (token === 'c' || token === 'S') result.push('center');
    if (token === 'r') result.push('right');
  }
  return result;
}

function splitTableRow(source: string) {
  const cells: string[] = []; let cursor = 0; let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '{' && source[index - 1] !== '\\') depth += 1;
    if (source[index] === '}' && source[index - 1] !== '\\') depth = Math.max(0, depth - 1);
    if (source[index] === '&' && source[index - 1] !== '\\' && depth === 0) { cells.push(source.slice(cursor, index)); cursor = index + 1; }
  }
  cells.push(source.slice(cursor));
  return cells;
}

function cleanTableCell(source: string): ParsedTableCell {
  let value = source.trim().replace(/^(?:\\(?:hline|toprule|midrule|bottomrule)\s*|\\(?:cline|cmidrule)(?:\([^)]*\))?\s*\{[^}]*\}\s*)+/g, '').trim();
  let colSpan = 1;
  const multi = /^\\multicolumn\s*\{(\d+)\}\s*\{[^}]*\}\s*\{/.exec(value);
  if (multi) { const group = readTeXGroup(value, (multi.index ?? 0) + multi[0].length - 1); if (group) { colSpan = Math.max(1, Number(multi[1]) || 1); value = group.value.trim(); } }
  value = value.replace(/^\\multirow(?:\[[^\]]*\])?\s*\{[^}]*\}\s*\{[^}]*\}\s*\{([\s\S]*)\}$/g, '$1').trim();
  const literal = /\\begin\{(?:verbatim\*?|Verbatim|lstlisting|alltt)\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{(?:verbatim\*?|Verbatim|lstlisting|alltt)\}/.exec(value);
  return { value: literal?.[1]?.trim() || value, colSpan, literal: Boolean(literal) };
}

export function parseSourceTable(source: string): ParsedSourceTable {
  const begin = /\\begin\{(tabular\*?|tabularx|longtable)\}(?:\[[^\]]*\])?/.exec(source);
  if (!begin) return { alignments: [], rows: [] };
  let cursor = (begin.index ?? 0) + begin[0].length;
  while (/\s/.test(source[cursor] || '')) cursor += 1;
  let specification = readTeXGroup(source, cursor);
  if ((begin[1] === 'tabular*' || begin[1] === 'tabularx') && specification) { cursor = specification.end; while (/\s/.test(source[cursor] || '')) cursor += 1; specification = readTeXGroup(source, cursor); }
  if (!specification) return { alignments: [], rows: [] };
  const bodyStart = specification.end;
  const end = source.lastIndexOf(`\\end{${begin[1]}}`);
  const rawBody = source.slice(bodyStart, end >= bodyStart ? end : source.length).replace(/%[^\n\r]*/g, '');
  const body = stripGroupedTeXCommands(rawBody, /\\caption(?:\[[^\]]*\])?\s*\{/g)
    .replace(/\\label\s*\{[^}]*\}|\\end(?:firsthead|head|foot|lastfoot)\b/g, '');
  const rawRows: string[] = []; let rowStart = 0; let depth = 0;
  for (let index = 0; index < body.length - 1; index += 1) {
    if (body[index] === '{' && body[index - 1] !== '\\') depth += 1;
    if (body[index] === '}' && body[index - 1] !== '\\') depth = Math.max(0, depth - 1);
    if (depth === 0 && body[index] === '\\' && body[index + 1] === '\\') { rawRows.push(body.slice(rowStart, index)); index += 1; while (/\s/.test(body[index + 1] || '')) index += 1; if (body[index + 1] === '[') { const close = body.indexOf(']', index + 2); if (close >= 0) index = close; } rowStart = index + 1; }
  }
  rawRows.push(body.slice(rowStart));
  const rows = rawRows.map((row) => splitTableRow(row).map(cleanTableCell)).filter((row) => row.some((cell) => cell.value));
  return { alignments: tableAlignments(specification.value), rows };
}

export function latexCompileError(value: string) {
  const expressions = [...String(value || '').matchAll(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$]+?)\$|\\\(([\s\S]+?)\\\)/g)];
  for (const match of expressions) {
    const expression = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    try { katex.renderToString(expression, { throwOnError: true, strict: 'ignore', displayMode: Boolean(match[1] || match[2]), macros: readerKatexMacros }); }
    catch (error) { return error instanceof Error ? error.message.replace(/^KaTeX parse error:\s*/i, '') : 'This formula does not compile.'; }
  }
  return '';
}
