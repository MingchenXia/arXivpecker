import { RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MathText } from './math';
import { notationUsedIn } from '../lib/glossary';
import type { GlossaryEntry } from '../lib/glossary';

const jumpTo = (unitId: string) => window.dispatchEvent(new CustomEvent('proofroom:jump-unit', { detail: unitId }));

const unwrapFormula = (source: string) =>
  source
    .replace(/^\$\$|\$\$$/g, '')
    .replace(/^\$|\$$/g, '')
    .replace(/^\\[([]|\\[)\]]$/g, '');

type Hovered = { entries: GlossaryEntry[]; top: number; left: number; below: boolean };

/**
 * Shows, next to a formula under the pointer, where the notation it uses is
 * defined. Listens on the document root so no formula needs its own handler.
 */
export function GlossaryHover({ root, glossary }: { root: RefObject<HTMLElement | null>; glossary: GlossaryEntry[] }) {
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const showTimer = useRef(0);
  const hideTimer = useRef(0);
  useEffect(() => {
    const element = root.current;
    if (!element || !glossary.length) return;
    const over = (event: MouseEvent) => {
      const formula = (event.target as HTMLElement).closest<HTMLElement>('.math-inline, .math-display');
      if (!formula) return;
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(showTimer.current);
      showTimer.current = window.setTimeout(() => {
        const unitId = formula.closest('[data-node-id]')?.getAttribute('data-node-id') ?? '';
        const entries = notationUsedIn(unwrapFormula(formula.dataset.source ?? ''), glossary).filter(
          (entry) => entry.unitId !== unitId,
        );
        if (!entries.length) return;
        const rect = formula.getBoundingClientRect();
        const below = rect.bottom + 220 < window.innerHeight;
        setHovered({
          entries,
          top: below ? rect.bottom + 6 : rect.top - 6,
          left: Math.max(8, Math.min(window.innerWidth - 368, rect.left)),
          below,
        });
      }, 350);
    };
    const out = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('.math-inline, .math-display')) return;
      window.clearTimeout(showTimer.current);
      hideTimer.current = window.setTimeout(() => setHovered(null), 250);
    };
    element.addEventListener('mouseover', over);
    element.addEventListener('mouseout', out);
    return () => {
      element.removeEventListener('mouseover', over);
      element.removeEventListener('mouseout', out);
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
    };
  }, [glossary, root]);
  if (!hovered) return null;
  return createPortal(
    <aside
      className={`glossary-card ${hovered.below ? '' : 'glossary-card-above'}`}
      style={{ top: hovered.top, left: hovered.left }}
      role="tooltip"
      aria-label="Notation in this formula"
      onMouseEnter={() => window.clearTimeout(hideTimer.current)}
      onMouseLeave={() => setHovered(null)}
    >
      {hovered.entries.map((entry) => (
        <button
          key={entry.id}
          onClick={() => {
            setHovered(null);
            jumpTo(entry.unitId);
          }}
          title="Go to the definition"
        >
          <b>
            <MathText value={`$${entry.symbol}$`} />
          </b>
          <span>
            <MathText value={entry.meaning} />
          </span>
        </button>
      ))}
    </aside>,
    document.body,
  );
}

/** The paper's notation in reading order, filterable, each linking to its definition. */
export function GlossaryList({ glossary }: { glossary: GlossaryEntry[] }) {
  const [filter, setFilter] = useState('');
  const query = filter.trim().toLowerCase();
  const shown = query
    ? glossary.filter((entry) => `${entry.symbol} ${entry.meaning}`.toLowerCase().includes(query))
    : glossary;
  if (!glossary.length)
    return <p className="glossary-empty">No defining sentences such as “Let X be …” or “denote by X” were found.</p>;
  return (
    <div className="glossary-list">
      <input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter notation"
        aria-label="Filter notation"
      />
      {shown.map((entry) => (
        <button key={entry.id} onClick={() => jumpTo(entry.unitId)}>
          <b>
            <MathText value={`$${entry.symbol}$`} />
          </b>
          <span>
            <MathText value={entry.meaning} />
          </span>
        </button>
      ))}
    </div>
  );
}
