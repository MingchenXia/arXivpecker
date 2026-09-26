// A paper's notation, read off its defining sentences ("Let $X$ denote …",
// "we define $P_k := …$", "denote … by $I_n(s)$"), and the lookup that finds
// which of those symbols a formula uses.
import type { AuditNode, SourceBlock } from './types';

export type GlossaryEntry = {
  id: string;
  /** The symbol as written, without math delimiters. */
  symbol: string;
  /** Normalized TeX used to find the symbol in formulas. */
  key: string;
  /** The defining sentence, with its mathematics. */
  meaning: string;
  /** The document unit that introduces the symbol. */
  unitId: string;
};

const mathToken = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$]+?\$|\\\([\s\S]+?\\\)/g;
const placeholder = /\u0000(\d+)\u0000/;
const P = String.raw`\u0000(\d+)\u0000`;

function unwrap(token: string) {
  if (token.startsWith('$$') || token.startsWith('\\[') || token.startsWith('\\(')) return token.slice(2, -2);
  return token.slice(1, -1);
}

/** TeX spelled one way, so `I_{n}(s)` and `I_n( s )` compare equal. */
export function normalizeTex(value: string) {
  return (
    value
      .replace(/\\(?:left|right|big|Big|bigg|Bigg)(?![A-Za-z])/g, '')
      .replace(/\\[,;:! ]/g, '')
      .replace(/\\operatorname\{([^{}]*)\}/g, '\\mathrm{$1}')
      // A space ends a control word (`\in I`); elsewhere it means nothing.
      .replace(/(\\[A-Za-z]+)\s+(?=[A-Za-z])/g, '$1\u0001')
      .replace(/\s+/g, '')
      .replace(/\u0001/g, ' ')
      .replace(/([_^])\{([A-Za-z0-9])\}/g, '$1$2')
  );
}

const relation =
  /\\(?:in|notin|subset|subseteq|supset|supseteq|le|leq|leqslant|ge|geq|geqslant|neq|ne|cong|simeq|sim|mid|approx|ll|gg)(?![A-Za-z])|[<>≤≥∈]/;

/**
 * The symbol a formula in a defining position introduces: the left side of
 * `:=` or `=`, the name of a map `f: A \to B`, or the whole formula. Bound
 * variables (`w \in W`), conditions, and lists name nothing.
 */
export function definedSymbol(expression: string) {
  const value = expression.trim().replace(/[\s,.;]+$/, '');
  let symbol = value;
  const assignment = /^(.+?)\s*(?::=|\\coloneqq|\\eqqcolon|\\stackrel\{[^{}]*\}\{=\}|\\overset\{[^{}]*\}\{=\}|=)/.exec(
    value,
  );
  const map = /^([^:=]+?)\s*:(?!=)\s*(.+)$/.exec(value);
  if (assignment && !(map && map[1].length < assignment[1].length)) symbol = assignment[1];
  else if (map && /\\(?:to|rightarrow|longrightarrow|mapsto|hookrightarrow|twoheadrightarrow)(?![A-Za-z])/.test(map[2]))
    symbol = map[1];
  symbol = symbol.trim();
  if (!symbol || symbol.length > 40 || relation.test(symbol) || /^[\d.\s]+$/.test(symbol)) return '';
  if (/,/.test(symbol.replace(/\{[^{}]*\}|\([^()]*\)/g, ''))) return '';
  return symbol;
}

/** Normalized TeX to look for: a symbol written with arguments, `j(h_1,h_2)`, is found as `j(`. */
function lookupKey(symbol: string) {
  const key = normalizeTex(symbol);
  const head = /^(.+?)\([^()]*\)$/.exec(key)?.[1];
  return head ? `${head}(` : key;
}

// Each pattern captures the placeholders of the formulas it defines; `requiresAssignment`
// accepts a formula only when it states its own definition (`we set $x = …$`).
const definingPatterns: { pattern: RegExp; requiresAssignment?: boolean }[] = [
  { pattern: new RegExp(String.raw`\blet\s+${P}((?:\s*(?:,|and)\s*${P})*)\s+(?:be|denote|stand|mean|refer)`, 'gi') },
  { pattern: new RegExp(String.raw`\blet\s+${P}`, 'gi'), requiresAssignment: true },
  { pattern: new RegExp(String.raw`\bdefine\s+${P}(?!\s*-)`, 'gi') },
  { pattern: new RegExp(String.raw`\bwe\s+(?:also\s+)?(?:set|put)\s+${P}`, 'gi'), requiresAssignment: true },
  { pattern: new RegExp(String.raw`\bdenoted?\b[^\u0000.;]{0,80}?\bby\s+${P}`, 'gi') },
  { pattern: new RegExp(String.raw`\bby\s+${P}\s+we\s+(?:will\s+)?denote`, 'gi') },
  { pattern: new RegExp(String.raw`\bwe\s+(?:will\s+)?write\s+${P}`, 'gi') },
  { pattern: new RegExp(String.raw`\bwrite\s+${P}\s+(?:for|to denote|instead)`, 'gi') },
  { pattern: new RegExp(String.raw`${P}\s+(?:denotes|stands for|will denote|is called|is defined)`, 'gi') },
];

