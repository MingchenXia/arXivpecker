// Cross-paper edges read off citations: a unit that cites "[Theorem 2.1]" of a
// paper in the library depends on that paper's Theorem 2.1. Only an explicit
// locator that names exactly one unit produces an edge; nothing is inferred.

const kindPrefixes = [
  ['theorem', /^(?:thm|theo|theorem)s?$/],
  ['lemma', /^(?:lem|lemma|lemmas|lemmata)$/],
  ['proposition', /^(?:prop|props|proposition)s?$/],
  ['corollary', /^(?:cor|coroll?|corollary|corollaries)$/],
  ['definition', /^(?:def|defn|definition)s?$/],
  ['remark', /^(?:rem|rmk|remark)s?$/],
  ['conjecture', /^(?:conj|conjecture)s?$/],
  ['example', /^(?:ex|exa|example)s?$/],
  ['claim', /^claims?$/],
  ['equation', /^(?:eq|eqn|eqs|equation)s?$/],
  ['section', /^(?:sec|sect|section|sections|§|§§)$/],
  ['chapter', /^(?:ch|chap|chapter)s?$/],
];

function canonicalKind(word) {
  const value = word.toLowerCase().replace(/\.$/, '');
  return kindPrefixes.find(([, pattern]) => pattern.test(value))?.[0] ?? null;
}

const number = String.raw`\d+(?:\.\d+)*[a-z]?`;

/**
 * The units a citation locator names: "Theorem~2.1", "Thm. 2.1(ii)", "Lemmas 3.1
 * and 3.2", "(4.5)", "§3". A kind word carries over to the numbers after it; an
 * unknown word ("p.", "page") stops the list.
 */
export function parseLocator(locator) {
  const refs = [];
  let kind = '';
  for (const part of String(locator || '')
    .replace(/~|\\[ ,;:!]/g, ' ')
    .split(/\s*(?:,|;|\band\b|&|\\&)\s*/i)) {
    const match = new RegExp(String.raw`^\s*(?:(§{1,2}|[A-Za-z]+\.?)\s*)?\(?(${number})\)?`).exec(part);
    if (!match) continue;
    if (match[1]) {
      const next = canonicalKind(match[1]);
      if (!next) break;
      kind = next;
    }
    const parenthesized = /^\s*(?:[A-Za-z§]+\.?\s*)?\(/.test(part);
    refs.push({ kind: kind || (parenthesized ? 'equation' : ''), number: match[2].toLowerCase() });
  }
  return refs;
}

function unitRef(node) {
  const label = String(node.label || '');
  const match = new RegExp(String.raw`^\s*(§{1,2}|[A-Za-z]+\.?)?\s*\(?(${number})\)?`).exec(label);
  if (!match) return null;
  return { kind: (match[1] && canonicalKind(match[1])) || String(node.kind || ''), number: match[2].toLowerCase() };
}

// Results share one counter in most papers, so a bare number ("[4.2]") resolves
// when exactly one result carries it. A kind that disagrees with the target's
// label more likely means a renumbered version, so it never resolves.
const resultKinds = new Set([
  'theorem',
  'lemma',
  'proposition',
  'corollary',
  'definition',
  'remark',
  'conjecture',
  'example',
  'claim',
]);

function resolve(ref, units) {
  const numbered = units.filter((unit) => unit.ref.number === ref.number);
  const exact = numbered.filter((unit) => unit.ref.kind === ref.kind);
  if (exact.length === 1) return exact[0];
  if (ref.kind) return null;
  const results = numbered.filter((unit) => resultKinds.has(unit.ref.kind));
  return results.length === 1 ? results[0] : null;
}

const baseArxivId = (value) =>
  String(value || '')
    .trim()
    .replace(/^arxiv:/i, '')
    .replace(/v\d+$/i, '')
    .toLowerCase();

/**
 * Edges from units to the exact units of other library papers they cite.
 * `papers` lists each paper with its working audit nodes.
 */
export function citationEdges(papers) {
  const byArxivId = new Map();
  for (const paper of papers) {
    const id = baseArxivId(paper.arxivId);
    if (!id || byArxivId.has(id)) continue;
    const units = paper.nodes.map((node) => ({ node, ref: unitRef(node) })).filter((unit) => unit.ref);
    byArxivId.set(id, { paper, units });
  }
  const edges = new Map();
  for (const paper of papers) {
    for (const node of paper.nodes) {
      for (const citation of Array.isArray(node.citations) ? node.citations : []) {
        const cited = byArxivId.get(baseArxivId(citation?.arxivId));
        if (!cited || cited.paper.id === paper.id) continue;
        for (const ref of parseLocator(citation.locator)) {
          const target = resolve(ref, cited.units);
          if (!target) continue;
          const from = `${paper.id}::${node.id}`;
          const to = `${cited.paper.id}::${target.node.id}`;
          const id = `citation:${from}:${to}`;
          if (edges.has(id)) continue;
          edges.set(id, {
            id,
            from,
            to,
            relation: ['section', 'chapter'].includes(target.ref.kind) ? 'background' : 'uses',
            source: 'citation',
            note: `Cites ${String(citation.locator).replace(/~/g, ' ')} of ${cited.paper.title}.`,
          });
        }
      }
    }
  }
  return [...edges.values()];
}
