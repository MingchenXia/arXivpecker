import assert from 'node:assert/strict';
import { citationEdges, parseLocator } from './citation-links.mjs';

assert.deepEqual(parseLocator('Theorem~2.1'), [{ kind: 'theorem', number: '2.1' }]);
assert.deepEqual(parseLocator('Thm. 2.1(ii)'), [{ kind: 'theorem', number: '2.1' }]);
assert.deepEqual(parseLocator('Corollary~7.3.4(ii)'), [{ kind: 'corollary', number: '7.3.4' }]);
assert.deepEqual(parseLocator('Lemmas 3.1 and 3.2'), [
  { kind: 'lemma', number: '3.1' },
  { kind: 'lemma', number: '3.2' },
]);
assert.deepEqual(parseLocator('Prop.~4, Lemma 5'), [
  { kind: 'proposition', number: '4' },
  { kind: 'lemma', number: '5' },
]);
assert.deepEqual(parseLocator('(4.5)'), [{ kind: 'equation', number: '4.5' }]);
assert.deepEqual(parseLocator('§3'), [{ kind: 'section', number: '3' }]);
assert.deepEqual(parseLocator('p.~23'), [], 'Page locators name no unit.');
assert.deepEqual(parseLocator(''), []);

const node = (id, kind, label, citations = []) => ({ id, kind, label, citations });
const cite = (locator, arxivId = '2401.00001v2') => ({ key: 'K', locator, arxivId });
const cited = {
  id: 'cited',
  arxivId: '2401.00001',
  title: 'Cited paper',
  nodes: [
    node('t21', 'theorem', 'Theorem 2.1'),
    node('l22', 'lemma', 'Lemma 2.2'),
    node('e45', 'equation', 'Equation (4.5)'),
    node('s3', 'section', 'Section 3'),
    node('p4', 'proposition', 'Proposition 4'),
    node('r4', 'remark', 'Remark 4'),
  ],
};
const citing = {
  id: 'citing',
  arxivId: '2502.00002',
  title: 'Citing paper',
  nodes: [
    node('main', 'theorem', 'Theorem 1', [cite('Theorem~2.1'), cite('Lemma 2.2'), cite('p. 3')]),
    node('lemma', 'lemma', 'Lemma 2', [cite('(4.5)'), cite('Section 3'), cite('Lemma 2.1'), cite('2.2')]),
    node('ambiguous', 'lemma', 'Lemma 3', [cite('4')]),
    node('other', 'lemma', 'Lemma 4', [cite('Theorem 2.1', '2401.99999')]),
  ],
};
const edges = citationEdges([citing, cited]);
assert.deepEqual(
  edges.map((edge) => [edge.from, edge.to, edge.relation]),
  [
    ['citing::main', 'cited::t21', 'uses'],
    ['citing::main', 'cited::l22', 'uses'],
    ['citing::lemma', 'cited::e45', 'uses'],
    ['citing::lemma', 'cited::s3', 'background'],
    // A bare number resolves to the one result carrying it; "Lemma 2.1" names no lemma.
    ['citing::lemma', 'cited::l22', 'uses'],
  ],
  'Exact locators link; pages, wrong kinds, ambiguous numbers, and papers outside the library do not.',
);
assert.equal(edges[0].source, 'citation');
assert.equal(citationEdges([citing]).length, 0);
console.log('Citation links: locators parsed and resolved to exact units.');
