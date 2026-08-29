import { NextRequest, NextResponse } from 'next/server';

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

function decodeXml(value: string) {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function valueOf(xml: string, tag: string) {
  return decodeXml(xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'))?.[1] ?? '');
}

function normalizeArxivId(value: string) {
  const cleaned = decodeURIComponent(value.trim())
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf(?:\?.*)?$/i, '')
    .replace(/[?#].*$/, '');
  return cleaned.match(/(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i)?.[0] ?? '';
}

function parseFeed(xml: string): ArxivPaper[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => {
    const entry = match[1];
    const arxivId = normalizeArxivId(valueOf(entry, 'id'));
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
      .map((author) => decodeXml(author[1]));
    const categories = [...entry.matchAll(/<category[^>]+term=["']([^"']+)["'][^>]*\/>/gi)]
      .map((category) => category[1]);
    const primaryCategory = entry.match(/<arxiv:primary_category[^>]+term=["']([^"']+)["']/i)?.[1] ?? categories[0] ?? 'math';

    return {
      id: `arxiv-${arxivId.replace(/[^a-z0-9]+/gi, '-')}`,
      title: valueOf(entry, 'title'),
      authors: authors.join(' · '),
      category: primaryCategory,
      arxivId,
      abstract: valueOf(entry, 'summary'),
      state: 'To read' as const,
      tags: categories.filter((item) => item.startsWith('math.')).slice(0, 4),
    };
  }).filter((paper) => paper.arxivId && paper.title);
}

function valueOfHtml(html: string, className: string) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return decodeXml(html.match(new RegExp(`<[^>]+class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i'))?.[1] ?? '');
}

function parseAbstractPage(html: string, requestedId: string): ArxivPaper | null {
  const title = valueOfHtml(html, 'title').replace(/^Title:\s*/i, '');
  const abstract = valueOfHtml(html, 'abstract').replace(/^Abstract:\s*/i, '');
  const authorBlock = html.match(/<div[^>]+class=["'][^"']*authors[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
  const authors = [...authorBlock.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map((match) => decodeXml(match[1])).filter(Boolean);
  const primary = html.match(/<span[^>]+class=["'][^"']*primary-subject[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '';
  const category = decodeXml(primary).match(/\((math\.[A-Z]{2})\)\s*$/)?.[1] ?? 'math';
  const categories = [...html.matchAll(/(?:primary-subject|subjects)[\s\S]{0,180}?\((math\.[A-Z]{2})\)/gi)].map((match) => match[1]);
  const latestVersion = Math.max(0, ...[...html.matchAll(/\[v(\d+)\]/gi)].map((match) => Number(match[1])));
  const resolvedId = /v\d+$/i.test(requestedId) || !latestVersion ? requestedId : `${requestedId}v${latestVersion}`;
  if (!title) return null;
  return {
    id: `arxiv-${resolvedId.replace(/[^a-z0-9]+/gi, '-')}`,
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
    id: `arxiv-${requestedId.replace(/[^a-z0-9]+/gi, '-')}`,
    title,
    authors: authorText.split(/\s*;\s*/).filter(Boolean).join(' · ') || 'Unknown authors',
    category,
    arxivId: requestedId,
    abstract: metaContent(html, 'citation_abstract'),
    state: 'To read',
    tags: category.startsWith('math.') ? [category] : [],
  };
}

async function fetchText(url: string, attempts = 2) {
  let lastError: unknown = new Error('arXiv is unavailable.');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        redirect: 'follow',
        signal: AbortSignal.timeout(25_000),
        headers: { 'User-Agent': 'arXivpecker/0.2 (local mathematics paper reader; TeX-first)' },
      });
      if (!response.ok) throw new Error(`arXiv returned ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function latestSourceVersion(arxivId: string) {
  if (/v\d+$/i.test(arxivId)) return arxivId;
  const baseId = arxivId.replace(/v\d+$/i, ''); const encoded = baseId.split('/').map(encodeURIComponent).join('/');
  for (const url of [`https://export.arxiv.org/e-print/${encoded}`, `https://arxiv.org/e-print/${encoded}`]) {
    try {
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(12_000), headers: { 'User-Agent': 'arXivpecker/0.2 (local mathematics paper reader; version check)' } });
      if (!response.ok) continue;
      const disposition = response.headers.get('content-disposition') || ''; const version = /(?:arXiv[-_])?[^";\s]*?v(\d+)\.(?:tar(?:\.gz)?|gz|pdf)/i.exec(disposition)?.[1];
      if (version) return `${baseId}v${version}`;
    } catch { /* Try the next official source host. */ }
  }
  return arxivId;
}

function abstractFromInvertedIndex(value: unknown) {
  if (!value || typeof value !== 'object') return '';
  const positions: { word: string; index: number }[] = [];
  for (const [word, indices] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(indices)) continue;
    for (const index of indices) if (typeof index === 'number') positions.push({ word, index });
  }
  return positions.sort((a, b) => a.index - b.index).map((item) => item.word).join(' ');
}

function openAlexCategory(result: Record<string, unknown>) {
  const topic = result.primary_topic && typeof result.primary_topic === 'object' ? result.primary_topic as Record<string, unknown> : {};
  const subfield = topic.subfield && typeof topic.subfield === 'object' ? topic.subfield as Record<string, unknown> : {};
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

async function fetchPaperFromOpenAlex(arxivId: string) {
  const baseId = arxivId.replace(/v\d+$/i, '');
  const filter = encodeURIComponent(`locations.landing_page_url:https://arxiv.org/abs/${baseId}`);
  const select = encodeURIComponent('title,authorships,abstract_inverted_index,primary_topic,topics');
  const payload = JSON.parse(await fetchText(`https://api.openalex.org/works?filter=${filter}&select=${select}`, 1)) as Record<string, unknown>;
  const result = Array.isArray(payload.results) && payload.results[0] && typeof payload.results[0] === 'object' ? payload.results[0] as Record<string, unknown> : null;
  if (!result) return null;
  const category = openAlexCategory(result);
  const authorships = Array.isArray(result.authorships) ? result.authorships : [];
  const authors = authorships.map((item) => {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const author = entry.author && typeof entry.author === 'object' ? entry.author as Record<string, unknown> : {};
    return String(author.display_name || entry.raw_author_name || '').trim();
  }).filter(Boolean);
  const title = String(result.title || '').trim();
  if (!title) return null;
  return {
    id: `arxiv-${arxivId.replace(/[^a-z0-9]+/gi, '-')}`,
    title,
    authors: authors.join(' · ') || 'Unknown authors',
    category,
    arxivId,
    abstract: abstractFromInvertedIndex(result.abstract_inverted_index),
    state: 'To read' as const,
    tags: category.startsWith('math.') ? [category] : [],
  } satisfies ArxivPaper;
}

async function fetchPaper(arxivId: string) {
  const encoded = arxivId.split('/').map(encodeURIComponent).join('/');
  const errors: string[] = [];
  const feedUrls = [
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`,
    `https://arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`,
  ];
  try { return await Promise.any(feedUrls.map(async (url) => { const paper = parseFeed(await fetchText(url, 1))[0]; if (!paper) throw new Error('metadata feed returned no matching entry'); return paper; })); }
  catch (error) { errors.push(error instanceof Error ? error.message : 'metadata feeds failed'); }
  const pageUrls = [`https://arxiv.org/abs/${encoded}`, `https://export.arxiv.org/abs/${encoded}`];
  try { return await Promise.any(pageUrls.map(async (url) => { const paper = parseAbstractPage(await fetchText(url, 1), arxivId); if (!paper) throw new Error('abstract page contained no paper metadata'); return paper; })); }
  catch (error) { errors.push(error instanceof Error ? error.message : 'abstract pages failed'); }
  const fallbackId = await latestSourceVersion(arxivId);
  try {
    const paper = parseMetadataMirror(await fetchText(`https://papers.cool/arxiv/${encoded}`, 1), fallbackId);
    if (paper) return paper;
    errors.push('metadata mirror contained no paper metadata');
  } catch (error) { errors.push(error instanceof Error ? error.message : 'metadata mirror failed'); }
  try {
    const paper = await fetchPaperFromOpenAlex(fallbackId);
    if (paper) return paper;
    errors.push('OpenAlex contained no matching arXiv record');
  } catch (error) { errors.push(error instanceof Error ? error.message : 'OpenAlex metadata failed'); }
  throw new Error(`Could not retrieve arXiv:${arxivId}. ${[...new Set(errors)].join(' · ')}`);
}

export async function GET(request: NextRequest) {
  const arxivId = normalizeArxivId(request.nextUrl.searchParams.get('id') ?? '');
  const categories = (request.nextUrl.searchParams.get('categories') || request.nextUrl.searchParams.get('category') || 'math')
    .split(',').map((value) => value.trim()).filter((value) => value === 'math' || /^math\.[A-Z]{2}$/.test(value));
  const allToday = request.nextUrl.searchParams.get('allToday') === '1' && !arxivId;
  const now = new Date(); const day = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  const categoryQuery = categories.length > 1 ? `(${categories.map((category) => `cat:${category}`).join(' OR ')})` : `cat:${categories[0] || 'math'}`;
  const searchQuery = allToday ? `${categoryQuery} AND submittedDate:[${day}0000 TO ${day}2359]` : categoryQuery;

  try {
    if (arxivId) {
      return NextResponse.json({ papers: [await fetchPaper(arxivId)] });
    }
    const pageSize = allToday ? 250 : 24; const papers: ArxivPaper[] = []; let start = 0; let total = pageSize;
    do {
      const query = `search_query=${encodeURIComponent(searchQuery)}&sortBy=submittedDate&sortOrder=descending&start=${start}&max_results=${pageSize}`;
      const response = await fetch(`https://export.arxiv.org/api/query?${query}`, { cache: 'no-store', headers: { 'User-Agent': 'arXivpecker/0.2 (local mathematics paper reader)' } });
      if (!response.ok) throw new Error(`arXiv returned ${response.status}`);
      const xml = await response.text(); const page = parseFeed(xml); papers.push(...page);
      total = Number(valueOf(xml, 'opensearch:totalResults')) || page.length; start += pageSize;
      if (!allToday || page.length < pageSize) break;
    } while (start < total);
    const unique = [...new Map(papers.map((paper) => [paper.arxivId, paper])).values()];
    return NextResponse.json({ papers: unique, total: allToday ? total : unique.length, mode: allToday ? 'today' : 'feed', day, categories });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'arXiv is unavailable.', papers: [] },
      { status: 502 },
    );
  }
}
