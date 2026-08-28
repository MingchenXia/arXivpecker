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
  const category = request.nextUrl.searchParams.get('category')?.trim() || 'math';
  const query = arxivId
    ? `id_list=${encodeURIComponent(arxivId)}`
    : `search_query=${encodeURIComponent(`cat:${category}`)}&sortBy=submittedDate&sortOrder=descending&start=0&max_results=12`;

  try {
    const response = await fetch(`https://export.arxiv.org/api/query?${query}`, {
      cache: 'no-store',
      headers: { 'User-Agent': 'Proofroom/0.1 (local mathematics paper reader)' },
    });
    if (!response.ok) throw new Error(`arXiv returned ${response.status}`);
    const papers = parseFeed(await response.text());
    return NextResponse.json({ papers });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'arXiv is unavailable.', papers: [] },
      { status: 502 },
    );
  }
}
