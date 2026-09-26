// Which page of the original PDF shows a document unit, for the side-by-side view.
import type { SourceBlock } from './types';

type PagedUnit = { id: string; anchor: { page: number | null } };

/**
 * The PDF page of a unit: its own anchor page, or for prose, which has none,
 * the page of the nearest audited result before it in the document.
 */
export function unitPage(unitId: string, units: PagedUnit[], sourceBlocks: Pick<SourceBlock, 'id' | 'nodeId'>[]) {
  const pages = new Map(units.map((unit) => [unit.id, unit.anchor.page]));
  const own = pages.get(unitId);
  if (own) return own;
  const blockId = unitId.startsWith('source-block:') ? unitId.slice('source-block:'.length) : '';
  const index = sourceBlocks.findIndex((block) => (blockId ? block.id === blockId : block.nodeId === unitId));
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const page = pages.get(sourceBlocks[cursor].nodeId);
    if (page) return page;
  }
  return undefined;
}
