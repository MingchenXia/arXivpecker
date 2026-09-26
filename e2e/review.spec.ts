import { expect, test } from '@playwright/test';
import { bridgeOrigin, eisensteinPaperId, openReader } from './helpers';

test('a result marked understood becomes a review card, is scheduled, and exports for Anki', async ({
  page,
  request,
}) => {
  await openReader(page);
  // Mark the first result's statement as understood.
  const result = page.locator('section.source-result').first();
  const nodeId = await result.getAttribute('data-node-id');
  await result.locator('select[aria-label="Mark your understanding"]').selectOption('understood', { force: true });

  await page.click('nav.hidden button[aria-label="Review"]');
  const card = page.getByRole('article', { name: 'Review card' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /Recall the statement/ }).click();
  await expect(card.locator('.review-answer .katex').first()).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export for Anki' }).click();
  const file = await (await download).path();
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  expect(lines.slice(0, 3)).toEqual(['#separator:tab', '#html:true', '#tags column:3']);
  expect(lines.length).toBeGreaterThan(3);
  expect(lines[3].split('\t')).toHaveLength(3);

  await card.getByRole('button', { name: /^Good/ }).click();
  await expect(page.locator('.review-empty')).toContainText('All caught up');
  await expect
    .poll(async () => {
      const vault = await (await request.get(`${bridgeOrigin}/vault`)).json();
      return JSON.parse(vault.nodeAnswers[eisensteinPaperId]?.[`__review__:${nodeId}`] ?? '{}').interval;
    })
    .toBe(1);

  // Leave the shared library as it was.
  await page.click('nav.hidden button[aria-label="Read"]');
  await result.locator('select[aria-label="Mark your understanding"]').selectOption('', { force: true });
});
