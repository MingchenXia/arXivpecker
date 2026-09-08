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
assert.deepEqual(await parseBody(auditBody, bodyLimitFor('/vault/audit')), auditBody, 'A 1.4 million-character enriched audit must be saveable.');
await assert.rejects(parseBody(auditBody, 1_000_000), /Request body is too large/, 'The previous generic limit would have rejected this audit.');

console.log('Audit save body limit: long enriched audit accepted and ordinary limit preserved.');
