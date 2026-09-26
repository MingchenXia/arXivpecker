import assert from 'node:assert/strict';

// The reader's framework-free logic lives in app/lib/*.ts; Node runs it directly
// with --experimental-strip-types (see the test:reader-logic script).
const { renderMath } = await import('../app/lib/tex-text.ts');
const { changedReaderPapers } = await import('../app/lib/app.ts');

// An unknown author macro is replaced only as a whole control word.
const typeset = renderMath(String.raw`\eps < \epsilon`, false);
assert.ok(typeset, 'A formula with an unknown macro must still typeset.');
assert.match(
  typeset,
  /<annotation encoding="application\/x-tex">\\operatorname\{eps\} &lt; \\epsilon<\/annotation>/,
  'An unknown \\eps must not rewrite \\epsilon.',
);
assert.equal(
  renderMath(String.raw`\eps < \epsilon`, false),
  typeset,
  'Repeated formulas are served from the typeset cache.',
);
assert.notEqual(
  renderMath(String.raw`\eps < \epsilon`, true),
  typeset,
  'Display and inline math are cached separately.',
);

// Reader state is saved for every paper whose slice changed, and only for those.
const note = (paperId, id) => ({ id, paperId, nodeId: 'n', anchor: '', text: id, latex: '', createdAt: '' });
const a1 = note('A', 'a1');
const b1 = note('B', 'b1');
const base = { notes: [a1, b1], nodeNotes: { A: {}, B: {} }, nodeAnswers: { A: {}, B: {} }, expanded: {}, marks: {} };
assert.deepEqual([...changedReaderPapers(base, { ...base })], []);
assert.deepEqual(
  [...changedReaderPapers(base, { ...base, nodeAnswers: { ...base.nodeAnswers, A: { chat: 'answer' } } })],
  ['A'],
  'An AI answer for a background paper marks that paper.',
);
assert.deepEqual([...changedReaderPapers(base, { ...base, marks: { B: { x: 'understood' } } })], ['B']);
assert.deepEqual(
  [...changedReaderPapers(base, { ...base, notes: [note('A', 'a2'), a1, b1] })],
  ['A'],
  'A new note marks only its own paper.',
);
assert.deepEqual([...changedReaderPapers(base, { ...base, notes: [b1] })], ['A'], 'Deleting a note marks its paper.');

console.log('Reader logic: macro fallback, typeset cache, and per-paper reader-state changes verified.');
