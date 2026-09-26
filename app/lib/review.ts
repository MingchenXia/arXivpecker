// Spaced-repetition review of the definitions and results a reader marked as
// understood, with export to Anki.
import type { AuditNode, NodeKind, Paper } from './types';

export const reviewKeyPrefix = '__review__:';
export const reviewKey = (nodeId: string) => `${reviewKeyPrefix}${nodeId}`;

export type ReviewCard = {
  id: string;
  paperId: string;
  paperTitle: string;
  arxivId: string;
  node: AuditNode;
};
export type ReviewState = { due: string; interval: number; ease: number; reps: number; lapses: number };
export type Grade = 'again' | 'hard' | 'good' | 'easy';

const cardKinds: NodeKind[] = ['definition', 'notation', 'theorem', 'lemma', 'proposition', 'corollary', 'conjecture'];

/** One card per definition or result the reader marked as understood, in library then paper order. */
export function reviewCards(
  sources: { paper: Pick<Paper, 'id' | 'title' | 'arxivId'>; nodes: AuditNode[] }[],
  isUnderstood: (unit: { paperId: string; nodeId: string }) => boolean,
) {
  const cards: ReviewCard[] = [];
  for (const { paper, nodes } of sources)
    for (const node of nodes)
      if (
        cardKinds.includes(node.kind) &&
        node.statement.trim() &&
        isUnderstood({ paperId: paper.id, nodeId: node.id })
      )
        cards.push({
          id: `${paper.id}::${node.id}`,
          paperId: paper.id,
          paperTitle: paper.title,
          arxivId: paper.arxivId,
          node,
        });
  return cards;
}

export function parseReviewState(value: string | undefined): ReviewState | null {
  try {
    const parsed = JSON.parse(value || 'null') as Partial<ReviewState> | null;
    if (!parsed || typeof parsed.due !== 'string' || Number.isNaN(Date.parse(parsed.due))) return null;
    const number = (item: unknown, fallback: number) =>
      typeof item === 'number' && Number.isFinite(item) ? item : fallback;
    return {
      due: parsed.due,
      interval: number(parsed.interval, 0),
      ease: number(parsed.ease, 2.5),
      reps: number(parsed.reps, 0),
      lapses: number(parsed.lapses, 0),
    };
  } catch {
    return null;
  }
}

const day = 24 * 60 * 60 * 1000;

/**
 * SM-2 with Anki's four answers. Intervals are in days; "again" brings the card
 * back in ten minutes and restarts its schedule.
 */
export function schedule(state: ReviewState | null, grade: Grade, now = new Date()): ReviewState {
  const current = state ?? { due: now.toISOString(), interval: 0, ease: 2.5, reps: 0, lapses: 0 };
  if (grade === 'again')
    return {
      due: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      interval: 0,
      ease: Math.max(1.3, current.ease - 0.2),
      reps: 0,
      lapses: current.lapses + 1,
    };
  const ease = Math.max(1.3, current.ease + (grade === 'hard' ? -0.15 : grade === 'easy' ? 0.15 : 0));
  let interval: number;
  if (grade === 'hard') interval = Math.max(1, Math.round(current.interval * 1.2));
  else if (current.reps === 0) interval = grade === 'easy' ? 4 : 1;
  else if (current.reps === 1 && grade === 'good') interval = 3;
  else interval = Math.max(current.interval + 1, Math.round(current.interval * ease * (grade === 'easy' ? 1.3 : 1)));
  return {
    due: new Date(now.getTime() + interval * day).toISOString(),
    interval,
    ease,
    reps: current.reps + 1,
    lapses: current.lapses,
  };
}

/** How long until a card graded this way comes back, for the answer buttons. */
export function intervalLabel(state: ReviewState | null, grade: Grade, now = new Date()) {
  const next = schedule(state, grade, now);
  const minutes = Math.round((Date.parse(next.due) - now.getTime()) / 60000);
  if (minutes < 60) return `${minutes}m`;
  const days = Math.round(minutes / 1440);
  return days < 31 ? `${days}d` : `${Math.round(days / 30)}mo`;
}

/** Cards to review now: overdue ones first, then new ones, in deck order. */
export function dueCards(cards: ReviewCard[], stateOf: (card: ReviewCard) => ReviewState | null, now = new Date()) {
  const scheduled = cards
    .map((card) => ({ card, state: stateOf(card) }))
    .filter(({ state }) => state && Date.parse(state.due) <= now.getTime())
    .sort((a, b) => Date.parse(a.state!.due) - Date.parse(b.state!.due))
    .map(({ card }) => card);
  return [...scheduled, ...cards.filter((card) => !stateOf(card))];
}

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Paper text as an Anki HTML field: MathJax delimiters, escaped markup, no tabs. */
export function ankiField(text: string) {
  const math = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$]+?)\$|\\\(([\s\S]+?)\\\)/g;
  let result = '';
  let cursor = 0;
  const prose = (value: string) =>
    escapeHtml(
      value.replace(
        /\[\[cite:([^|\]]+)(?:\|([^\]]*))?\]\]/g,
        (_, key, locator) => `[${key}${locator ? `, ${locator}` : ''}]`,
      ),
    )
      .replace(/\t/g, ' ')
      .replace(/\r?\n/g, '<br>');
  for (const match of text.matchAll(math)) {
    result += prose(text.slice(cursor, match.index));
    const display = match[1] ?? match[2];
    const expression = escapeHtml((display ?? match[3] ?? match[4]).replace(/\s+/g, ' ').trim());
    result += display !== undefined ? `\\[${expression}\\]` : `\\(${expression}\\)`;
    cursor = (match.index ?? 0) + match[0].length;
  }
  return result + prose(text.slice(cursor));
}

/**
 * A tab-separated file Anki imports directly (File → Import): front, back, tags.
 * `label` names a unit as the reader shows it ("Theorem 2.1").
 */
export function ankiExport(cards: ReviewCard[], label: (node: AuditNode) => string) {
  const tag = (value: string) => value.replace(/[^A-Za-z0-9_.:-]+/g, '_');
  const lines = cards.map((card) => {
    const source = card.arxivId.startsWith('local-') ? card.paperTitle : `${card.paperTitle} (arXiv:${card.arxivId})`;
    const front = `<b>${escapeHtml(label(card.node))}</b>${card.node.title ? ` — ${ankiField(card.node.title)}` : ''}<br><small>${ankiField(source)}</small>`;
    const tags = ['arxivpecker', card.node.kind, card.arxivId.startsWith('local-') ? '' : `arXiv:${card.arxivId}`]
      .filter(Boolean)
      .map(tag)
      .join(' ');
    return [front, ankiField(card.node.statement), tags].join('\t');
  });
  return ['#separator:tab', '#html:true', '#tags column:3', ...lines].join('\n') + '\n';
}
