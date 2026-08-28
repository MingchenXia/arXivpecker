import fs from 'node:fs/promises';
import path from 'node:path';
import katex from 'katex';

const root = 'proofroom-library';
const formulaPattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$]+?)\$|\\\(([\s\S]+?)\\\)/g;
let total = 0;
const failed = [];

for (const folder of (await fs.readdir(root)).filter((name) => name.startsWith('arxiv-'))) {
  const audit = JSON.parse(await fs.readFile(path.join(root, folder, 'audit.json'), 'utf8'));
  for (const node of audit.nodes) {
    for (const [field, value] of [['statement', node.statement], ['proof', node.proofText]]) {
      for (const match of String(value || '').matchAll(formulaPattern)) {
        total += 1;
        const expression = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
        try {
          katex.renderToString(expression, {
            throwOnError: true,
            strict: 'ignore',
            displayMode: Boolean(match[1] || match[2]),
          });
        } catch (error) {
          failed.push({
            paper: folder,
            node: node.title,
            field,
            expression,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}

console.log(JSON.stringify({ total, failedCount: failed.length, failed }, null, 2));
