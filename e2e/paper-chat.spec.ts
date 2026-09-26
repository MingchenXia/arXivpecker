import { expect, test } from '@playwright/test';
import {
  bridgeOrigin,
  eisensteinPaperId,
  openReader,
  openTrayResult,
  recordReaderSaves,
  samplePaperId,
} from './helpers';

test('an answer that arrives after a paper switch stays with the paper that asked', async ({ page }) => {
  const question = `Question ${Date.now()}`;
  const answer = `Answer to ${question}`;
  let release = () => {};
  const answered = new Promise<void>((resolve) => (release = resolve));
  await page.route(`${bridgeOrigin}/paper-question`, async (route) => {
    await answered;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': 'http://localhost:3000' },
      body: JSON.stringify({ text: answer, threadId: 'e2e-thread' }),
    });
  });
  const saves = recordReaderSaves(page);
  await openReader(page, eisensteinPaperId);

  await page.click('button[aria-label="Ask AI about the whole paper"]');
  await page.fill('.paper-chat-shell textarea', question);
  await page.locator('.paper-chat-shell').getByRole('button', { name: 'Ask', exact: true }).click();

  // Switch to the sample paper while the reader stays mounted, then let the answer arrive.
  await openTrayResult(page, samplePaperId);
  await expect(page.locator('.paper-chat-shell')).toBeVisible();
  release();

  const lastChat = (paperId: string) =>
    saves.filter((save) => save.paperId === paperId).at(-1)?.reader.nodeAnswers?.__paper_chat__ ?? '[]';
  await expect
    .poll(() => JSON.parse(lastChat(eisensteinPaperId)).slice(-2), { message: 'saved while another paper is shown' })
    .toEqual([
      { role: 'user', text: question },
      { role: 'assistant', text: answer },
    ]);
  await expect(page.locator('.paper-chat-shell')).not.toContainText(answer);
  expect(lastChat(samplePaperId)).not.toContain(answer);
});
