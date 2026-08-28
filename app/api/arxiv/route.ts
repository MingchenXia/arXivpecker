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
      const response = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`, { cache: 'no-store', headers: { 'User-Agent': 'Proofroom/0.1 (local mathematics paper reader)' } });
      if (!response.ok) throw new Error(`arXiv returned ${response.status}`);
      return NextResponse.json({ papers: parseFeed(await response.text()) });
    }
    const pageSize = allToday ? 250 : 24; const papers: ArxivPaper[] = []; let start = 0; let total = pageSize;
    do {
      const query = `search_query=${encodeURIComponent(searchQuery)}&sortBy=submittedDate&sortOrder=descending&start=${start}&max_results=${pageSize}`;
      const response = await fetch(`https://export.arxiv.org/api/query?${query}`, { cache: 'no-store', headers: { 'User-Agent': 'Proofroom/0.1 (local mathematics paper reader)' } });
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
