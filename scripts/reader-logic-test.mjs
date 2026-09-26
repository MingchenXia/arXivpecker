import assert from 'node:assert/strict';

// The reader's framework-free logic lives in app/lib/*.ts; Node runs it directly
// with --experimental-strip-types (see the test:reader-logic script).
const { renderMath } = await import('../app/lib/tex-text.ts');
const { changedReaderPapers } = await import('../app/lib/reader-state.ts');

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

// Package commands KaTeX lacks must not fall back to operator names such as
// "abs x", "mathbbm 1", or "SI 3 meter". Compare what a reader sees and hears:
// the rendered HTML and MathML text, without the TeX source annotation.
const renderedText = (expression, display = false) =>
  (renderMath(expression, display) ?? 'did not typeset')
    .replace(/<annotation[\s\S]*?<\/annotation>/g, '')
    .replace(/<[^>]+>/g, '');
for (const [command, definition] of [
  [String.raw`\abs{x}`, String.raw`\left\lvert x\right\rvert`],
  [String.raw`\abs*{x}`, String.raw`\left\lvert x\right\rvert`],
  [String.raw`\abs[\big]{x}`, String.raw`\bigl\lvert x\bigr\rvert`],
  [String.raw`\norm{x}`, String.raw`\left\lVert x\right\rVert`],
  [String.raw`\ceil{x}`, String.raw`\left\lceil x\right\rceil`],
  [String.raw`\floor{x}`, String.raw`\left\lfloor x\right\rfloor`],
  [String.raw`\mathds{R}`, String.raw`\mathbb{R}`],
  [String.raw`\SI{3}{\meter}`, String.raw`3\,\mathrm{m}`],
  [String.raw`\si{\kilo\meter\per\second\squared}`, String.raw`\mathrm{km/s^{2}}`],
  [String.raw`\si{\micro\meter}`, String.raw`\mathrm{\mu m}`],
  [String.raw`\num{0.5}`, '0.5'],
  [String.raw`\ang{30}`, String.raw`30^{\circ}`],
  [String.raw`x \defeq y`, String.raw`x \coloneqq y`],
  [String.raw`\faktor{G}{H}`, String.raw`{\raisebox{.2em}{$G$}\left/\raisebox{-.2em}{$H$}\right.}`],
  [String.raw`\bigslant{G}{H}`, String.raw`{\raisebox{.2em}{$G$}\left/\raisebox{-.2em}{$H$}\right.}`],
  [String.raw`\textsc{abc}`, String.raw`\text{abc}`],
  [String.raw`\esssup_x f`, String.raw`\operatorname*{ess\,sup}_x f`],
  [String.raw`\essinf_x f`, String.raw`\operatorname*{ess\,inf}_x f`],
  [String.raw`\int f \dd x`, String.raw`\int f \mathop{}\!\mathrm{d}x`],
])
  assert.equal(renderedText(command), renderedText(definition), `${command} must render as ${definition}.`);
assert.equal(renderedText(String.raw`\abs{x}`), '∣x∣∣x∣', 'MathML and HTML both show the bars, never "abs".');
// KaTeX's \mathbb has no digits, so every spelling of the indicator 1 draws it
// and gives MathML the double-struck character.
for (const indicator of [
  String.raw`\mathbbm{1}_A`,
  String.raw`\mathds{1}_A`,
  String.raw`\mathbb{1}_A`,
  String.raw`\mathbb 1_A`,
  String.raw`\1_A`,
  String.raw`\bbone_A`,
]) {
  assert.match(renderMath(indicator, false) ?? '', /<mi mathvariant="normal">𝟙<\/mi>/, indicator);
  assert.equal(renderedText(indicator), renderedText(String.raw`\bbone_A`), indicator);
}
assert.equal(renderedText(String.raw`\mathbb{1}x`), renderedText(String.raw`\bbone x`));
const intertext = renderedText(String.raw`\begin{aligned}a&=b\\\intertext{so}c&=d\end{aligned}`, true);
assert.match(intertext, /so/);
assert.doesNotMatch(intertext, /intertext/, '\\intertext must set its text between rows.');
for (const average of [String.raw`\fint_B f`, String.raw`\dashint_B f`])
  assert.doesNotMatch(renderedText(average, true), /fint|dashint/, `${average} must draw an averaged integral.`);

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

