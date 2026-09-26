import { expect, test } from '@playwright/test';
import { bridgeOrigin, eisensteinPaperId, eisensteinTitle, openReader } from './helpers';

const cors = { 'Access-Control-Allow-Origin': 'http://localhost:3000' };

test('reading marks made while a version update runs are kept', async ({ page, request }) => {
  const before = await (await request.get(`${bridgeOrigin}/vault`)).json();
  const paper = before.papers.find((item: { id: string }) => item.id === eisensteinPaperId);
  const currentAudit = before.audits[eisensteinPaperId];

  // arXiv reports a v2; the comparison is held until the test releases it, and the
  // v2 audit is the current one, so every unit has a counterpart.
  await page.route('**/api/arxiv?id=*', (route) =>
    route.fulfill({ json: { papers: [{ ...paper, arxivId: '2608.24719v2' }] } }),
  );
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`${bridgeOrigin}/compare-versions`, async (route) => {
    await held;
    await route.fulfill({
      headers: cors,
      json: {
        text: JSON.stringify({
          summary: 'No mathematical changes.',
          changedUnits: [],
          proofChanges: [],
          notationChanges: [],
          editorialChanges: [],
          dependencyImpact: [],
          readingRecommendation: 'Nothing to reread.',
          warnings: [],
        }),
      },
    });
  });
  await page.route(`${bridgeOrigin}/analyze`, (route) =>
    route.fulfill({
      headers: cors,
      json: {
        // The stored audit (including its TeX source blocks), unchanged in v2.
        text: JSON.stringify(currentAudit),
        threadId: 'update-thread',
        paper: { ...paper, arxivId: '2608.24719v2' },
        primarySource: { kind: 'tex' },
        sourceRecord: {},
      },
    }),
  );

  await openReader(page);
  await page.click('nav.hidden button[aria-label="Library"]');
  await page.click(`button[aria-label="Check arXiv for a newer version of ${eisensteinTitle}"]`);
  await page.click('nav.hidden button[aria-label="Read"]');

  // Mark a result while the AI comparison is still running.
  const mark = page.locator('select[aria-label="Mark your understanding"]').first();
  await mark.selectOption('question', { force: true });
  release();

  await expect(page.locator('.notice-banner')).toContainText('Updated to arXiv:2608.24719v2', { timeout: 30_000 });
  const after = await (await request.get(`${bridgeOrigin}/vault`)).json();
  expect(Object.values(after.marks[eisensteinPaperId] ?? {})).toContain('question');
  await expect(mark).toHaveValue('question');
});
