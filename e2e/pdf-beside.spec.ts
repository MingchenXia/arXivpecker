import { expect, test } from '@playwright/test';
import { openReader } from './helpers';

test('the original PDF beside the paper follows the unit being read', async ({ page }) => {
  // A stand-in for the arXiv PDF that shows which page it was asked for.
  await page.route('https://arxiv.org/pdf/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<body><output id="page"></output><script>const show = () => (document.getElementById("page").textContent = location.hash); show(); addEventListener("hashchange", show);</script></body>',
    }),
  );
  await openReader(page);
  await page.click('button[aria-label="Show the original PDF beside the paper"]');
  const pane = page.locator('.reader-pdf-pane');
  await expect(pane).toBeVisible();
  const shown = pane.frameLocator('iframe').locator('#page');

  // Selecting a result moves the PDF to its page.
  const jump = (nodeId: string) =>
    page.evaluate((id) => window.dispatchEvent(new CustomEvent('proofroom:jump-unit', { detail: id })), nodeId);
  await jump('lem-3-1');
  await expect(pane.locator('header span')).toHaveText(/^p\. \d+$/);
  const lemmaPage = (await pane.locator('header span').textContent())?.replace('p. ', '');
  await expect(shown).toHaveText(`#page=${lemmaPage}`);
  await jump('thm-1-1');
  const theoremPage = (await pane.locator('header span').textContent())?.replace('p. ', '');
  await expect(shown).toHaveText(`#page=${theoremPage}`);
  expect(theoremPage).not.toBe(lemmaPage);

  // Unfollowing keeps the PDF where it is.
  await pane.getByRole('checkbox', { name: 'Follow reading' }).uncheck();
  await jump('lem-3-1');
  await page.waitForTimeout(800);
  await expect(shown).toHaveText(`#page=${theoremPage}`);

  await pane.getByRole('button', { name: 'Close the PDF beside the paper' }).click();
  await expect(pane).toBeHidden();
});
