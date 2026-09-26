import { expect, test } from '@playwright/test';
import { bridgeOrigin, eisensteinPaperId, openReader } from './helpers';

const citedId = '2510.27362';
const citedTitle = 'm-Pseudo-effectivity and a Monge-Ampère-Type Equation';

// The e2e library is shared by every test: take the added paper out again.
test.afterEach(async ({ request }) => {
  await request.post(`${bridgeOrigin}/vault/paper/delete`, {
    headers: { Origin: 'http://localhost:3000' },
    data: { paperId: `arxiv-${citedId}` },
  });
});

test('a cited arXiv paper is added to the library from its bibliography entry', async ({ page, request }) => {
  // Give the paper a bibliography entry that resolves to an arXiv identifier.
  await page.route(`${bridgeOrigin}/vault`, async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    const audit = snapshot.audits[eisensteinPaperId];
    audit.sourceBlocks.push({
      id: 'source-bibliography-e2e',
      kind: 'bibliography',
      level: 4,
      title: 'DP25',
      content: `S. Dinew, D. Popovici, ${citedTitle}, arXiv:${citedId}v1.`,
      proofText: '',
      nodeId: '',
      resultKind: '',
      citations: [
        {
          key: 'DP25',
          locator: '',
          statement: '',
          title: citedTitle,
          authors: 'S. Dinew, D. Popovici',
          text: '',
          url: `https://arxiv.org/abs/${citedId}`,
          searchUrl: '',
          doi: '',
          arxivId: citedId,
          direct: true,
        },
      ],
      assetPaths: [],
      caption: '',
    });
    await route.fulfill({ response, json: snapshot });
  });
  const lookups: string[] = [];
  await page.route('**/api/arxiv?id=*', (route) => {
    lookups.push(new URL(route.request().url()).searchParams.get('id') ?? '');
    return route.fulfill({
      json: {
        papers: [
          {
            id: `arxiv-${citedId}`,
            arxivId: `${citedId}v1`,
            title: citedTitle,
            authors: 'S. Dinew, D. Popovici',
            category: 'math.DG',
            abstract: 'A cited paper.',
            state: 'To read',
            tags: [],
          },
        ],
      },
    });
  });

  await openReader(page);
  const entry = page.locator('.source-bibliography-entry', { hasText: 'DP25' });
  await entry.getByRole('button', { name: 'Add to library' }).click();
  await expect(entry.getByRole('button', { name: 'Open in library' })).toBeVisible({ timeout: 20_000 });
  expect(lookups).toEqual([citedId]);
  const vault = await (await request.get(`${bridgeOrigin}/vault`)).json();
  expect(vault.papers.some((paper: { arxivId: string }) => paper.arxivId.startsWith(citedId))).toBe(true);
  // The reader stays on the citing paper.
  await expect(page.locator('.app-header-title')).not.toContainText(citedTitle);
});

test.afterAll(async ({ request }) => {
  const vault = await (await request.get(`${bridgeOrigin}/vault`)).json();
  expect(vault.papers.some((paper: { arxivId: string }) => paper.arxivId.startsWith(citedId))).toBe(false);
});
