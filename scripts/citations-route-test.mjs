import assert from 'node:assert/strict';

// The /api/citations route delegates to this framework-free module; Node runs it
// directly with --experimental-strip-types (see the test:citations-route script).
const { arxivIdOf, handleCitationsRequest, resetCitationCache } = await import('../app/api/citations/openalex.ts');

const originalFetch = globalThis.fetch;
let calls = [];
function stub(route) {
  resetCitationCache();
  calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    return route(url);
  };
}
const get = async (query) => {
  const response = await handleCitationsRequest(new Request(`http://localhost/api/citations?${query}`));
  return { status: response.status, body: await response.json() };
};

try {
  assert.equal(arxivIdOf({ doi: 'https://doi.org/10.48550/arxiv.2401.01234' }), '2401.01234');
  assert.equal(arxivIdOf({ locations: [{ landing_page_url: 'http://arxiv.org/abs/2402.00002v2' }] }), '2402.00002v2');
  assert.equal(arxivIdOf({ doi: 'https://doi.org/10.1007/s00222-020-01000-1', locations: [] }), '');

  stub((url) => {
    if (url.pathname === '/works/doi:10.48550/arXiv.2608.24719')
      return Response.json({ id: 'https://openalex.org/W42', cited_by_count: 2 });
    if (url.pathname === '/works' && url.searchParams.get('filter') === 'cites:W42')
      return Response.json({
        meta: { count: 2 },
        results: [
          {
            id: 'https://openalex.org/W7',
            display_name: 'A later paper',
            publication_date: '2026-09-01',
            doi: 'https://doi.org/10.48550/arxiv.2609.00007',
            authorships: ['A', 'B', 'C', 'D'].map((name) => ({ author: { display_name: name } })),
          },
          {
            id: 'https://openalex.org/W8',
            display_name: 'A journal paper',
            publication_date: '2026-08-01',
            doi: 'https://doi.org/10.1000/j.1',
            authorships: [{ author: { display_name: 'E' } }],
            locations: [],
          },
        ],
      });
    return new Response('not found', { status: 404 });
  });
  let result = await get('arxivId=2608.24719v1');
  assert.equal(result.status, 200);
  assert.deepEqual(
    { found: result.body.found, workId: result.body.workId, count: result.body.citedByCount },
    { found: true, workId: 'W42', count: 2 },
  );
  assert.deepEqual(result.body.citing[0], {
    id: 'https://openalex.org/W7',
    title: 'A later paper',
    date: '2026-09-01',
    authors: 'A, B, C et al.',
    arxivId: '2609.00007',
    url: 'https://arxiv.org/abs/2609.00007',
  });
  assert.equal(result.body.citing[1].url, 'https://doi.org/10.1000/j.1');
  assert.equal(calls[1].searchParams.get('sort'), 'publication_date:desc');

  // The answer is cached per paper, whatever the version asked for.
  result = await get('arxivId=2608.24719v2');
  assert.equal(calls.length, 2);

  // A paper OpenAlex does not know is reported, not an error.
  result = await get('arxivId=2501.00001');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { found: false, workId: '', citedByCount: 0, citing: [] });

  stub(() => new Response('busy', { status: 503 }));
  result = await get('arxivId=2501.00002');
  assert.equal(result.status, 502);

  stub(() => assert.fail('No request for an invalid identifier.'));
  result = await get('arxivId=nonsense');
  assert.equal(result.status, 400);
} finally {
  globalThis.fetch = originalFetch;
}
console.log('Citations route: OpenAlex lookup, arXiv ids of citing works, caching, and errors verified.');
