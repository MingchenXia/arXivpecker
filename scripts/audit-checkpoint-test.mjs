import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PaperVault } from './paper-vault.mjs';

const target = await mkdtemp(path.join(os.tmpdir(), 'arxivpecker-audit-checkpoint-'));

try {
  const vault = new PaperVault(target);
  const paper = await vault.upsertPaper({ id: 'temporary-client-id', title: 'Checkpointed audit', authors: 'Reader', category: 'math.AG', arxivId: '2601.12345', abstract: 'A test paper.', state: 'Reading', tags: [] });
  const options = { convertPdfToLatex: true, correctnessAudit: true, detailedAudit: false };
  const first = await vault.startAuditJob(paper.id, options);
  assert.equal(first.state, 'preparing');
  assert.equal(first.threadId, '');
  assert.deepEqual(first.options, options);

  const active = await vault.saveAuditJob(paper.id, { state: 'running', threadId: 'saved-audit-thread', message: 'Reading source.' });
  assert.equal(active.threadId, 'saved-audit-thread');
  const resumed = await vault.startAuditJob(paper.id, { convertPdfToLatex: false, correctnessAudit: false, detailedAudit: true }, { resume: true });
  assert.equal(resumed.threadId, 'saved-audit-thread', 'A resumed audit must keep its original Codex thread.');
  assert.equal(resumed.attempts, 2);
  assert.deepEqual(resumed.options, options, 'A resumed audit must retain its original audit options.');

  const snapshot = await vault.snapshot();
  assert.equal(snapshot.auditJobs[paper.id].state, 'preparing');
  assert.equal(snapshot.auditJobs[paper.id].threadId, 'saved-audit-thread');
  await vault.pauseAuditJob(paper.id, 'Computer restarted.');
  assert.equal((await vault.snapshot()).auditJobs[paper.id].state, 'paused');
  await vault.completeAuditJob(paper.id);
  assert.equal((await vault.snapshot()).auditJobs[paper.id], undefined, 'Completed audit checkpoints should not appear as resumable work.');
  console.log('Audit checkpoint: saved thread, options, pause/resume state, and completion filtering verified.');
} finally {
  await rm(target, { recursive: true, force: true });
}
