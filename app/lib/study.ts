// Study aids built on the audit: reading paths, review scheduling, and card export.
import type { Graph, GraphNode, PaperAudit, ReadingMark } from './types';

export type ReadingPathStep = { node: GraphNode; depth: number; understood: boolean };

/**
 * Everything to read before `targetId`, prerequisites first: a depth-first walk of
 * the dependency graph ('uses', 'extends', and 'background' edges, across papers),
 * emitted in post-order so each unit comes after what it relies on. Cycles are
 * cut where they close. The target itself comes last.
 */
export function readingPath(graph: Graph, targetId: string, isUnderstood: (node: GraphNode) => boolean) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const prerequisites = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.relation === 'contrasts') continue;
    const list = prerequisites.get(edge.from) ?? [];
    if (!list.includes(edge.to)) list.push(edge.to);
    prerequisites.set(edge.from, list);
  }
  const steps: ReadingPathStep[] = [];
  const visited = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const next of prerequisites.get(id) ?? []) visit(next, depth + 1);
    const node = nodes.get(id);
    if (node) steps.push({ node, depth, understood: isUnderstood(node) });
  };
  visit(targetId, 0);
  return steps;
}

/**
 * Whether the reader marked a graph unit as understood. Marks are kept per source
 * block, so a unit counts once its statement or proof block carries the mark.
 */
export function understoodUnits(
  marks: Record<string, Record<string, Exclude<ReadingMark, ''>>>,
  audits: Record<string, Pick<PaperAudit, 'sourceBlocks'>>,
) {
  return (unit: GraphNode) => {
    const paperMarks = marks[unit.paperId];
    if (!paperMarks) return false;
    if (paperMarks[unit.nodeId] === 'understood') return true;
    return (audits[unit.paperId]?.sourceBlocks ?? []).some(
      (block) => block.nodeId === unit.nodeId && paperMarks[block.id] === 'understood',
    );
  };
}

// Study records live beside the unit's AI answers, under prefixed keys.
export const practiceKeyPrefix = '__practice__:';
export const leanKeyPrefix = '__lean__:';
export const practiceKey = (nodeId: string) => `${practiceKeyPrefix}${nodeId}`;
export const leanKey = (nodeId: string) => `${leanKeyPrefix}${nodeId}`;

export type PracticeRecord = { attempt: string; feedback: string; updatedAt: string };

export function parsePracticeRecord(value: string | undefined): PracticeRecord {
  try {
    const parsed = JSON.parse(value || '{}') as Partial<PracticeRecord>;
    return {
      attempt: typeof parsed.attempt === 'string' ? parsed.attempt : '',
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return { attempt: '', feedback: '', updatedAt: '' };
  }
}

export function proofPracticePrompt(label: string, attempt: string, mode: 'check' | 'hint') {
  const rules =
    'Never reproduce the author proof or later steps the reader has not reached; the reader is practicing. Use $...$ for mathematics.';
  if (mode === 'hint')
    return `The reader is trying to prove ${label} without looking at the author proof. ${
      attempt.trim()
        ? 'Their attempt so far is below. Give exactly one hint for the next step, as a question or a pointer to a prerequisite, not a solution.'
        : 'They have not started. Give exactly one hint for how to begin: which prerequisite or idea to reach for, not a solution.'
    } ${rules}${attempt.trim() ? `\n\nReader's attempt:\n${attempt}` : ''}`;
  return `The reader wrote the proof of ${label} below without looking at the author proof. Compare it with the author proof in the paper. Reply in three short parts: "Correct" (the steps that hold, even if they differ from the author route), "Gaps" (missing or false steps, each with what would be needed to close it), and "Next" (one hint to continue). If the attempt is essentially complete, say so and then describe how its route differs from the author's. ${rules}\n\nReader's attempt:\n${attempt}`;
}

export function leanDraftPrompt(label: string) {
  return `Draft a Lean 4 formalization of the statement of ${label} against current Mathlib. Give one \`\`\`lean code block that states it as a theorem (or def/structure for a definition) with the proof body \`sorry\`, including the imports and any local definitions it needs. After the block, list: the Mathlib declarations the statement relies on; every point where the Lean statement differs from the paper (hypotheses made explicit, conventions, generality); and anything Mathlib lacks. Say plainly that the draft was not compiled.`;
}

/** The first fenced code block of a given language (or any fenced block), unfenced. */
export function extractCodeBlock(text: string, language = 'lean') {
  const blocks = [...text.matchAll(/```([\w-]*)[^\n]*\n([\s\S]*?)```/g)];
  const match = blocks.find((block) => block[1].toLowerCase() === language) ?? blocks[0];
  return match ? match[2].replace(/\s+$/, '') : '';
}
