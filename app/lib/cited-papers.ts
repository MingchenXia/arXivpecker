// The arXiv papers a paper cites, read off its resolved bibliography.
import type { CitationReference, PaperAudit } from './types';

export type CitedArxivPaper = { arxivId: string; key: string; title: string; authors: string };

export const arxivKey = (value: string) =>
  value
    .trim()
    .replace(/^arxiv:/i, '')
    .replace(/v\d+$/i, '')
    .toLowerCase();

/** Each cited arXiv paper once, in bibliography order, then any cited only inside units. */
export function citedArxivPapers(audit: Pick<PaperAudit, 'nodes' | 'sourceBlocks'>) {
  const found = new Map<string, CitedArxivPaper>();
  const add = (citation: CitationReference) => {
    const key = arxivKey(citation.arxivId || '');
    if (!key || found.has(key)) return;
    found.set(key, {
      arxivId: citation.arxivId.replace(/^arxiv:/i, '').replace(/v\d+$/i, ''),
      key: citation.key,
      title: citation.title || `arXiv:${citation.arxivId}`,
      authors: citation.authors,
    });
  };
  for (const block of audit.sourceBlocks ?? []) for (const citation of block.citations ?? []) add(citation);
  for (const node of audit.nodes ?? []) for (const citation of node.citations ?? []) add(citation);
  return [...found.values()];
}
