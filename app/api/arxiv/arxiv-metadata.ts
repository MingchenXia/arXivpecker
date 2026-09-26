import { normalizeArxivId } from './arxiv-id.mjs';

// Framework-free implementation of GET /api/arxiv. It uses only web-standard APIs
// (fetch, AbortController, setTimeout, Response, URL) so it runs in workerd, and
// Node can test it directly with --experimental-strip-types
// (scripts/arxiv-route-test.mjs).

type ArxivPaper = {
  id: string;
  title: string;
  authors: string;
  category: string;
  arxivId: string;
  abstract: string;
  state: 'To read';
  tags: string[];
};

type Listing = { label: string; total: number; papers: ArxivPaper[] };

const xmlEntities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(value: string) {
  return (
    value
      .replace(/<[^>]+>/g, ' ')
      // One pass, so an escaped entity such as &amp;lt; stays the literal text "&lt;";
      // an out-of-range character reference is kept instead of failing the whole feed.
      .replace(
        /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g,
        (match: string, decimal?: string, hex?: string, name?: string) => {
          if (name) return xmlEntities[name];
          const code = decimal ? Number(decimal) : Number.parseInt(hex ?? '', 16);
          return Number.isInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
        },
      )
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function valueOf(xml: string, tag: string) {
  return decodeXml(xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'))?.[1] ?? '');
}

function paperKey(arxivId: string) {
  return `arxiv-${arxivId.replace(/[^a-z0-9]+/gi, '-')}`;
}

function baseId(arxivId: string) {
  return arxivId.replace(/v\d+$/i, '');
}

function parseFeed(xml: string): ArxivPaper[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)]
    .map((match) => {
      const entry = match[1];
      const arxivId = normalizeArxivId(valueOf(entry, 'id'));
      const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map(
        (author) => decodeXml(author[1]),
      );
      const categories = [...entry.matchAll(/<category[^>]+term=["']([^"']+)["'][^>]*\/>/gi)].map(
        (category) => category[1],
      );
      const primaryCategory =
        entry.match(/<arxiv:primary_category[^>]+term=["']([^"']+)["']/i)?.[1] ?? categories[0] ?? 'math';

      return {
        id: paperKey(arxivId),
        title: valueOf(entry, 'title'),
        authors: authors.join(' · '),
        category: primaryCategory,
        arxivId,
        abstract: valueOf(entry, 'summary'),
        state: 'To read' as const,
        tags: categories.filter((item) => item.startsWith('math.')).slice(0, 4),
      };
    })
    .filter((paper) => paper.arxivId && paper.title);
}

function valueOfHtml(html: string, className: string) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Read up to the element's own closing tag: arXiv nests a "Title:"/"Abstract:"
  // descriptor <span> inside it, whose </span> would otherwise end the match early.
  return decodeXml(
    html.match(
      new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'),
    )?.[2] ?? '',
  );
}

