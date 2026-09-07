import assert from 'node:assert/strict';
import { normalizeArxivId } from '../app/api/arxiv/arxiv-id.mjs';

assert.equal(normalizeArxivId('2608.24719'), '2608.24719');
assert.equal(normalizeArxivId('https://arxiv.org/pdf/math/0702066v2.pdf?download=1'), 'math/0702066v2');
assert.equal(normalizeArxivId('https%3A%2F%2Farxiv.org%2Fabs%2F2608.24719v3'), '2608.24719v3');
assert.equal(normalizeArxivId('%ZZ'), '', 'Malformed percent escapes must be rejected without throwing.');
assert.equal(normalizeArxivId('not an arXiv identifier'), '');

console.log('arXiv ID normalization: valid IDs accepted and malformed input rejected safely.');
