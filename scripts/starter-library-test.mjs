import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PaperVault } from './paper-vault.mjs';

const project = path.resolve(import.meta.dirname, '..');
const starterRoot = path.join(project, 'examples', 'starter-library');
const target = await mkdtemp(path.join(os.tmpdir(), 'arxivpecker-starter-'));

try {
  const vault = new PaperVault(target, { starterRoot });
  const snapshot = await vault.snapshot();
  assert.equal(snapshot.papers.length, 3, 'A fresh library must contain exactly three starter papers.');
  assert.equal(snapshot.profile, null, 'The starter library must not suppress first-time setup.');
  assert.deepEqual(snapshot.papers.map((paper) => paper.arxivId).sort(), ['2607.17203', '2608.24719v1', 'local-333f9f47-cd02-424f-b473-587dc480d69f'].sort());

  for (const paper of snapshot.papers) {
    const record = await vault.recordFor(paper.id);
    const source = JSON.parse(await readFile(path.join(vault.paperDirectory(record), 'paper.json'), 'utf8')).source;
    if (source?.sourceDirectory) {
      assert.equal(path.isAbsolute(source.sourceDirectory), true, 'Runtime source paths must be hydrated for the current clone.');
      await stat(source.sourceDirectory);
    }
    if (source?.mainTex) await stat(source.mainTex);
  }
  console.log('Starter library: 3 papers, portable sources, first-time setup enabled.');
} finally {
  await rm(target, { recursive: true, force: true });
}
