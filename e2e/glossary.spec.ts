import { expect, test } from '@playwright/test';
import { openReader, recordPageErrors } from './helpers';

test('the outline lists the paper notation, and a formula shows where its notation is defined', async ({ page }) => {
  const errors = recordPageErrors(page);
  await openReader(page);

  await page.click('button[aria-label="Toggle logical outline"]');
  await page.getByRole('button', { name: 'Notation', exact: true }).click();
  const list = page.locator('.glossary-list');
  await expect.poll(() => list.locator('> button').count()).toBeGreaterThan(20);
  await list.getByRole('textbox', { name: 'Filter notation' }).fill('number field');
  await expect(list.locator('> button')).toHaveCount(1);
  await list.locator('> button').click();
  await expect(page.locator('[data-node-id="source-block:source-paragraph-2"]')).toBeInViewport();

  // I_n(s) is defined in the introduction; a later formula that uses it explains it on hover.
  const formula = page
    .locator('[data-node-id]:not([data-node-id="source-block:source-paragraph-2"]) .math-inline[data-source*="I_n(s)"]')
    .first();
  await formula.scrollIntoViewIfNeeded();
  await formula.hover();
  const card = page.locator('.glossary-card');
  await expect(card).toContainText('resulting representation');
  await card.getByRole('button').filter({ hasText: 'resulting representation' }).click();
  await expect(card).toBeHidden();
  await expect(page.locator('[data-node-id="source-block:source-paragraph-2"]')).toBeInViewport();
  expect(errors).toEqual([]);
});
