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