const hasAssignment = (expression: string) =>
  /:=|\\coloneqq|\\eqqcolon|(?<![<>!\\])=/.test(expression) ||
  /:\s*.*\\(?:to|rightarrow|longrightarrow|mapsto)(?![A-Za-z])/.test(expression);

function shorten(sentence: string, limit = 280) {
  if (sentence.length <= limit) return sentence;
  const words = sentence.split(/(\s+)/);
  let result = '';
  for (const word of words) {
    if ((result + word).length > limit) break;
    result += word;
  }
  return `${result.trimEnd()} …`;
}

/** The symbols one passage defines, with the sentence that defines each. */
export function definitionsIn(text: string) {
  const formulas: string[] = [];
  const masked = text.replace(mathToken, (token) => `\u0000${formulas.push(token) - 1}\u0000`);
  const found: { symbol: string; meaning: string }[] = [];
  for (const sentence of masked.split(/(?<=[.!?])\s+(?=[A-Z\u0000\\])/)) {
    const restore = (value: string) =>
      value.replace(new RegExp(placeholder.source, 'g'), (_, index) => formulas[Number(index)]);
    const indices = new Set<number>();
    for (const { pattern, requiresAssignment } of definingPatterns) {
      for (const match of sentence.matchAll(pattern)) {
        const listed = [match[1], ...[...(match[2] ?? '').matchAll(new RegExp(P, 'g'))].map((item) => item[1])];
        for (const index of listed.filter(Boolean).map(Number)) {
          if (requiresAssignment && !hasAssignment(unwrap(formulas[index]))) continue;
          indices.add(index);
        }
      }
    }
    for (const index of [...indices].sort((a, b) => a - b)) {
      const symbol = definedSymbol(unwrap(formulas[index]));
      if (symbol) found.push({ symbol, meaning: shorten(restore(sentence).trim()) });
    }
  }
  return found;
}

/**
 * The paper's glossary in reading order: every symbol with the first sentence
 * that defines it. Papers read from TeX are scanned block by block; others
 * through their audited units.
 */
export function buildGlossary(sourceBlocks: SourceBlock[], nodes: AuditNode[]) {
  const passages = sourceBlocks.length
    ? sourceBlocks
        .filter((block) => ['paragraph', 'result'].includes(block.kind))
        .map((block) => ({ unitId: block.nodeId || `source-block:${block.id}`, text: block.content }))
    : nodes.map((node) => ({ unitId: node.id, text: node.statement }));
  const entries = new Map<string, GlossaryEntry>();
  for (const passage of passages)
    for (const { symbol, meaning } of definitionsIn(passage.text || '')) {
      const key = lookupKey(symbol);
      if (!key || entries.has(key)) continue;
      entries.set(key, { id: `${passage.unitId}:${key}`, symbol, key, meaning, unitId: passage.unitId });
    }
  return [...entries.values()];
}

const letterOrDigit = /[A-Za-z0-9]/;
const fontCommand = /\\(?:math[a-z]*|operatorname|text[a-z]*|boldsymbol|bm)\{$/;

function occursIn(formula: string, key: string) {
  for (let index = formula.indexOf(key); index >= 0; index = formula.indexOf(key, index + 1)) {
    const before = formula[index - 1] ?? '';
    const after = formula[index + key.length] ?? '';
    if (/^[A-Za-z]/.test(key) && /[A-Za-z\\]/.test(before)) continue;
    // `F` is not the `F` inside `\mathbb{F}`.
    if (!key.startsWith('\\') && fontCommand.test(formula.slice(Math.max(0, index - 16), index))) continue;
    if (/[A-Za-z0-9]$/.test(key) && letterOrDigit.test(after)) continue;
    // `W_n` is its own symbol, not `W` with a subscript.
    if (!key.includes('_') && after === '_') continue;
    return true;
  }
  return false;
}

/** The glossary symbols a formula uses, the most specific first. */
export function notationUsedIn(formula: string, glossary: GlossaryEntry[], limit = 5) {
  const normalized = normalizeTex(formula);
  return glossary
    .filter((entry) => occursIn(normalized, entry.key))
    .sort((a, b) => b.key.length - a.key.length)
    .slice(0, limit);
}