// Bridge requests surface the service's message, a clear hint when the bridge is
// down, and a failure when a required field is missing.
const { bridgePost, bridgeGet, ServiceError } = await import('../app/lib/bridge-client.ts');
const realFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Paper not in vault.' }), { status: 404 });
  await assert.rejects(
    bridgePost('/vault/paper', {}, 'Could not save.'),
    (error) => error instanceof ServiceError && error.status === 404 && error.message === 'Paper not in vault.',
  );
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(
    bridgeGet('/vault', 'The library could not be loaded.'),
    /The library could not be loaded\. The local arXivpecker bridge is not reachable/,
  );
  globalThis.fetch = async () => new Response(JSON.stringify({ graph: {} }), { status: 200 });
  await assert.rejects(
    bridgePost('/vault/paper', {}, 'Could not create the paper folder.', { require: ['paper'] }),
    /Could not create the paper folder\./,
  );
  globalThis.fetch = async (url, init) =>
    new Response(JSON.stringify({ paper: { id: 'p' }, echo: JSON.parse(init.body), url }), { status: 200 });
  const posted = await bridgePost('/vault/paper', { paper: { id: 'p' } }, 'Could not save.', { require: ['paper'] });
  assert.equal(posted.paper.id, 'p');
  assert.equal(posted.url, 'http://127.0.0.1:4318/vault/paper');
} finally {
  globalThis.fetch = realFetch;
}

console.log(
  'Reader logic: macro fallback, typeset cache, per-paper reader-state changes, and bridge request errors verified.',
);

// A reading path lists prerequisites before the results that use them.
const { readingPath, understoodUnits } = await import('../app/lib/study.ts');
const unit = (id) => ({
  id,
  paperId: 'p',
  paperTitle: '',
  arxivId: '',
  nodeId: id,
  label: id,
  title: id,
  kind: 'lemma',
  page: null,
  status: 'verified',
});
const pathGraph = {
  version: 1,
  updatedAt: null,
  nodes: ['main', 'lemmaA', 'lemmaB', 'def', 'other'].map(unit),
  edges: [
    { id: '1', from: 'main', to: 'lemmaA', relation: 'uses', source: 'audit' },
    { id: '2', from: 'main', to: 'lemmaB', relation: 'uses', source: 'audit' },
    { id: '3', from: 'lemmaA', to: 'def', relation: 'uses', source: 'audit' },
    { id: '4', from: 'lemmaB', to: 'def', relation: 'background', source: 'manual' },
    { id: '5', from: 'def', to: 'main', relation: 'uses', source: 'audit' },
    { id: '6', from: 'main', to: 'other', relation: 'contrasts', source: 'manual' },
  ],
};
const route = readingPath(pathGraph, 'main', (node) => node.id === 'lemmaB');
assert.deepEqual(
  route.map((step) => step.node.id),
  ['def', 'lemmaA', 'lemmaB', 'main'],
  'Prerequisites come first; cycles and contrasts are cut.',
);
assert.deepEqual(
  route.map((step) => step.understood),
  [false, false, true, false],
);
const understood = understoodUnits(
  { p: { 'block-a': 'understood', 'block-b': 'question' } },
  {
    p: {
      sourceBlocks: [
        { id: 'block-a', nodeId: 'lemmaA' },
        { id: 'block-b', nodeId: 'lemmaB' },
      ],
    },
  },
);
assert.deepEqual(
  pathGraph.nodes.map(understood),
  [false, true, false, false, false],
  'A unit is understood once one of its blocks carries the mark.',
);
console.log('Reader logic: reading paths verified.');

// Study records survive malformed storage; Lean drafts expose their code block.
const { extractCodeBlock, parsePracticeRecord, proofPracticePrompt } = await import('../app/lib/study.ts');
assert.deepEqual(parsePracticeRecord('not json'), { attempt: '', feedback: '', updatedAt: '' });
assert.equal(parsePracticeRecord(JSON.stringify({ attempt: 'By induction.', feedback: 7 })).attempt, 'By induction.');
assert.equal(parsePracticeRecord(JSON.stringify({ attempt: 'x', feedback: 7 })).feedback, '');
assert.match(proofPracticePrompt('Lemma 2', '', 'hint'), /how to begin/);
assert.match(proofPracticePrompt('Lemma 2', 'Take $x$.', 'check'), /Take \$x\$\./);
assert.equal(
  extractCodeBlock('Intro\n```text\nnot this\n```\n```lean\ntheorem t : 1 = 1 := by\n  sorry\n```\nNotes'),
  'theorem t : 1 = 1 := by\n  sorry',
);
assert.equal(extractCodeBlock('```\nexample : True := trivial\n```'), 'example : True := trivial');
assert.equal(extractCodeBlock('No code.'), '');
console.log('Reader logic: study records verified.');

// Cited arXiv papers are listed once each, bibliography first.
const { arxivKey, citedArxivPapers } = await import('../app/lib/cited-papers.ts');
const citation = (key, arxivId, title = key) => ({ key, arxivId, title, authors: '', locator: '' });
assert.equal(arxivKey(' arXiv:2401.01234v3 '), '2401.01234');
assert.deepEqual(
  citedArxivPapers({
    sourceBlocks: [
      { citations: [citation('B', '2402.00002v2')] },
      { citations: [citation('none', '')] },
      { citations: [citation('A', '2401.00001')] },
    ],
    nodes: [{ citations: [citation('A', '2401.00001v1'), citation('C', 'math/0601001')] }],
  }).map((paper) => [paper.key, paper.arxivId]),
  [
    ['B', '2402.00002'],
    ['A', '2401.00001'],
    ['C', 'math/0601001'],
  ],
);
console.log('Reader logic: cited arXiv papers verified.');

