import { expect, test } from '@playwright/test';
import {
  eisensteinPaperId,
  eisensteinTitle,
  openReader,
  openTrayResult,
  recordPageErrors,
  recordReaderSaves,
  samplePaperId,
} from './helpers';

test('an audited paper opens with its mathematics typeset', async ({ page }) => {
  const errors = recordPageErrors(page);
  await openReader(page);
  await expect(page.locator('.app-header-title')).toContainText(eisensteinTitle);
  await expect.poll(() => page.locator('.katex').count()).toBeGreaterThan(100);
  expect(errors).toEqual([]);
});

test('loading the library sends no saves, and one reading mark sends one save', async ({ page }) => {
  const saves = recordReaderSaves(page);
  await openReader(page);
  await page.waitForTimeout(1500);
  expect(saves).toEqual([]);
  await page
    .locator('select[aria-label="Mark your understanding"]')
    .first()
    .selectOption('understood', { force: true });
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].paperId).toBe(eisensteinPaperId);
  expect(Object.values(saves[0].reader.marks ?? {})).toContain('understood');
});

test('the library still loads when browser storage is blocked', async ({ page }) => {
  await page.addInitScript(() => {
    const blocked = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    Storage.prototype.getItem = blocked;
    Storage.prototype.setItem = blocked;
  });
  await page.goto('/');
  await expect(page.locator('.katex').first()).toBeVisible();
});

test('a handled activity-tray navigation is not replayed on return to the reader', async ({ page }) => {
  await openReader(page);
  await openTrayResult(page, samplePaperId);
  await expect(page.locator('.paper-chat-shell')).toBeVisible();
  await page.click('button[aria-label="Close paper conversation"]');
  await page.click('nav.hidden button[aria-label="Library"]');
  await page.click('nav.hidden button[aria-label="Read"]');
  await expect(page.locator('.katex').first()).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.locator('.paper-chat-shell')).toBeHidden();
});

test('formulas are typeset as they near the viewport, and all of them before printing', async ({ page }) => {
  const errors = recordPageErrors(page);
  await openReader(page);
  // Far-away formulas wait as TeX until the reader scrolls near them.
  await expect.poll(() => page.locator('.math-pending').count()).toBeGreaterThan(100);
  const initial = await page.locator('.katex').count();
  for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, 3000);
  await expect.poll(() => page.locator('.katex').count()).toBeGreaterThan(initial);
  // Printing (from the browser or the reader) must never show raw TeX.
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await expect(page.locator('.math-pending')).toHaveCount(0);
  expect(await page.locator('.katex').count()).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
});
