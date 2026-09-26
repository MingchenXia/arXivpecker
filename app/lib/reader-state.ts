import type { Note, ReadingMark } from './types';

export type ReaderStateSlices = {
  notes: Note[];
  nodeNotes: Record<string, Record<string, string>>;
  nodeAnswers: Record<string, Record<string, string>>;
  expanded: Record<string, Record<string, boolean>>;
  marks: Record<string, Record<string, Exclude<ReadingMark, ''>>>;
};

// State updates replace only the slice of the paper they touch, so comparing
// slices by identity finds every paper whose reader state needs saving.
export function changedReaderPapers(previous: ReaderStateSlices, next: ReaderStateSlices) {
  const changed = new Set<string>();
  for (const key of ['nodeNotes', 'nodeAnswers', 'expanded', 'marks'] as const) {
    const before: Record<string, unknown> = previous[key];
    const after: Record<string, unknown> = next[key];
    if (before === after) continue;
    for (const paperId of new Set([...Object.keys(before), ...Object.keys(after)]))
      if (before[paperId] !== after[paperId]) changed.add(paperId);
  }
  if (previous.notes !== next.notes) {
    const byPaper = (notes: Note[]) => {
      const groups = new Map<string, Note[]>();
      for (const note of notes) {
        const group = groups.get(note.paperId);
        if (group) group.push(note);
        else groups.set(note.paperId, [note]);
      }
      return groups;
    };
    const before = byPaper(previous.notes);
    const after = byPaper(next.notes);
    for (const paperId of new Set([...before.keys(), ...after.keys()])) {
      const left = before.get(paperId) ?? [];
      const right = after.get(paperId) ?? [];
      if (left.length !== right.length || left.some((note, index) => note !== right[index])) changed.add(paperId);
    }
  }
  return changed;
}