// The glossary finds defined symbols and the formulas that use them.
const { buildGlossary, definedSymbol, definitionsIn, notationUsedIn, normalizeTex } =
  await import('../app/lib/glossary.ts');
assert.equal(definedSymbol('P_{k}:=P_{k,n} = M_k'), 'P_{k}');
assert.equal(definedSymbol('K_v=\\operatorname{Sp}_{2n}(\\mathcal{O}_v)'), 'K_v');
assert.equal(definedSymbol('H_M : M(\\mathbb{A}) \\rightarrow \\mathfrak{a}_P'), 'H_M');
assert.equal(definedSymbol('w\\in W_n'), '', 'A bound variable names nothing.');
assert.equal(definedSymbol('3\\leqslant k <n'), '');
assert.equal(definedSymbol('a, b'), '');
assert.equal(normalizeTex('f_s \\in I_{n}( s )'), 'f_s\\in I_n(s)');
assert.deepEqual(
  definitionsIn(
    'Let $F$ be a number field. We define $P_k := M_k U_k$ to be parabolic. Denote the resulting representation by $I_n(s)$. Let $w\\in W$ be a Weyl element. We define \\(k\\)-dependent embeddings. By $\\Sigma$ we denote the roots. Let $P$ and $Q$ denote two subgroups. We set $H = U^w$. The set $S$ of roots.',
  ).map((item) => item.symbol),
  ['F', 'P_k', 'I_n(s)', '\\Sigma', 'P', 'Q', 'H'],
);
const glossary = buildGlossary(
  [
    {
      id: 'b1',
      kind: 'paragraph',
      content: 'Let $F$ be a number field and let $I_n(s)$ denote the induced representation.',
      nodeId: '',
    },
    { id: 'b2', kind: 'result', content: 'Let $W_n := N(T)/T$ be the Weyl group.', nodeId: 'def-weyl' },
    { id: 'b3', kind: 'paragraph', content: 'Let $F$ be redefined here.', nodeId: '' },
  ],
  [],
);
assert.deepEqual(
  glossary.map((entry) => [entry.symbol, entry.unitId]),
  [
    ['F', 'source-block:b1'],
    ['I_n(s)', 'source-block:b1'],
    ['W_n', 'def-weyl'],
  ],
  'Each symbol is kept once, where it is first defined.',
);
const used = (formula) => notationUsedIn(formula, glossary).map((entry) => entry.symbol);
assert.deepEqual(used('f \\in I_{n}(1/2)'), ['I_n(s)']);
assert.deepEqual(used('w \\in W_n(F)'), ['W_n', 'F']);
assert.deepEqual(used('\\mathbb{F}_q \\times F_v'), [], 'Neither a font letter nor a subscripted symbol is F.');
assert.deepEqual(used('\\Phi + I_n'), [], 'I_n( is looked for with its argument.');
console.log('Reader logic: notation glossary verified.');

// The side-by-side PDF follows prose to the page of the result before it.
const { unitPage } = await import('../app/lib/pdf-sync.ts');
const pagedUnits = [
  { id: 'thm', anchor: { page: 4 } },
  { id: 'lemma', anchor: { page: null } },
  { id: 'def', anchor: { page: 7 } },
];
const pagedBlocks = [
  { id: 'p0', nodeId: '' },
  { id: 'r1', nodeId: 'thm' },
  { id: 'p1', nodeId: '' },
  { id: 'r2', nodeId: 'lemma' },
  { id: 'r3', nodeId: 'def' },
];
assert.equal(unitPage('def', pagedUnits, pagedBlocks), 7);
assert.equal(unitPage('source-block:p1', pagedUnits, pagedBlocks), 4);
assert.equal(unitPage('lemma', pagedUnits, pagedBlocks), 4, 'A result without a page takes the previous one.');
assert.equal(unitPage('source-block:p0', pagedUnits, pagedBlocks), undefined);
assert.equal(unitPage('unknown', pagedUnits, pagedBlocks), undefined);
console.log('Reader logic: PDF page sync verified.');

// Review cards: SM-2 scheduling, due order, and a file Anki can import.
const { ankiExport, ankiField, dueCards, parseReviewState, reviewCards, schedule } =
  await import('../app/lib/review.ts');
