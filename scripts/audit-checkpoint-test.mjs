import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PaperVault } from './paper-vault.mjs';

const target = await mkdtemp(path.join(os.tmpdir(), 'arxivpecker-audit-checkpoint-'));

try {
  const vault = new PaperVault(target);
  const paper = await vault.upsertPaper({ id: 'temporary-client-id', title: 'Checkpointed audit', authors: 'Reader', category: 'math.AG', arxivId: '2601.12345', abstract: 'A test paper.', state: 'Reading', tags: [] });
  await vault.saveAudit(paper, { threadId: '', nodes: [] });
  const readerAudit = await vault.saveAuditThread(paper.id, 'saved-reader-thread');
  assert.equal(readerAudit.threadId, 'saved-reader-thread');
  assert.equal((await vault.snapshot()).audits[paper.id].threadId, 'saved-reader-thread', 'The first reader question must persist its new Codex thread.');
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

  // A new vault instance models the process state after a full computer/app
  // restart. Resume must come entirely from the durable checkpoint on disk.
  const restartedVault = new PaperVault(target);
  const afterRestart = (await restartedVault.snapshot()).auditJobs[paper.id];
  assert.equal(afterRestart.state, 'paused');
  assert.equal(afterRestart.threadId, 'saved-audit-thread');
  assert.deepEqual(afterRestart.options, options);
  const restartedResume = await restartedVault.startAuditJob(paper.id, { convertPdfToLatex: false, correctnessAudit: false, detailedAudit: true }, { resume: true });
  assert.equal(restartedResume.threadId, 'saved-audit-thread', 'A process restart must resume the exact same Codex audit thread.');
  assert.equal(restartedResume.attempts, 3);
  assert.deepEqual(restartedResume.options, options, 'A process restart must not silently change audit options.');

  await restartedVault.completeAuditJob(paper.id);
  assert.equal((await restartedVault.snapshot()).auditJobs[paper.id], undefined, 'Completed audit checkpoints should not appear as resumable work.');
  console.log('Audit checkpoint: reader thread persistence, full process restart, options, pause/resume state, and completion filtering verified.');
} finally {
  await rm(target, { recursive: true, force: true });
}
