import assert from 'node:assert/strict';

// The /api/arxiv route delegates to this framework-free module; Node runs it
// directly with --experimental-strip-types (see the test:arxiv-route script).
const { handleArxivRequest, configureArxivUpstream, resetArxivUpstream } =
  await import('../app/api/arxiv/arxiv-metadata.ts');

const SPACING_MS = 40;
const originalFetch = globalThis.fetch;
let calls = [];
let inFlight = 0;
let maxInFlight = 0;

function stubUpstream(route, options = {}) {
  resetArxivUpstream();
  configureArxivUpstream({ apiSpacingMs: SPACING_MS, ...options });
  calls = [];
  inFlight = 0;
  maxInFlight = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { url, method: init.method ?? 'GET', at: Date.now(), signal: init.signal };
    calls.push(call);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await route(url, call);
    } finally {
      inFlight -= 1;
    }
  };
}

async function get(query) {
  const response = await handleArxivRequest(new Request(`http://localhost/api/arxiv?${query}`));
  return { status: response.status, cacheControl: response.headers.get('cache-control'), body: await response.json() };
}

const reply = (body, status = 200, headers = {}) => new Response(body, { status, headers });
const hang = (signal) =>
  new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }),
  );
const isExportApi = (url) => url.hostname === 'export.arxiv.org' && url.pathname === '/api/query';
const isArxivAbs = (url) => url.hostname === 'arxiv.org' && url.pathname.startsWith('/abs/');
const apiCalls = () => calls.filter((call) => call.url.pathname === '/api/query');
const describeCall = (call) => `${call.method} ${call.url.hostname}${call.url.pathname}`;
const gaps = (list) => list.slice(1).map((call, index) => call.at - list[index].at);

const entry = (id, title = `Paper ${id}`) =>
  `<entry><id>http://arxiv.org/abs/${id}</id><title>${title}</title><summary>Abstract of ${id}.</summary>` +
  `<author><name>Ada Author</name></author>` +
  `<arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="math.DG"/>` +
  `<category term="math.DG" scheme="http://arxiv.org/schemas/atom"/></entry>`;
