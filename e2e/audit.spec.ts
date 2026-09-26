import { expect, test } from '@playwright/test';
import { bridgeOrigin, openReader, sampleTitle } from './helpers';

// The e2e server puts a scripted Codex (e2e/fixtures/bin/codex) on the bridge's
// PATH; each of its turns streams progress for a few seconds before answering.
const unauditedId = 'arxiv-2607.17203';
const unauditedTitle = '$m$-Positive Stability of Holomorphic Vector Bundles and Moduli Spaces';

test('an audit keeps running through a reload and its result is adopted afterwards', async ({ page, request }) => {
  await openReader(page);
  await page.click('nav.hidden button[aria-label="Library"]');
  await page.click(`button[aria-label="Analyze ${unauditedTitle}"]`);
  await expect(page.getByRole('button', { name: `Stop the AI audit of ${unauditedTitle}` })).toBeVisible();

  // Reload while Codex is still working: the bridge owns the audit, not the page.
  await page.reload();
  await expect(page.locator('.notice-banner')).toContainText('is ready', { timeout: 60_000 });
  const snapshot = await (await request.get(`${bridgeOrigin}/vault`)).json();
  expect(
    snapshot.audits[unauditedId].nodes.some((node: { title: string }) => node.title === 'Scripted main result'),
  ).toBe(true);
  expect(snapshot.auditJobs[unauditedId]).toBeUndefined();
});

test('a running audit can be stopped from the activity tray and continued later', async ({ page }) => {
  await openReader(page);
  await page.click('nav.hidden button[aria-label="Library"]');
  await page.click(`button[aria-label="Re-audit ${sampleTitle}"]`);
  if (!(await page.getByRole('button', { name: 'Stop AI audit' }).isVisible()))
    await page.click('button[aria-label="Show or hide AI activity"]');
  await page.getByRole('button', { name: 'Stop AI audit' }).click();
  await expect(page.locator('.notice-banner')).toContainText('was stopped', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: `Continue audit ${sampleTitle}` })).toBeEnabled();
});
