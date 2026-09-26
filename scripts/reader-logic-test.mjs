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
