import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PaperVault } from './paper-vault.mjs';

const target = await mkdtemp(path.join(os.tmpdir(), 'arxivpecker-vault-robustness-'));
const warn = console.warn;
console.warn = () => {};

try {
  const vault = new PaperVault(target);
  const paper = await vault.upsertPaper({
    title: 'Concurrent saves',
    authors: 'Reader',
    category: 'math.AP',
    arxivId: '2601.00001',
    abstract: '',
    state: 'Reading',
    tags: [],
  });
  const second = await vault.upsertPaper({
    title: 'Malformed records',
    authors: 'Reader',
    category: 'math.AP',
    arxivId: '2601.00002',
    abstract: '',
    state: 'Reading',
    tags: [],
  });
  const folder = path.join(target, (await vault.recordFor(paper.id)).folder);
  const secondFolder = path.join(target, (await vault.recordFor(second.id)).folder);

  // Saves of the same file that start in the same millisecond must neither fail
  // nor leave invalid JSON. (Request ordering is the bridge mutation queue's job.)
  for (let round = 0; round < 25; round += 1) {
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        vault.saveReader(paper.id, { notes: [{ id: `note-${round}-${index}`, text: 'x'.repeat(4000 * (index + 1)) }] }),
      ),
    );
    const saved = JSON.parse(await readFile(path.join(folder, 'reader.json'), 'utf8'));
    assert.match(
      saved.notes[0].id,
      new RegExp(`^note-${round}-\\d$`),
      'A concurrent reader save must leave one complete record.',
    );
  }
  await Promise.all(Array.from({ length: 10 }, (_, index) => vault.saveProfile({ level: `level-${index}` })));
  assert.equal(
    JSON.parse(await readFile(path.join(target, 'profile.json'), 'utf8')).level,
    'level-9',
    'Writes that reach one file are applied in call order.',
  );
  assert.deepEqual(
    (await readdir(folder)).filter((name) => name.endsWith('.tmp')),
    [],
    'No temporary files may be left behind.',
  );

  // A damaged file loads as empty, but its original bytes are preserved.
  await writeFile(path.join(folder, 'reader.json'), '{"notes": [{"id": "precious"', 'utf8');
  const snapshot = await vault.snapshot();
  assert.deepEqual(snapshot.notes, [], 'A corrupt reader file falls back to an empty reader.');
  const backups = (await readdir(folder)).filter((name) => name.startsWith('reader.json.corrupt-'));
  assert.equal(backups.length, 1, 'The corrupt reader file must be copied aside before it can be overwritten.');
  assert.match(await readFile(path.join(folder, backups[0]), 'utf8'), /precious/);
  await vault.snapshot();
  assert.equal(
    (await readdir(folder)).filter((name) => name.startsWith('reader.json.corrupt-')).length,
    1,
    'Re-reading the same corrupt file must not create more copies.',
  );

  // Valid JSON of the wrong shape in one paper must not break the library.
  await writeFile(path.join(secondFolder, 'audit.json'), JSON.stringify({ nodes: {} }), 'utf8');
  await writeFile(path.join(secondFolder, 'reader.json'), 'null', 'utf8');
  await writeFile(
    path.join(folder, 'audit.json'),
    JSON.stringify({ nodes: [null, { id: 'n1', kind: 'lemma', dependencies: [7] }], crossPaperLinks: {} }),
    'utf8',
  );
  const mixed = await vault.snapshot();
  assert.equal(mixed.papers.length, 2, 'Every paper stays visible when one has malformed records.');
  assert.equal(mixed.audits[second.id], undefined, 'A malformed audit is treated as absent.');
  await vault.rebuildGraph();
  await vault.compactInventory();

  console.log('Vault robustness: concurrent saves, corrupt-file preservation, and malformed paper records verified.');
} finally {
  console.warn = warn;
  await rm(target, { recursive: true, force: true });
}