const reviewNode = (id, kind, statement = 'For all $x$, $f(x) < 1$.') => ({
  id,
  kind,
  label: id,
  title: `${id} title`,
  statement,
  citations: [],
});
const deck = reviewCards(
  [
    {
      paper: { id: 'p', title: 'Paper', arxivId: '2401.00001' },
      nodes: [
        reviewNode('thm', 'theorem'),
        reviewNode('rem', 'remark'),
        reviewNode('def', 'definition'),
        reviewNode('lem', 'lemma'),
      ],
    },
  ],
  (unit) => unit.nodeId !== 'lem',
);
assert.deepEqual(
  deck.map((card) => card.id),
  ['p::thm', 'p::def'],
  'Only understood definitions and results become cards.',
);
const start = new Date('2026-01-01T00:00:00Z');
const first = schedule(null, 'good', start);
assert.equal(first.interval, 1);
const second = schedule(first, 'good', start);
assert.equal(second.interval, 3);
const third = schedule(second, 'good', start);
assert.equal(third.interval, Math.round(3 * 2.5));
const lapsed = schedule(third, 'again', start);
assert.deepEqual([lapsed.reps, lapsed.lapses, lapsed.interval], [0, 1, 0]);
assert.equal(Date.parse(lapsed.due) - start.getTime(), 10 * 60 * 1000);
assert.equal(schedule(null, 'easy', start).interval, 4);
assert.ok(schedule(third, 'hard', start).interval < third.interval * 2.5);
assert.equal(parseReviewState('{"due":"nope"}'), null);
assert.equal(parseReviewState(JSON.stringify(first)).interval, 1);
const states = { 'p::thm': { ...first, due: '2026-01-05T00:00:00Z' } };
assert.deepEqual(
  dueCards(deck, (card) => states[card.id] ?? null, start).map((card) => card.id),
  ['p::def'],
  'A card scheduled for later is not due; a new card is.',
);
assert.equal(
  ankiField('If $a<b$ then\n$$\\sum a_i$$ [[cite:KM|Thm 2]]'),
  'If \\(a&lt;b\\) then<br>\\[\\sum a_i\\] [KM, Thm 2]',
);
const exported = ankiExport(deck, (node) => node.label).split('\n');
assert.deepEqual(exported.slice(0, 3), ['#separator:tab', '#html:true', '#tags column:3']);
assert.equal(exported[3].split('\t').length, 3);
assert.match(
  exported[3],
  /^<b>thm<\/b> — thm title<br><small>Paper \(arXiv:2401\.00001\)<\/small>\tFor all \\\(x\\\), \\\(f\(x\) &lt; 1\\\)\.\tarxivpecker theorem arXiv:2401\.00001$/,
);
console.log('Reader logic: review scheduling and Anki export verified.');

// The update and citation watch: a baseline first, then only what is new.
const { mergeWatch, newerVersion, parseWatch } = await import('../app/lib/watch.ts');
const work = (id) => ({ id, title: id, date: '', authors: '', arxivId: '', url: '' });
const baseline = mergeWatch(
  null,
  { latestVersion: '2401.00001v2', citations: { citedByCount: 1, citing: [work('W1')] } },
  't1',
);
assert.deepEqual(baseline.newIds, [], 'The first check is a baseline.');
const later = mergeWatch(
  baseline,
  { latestVersion: '2401.00001v3', citations: { citedByCount: 3, citing: [work('W3'), work('W2'), work('W1')] } },
  't2',
);
assert.deepEqual(later.newIds, ['W3', 'W2']);
const failed = mergeWatch(later, { latestVersion: '', citations: null }, 't3');
assert.deepEqual(
  [failed.latestVersion, failed.citedByCount, failed.newIds],
  ['2401.00001v3', 3, ['W3', 'W2']],
  'A failed lookup keeps what was known.',
);
assert.deepEqual(
  mergeWatch(
    { ...later, newIds: [] },
    { latestVersion: '', citations: { citedByCount: 3, citing: later.citing } },
    't4',
  ).newIds,
  [],
);
assert.equal(newerVersion('2401.00001v2', later), '2401.00001v3');
assert.equal(newerVersion('2401.00001v3', later), '');
assert.equal(newerVersion('2401.00001', baseline), '2401.00001v2', 'An unversioned library copy counts as v1.');
assert.equal(parseWatch('{broken'), null);
assert.deepEqual(parseWatch(JSON.stringify(later)).newIds, ['W3', 'W2']);
console.log('Reader logic: update and citation watch verified.');

// AI-written citations read like the paper's, whichever citation package they use.
{
  const { cleanTeXProse } = await import('../app/lib/tex-text.ts');
  assert.equal(
    cleanTeXProse(String.raw`As \parencite[Thm.~2]{kn} and \textcite{ab,cd} show, see also \cite{ef}.`),
    'As [kn, Thm.~2] and [ab] [cd] show, see also [ef].',
  );
  console.log('Reader logic: citation commands in AI text verified.');
}
