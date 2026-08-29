import fs from 'node:fs/promises';
import path from 'node:path';
import katex from 'katex';

const runtimeRoot = path.resolve(process.env.PROOFROOM_LIBRARY_DIR || 'proofroom-library');
const starterRoot = path.resolve('examples/starter-library');
let root = runtimeRoot;
try {
  await fs.access(runtimeRoot);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  root = starterRoot;
}
const formulaPattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$]+?)\$|\\\(([\s\S]+?)\\\)/g;
const readerKatexMacros = { '\\qed': '\\square', '\\qedsymbol': '\\square', '\\qedhere': '\\square' };
let total = 0;
let auditedPapers = 0;
let skippedPapers = 0;
const failed = [];

for (const folder of (await fs.readdir(root)).filter((name) => name.startsWith('arxiv-'))) {
  let audit;
  try { audit = JSON.parse(await fs.readFile(path.join(root, folder, 'audit.json'), 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') { skippedPapers += 1; continue; }
    throw error;
  }
  auditedPapers += 1;
  const documents = [
    ...(audit.nodes ?? []).flatMap((node) => [['statement', node.statement, node.title], ['proof', node.proofText, node.title]]),
    ...(audit.sourceBlocks ?? []).flatMap((block) => [['source content', block.content, block.title || block.id], ['source proof', block.proofText, block.title || block.id]]),
  ];
  for (const [field, value, label] of documents) {
      const source = String(value || '').replace(/\\verb\*?([^A-Za-z0-9\s])([\s\S]*?)\1/g, (_match, _delimiter, content) => content.replace(/\$/g, '\uE000')).replace(/\\\$/g, '\uE000');
      for (const match of source.matchAll(formulaPattern)) {
        total += 1;
        const expression = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').replace(/\\eqno\s*\{([^{}]*)\}/g, '\\tag{$1}');
        try {
          katex.renderToString(expression, {
            throwOnError: true,
            strict: 'ignore',
            displayMode: Boolean(match[1] || match[2]),
            macros: readerKatexMacros,
          });
        } catch (error) {
          failed.push({
            paper: folder,
            node: label,
            field,
            expression,
            error: error instanceof Error ? error.message : String(error),
          });
        }
    }
  }
}

console.log(JSON.stringify({ auditedPapers, skippedPapers, total, failedCount: failed.length, failed }, null, 2));
