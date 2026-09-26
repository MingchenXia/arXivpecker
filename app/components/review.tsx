import { useEffect, useState } from 'react';
import { MathText } from './math';
import { displayUnitLabel } from '../lib/audit';
import { ankiExport, dueCards, intervalLabel } from '../lib/review';
import type { Grade, ReviewCard, ReviewState } from '../lib/review';

const grades: [Grade, string][] = [
  ['again', 'Again'],
  ['hard', 'Hard'],
  ['good', 'Good'],
  ['easy', 'Easy'],
];

export function ReviewView({
  cards,
  stateOf,
  grade,
  openUnit,
}: {
  cards: ReviewCard[];
  stateOf: (card: ReviewCard) => ReviewState | null;
  grade: (card: ReviewCard, grade: Grade) => void;
  openUnit: (paperId: string, nodeId: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  // Read once per render; grading re-renders with the new schedule.
  const [now, setNow] = useState(() => new Date());
  const due = dueCards(cards, stateOf, now);
  const card = due[0];
  const state = card ? stateOf(card) : null;
  const upcoming = cards
    .map(stateOf)
    .filter((item): item is ReviewState => Boolean(item))
    .map((item) => Date.parse(item.due))
    .filter((time) => time > now.getTime())
    .sort((a, b) => a - b)[0];
  function answer(value: Grade) {
    if (!card) return;
    grade(card, value);
    setRevealed(false);
    setNow(new Date());
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!card || (event.target as HTMLElement).closest('input, textarea, select')) return;
      if (event.key === ' ' && !revealed) {
        event.preventDefault();
        setRevealed(true);
      } else if (revealed && ['1', '2', '3', '4'].includes(event.key)) {
        grade(card, grades[Number(event.key) - 1][0]);
        setRevealed(false);
        setNow(new Date());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, grade, revealed]);
  function download() {
    const blob = new Blob([ankiExport(cards, displayUnitLabel)], { type: 'text/tab-separated-values' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'arxivpecker-cards.txt';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  return (
    <section className="review-view">
      <header>
        <div>
          <h2>Review</h2>
          <p>
            {cards.length} card{cards.length === 1 ? '' : 's'} from definitions and results marked understood ·{' '}
            {due.length} due now
          </p>
        </div>
        <button onClick={download} disabled={!cards.length}>
          Export for Anki
        </button>
      </header>
      {!cards.length ? (
        <div className="review-empty">
          <b>No cards yet.</b>
          <p>
            While reading, mark a definition or result as <i>Understood</i>; it becomes a review card here, scheduled so
            that it returns just before you would forget it.
          </p>
        </div>
      ) : !card ? (
        <div className="review-empty">
          <b>All caught up.</b>
          <p>
            {upcoming
              ? `The next card is due ${new Date(upcoming).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`
              : 'Nothing is scheduled.'}
          </p>
        </div>
      ) : (
        <article className="review-card" aria-label="Review card">
          <header>
            <span>{card.node.kind}</span>
            <b>{displayUnitLabel(card.node)}</b>
            <button onClick={() => openUnit(card.paperId, card.node.id)}>Open in paper</button>
          </header>
          <h3>
            <MathText value={card.node.title || displayUnitLabel(card.node)} citations={card.node.citations ?? []} />
          </h3>
          <p className="review-source">
            <MathText value={card.paperTitle} />
          </p>
          {revealed ? (
            <>
              <div className="review-answer">
                <MathText value={card.node.statement} block citations={card.node.citations ?? []} />
              </div>
              <div className="review-grades" role="group" aria-label="How well did you recall it?">
                {grades.map(([value, label], index) => (
                  <button key={value} className={`review-grade-${value}`} onClick={() => answer(value)}>
                    <b>{label}</b>
                    <small>
                      {intervalLabel(state, value, now)} · {index + 1}
                    </small>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <button className="review-reveal" onClick={() => setRevealed(true)}>
              Recall the statement, then show it <small>Space</small>
            </button>
          )}
        </article>
      )}
    </section>
  );
}
