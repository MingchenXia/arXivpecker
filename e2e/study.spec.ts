import { expect, test, type Locator } from '@playwright/test';
import { bridgeOrigin, eisensteinPaperId, openReader, recordPageErrors } from './helpers';

/** Opens the assistant on the result a proof belongs to; retried in case the click lands before hydration. */
async function openStudyTools(proof: Locator) {
  const study = proof.page().locator('.assistant-study');
  await expect(async () => {
    await proof.locator('.source-proof-note').click();
    await expect(study).toBeVisible({ timeout: 2000 });
  }).toPass();
  return study;
}

test('a proof can be practiced with the author proof hidden, and the attempt is kept', async ({ page, request }) => {
  const errors = recordPageErrors(page);
  await openReader(page);
  const proof = page.locator('section.source-proof').first();
  const nodeId = await proof.getAttribute('data-node-id');
  const study = await openStudyTools(proof);
  await study.getByRole('button', { name: 'Reading path' }).click();
  await expect(study.locator('.study-path, .study-empty')).toBeVisible();

  await study.getByRole('button', { name: 'Practice proof' }).click();
  await study.getByRole('button', { name: 'Hide the proof and start' }).click();
  const authorProof = page.locator(`section.source-proof[data-node-id="${nodeId}"]`);
  await expect(authorProof).toHaveClass(/source-proof-collapsed/);

  await study.getByRole('textbox').fill('By induction on $n$.');
  await expect(study.locator('.assistant-note-preview .katex')).toBeVisible();
  await study.getByRole('button', { name: 'Compare with the paper' }).click();
  await expect(study.locator('.study-feedback')).toContainText('Scripted answer', { timeout: 30_000 });
  await expect
    .poll(async () => {
      const vault = await (await request.get(`${bridgeOrigin}/vault`)).json();
      return JSON.parse(vault.nodeAnswers[eisensteinPaperId]?.[`__practice__:${nodeId}`] ?? '{}').attempt;
    })
    .toBe('By induction on $n$.');

  await study.getByRole('button', { name: 'Reveal proof' }).click();
  await expect(authorProof).not.toHaveClass(/source-proof-collapsed/);
  expect(errors).toEqual([]);
});

test('a Lean draft is requested for a result and kept with it', async ({ page, request }) => {
  await openReader(page);
  const proof = page.locator('section.source-proof').first();
  const nodeId = await proof.getAttribute('data-node-id');
  const study = await openStudyTools(proof);
  await study.getByRole('button', { name: 'Lean draft' }).click();
  await study.getByRole('button', { name: 'Draft Lean statement' }).click();
  await expect(study.locator('.study-feedback')).toContainText('Scripted answer', { timeout: 30_000 });
  await expect
    .poll(async () => {
      const vault = await (await request.get(`${bridgeOrigin}/vault`)).json();
      return vault.nodeAnswers[eisensteinPaperId]?.[`__lean__:${nodeId}`] ?? '';
    })
    .toContain('Scripted answer');
});
