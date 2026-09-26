import { expect, type Page } from '@playwright/test';

export const eisensteinPaperId = 'arxiv-2608.24719';
export const eisensteinTitle = 'Fourier Coefficients of the Degenerate Eisenstein Series on Symplectic Groups';
export const samplePaperId = 'arxiv-local-333f9f47-cd02-424f-b473-587dc480d69f';
export const sampleTitle = 'A Sample Mathematics Paper';
export const bridgeOrigin = 'http://127.0.0.1:4318';

type ReaderSave = { paperId: string; reader: { marks?: Record<string, string>; nodeAnswers?: Record<string, string> } };

/** Skips first-run setup and opens the reader on one paper. */
export async function openReader(page: Page, paperId = eisensteinPaperId) {
  await page.addInitScript((selected) => {
    localStorage.setItem('arxivpecker-onboarding-complete-v1', 'complete');
    localStorage.setItem(
      'proofroom-reader-preferences-v1',
      JSON.stringify({
        level: 'Graduate student',
        areas: ['math.NT'],
        goal: 'Understand proofs',
        model: '',
        reasoning: 'xhigh',
        reasoningConfigured: true,
      }),
    );
    localStorage.setItem('arxivpecker-selected-paper-v1', selected);
    // No automatic calls to arXiv or OpenAlex during a test; e2e/watch.spec.ts checks by hand.
    localStorage.setItem('arxivpecker-watch-daily-v1', 'off');
  }, paperId);
  await page.goto('/');
  await expect(page.locator('.katex').first()).toBeVisible();
}

/** Records every reader-state save the page sends to the bridge. */
export function recordReaderSaves(page: Page) {
  const saves: ReaderSave[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url() === `${bridgeOrigin}/vault/reader`)
      saves.push(JSON.parse(request.postData() ?? '{}'));
  });
  return saves;
}

/** Collects uncaught page errors so a test can assert there were none. */
export function recordPageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** Opens a finished AI result from the activity tray, which switches paper without unmounting the reader. */
export async function openTrayResult(page: Page, paperId: string, panel: 'paper-chat' | 'assistant' = 'paper-chat') {
  await page.evaluate(
    ({ paperId, panel }) =>
      window.dispatchEvent(
        new CustomEvent('proofroom:process', {
          detail: {
            id: `e2e-${paperId}-${Date.now()}`,
            label: 'Result ready',
            detail: '',
            status: 'complete',
            resultTarget: { paperId, panel },
          },
        }),
      ),
    { paperId, panel },
  );
  if (!(await page.locator('.process-entry-open').first().isVisible()))
    await page.click('button[aria-label="Show or hide AI activity"]');
  await page.locator('.process-entry-open').first().click();
}
