import { expect, test } from '@playwright/test';
import { bridgeOrigin, eisensteinPaperId, eisensteinTitle, openReader } from './helpers';

const citing = (id: string, arxivId = '') => ({
  id: `https://openalex.org/${id}`,
  title: `Paper ${id}`,
  date: '2026-09-01',
  authors: 'A. Author',
  arxivId,
  url: arxivId ? `https://arxiv.org/abs/${arxivId}` : `https://doi.org/10.1/${id}`,
});

test('the library shows new arXiv versions and new citing papers', async ({ page, request }) => {
  let citingWorks = [citing('W1')];
  // Other tests may already have updated the paper: report one version past the library's.
  const before = await (await request.get(`${bridgeOrigin}/vault`)).json();
  const current = before.papers.find((paper: { id: string }) => paper.id === eisensteinPaperId).arxivId;
  const next = `v${Number(/v(\d+)$/.exec(current)?.[1] ?? 1) + 1}`;
  await page.route('**/api/arxiv?ids=*', (route) =>
    route.fulfill({ json: { papers: [{ arxivId: `2608.24719${next}` }, { arxivId: '2607.17203v1' }] } }),
  );
  await page.route('**/api/citations?*', (route) => {
    const arxivId = new URL(route.request().url()).searchParams.get('arxivId');
    return route.fulfill({
      json:
        arxivId === '2608.24719'
          ? { found: true, workId: 'W0', citedByCount: citingWorks.length, citing: citingWorks }
          : { found: false, workId: '', citedByCount: 0, citing: [] },
    });
  });
  await page.route('**/api/arxiv?id=*', (route) =>
    route.fulfill({
      json: {
        papers: [
          {
            id: 'arxiv-2609.00002',
            arxivId: '2609.00002v1',
            title: 'Paper W2',
            authors: 'A. Author',
            category: 'math.NT',
            abstract: '',
            state: 'To read',
            tags: [],
          },
        ],
      },
    }),
  );

  await openReader(page);
  await page.click('nav.hidden button[aria-label="Library"]');
  const card = page.locator('article.library-paper', { hasText: eisensteinTitle });

  // The first check is a baseline: the new version shows, no citation is "new".
  await page.getByRole('button', { name: 'Check for new versions and citations' }).click();
  await expect(card.getByRole('button', { name: `${next} on arXiv` })).toBeVisible();
  const citations = card.locator('.library-citations');
  await expect(citations.locator('summary')).toHaveText('Cited by 1');

  // A later check marks what appeared since.
  citingWorks = [citing('W2', '2609.00002'), citing('W1')];
  await page.getByRole('button', { name: 'Check for new versions and citations' }).click();
  await expect(citations.locator('summary')).toHaveText('Cited by 21 new');
  await citations.locator('summary').click();
  await expect(citations.locator('li.new')).toHaveCount(1);
  await citations.locator('li.new').getByRole('button', { name: 'Add' }).click();
  await expect(citations.locator('li.new')).toContainText('In library');

  // Closing the list marks the new ones as seen.
  await citations.locator('summary').click();
  await expect(citations.locator('summary')).toHaveText('Cited by 2');
  const vault = await (await request.get(`${bridgeOrigin}/vault`)).json();
  expect(JSON.parse(vault.nodeAnswers[eisensteinPaperId].__watch__).latestVersion).toBe(`2608.24719${next}`);

  await request.post(`${bridgeOrigin}/vault/paper/delete`, {
    headers: { Origin: 'http://localhost:3000' },
    data: { paperId: 'arxiv-2609.00002' },
  });
});
