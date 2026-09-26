import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { bodyLimitFor, readBody } from './codex-bridge.mjs';

function parseBody(value, limit) {
  const request = new PassThrough();
  const parsed = readBody(request, limit);
  request.end(JSON.stringify(value));
  return parsed;
}

const auditBody = {
  paper: { id: 'long-paper' },
  audit: { nodes: [], rawText: 'x'.repeat(1_400_000) },
};

assert.equal(bodyLimitFor('/vault/audit'), 32_000_000, 'Audit saves need a dedicated large request limit.');
assert.equal(bodyLimitFor('/vault/paper'), 1_000_000, 'Ordinary paper updates should retain the smaller safety limit.');
assert.ok(
  bodyLimitFor('/vault/reader') > 1_000_000,
  'Reader state with long AI conversations needs more than the default limit.',
);
assert.deepEqual(
  await parseBody(auditBody, bodyLimitFor('/vault/audit')),
  auditBody,
  'A 1.4 million-character enriched audit must be saveable.',
);
await assert.rejects(
  parseBody(auditBody, 1_000_000),
  /Request body is too large/,
  'The previous generic limit would have rejected this audit.',
);

// A multi-byte character split across two network chunks must survive decoding.
const unicodeBody = { note: '引理 3.2: ‖u‖ ≤ C for u ∈ ℝⁿ' };
const encoded = Buffer.from(JSON.stringify(unicodeBody));
const splitRequest = new PassThrough();
const splitParsed = readBody(splitRequest);
const cut = encoded.indexOf(Buffer.from('引')) + 1;
splitRequest.write(encoded.subarray(0, cut));
splitRequest.end(encoded.subarray(cut));
assert.deepEqual(await splitParsed, unicodeBody, 'UTF-8 characters split across request chunks must not be corrupted.');

console.log('Audit save body limit: long enriched audit accepted and ordinary limit preserved.');