function parseAbstractPage(html: string, requestedId: string): ArxivPaper | null {
  const title = valueOfHtml(html, 'title').replace(/^Title:\s*/i, '');
  const abstract = valueOfHtml(html, 'abstract').replace(/^Abstract:\s*/i, '');
  const authorBlock = html.match(/<div[^>]+class=["'][^"']*authors[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
  const authors = [...authorBlock.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => decodeXml(match[1]))
    .filter(Boolean);
  const primary = html.match(/<span[^>]+class=["'][^"']*primary-subject[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '';
  const category = decodeXml(primary).match(/\((math\.[A-Z]{2})\)\s*$/)?.[1] ?? 'math';
  const categories = [...html.matchAll(/(?:primary-subject|subjects)[\s\S]{0,180}?\((math\.[A-Z]{2})\)/gi)].map(
    (match) => match[1],
  );
  const latestVersion = Math.max(0, ...[...html.matchAll(/\[v(\d+)\]/gi)].map((match) => Number(match[1])));
  const resolvedId = /v\d+$/i.test(requestedId) || !latestVersion ? requestedId : `${requestedId}v${latestVersion}`;
  if (!title) return null;
  return {
    id: paperKey(resolvedId),
    title,
    authors: authors.join(' · ') || 'Unknown authors',
    category,
    arxivId: resolvedId,
    abstract,
    state: 'To read',
    tags: [...new Set([category, ...categories])].filter((item) => item.startsWith('math.')).slice(0, 4),
  };
}

function metaContent(html: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = html.match(new RegExp(`<meta\\s+[^>]*name=["']${escaped}["'][^>]*>`, 'i'))?.[0] ?? '';
  return decodeXml(tag.match(/content=["']([\s\S]*?)["']/i)?.[1] ?? '');
}

function parseMetadataMirror(html: string, requestedId: string): ArxivPaper | null {
  const title = metaContent(html, 'citation_title');
  if (!title) return null;
  const authorText = metaContent(html, 'citation_authors');
  const category = metaContent(html, 'citation_publisher').match(/\b(math\.[A-Z]{2})\b/)?.[1] ?? 'math';
  return {
    id: paperKey(requestedId),
    title,
    authors:
      authorText
        .split(/\s*;\s*/)
        .filter(Boolean)
        .join(' · ') || 'Unknown authors',
    category,
    arxivId: requestedId,
    abstract: metaContent(html, 'citation_abstract'),
    state: 'To read',
    tags: category.startsWith('math.') ? [category] : [],
  };
}

function parseLatestListing(html: string): Listing {
  const articles = html.match(/<dl[^>]+id=["']articles["'][^>]*>([\s\S]*?)<\/dl>/i)?.[1] ?? '';
  const heading = articles.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
  if (!heading) return { label: '', total: 0, papers: [] };
  const afterHeading = articles.slice((heading.index ?? 0) + heading[0].length);
  const latestSection = afterHeading.split(/<h3[^>]*>/i)[0] ?? '';
  const label = decodeXml(heading[1])
    .replace(/\s*\(showing[\s\S]*$/i, '')
    .trim();
  const total = Number(decodeXml(heading[1]).match(/(?:of\s+)?(\d+)\s+entr(?:y|ies)/i)?.[1]) || 0;
  const papers = [...latestSection.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)]
    .map((match) => {
      const arxivId = normalizeArxivId(match[1].match(/href\s*=\s*["']\/abs\/([^"'?#]+)["']/i)?.[1] ?? '');
      const authorsBlock =
        match[2].match(/<div[^>]+class=["'][^"']*\blist-authors\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
      const titleBlock =
        match[2].match(/<div[^>]+class=["'][^"']*\blist-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
      const subjectsBlock =
        match[2].match(/<div[^>]+class=["'][^"']*\blist-subjects\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
      const authors = [...authorsBlock.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)]
        .map((author) => decodeXml(author[1]))
        .filter(Boolean);
      const subjects = decodeXml(subjectsBlock).replace(/^Subjects:\s*/i, '');
      const primaryCategory =
        match[2].match(/class=["'][^"']*primary-subject[^"']*["'][^>]*>[\s\S]*?\((math\.[A-Z]{2})\)/i)?.[1] ??
        subjects.match(/\((math\.[A-Z]{2})\)/)?.[1] ??
        'math';
      const categories = [...subjects.matchAll(/\((math\.[A-Z]{2})\)/g)].map((category) => category[1]);
      return {
        id: paperKey(arxivId),
        title: decodeXml(titleBlock).replace(/^Title:\s*/i, ''),
        authors: authors.join(' · ') || 'Unknown authors',
        category: primaryCategory,
        arxivId,
        abstract: '',
        state: 'To read' as const,
        tags: [...new Set([primaryCategory, ...categories])].filter((item) => item.startsWith('math.')).slice(0, 4),
      };
    })
    .filter((paper) => paper.arxivId && paper.title);
  return { label, total: total || papers.length, papers };
}

function abstractFromInvertedIndex(value: unknown) {
  if (!value || typeof value !== 'object') return '';
  const positions: { word: string; index: number }[] = [];
  for (const [word, indices] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(indices)) continue;
    for (const index of indices) if (typeof index === 'number') positions.push({ word, index });
  }
  return positions
    .sort((a, b) => a.index - b.index)
    .map((item) => item.word)
    .join(' ');
}

function openAlexCategory(result: Record<string, unknown>) {
  const topic =
    result.primary_topic && typeof result.primary_topic === 'object'
      ? (result.primary_topic as Record<string, unknown>)
      : {};
  const subfield =
    topic.subfield && typeof topic.subfield === 'object' ? (topic.subfield as Record<string, unknown>) : {};
  const text = `${String(topic.display_name || '')} ${String(subfield.display_name || '')}`.toLowerCase();
  if (/complex manifold|differential geometry|curvature|riemannian/.test(text)) return 'math.DG';
  if (/algebraic geometry/.test(text)) return 'math.AG';
  if (/number theory/.test(text)) return 'math.NT';
  if (/combinator/.test(text)) return 'math.CO';
  if (/probability|stochastic/.test(text)) return 'math.PR';
  if (/partial differential|pde|analysis/.test(text)) return 'math.AP';
  if (/optimization|operations research/.test(text)) return 'math.OC';
  if (/numerical/.test(text)) return 'math.NA';
  if (/logic|foundations/.test(text)) return 'math.LO';
  if (/topology/.test(text)) return 'math.GT';
  return 'math';
}

function openAlexUrl(arxivId: string) {
  const filter = encodeURIComponent(`locations.landing_page_url:https://arxiv.org/abs/${baseId(arxivId)}`);
  const select = encodeURIComponent('title,authorships,abstract_inverted_index,primary_topic,topics');
  return `https://api.openalex.org/works?filter=${filter}&select=${select}`;
}

function parseOpenAlex(json: string, arxivId: string): ArxivPaper | null {
  const payload = JSON.parse(json) as Record<string, unknown>;
  const result =
    Array.isArray(payload.results) && payload.results[0] && typeof payload.results[0] === 'object'
      ? (payload.results[0] as Record<string, unknown>)
      : null;
  if (!result) return null;
  const category = openAlexCategory(result);
  const authorships = Array.isArray(result.authorships) ? result.authorships : [];
  const authors = authorships
    .map((item) => {
      const entry = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const author = entry.author && typeof entry.author === 'object' ? (entry.author as Record<string, unknown>) : {};
      return String(author.display_name || entry.raw_author_name || '').trim();
    })
    .filter(Boolean);
  const title = String(result.title || '').trim();
  if (!title) return null;
  return {
    id: paperKey(arxivId),
    title,
    authors: authors.join(' · ') || 'Unknown authors',
    category,
    arxivId,
    abstract: abstractFromInvertedIndex(result.abstract_inverted_index),
    state: 'To read',
    tags: category.startsWith('math.') ? [category] : [],
  };
}

// --- Upstream policy -------------------------------------------------------

const USER_AGENT = 'arXivpecker/0.2 (local mathematics paper reader; TeX-first)';
// arXiv's API terms ask for no more than one request every three seconds.
const DEFAULT_API_SPACING_MS = 3_000;
// A Retry-After longer than this is not waited out; the caller falls back instead.
const RETRY_AFTER_CAP_MS = 10_000;
const MAX_API_BACKOFF_MS = 5 * 60_000;
const TIMEOUT_MS = { api: 8_000, apiBatch: 15_000, page: 8_000, listing: 20_000, probe: 5_000, thirdParty: 8_000 };
// Whole-request budgets, including time spent queued behind other arXiv API calls.
const LOOKUP_BUDGET_MS = 45_000;
const FEED_BUDGET_MS = 20_000;
const LATEST_BUDGET_MS = 45_000;
// An attempt is skipped rather than started when less than this remains.
const MIN_ATTEMPT_MS = 1_000;
const ID_TTL_MS = 60 * 60_000;
const LISTING_TTL_MS = 15 * 60_000;
const CACHE_MAX_ENTRIES = 200;
const ID_CHUNK_SIZE = 100;
const SUCCESS_CACHE_CONTROL = 'private, max-age=300';

const settings = { apiSpacingMs: DEFAULT_API_SPACING_MS, timeoutMs: null as number | null };

/**
 * Test hook: shorten the arXiv API spacing and/or force every per-request timeout.
 * Omitted options return to their production defaults.
 */
export function configureArxivUpstream(options: { apiSpacingMs?: number; timeoutMs?: number } = {}) {
  settings.apiSpacingMs = options.apiSpacingMs ?? DEFAULT_API_SPACING_MS;
  settings.timeoutMs = options.timeoutMs ?? null;
}

/** Test hook: forget cached results and scheduler state. */
export function resetArxivUpstream() {
  cache.clear();
  apiNextSlot = 0;
  apiLastStart = Number.NEGATIVE_INFINITY;
  apiBlockedUntil = 0;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Bounded in-memory cache of parsed upstream results, keyed by the normalized
// upstream URL. Only successful results are stored; Map order doubles as LRU order.
const cache = new Map<string, { expires: number; value: unknown }>();

function cacheKey(url: string) {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.searchParams.sort();
  return parsed.toString();
}

function cacheGet<T>(url: string): T | undefined {
  const key = cacheKey(url);
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  if (entry.expires <= Date.now()) return undefined;
  cache.set(key, entry);
  return entry.value as T;
}

function cacheSet(url: string, value: unknown, ttlMs: number) {
  const key = cacheKey(url);
  cache.delete(key);
  cache.set(key, { expires: Date.now() + ttlMs, value });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

// Module-level scheduler for arXiv API traffic. Each caller reserves the next free
// start time (FIFO, nothing is dropped) and waits for it on its own timer, so no
// request ever waits on a promise owned by another, possibly cancelled, request.
// Before starting it re-checks the actual previous start and any Retry-After backoff.
let apiNextSlot = 0;
let apiLastStart = Number.NEGATIVE_INFINITY;
let apiBlockedUntil = 0;

function usesApiScheduler(url: string) {
  const { hostname, pathname } = new URL(url);
  return hostname === 'export.arxiv.org' || (hostname === 'arxiv.org' && pathname.startsWith('/api/'));
}

async function waitForApiSlot(deadline: number) {
  const busy = () => new Error('the arXiv API request queue is busy; try again shortly');
  const slot = Math.max(Date.now(), apiNextSlot, apiBlockedUntil);
  if (slot + MIN_ATTEMPT_MS > deadline) throw busy();
  apiNextSlot = slot + settings.apiSpacingMs;
  for (;;) {
    const readyAt = Math.max(slot, apiLastStart + settings.apiSpacingMs, apiBlockedUntil);
    const wait = readyAt - Date.now();
    if (wait <= 0) break;
    if (readyAt + MIN_ATTEMPT_MS > deadline) throw busy();
    await sleep(wait);
  }
  apiLastStart = Date.now();
}

type UpstreamResponse = { ok: boolean; status: number; headers: Headers; body: string };
type RequestOptions = { deadline: number; timeoutMs: number; method?: 'GET' | 'HEAD' };

async function sendOnce(
  url: string,
  { deadline, timeoutMs, method = 'GET' }: RequestOptions,
): Promise<UpstreamResponse> {
  const host = new URL(url).hostname;
  if (usesApiScheduler(url)) await waitForApiSlot(deadline);
  const remaining = deadline - Date.now();
  if (remaining < MIN_ATTEMPT_MS) throw new Error(`no time left to ask ${host}`);
  const limit = Math.min(settings.timeoutMs ?? timeoutMs, remaining);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    const response = await fetch(url, {
      method,
      // Results are cached explicitly in this module; keep framework fetch caches out of it.
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    const body = response.ok && method === 'GET' ? await response.text() : '';
    if (!response.ok) await response.body?.cancel().catch(() => undefined);
    return { ok: response.ok, status: response.status, headers: response.headers, body };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${host} did not respond within ${Math.ceil(limit / 1000)} s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function retryAfterMs(value: string | null) {
  const text = value?.trim() ?? '';
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

// One upstream request with a timeout. On 429/503 a Retry-After of at most
// RETRY_AFTER_CAP_MS is honoured once; otherwise the response is returned as-is
// and the caller falls back to its next source.
async function requestUpstream(url: string, options: RequestOptions): Promise<UpstreamResponse> {
  const response = await sendOnce(url, options);
  if (response.status !== 429 && response.status !== 503) return response;
  const waitMs = retryAfterMs(response.headers.get('retry-after'));
  if (waitMs === null) return response;
  const api = usesApiScheduler(url);
  // The API scheduler makes every queued API call respect the backoff, not just this one.
  if (api) apiBlockedUntil = Math.max(apiBlockedUntil, Date.now() + Math.min(waitMs, MAX_API_BACKOFF_MS));
  if (waitMs > RETRY_AFTER_CAP_MS || Date.now() + waitMs + MIN_ATTEMPT_MS > options.deadline) return response;
  if (!api) await sleep(waitMs);
  return sendOnce(url, options);
}

function requireOk(response: UpstreamResponse, label: string) {
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response.body;
}

function errorMessage(label: string, error: unknown) {
  return `${label}: ${error instanceof Error ? error.message : 'request failed'}`;
}

function withArxivId(paper: ArxivPaper, arxivId: string): ArxivPaper {
  return paper.arxivId === arxivId ? paper : { ...paper, arxivId, id: paperKey(arxivId) };
}

function encodedPath(arxivId: string) {
  return arxivId.split('/').map(encodeURIComponent).join('/');
}

function apiLookupUrl(host: string, arxivId: string) {
  return `https://${host}/api/query?id_list=${encodeURIComponent(arxivId)}`;
}

// Only used for third-party results, which carry no version number.
async function latestSourceVersion(arxivId: string, deadline: number) {
  if (/v\d+$/i.test(arxivId)) return arxivId;
  const encoded = encodedPath(baseId(arxivId));
  for (const url of [`https://export.arxiv.org/e-print/${encoded}`, `https://arxiv.org/e-print/${encoded}`]) {
    try {
      const response = await sendOnce(url, { method: 'HEAD', timeoutMs: TIMEOUT_MS.probe, deadline });
      if (!response.ok) continue;
      const disposition = response.headers.get('content-disposition') || '';
      const version = /(?:arXiv[-_])?[^";\s]*?v(\d+)\.(?:tar(?:\.gz)?|gz|pdf)/i.exec(disposition)?.[1];
      if (version) return `${baseId(arxivId)}v${version}`;
    } catch {
      /* Try the next official source host. */
    }
  }
  return arxivId;
}

/**
 * Looks up one paper. Returns null when arXiv reports that no such paper exists and
 * throws when no source could answer. Sources are tried one at a time, in order,
 * and the first good answer wins; each attempt is aborted when it times out.
 */
async function lookupPaper(arxivId: string): Promise<ArxivPaper | null> {
  const canonicalUrl = apiLookupUrl('export.arxiv.org', arxivId);
  const cached = cacheGet<ArxivPaper>(canonicalUrl);
  if (cached) return cached;

  const deadline = Date.now() + LOOKUP_BUDGET_MS;
  const encoded = encodedPath(arxivId);
  const errors: string[] = [];
  let arxivReportedMissing = false;
  const arxivSources = [
    { label: 'export.arxiv.org API', url: canonicalUrl, feed: true },
    { label: 'arxiv.org abstract page', url: `https://arxiv.org/abs/${encoded}`, feed: false },
    { label: 'arxiv.org API', url: apiLookupUrl('arxiv.org', arxivId), feed: true },
    { label: 'export.arxiv.org abstract page', url: `https://export.arxiv.org/abs/${encoded}`, feed: false },
  ];
  for (const source of arxivSources) {
    try {
      const response = await requestUpstream(source.url, {
        timeoutMs: source.feed ? TIMEOUT_MS.api : TIMEOUT_MS.page,
        deadline,
      });
      // arXiv serves a 404 abstract page only for identifiers it does not have.
      if (!source.feed && response.status === 404) return null;
      const body = requireOk(response, source.label);
      const paper = source.feed ? parseFeed(body)[0] : parseAbstractPage(body, arxivId);
      if (paper) {
        cacheSet(canonicalUrl, paper, ID_TTL_MS);
        return paper;
      }
      // The API answers an unknown identifier with an empty feed or an error entry.
      if (source.feed) arxivReportedMissing = true;
      errors.push(`${source.label}: no matching paper`);
    } catch (error) {
      errors.push(errorMessage(source.label, error));
    }
  }
  if (arxivReportedMissing) return null;

  // Last resort only: papers.cool and OpenAlex are third parties, so an arXiv ID is
  // sent to them only after every arXiv host above failed to answer at all, never
  // when arXiv itself says the paper does not exist.
  const fallbacks = [
    { label: 'papers.cool', url: `https://papers.cool/arxiv/${encoded}`, parse: parseMetadataMirror },
    { label: 'OpenAlex', url: openAlexUrl(arxivId), parse: parseOpenAlex },
  ];
  for (const source of fallbacks) {
    try {
      const response = await requestUpstream(source.url, { timeoutMs: TIMEOUT_MS.thirdParty, deadline });
      const paper = source.parse(requireOk(response, source.label), arxivId);
      if (!paper) {
        errors.push(`${source.label}: no matching paper`);
        continue;
      }
      const resolved = withArxivId(paper, await latestSourceVersion(arxivId, deadline));
      // Third-party metadata lacks arXiv's own fields, so ask arXiv again sooner.
      cacheSet(canonicalUrl, resolved, LISTING_TTL_MS);
      return resolved;
    } catch (error) {
      errors.push(errorMessage(source.label, error));
    }
  }
  throw new Error(`Could not retrieve arXiv:${arxivId}. ${[...new Set(errors)].join(' · ')}`);
}

async function fetchFeedChunk(ids: string[], deadline: number) {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(ids.join(','))}&max_results=${ids.length}`;
  const cached = cacheGet<ArxivPaper[]>(url);
  if (cached) return cached;
  const papers = parseFeed(
    requireOk(await requestUpstream(url, { timeoutMs: TIMEOUT_MS.apiBatch, deadline }), 'arXiv API'),
  );
  if (papers.length) cacheSet(url, papers, LISTING_TTL_MS);
  return papers;
}

async function fetchLatestListing(category: string) {
  const deadline = Date.now() + LATEST_BUDGET_MS;
  const listingUrl = `https://arxiv.org/list/${encodeURIComponent(category)}/recent?skip=0&show=2000`;
  let listing = cacheGet<Listing>(listingUrl);
  if (!listing) {
    listing = parseLatestListing(
      requireOk(await requestUpstream(listingUrl, { timeoutMs: TIMEOUT_MS.listing, deadline }), 'arXiv listing'),
    );
    if (listing.papers.length) cacheSet(listingUrl, listing, LISTING_TTL_MS);
  }
  // The listing lacks abstracts; fill them in from the API in chunks of at most
  // ID_CHUNK_SIZE identifiers so no request URL grows past common length limits.
  const metadata = new Map<string, ArxivPaper>();
  let complete = true;
  for (let start = 0; start < listing.papers.length; start += ID_CHUNK_SIZE) {
    const ids = listing.papers.slice(start, start + ID_CHUNK_SIZE).map((paper) => paper.arxivId);
    try {
      for (const paper of await fetchFeedChunk(ids, deadline)) metadata.set(baseId(paper.arxivId), paper);
    } catch {
      // The official listing still provides a usable batch (titles, authors,
      // subjects); stop here rather than sending more chunks to a failing API.
      complete = false;
      break;
    }
  }
  const papers = listing.papers.map((paper) => metadata.get(baseId(paper.arxivId)) ?? paper);
  return { ...listing, papers, complete };
}

async function fetchCategoryFeed(categoryQuery: string) {
  const query = `search_query=${encodeURIComponent(categoryQuery)}&sortBy=submittedDate&sortOrder=descending&start=0&max_results=24`;
  const url = `https://export.arxiv.org/api/query?${query}`;
  const cached = cacheGet<ArxivPaper[]>(url);
  if (cached) return cached;
  const response = await requestUpstream(url, { timeoutMs: TIMEOUT_MS.api, deadline: Date.now() + FEED_BUDGET_MS });
  const papers = [
    ...new Map(parseFeed(requireOk(response, 'arXiv API')).map((paper) => [paper.arxivId, paper])).values(),
  ];
  if (papers.length) cacheSet(url, papers, LISTING_TTL_MS);
  return papers;
}

function json(body: unknown, status: number, cacheable = false) {
  return Response.json(body, { status, headers: { 'Cache-Control': cacheable ? SUCCESS_CACHE_CONTROL : 'no-store' } });
}

export async function handleArxivRequest(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const rawArxivId = params.get('id');
  const arxivId = normalizeArxivId(rawArxivId ?? '');
  if (rawArxivId && !arxivId) {
    return json({ papers: [], error: 'Enter a valid arXiv ID or URL.' }, 400);
  }
  const categories = (params.get('categories') || params.get('category') || 'math')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value === 'math' || /^math\.[A-Z]{2}$/.test(value));
  const latestBatch = params.get('latest') === '1' && !arxivId;
  const categoryQuery =
    categories.length > 1
      ? `(${categories.map((category) => `cat:${category}`).join(' OR ')})`
      : `cat:${categories[0] || 'math'}`;

  try {
    if (arxivId) {
      const paper = await lookupPaper(arxivId);
      if (!paper) {
        return json(
          { papers: [], error: `arXiv has no paper with the identifier ${arxivId}. Check the ID and version.` },
          404,
        );
      }
      return json({ papers: [paper] }, 200, true);
    }
    if (latestBatch) {
      const batch = await fetchLatestListing(categories[0] || 'math');
      return json(
        {
          papers: batch.papers,
          total: batch.total,
          mode: 'latest',
          batchLabel: batch.label,
          categories: [categories[0] || 'math'],
        },
        200,
        batch.complete && batch.papers.length > 0,
      );
    }
    const papers = await fetchCategoryFeed(categoryQuery);
    return json({ papers, total: papers.length, mode: 'feed', categories }, 200, papers.length > 0);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'arXiv is unavailable.', papers: [] }, 502);
  }
}