const feed = (entries) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join('')}</feed>`;
// Mirrors arxiv.org/abs markup, including the "Title:"/"Abstract:" descriptor spans.
const absPage = (title) =>
  `<html><body><h1 class="title mathjax"><span class="descriptor">Title:</span>${title}</h1>` +
  `<div class="authors"><span class="descriptor">Authors:</span><a href="/a/writer_b">Bea Writer</a></div>` +
  `<blockquote class="abstract mathjax"><span class="descriptor">Abstract:</span>From the abstract page.</blockquote>` +
  `<td class="tablecell subjects"><span class="primary-subject">Differential Geometry (math.DG)</span></td>` +
  `<div class="submission-history"><strong>[v1]</strong> Mon, 1 Sep 2025 <strong>[v2]</strong> Tue, 2 Sep 2025</div>` +
  `</body></html>`;
const listingPage = (ids) =>
  `<dl id="articles"><h3>Fri, 26 Sep 2026 (showing ${ids.length} of ${ids.length} entries )</h3>` +
  ids
    .map(
      (id) =>
        `<dt><a href ="/abs/${id}" title="Abstract" id="${id}">arXiv:${id}</a></dt><dd><div class="meta">` +
        `<div class="list-title mathjax"><span class="descriptor">Title:</span> Listed ${id}</div>` +
        `<div class="list-authors"><a href="/a/author_a">Ada Author</a></div>` +
        `<div class="list-subjects"><span class="descriptor">Subjects:</span> ` +
        `<span class="primary-subject">Differential Geometry (math.DG)</span></div></div></dd>`,
    )
    .join('') +
  `</dl>`;

try {
  // Hosts are tried one after another; a failing host is not raced against the next.
  stubUpstream((url) => (isExportApi(url) ? reply('unavailable', 500) : reply(absPage('Sequential Fallback'))));
  let result = await get('id=2501.00001');
  assert.equal(result.status, 200);
  assert.equal(result.body.papers[0].title, 'Sequential Fallback');
  assert.equal(result.body.papers[0].abstract, 'From the abstract page.');
  assert.equal(result.body.papers[0].arxivId, '2501.00001v2', 'The abstract page resolves the latest version.');
  assert.deepEqual(calls.map(describeCall), ['GET export.arxiv.org/api/query', 'GET arxiv.org/abs/2501.00001']);
  assert.equal(maxInFlight, 1, 'Only one upstream request may be in flight per lookup.');

  // A host that hangs is aborted at its timeout before the next host is asked.
  stubUpstream((url, call) => (isExportApi(url) ? hang(call.signal) : reply(absPage('After Timeout'))), {
    timeoutMs: 60,
  });
  result = await get('id=2501.00002');
  assert.equal(result.status, 200);
  assert.equal(result.body.papers[0].title, 'After Timeout');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signal.aborted, true, 'The timed-out request must be cancelled.');
  assert.ok(calls[1].at - calls[0].at >= 55, 'The fallback starts only after the first attempt timed out.');
  assert.equal(maxInFlight, 1);

  // Successful lookups are cached by upstream URL; equivalent inputs share the entry.
  stubUpstream((url) => (isExportApi(url) ? reply(feed([entry('2501.00003v1', 'Cached Paper')])) : reply('', 500)));
  const first = await get('id=2501.00003');
  const second = await get(`id=${encodeURIComponent('https://arxiv.org/abs/2501.00003')}`);
  assert.equal(first.status, 200);
  assert.equal(first.cacheControl, 'private, max-age=300');
  assert.deepEqual(second.body, first.body);
  assert.equal(calls.length, 1, 'A cache hit must not reach arXiv again.');

  // Failures are not cached.
  stubUpstream(() => reply('down', 500));
  result = await get('id=2501.00004');
  assert.equal(result.status, 502);
  assert.equal(result.cacheControl, 'no-store');
  assert.match(result.body.error, /Could not retrieve arXiv:2501\.00004/);
  assert.deepEqual(result.body.papers, []);
  assert.deepEqual(calls.map(describeCall), [
    'GET export.arxiv.org/api/query',
    'GET arxiv.org/abs/2501.00004',
    'GET arxiv.org/api/query',
    'GET export.arxiv.org/abs/2501.00004',
    'GET papers.cool/arxiv/2501.00004',
    'GET api.openalex.org/works',
  ]);
  const failedCalls = calls.length;
  await get('id=2501.00004');
  assert.equal(calls.length, 2 * failedCalls, 'A failed lookup must be retried upstream, not served from cache.');

  // Third parties are a last resort, consulted only after every arXiv host failed.
  stubUpstream((url, call) => {
    if (url.hostname === 'papers.cool') {
      return reply(
        '<meta name="citation_title" content="Mirror Title"><meta name="citation_authors" content="Ada Author; Bea Writer">' +
          '<meta name="citation_abstract" content="Mirror abstract."><meta name="citation_publisher" content="arXiv math.AG">',
      );
    }
    if (call.method === 'HEAD' && url.hostname === 'export.arxiv.org') {
      return reply(null, 200, { 'content-disposition': 'attachment; filename="arXiv-2501.00005v3.tar.gz"' });
    }
    return reply('down', 503);
  });
  result = await get('id=2501.00005');
  assert.equal(result.status, 200);
  assert.equal(result.body.papers[0].title, 'Mirror Title');
  assert.equal(result.body.papers[0].arxivId, '2501.00005v3');
  assert.equal(result.body.papers[0].id, 'arxiv-2501-00005v3');
  assert.deepEqual(calls.map(describeCall).slice(4), [
    'GET papers.cool/arxiv/2501.00005',
    'HEAD export.arxiv.org/e-print/2501.00005',
  ]);

  // Retry-After is honoured once, then the lookup falls back to the next host.
  stubUpstream((url) =>
    isExportApi(url) ? reply('slow down', 429, { 'Retry-After': '1' }) : reply(absPage('After 429')),
  );
  result = await get('id=2501.00006');
  assert.equal(result.status, 200);
  assert.equal(result.body.papers[0].title, 'After 429');
  assert.equal(apiCalls().length, 2, 'A 429 is retried exactly once.');
  assert.ok(gaps(apiCalls())[0] >= 990, `The retry waited ${gaps(apiCalls())[0]} ms instead of Retry-After.`);
  assert.ok(isArxivAbs(calls[2].url));

  // A Retry-After beyond the cap is not waited out, and it holds back later API calls.
  stubUpstream((url) =>
    isExportApi(url) ? reply('busy', 503, { 'Retry-After': '120' }) : reply(absPage('After 503')),
  );
  const started = Date.now();
  result = await get('id=2501.00007');
  assert.equal(result.status, 200);
  assert.equal(result.body.papers[0].title, 'After 503');
  assert.ok(Date.now() - started < 1000, 'A long Retry-After must not be waited out.');
  assert.deepEqual(calls.map(describeCall), ['GET export.arxiv.org/api/query', 'GET arxiv.org/abs/2501.00007']);
  result = await get('id=2501.00008');
  assert.equal(result.status, 200);
  assert.equal(apiCalls().length, 1, 'The API is not asked again while its Retry-After is in force.');

  // A paper arXiv does not have is a 404, and its ID is never sent to third parties.
  stubUpstream((url) => (isExportApi(url) ? reply(feed([])) : reply('Article identifier not recognized', 404)));
  result = await get('id=2501.99999');
  assert.equal(result.status, 404);
  assert.equal(result.cacheControl, 'no-store');
  assert.deepEqual(result.body.papers, []);
  assert.match(result.body.error, /arXiv has no paper with the identifier 2501\.99999/);
  assert.deepEqual(calls.map(describeCall), ['GET export.arxiv.org/api/query', 'GET arxiv.org/abs/2501.99999']);

  // An API "no such paper" answer is enough for a 404 when the abstract pages are down.
  const errorEntry =
    '<entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_2501.99998</id><title>Error</title></entry>';
  stubUpstream((url) => (url.pathname === '/api/query' ? reply(feed([errorEntry])) : reply('down', 500)));
  result = await get('id=2501.99998');
  assert.equal(result.status, 404);
  assert.ok(
    calls.every((call) => call.url.hostname.endsWith('arxiv.org')),
    'No third party is asked about a paper arXiv says does not exist.',
  );

  // The scheduler queues API calls at least SPACING_MS apart and drops none.
  stubUpstream(() => reply(feed([entry('2509.00001')])));
  const feeds = await Promise.all(
    ['math.DG', 'math.AG', 'math.NT', 'math.CO'].map((area) => get(`categories=${area}`)),
  );
  assert.deepEqual(
    feeds.map((item) => item.status),
    [200, 200, 200, 200],
  );
  assert.equal(apiCalls().length, 4);
  for (const gap of gaps(apiCalls())) assert.ok(gap >= SPACING_MS - 2, `API calls were only ${gap} ms apart.`);
  await get('categories=math.DG');
  assert.equal(apiCalls().length, 4, 'Category feeds are cached too.');

  // latest=1 fills abstracts in with id_list chunks of at most 100 identifiers.
  const listed = Array.from({ length: 250 }, (_, index) => `2609.${String(index + 1).padStart(5, '0')}`);
  const answerChunks = (url) => {
    if (url.pathname.startsWith('/list/')) return reply(listingPage(listed));
    const ids = url.searchParams.get('id_list').split(',');
    return reply(feed(ids.map((id) => entry(`${id}v1`))));
  };
  stubUpstream(answerChunks);
  result = await get('categories=math.DG&latest=1');
  assert.equal(result.status, 200);
  assert.equal(result.cacheControl, 'private, max-age=300');
  assert.equal(result.body.mode, 'latest');
  assert.equal(result.body.batchLabel, 'Fri, 26 Sep 2026');
  assert.equal(result.body.total, 250);
  assert.equal(result.body.papers.length, 250);
  assert.ok(result.body.papers.every((paper, index) => paper.abstract === `Abstract of ${listed[index]}v1.`));
  const chunkSizes = apiCalls().map((call) => call.url.searchParams.get('id_list').split(',').length);
  assert.deepEqual(chunkSizes, [100, 100, 50]);
  assert.deepEqual(
    apiCalls().map((call) => Number(call.url.searchParams.get('max_results'))),
    [100, 100, 50],
  );
  for (const gap of gaps(apiCalls())) assert.ok(gap >= SPACING_MS - 2, `Chunks were only ${gap} ms apart.`);
  assert.equal(maxInFlight, 1);

  // A failing chunk keeps the listing's own entries and stops further chunk requests.
  stubUpstream((url) =>
    url.searchParams.get('id_list')?.startsWith('2609.00101') ? reply('down', 500) : answerChunks(url),
  );
  result = await get('categories=math.DG&latest=1');
  assert.equal(result.status, 200);
  assert.equal(result.cacheControl, 'no-store', 'An incompletely enriched batch is not cached by the browser.');
  assert.equal(apiCalls().length, 2);
  assert.equal(result.body.papers[0].abstract, 'Abstract of 2609.00001v1.');
  assert.equal(result.body.papers[100].abstract, '');
  assert.equal(result.body.papers[100].title, 'Listed 2609.00101');

  // Invalid identifiers are still rejected before any upstream request.
  stubUpstream(() => reply('unexpected', 500));
  result = await get('id=not-an-id');
  assert.equal(result.status, 400);
  assert.equal(calls.length, 0);

  // The update watch asks for the current version of several papers in one request.
  stubUpstream((url) =>
    isExportApi(url)
      ? reply(
          feed(
            url.searchParams
              .get('id_list')
              .split(',')
              .map((id) => entry(`${id}v3`)),
          ),
        )
      : reply('unexpected', 500),
  );
  result = await get('ids=2608.24719v1,2607.17203,not-an-id,2608.24719');
  assert.equal(result.status, 200);
  assert.equal(apiCalls().length, 1);
  assert.equal(
    apiCalls()[0].url.searchParams.get('id_list'),
    '2608.24719,2607.17203',
    'Versions are dropped and ids deduplicated.',
  );
  assert.deepEqual(
    result.body.papers.map((paper) => paper.arxivId),
    ['2608.24719v3', '2607.17203v3'],
  );
  result = await get('ids=');
  assert.equal(result.status, 400);
} finally {
  globalThis.fetch = originalFetch;
  configureArxivUpstream();
  resetArxivUpstream();
}

console.log(
  'arXiv route: sequential fallback, timeouts, caching, Retry-After, 404s, id_list chunking, and API spacing verified.',
);
