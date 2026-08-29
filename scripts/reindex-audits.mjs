import path from 'node:path';
import { enrichAuditFromTex } from './codex-bridge.mjs';
import { PaperVault } from './paper-vault.mjs';

const root = path.resolve(process.env.PROOFROOM_LIBRARY_DIR || path.join(process.cwd(), 'proofroom-library'));
const vault = new PaperVault(root);
const records = await vault.allRecords();
let updated = 0;

for (const record of records) {
  const source = record.paper?.source;
  if (!record.audit || !source?.mainTex || !source?.sourceDirectory) continue;
  const paperDirectory = path.join(root, record.folder);
  const entryFile = path.isAbsolute(source.mainTex) ? source.mainTex : path.resolve(paperDirectory, source.mainTex);
  const sourceDirectory = path.isAbsolute(source.sourceDirectory) ? source.sourceDirectory : path.resolve(paperDirectory, source.sourceDirectory);
  const enriched = await enrichAuditFromTex(JSON.stringify(record.audit), { entryFile, sourceDirectory });
  const audit = JSON.parse(enriched);
  await vault.saveAudit(record.paper, audit);
  updated += 1;
  console.log(`${record.paper.arxivId}: ${(audit.sourceBlocks || []).length} source blocks`);
}

console.log(`Reindexed ${updated} audited paper${updated === 1 ? '' : 's'}.`);
