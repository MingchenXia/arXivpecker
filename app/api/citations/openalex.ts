// Papers that cite an arXiv paper, from OpenAlex. Framework-free, so
// scripts/citations-route-test.mjs runs it under plain Node with a stubbed fetch.
import { normalizeArxivId } from '../arxiv/arxiv-id.mjs';

export type CitingWork = {
  id: string;
  title: string;
  date: string;
  authors: string;
  arxivId: string;
  url: string;
};
export type CitationReport = { found: boolean; workId: string; citedByCount: number; citing: CitingWork[] };

const API = 'https://api.openalex.org';
const TIMEOUT_MS = 10_000;
const TTL_MS = 6 * 60 * 60_000;
const SPACING_MS = 200;
const CITING_LIMIT = 50;
const cache = new Map<string, { expires: number; value: CitationReport }>();
let queue: Promise<unknown> = Promise.resolve();
let lastStart = 0;

export function resetCitationCache() {
  cache.clear();
  lastStart = 0;
}

// One request at a time, a little apart: OpenAlex asks clients to stay under ten a second.
function politely<T>(task: () => Promise<T>) {
  const run = queue.then(async () => {
    const wait = lastStart + SPACING_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastStart = Date.now();
    return task();
  });
  queue = run.catch(() => undefined);
  return run;
}

async function getJson(url: string) {
  return politely(async () => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`OpenAlex answered ${response.status}.`);
    return (await response.json()) as Record<string, unknown>;
  });
}

type OpenAlexWork = {
  id?: string;
  display_name?: string;
  publication_date?: string;
  doi?: string | null;
  authorships?: { author?: { display_name?: string } }[];
  locations?: { landing_page_url?: string | null }[];
};

/** The arXiv identifier of a work, from its arXiv DOI or an arxiv.org landing page. */
export function arxivIdOf(work: OpenAlexWork) {
  const fromDoi = /10\.48550\/arxiv\.(.+)$/i.exec(work.doi ?? '')?.[1];
  if (fromDoi) return normalizeArxivId(fromDoi);
  for (const location of work.locations ?? []) {
    const fromPage = /arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?$/i.exec(location.landing_page_url ?? '')?.[1];
    if (fromPage) return normalizeArxivId(fromPage);
  }
  return '';
}

function citingWork(work: OpenAlexWork): CitingWork {
  const names = (work.authorships ?? []).map((item) => item.author?.display_name ?? '').filter(Boolean);
  const arxivId = arxivIdOf(work);
  return {
    id: String(work.id ?? ''),
    title: String(work.display_name ?? 'Untitled'),
    date: String(work.publication_date ?? ''),
    authors: names.length > 3 ? `${names.slice(0, 3).join(', ')} et al.` : names.join(', '),
    arxivId,
    url: arxivId ? `https://arxiv.org/abs/${arxivId}` : (work.doi ?? String(work.id ?? '')),
  };
}

export async function citationsFor(arxivId: string): Promise<CitationReport> {
  const base = arxivId.replace(/v\d+$/i, '');
  const cached = cache.get(base);
  if (cached && cached.expires > Date.now()) return cached.value;
  const work = await getJson(`${API}/works/doi:10.48550/arXiv.${base}?select=id,cited_by_count`);
  let report: CitationReport = { found: false, workId: '', citedByCount: 0, citing: [] };
  const workId = String(work?.id ?? '').replace(/^https:\/\/openalex\.org\//, '');
  if (workId) {
    const list = await getJson(
      `${API}/works?filter=cites:${workId}&sort=publication_date:desc&per-page=${CITING_LIMIT}&select=id,display_name,publication_date,doi,authorships,locations`,
    );
    const results = Array.isArray(list?.results) ? (list.results as OpenAlexWork[]) : [];
    const count = Number((list?.meta as { count?: number } | undefined)?.count ?? work?.cited_by_count ?? 0);
    report = { found: true, workId, citedByCount: Number.isFinite(count) ? count : 0, citing: results.map(citingWork) };
  }
  cache.set(base, { expires: Date.now() + TTL_MS, value: report });
  return report;
}

export async function handleCitationsRequest(request: Request) {
  const arxivId = normalizeArxivId(new URL(request.url).searchParams.get('arxivId') ?? '');
  if (!arxivId) return Response.json({ error: 'Give an arXiv identifier.' }, { status: 400 });
  try {
    return Response.json(await citationsFor(arxivId), { headers: { 'Cache-Control': 'private, max-age=600' } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'OpenAlex is unavailable.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
