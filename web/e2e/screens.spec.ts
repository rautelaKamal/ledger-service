import { expect, test, type Page } from '@playwright/test';
import { resetDemo } from './demo-db';
import { become, expectAccessible } from './helpers';

// Every screen, desktop and phone, light and dark: docs/images/web/<screen>-<device>-<theme>.png
// Run with `npm run screenshots` (the four shots-* projects). Each one stages the
// screen in a meaningful state first (a sent transfer and its replay, a top-up
// waiting for the bank, an answered question, a finished chaos run).

const OUT = '../docs/images/web';

async function shot(page: Page, name: string): Promise<void> {
  const { device, theme } = test.info().project.metadata as { device: string; theme: string };
  await page.evaluate(() => document.fonts.ready);
  // Every screen, in every device and theme, passes axe (dark mode's contrast included).
  await expectAccessible(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  // Desktop: the whole page. Phone: one screen, as a phone shows it (a full-page
  // capture would paint the fixed bottom tab bar over the middle of the page).
  await page.screenshot({ path: `${OUT}/${name}-${device}-${theme}.png`, fullPage: device === 'desktop', animations: 'disabled', caret: 'hide' });
}

test.describe.configure({ mode: 'serial' });

// Every device/theme starts from the seed, so all 24 screenshots show the same
// balances (the Send and Top up screens move money while they are captured).
test.beforeAll(() => resetDemo());

test('1 pick', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Pick someone to be.' })).toBeVisible();
  await shot(page, '1-pick');
});

test('2 overview', async ({ page }) => {
  await become(page, 'Meera Iyer');
  await expect(page.getByRole('table', { name: /Passbook/ })).toBeVisible();
  await shot(page, '2-overview');
});

test('3 send', async ({ page }) => {
  await become(page, 'Meera Iyer');
  await page.goto('/send');
  await page.getByLabel('To', { exact: true }).selectOption({ label: 'Arjun Rao, Shop' });
  await page.getByLabel('Amount in rupees').fill('1,200.00');
  await page.getByLabel('Note, optional').fill('rent share');
  await page.getByRole('button', { name: 'Send ₹1,200.00' }).click();
  await page.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByText('Replayed, no new money moved')).toBeVisible();
  await shot(page, '3-send');
});

test('4 top-up', async ({ page }) => {
  await become(page, 'Kavya Nair');
  await page.goto('/topup');
  await page.getByLabel('Amount in rupees').fill('5,000.00');
  await page.getByRole('button', { name: /Request a ₹5,000.00 top-up/ }).click();
  await expect(page.getByRole('button', { name: 'Approve as the bank' })).toBeVisible();
  await shot(page, '4-topup');
  // Leave nothing pending behind (a top-up pending for 24 h is a reconciliation finding).
  await page.getByRole('button', { name: 'Approve as the bank' }).click();
  await expect(page.getByText(/entered in the passbook/)).toBeVisible();
});

test('5 assistant', async ({ page }) => {
  await become(page, 'Arjun Rao');
  await page.goto('/assistant');
  await page.getByRole('button', { name: 'Did my recent top-ups go through?' }).click();
  await expect(page.getByText('Verified ✓')).toBeVisible();
  await page.getByText('How it answered').click();
  await shot(page, '5-assistant');
});

test('6 system', async ({ page }) => {
  await become(page, 'Meera Iyer');
  await page.goto('/system');
  const run = page.getByRole('button', { name: 'Run 200 concurrent transfers' });
  await expect(run).toBeEnabled({ timeout: 30_000 }); // another project's run may still be cooling down
  await run.click();
  await expect(page.getByText(/not a paisa created or lost/)).toBeVisible({ timeout: 45_000 });
  await shot(page, '6-system');
});
