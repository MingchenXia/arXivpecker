import { expect, test, type Locator, type Page } from '@playwright/test';
import { openReader, recordPageErrors } from './helpers';

/** Opens the assistant on the first proof's result; retried in case the click lands before hydration. */
async function openAssistant(page: Page) {
  const panel = page.locator('.reader-inspector');
  await expect(async () => {
    await page.locator('section.source-proof').first().locator('.source-proof-note').click();
    await expect(panel).toBeVisible({ timeout: 2000 });
  }).toPass();
  return panel;
}

/** Drags from the centre of `handle` by (dx, dy). */
async function drag(page: Page, handle: Locator, dx: number, dy: number) {
  const box = await handle.boundingBox();
  if (!box) throw new Error('The resize handle is not visible.');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
}

const size = async (panel: Locator) => {
  const box = await panel.boundingBox();
  return { width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0) };
};

/** How far anything in the assistant's body reaches past its right edge, and whether the body scrolls sideways. */
const sidewaysOverflow = (panel: Locator) =>
  panel.locator('.assistant-body').evaluate((body) => {
    const right = body.getBoundingClientRect().right - parseFloat(getComputedStyle(body).paddingRight);
    let beyond = 0;
    for (const element of body.querySelectorAll('*'))
      if (!element.closest('.katex-mathml')) beyond = Math.max(beyond, element.getBoundingClientRect().right - right);
    return { beyond: Math.round(beyond), scrolls: body.scrollWidth > body.clientWidth };
  });

test('the assistant resizes from its edges and wraps its content instead of scrolling sideways', async ({ page }) => {
  const errors = recordPageErrors(page);
  await openReader(page);
  const panel = await openAssistant(page);

  // The unsaved note preview shows long content without writing to the library.
  await panel
    .locator('.assistant-note-composer textarea')
    .fill(
      [
        'A long word averyveryverylongwordwithoutanyspacesthatmuststillwrapinsidethepanel and a link https://example.org/a/long/path/without/any/spaces/in/it.',
        String.raw`$$\sum_{n=1}^{\infty} a(n) q^n = \prod_{p} \left(1 - \alpha_p p^{-s}\right)^{-1} \left(1 - \beta_p p^{-s}\right)^{-1} + \sum_{T > 0} a(T) e^{2\pi i \operatorname{tr}(TZ)} = F(Z)$$`,
        String.raw`$$\begin{pmatrix} a_{1} & a_{2} & a_{3} & a_{4} & a_{5} & a_{6} & a_{7} & a_{8} & a_{9} & a_{10} & a_{11} & a_{12} & a_{13} & a_{14} \end{pmatrix}$$`,
      ].join('\n\n'),
    );
  await expect(panel.locator('.assistant-note-preview .katex-display')).toHaveCount(2);

  // The left edge sets the width; the height keeps following the content.
  await drag(page, panel.locator('.assistant-resize-left'), -280, 0);
  await expect.poll(async () => (await size(panel)).width).toBe(600);
  expect(await panel.getAttribute('style')).not.toMatch(/height/);
  await expect.poll(() => sidewaysOverflow(panel)).toEqual({ beyond: 0, scrolls: false });
  await expect(panel.locator('.assistant-note-preview .math-display').last()).not.toHaveAttribute('style', /font-size/);

  // Narrowing stops at the minimum width, where text and formulas still wrap
  // inside the panel; the matrix cannot break across lines, so it is shrunk to fit.
  await drag(page, panel.locator('.assistant-resize-left'), 600, 0);
  await expect.poll(async () => (await size(panel)).width).toBe(320);
  await expect.poll(() => sidewaysOverflow(panel)).toEqual({ beyond: 0, scrolls: false });
  await expect(panel.locator('.assistant-note-preview .math-display').last()).toHaveAttribute('style', /font-size/);

  // The bottom edge sets the height, and the corner changes both.
  await drag(page, panel.locator('.assistant-resize-left'), -280, 0);
  await expect.poll(async () => (await size(panel)).width).toBe(600);
  const tall = await size(panel);
  await drag(page, panel.locator('.assistant-resize-bottom'), 0, -200);
  await expect.poll(async () => (await size(panel)).height).toBe(tall.height - 200);
  expect((await size(panel)).width).toBe(600);
  await drag(page, panel.getByRole('button', { name: 'Resize assistant panel' }), -100, 50);
  await expect.poll(() => size(panel)).toEqual({ width: 700, height: tall.height - 150 });

  // The size is kept for the next visit.
  await page.reload();
  await expect(page.locator('.katex').first()).toBeVisible();
  const reopened = await openAssistant(page);
  await expect.poll(() => size(reopened)).toEqual({ width: 700, height: tall.height - 150 });
  expect(errors).toEqual([]);
});
