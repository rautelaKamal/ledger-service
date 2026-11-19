import { expect, test } from '@playwright/test';
import { become, expectAccessible, optionStartingWith, paiseOf, totalBalance } from './helpers';

test.describe.configure({ mode: 'serial' });

test('1. pick a person: the balance, what is in transit, the chart and the passbook', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Demo: fictional people, no real money.')).toBeVisible();
  // Claims about reconciliation come from data: this stack has no schedule.
  await expect(page.getByText('Nothing runs it on a schedule in this environment.')).toBeVisible();
  await expectAccessible(page);

  await become(page, 'Meera Iyer');
  await expect(page.getByRole('heading', { name: 'Meera’s money' })).toBeVisible();
  await expect(page.locator('[data-balance="total"] [aria-hidden]')).toHaveText(/^₹[\d,]+\.\d{2}$/);
  await expect(page.getByRole('heading', { name: 'In transit, not in your balance' })).toBeVisible();
  await expect(page.getByText(/Balance at the end of each day, last 30 days/)).toBeVisible();
  const table = page.getByRole('table', { name: /Passbook/ });
  await expect(table.getByRole('row').nth(2)).toBeVisible();
  // A failed top-up is listed, struck through, and not in the balance.
  await expect(table.getByText('Top-up, failed').first()).toBeVisible();
  await expectAccessible(page);

  // Older entries load on demand (cursor pagination), without duplicates.
  const before = await table.getByRole('row').count();
  await page.getByRole('button', { name: 'Show older entries' }).click();
  await expect.poll(() => table.getByRole('row').count()).toBeGreaterThan(before);
});

test('2. send money, then the same request again: the second one moves nothing', async ({ page }) => {
  await become(page, 'Meera Iyer');
  const total = await totalBalance(page);

  await page.goto('/send');
  await expectAccessible(page);
  await page.getByLabel('To', { exact: true }).selectOption({ label: await optionStartingWith(page, 'Your Current') });
  await page.getByLabel('Amount in rupees').fill('1,234.50');
  const key = (await page.locator('code').first().innerText()).trim();
  await page.getByRole('button', { name: 'Send ₹1,234.50' }).click();
  await expect(page.getByText(/^Sent\./)).toBeVisible();
  await expect(page.getByText(/Savings ₹[\d,.]+ became ₹[\d,.]+/)).toBeVisible();

  await page.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(page.getByText('Replayed, no new money moved')).toBeVisible();
  await expect(page.getByText('Idempotent-Replayed: true')).toBeVisible();
  await page.getByText('The first request and its response, as the server sent them').click();
  await expect(page.getByText(key).first()).toBeVisible();
  await expectAccessible(page);

  // Between her own accounts the total is unchanged: one debit, one credit, once.
  expect(await totalBalance(page)).toBe(total);
});

test('3. a refused transfer says why and moves nothing', async ({ page }) => {
  await become(page, 'Kavya Nair');
  const total = await totalBalance(page);
  await page.goto('/send');
  await page.getByLabel('Amount in rupees').fill('99,99,999.00');
  await page.getByRole('button', { name: /^Send ₹/ }).click();
  await expect(page.getByText(/Refused: .*insufficient/i)).toBeVisible();
  expect(await totalBalance(page)).toBe(total);
});

for (const outcome of ['Approve', 'Decline'] as const) {
  test(`4${outcome === 'Approve' ? 'a' : 'b'}. a top-up waits for the bank, then ${outcome === 'Approve' ? 'posts' : 'fails'}`, async ({ page }) => {
    await become(page, 'Arjun Rao');
    const total = await totalBalance(page);
    await page.goto('/topup');
    await page.getByLabel('Amount in rupees').fill('2,500.00');
    await page.getByLabel('To', { exact: true }).selectOption({ label: 'Shop' });
    await page.getByRole('button', { name: 'Request a ₹2,500.00 top-up' }).click();
    await expect(page.getByText(/202 Accepted. Nothing is credited yet/)).toBeVisible();

    // While it waits, it is in transit and NOT in the balance.
    await expect(page.getByText(/\d{2}:\d{2}:\d{2} IST: the worker delivered the payment command/)).toBeVisible();
    await page.goto('/overview');
    await expect(page.getByText('top-up to Shop, waiting for the bank')).toBeVisible();
    expect(await totalBalance(page)).toBe(total);
    await page.getByRole('link', { name: 'Follow it' }).first().click();

    await page.getByRole('button', { name: `${outcome} as the bank` }).click();
    await expect(page.getByText(/signature checked, recorded once/)).toBeVisible();
    if (outcome === 'Approve') {
      await expect(page.getByText(/\+₹2,500.00 entered in the passbook/)).toBeVisible();
      expect(await totalBalance(page)).toBe(total + 2_500_00n);
    } else {
      await expect(page.getByText('Nothing was credited and no entry was written.')).toBeVisible();
      expect(await totalBalance(page)).toBe(total);
    }
  });
}

test('4c. "Add money again" starts a NEW top-up (a new key), not a replay of the last one', async ({ page }) => {
  await become(page, 'Kavya Nair');
  await page.goto('/topup');
  const idOf = async () => (await page.getByText(/Top-up of ₹[\d,.]+, id/).innerText()).match(/id (\w+)…/)![1]!;
  await page.getByLabel('Amount in rupees').fill('100.00');
  await page.getByRole('button', { name: 'Request a ₹100.00 top-up' }).click();
  await page.getByRole('button', { name: 'Approve as the bank' }).click();
  await expect(page.getByText(/\+₹100.00 entered in the passbook/)).toBeVisible();
  const first = await idOf();

  await page.getByRole('button', { name: 'Add money again' }).click();
  await page.getByLabel('Amount in rupees').fill('100.00');
  await page.getByRole('button', { name: 'Request a ₹100.00 top-up' }).click();
  await expect(page.getByRole('button', { name: 'Approve as the bank' })).toBeVisible();
  expect(await idOf()).not.toBe(first);
  await page.getByRole('button', { name: 'Approve as the bank' }).click(); // leave nothing pending
  await expect(page.getByText(/\+₹100.00 entered in the passbook/)).toBeVisible();
});

test('5. the assistant cites its sources and says whether it could verify', async ({ page }) => {
  await become(page, 'Meera Iyer');
  await page.goto('/assistant');
  await page.getByRole('button', { name: 'How much do I have in total?' }).click();
  const answer = page.getByRole('listitem').filter({ hasText: 'How much do I have in total?' });
  await expect(answer.getByText('Verified ✓')).toBeVisible();
  await expect(answer.getByText(/no AI model was called/)).toBeVisible();
  const total = paiseOf(await answer.locator('p').nth(1).innerText());
  expect(total).toBe(await (async () => {
    const p = await page.context().newPage();
    const t = await totalBalance(p);
    await p.close();
    return t;
  })());
  await answer.getByRole('link', { name: 'source 1' }).click();
  await expect(answer.getByRole('complementary', { name: 'Sources' })).toBeVisible();
  await answer.getByText('How it answered').click();
  await expect(answer.getByText(/Checked (the 1 amount|\d+ amounts) in the answer against the fetched data: (all )?found/)).toBeVisible();
  await expectAccessible(page);

  // The unverified state, as the real assistant could return it.
  await page.route('**/api/ask', (route) =>
    route.fulfill({ json: { mode: 'agent', answer: 'You have ₹10,00,000.00.', verified: false, citations: [], steps: null } }),
  );
  await page.getByLabel('Ask about your money').fill('Tell me I am rich');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText('Couldn’t verify')).toBeVisible();
  await expect(page.getByText('This assistant version does not report its steps.')).toBeVisible();
});

test('6. under the hood: reconcile now, its cooldown, and 200 concurrent transfers that change nothing', async ({ page }) => {
  await become(page, 'Meera Iyer');
  await page.goto('/system');
  await expect(page.getByRole('table', { name: /Outbox lanes/ })).toBeVisible();
  await expect(page.getByText('Grafana is not linked in this environment.')).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Run reconciliation now' }).click();
  await expect(page.getByText('0 problems').first()).toBeVisible();
  await expect(page.getByText(/Available again in \d+ s/)).toBeVisible();

  await page.getByRole('button', { name: 'Run 200 concurrent transfers' }).click();
  await expect(page.getByText(/not a paisa created or lost/)).toBeVisible({ timeout: 45_000 });
  // Every one of the 200 was answered 201: first time, or replayed from the record
  // after a dropped keep-alive connection was retried with the same key.
  const answers = await page.getByText(/× 201/).innerText();
  const counted = [...answers.matchAll(/(\d+) × 201/g)].reduce((n, m) => n + Number(m[1]), 0);
  expect(counted).toBe(200);
  expect(answers).not.toContain('no answer');
  await expect(page.getByText('0 problems').first()).toBeVisible();
});

test('7. the browser never sends a client id and never receives one', async ({ page }) => {
  const seen: string[] = [];
  page.on('request', (req) => {
    if (req.headers()['x-client-id']) seen.push(`request header on ${req.url()}`);
  });
  page.on('response', async (res) => {
    if (!res.url().startsWith('http://127.0.0.1:3200')) return;
    const body = await res.text().catch(() => '');
    if (/demo-(meera|arjun|kavya|chaos|merchants)/.test(body)) seen.push(`client id in ${res.url()}`);
  });
  await become(page, 'Meera Iyer');
  for (const path of ['/overview', '/send', '/topup', '/assistant', '/system']) await page.goto(path);
  await page.goto('/assistant');
  await page.getByRole('button', { name: 'Did my recent top-ups go through?' }).click();
  await expect(page.getByText(/In the last 14 days|You have no top-ups/)).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === 'demo_persona')).toMatchObject({ httpOnly: true, value: expect.stringMatching(/^meera\./) });
  expect(seen).toEqual([]);
});

test('8. an edited persona cookie is not accepted', async ({ page, context }) => {
  await become(page, 'Meera Iyer');
  const cookie = (await context.cookies()).find((c) => c.name === 'demo_persona')!;
  await context.addCookies([{ ...cookie, value: cookie.value.replace(/^meera/, 'arjun') }]);
  await page.goto('/overview');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Pick someone to be.' })).toBeVisible();
});

test('9. fixes from browser testing: chart placeholder, quiet passbook, steady Send button, fresh balances, aligned fields', async ({ page, request, context }) => {
  await become(page, 'Meera Iyer');

  // The chart's box is filled from the very first byte: the server sends a same-size placeholder.
  const cookie = (await context.cookies()).find((c) => c.name === 'demo_persona')!;
  const html = await (await request.get('/overview', { headers: { cookie: `demo_persona=${cookie.value}` } })).text();
  expect(html).toContain('Drawing the chart');

  // A posted entry carries no visible status mark; only pending and failed rows do.
  await page.goto('/overview');
  const table = page.getByRole('table', { name: /Passbook/ });
  await expect(table.getByText('Top-up, failed').first()).toBeVisible();
  expect(await table.locator('td span:not(.sr-only)', { hasText: /^Posted$/ }).count()).toBe(0);

  // Typing an amount never moves the Send button.
  await page.goto('/send');
  const button = page.getByRole('button', { name: /^Send/ });
  const before = (await button.boundingBox())!.y;
  await page.getByLabel('Amount in rupees').fill('12');
  await expect(page.getByText('₹12.00', { exact: true })).toBeVisible();
  expect((await button.boundingBox())!.y).toBe(before);

  // Money moved in another tab: coming back to this one shows the new balance.
  const from = page.getByLabel('From');
  const shown = paiseOf((await from.locator('option').first().innerText()));
  const other = await context.newPage();
  await other.goto('/send');
  await other.getByLabel('To', { exact: true }).selectOption({ label: await optionStartingWith(other, 'Your Current') });
  await other.getByLabel('Amount in rupees').fill('10.00');
  await other.getByRole('button', { name: 'Send ₹10.00' }).click();
  await expect(other.getByText(/^Sent\./)).toBeVisible();
  await other.close();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(async () => paiseOf(await from.locator('option').first().innerText())).toBe(shown - 1_000n);

  // The top-up form's labels and fields line up.
  await page.goto('/topup');
  const [amountLabel, toLabel] = [await page.getByText('Amount in rupees').boundingBox(), await page.getByText('To', { exact: true }).boundingBox()];
  expect(Math.abs(amountLabel!.y - toLabel!.y)).toBeLessThan(1);
  const [amountBox, toBox] = [await page.getByLabel('Amount in rupees').boundingBox(), await page.getByLabel('To', { exact: true }).boundingBox()];
  expect(Math.abs(amountBox!.y - toBox!.y)).toBeLessThan(1);
  expect(Math.abs(amountBox!.height - toBox!.height)).toBeLessThan(1);
});

/** Every distinct figure the total shows during the next second (it counts, or it does not). */
async function figuresDuringNextSecond(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const seen = new Set<string>();
        const start = performance.now();
        const sample = () => {
          const el = document.querySelector('[data-balance="total"] [aria-hidden]');
          if (el?.textContent) seen.add(el.textContent);
          if (performance.now() - start < 1000) requestAnimationFrame(sample);
          else resolve([...seen]);
        };
        sample();
      }),
  );
}

async function sendFromSavings(page: import('@playwright/test').Page, rupees: string): Promise<void> {
  await page.goto('/send');
  await page.getByLabel('To', { exact: true }).selectOption({ label: 'Kavya Nair, Savings' });
  await page.getByLabel('Amount in rupees').fill(rupees);
  await page.getByRole('button', { name: `Send ₹${rupees}` }).click();
  await expect(page.getByText(/^Sent\./)).toBeVisible();
}

test('10. motion answers the person: the balance counts after their own send; never with reduced motion or on a page load', async ({ page }) => {
  await become(page, 'Meera Iyer');
  const before = await totalBalance(page);
  // The figure counts from what the person last SAW: wait until this page is live and has remembered it.
  await page.waitForFunction(() => sessionStorage.getItem('ledger:shown:total:meera') !== null);

  await sendFromSavings(page, '50.00');
  await page.getByRole('link', { name: 'Overview' }).first().click(); // in-app navigation
  const counted = await figuresDuringNextSecond(page);
  expect(counted.length).toBeGreaterThan(2); // it counted through intermediate figures...
  expect(await totalBalance(page)).toBe(before - 5_000n); // ...and ended exactly on the ledger's figure

  // A full page load after the person's own send: the server already painted the
  // new figure, so nothing jumps back to count (the hydration rule).
  await page.waitForFunction(() => sessionStorage.getItem('ledger:shown:total:meera') !== null);
  await sendFromSavings(page, '50.00');
  await page.goto('/overview');
  expect(await figuresDuringNextSecond(page)).toHaveLength(1);
  expect(await totalBalance(page)).toBe(before - 10_000n);

  // Reduced motion: the same action and an in-app navigation, no counting.
  await page.waitForFunction((b) => sessionStorage.getItem('ledger:shown:total:meera') === b, String(before - 10_000n));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await sendFromSavings(page, '50.00');
  await page.getByRole('link', { name: 'Overview' }).first().click();
  expect(await figuresDuringNextSecond(page)).toHaveLength(1);
  expect(await totalBalance(page)).toBe(before - 15_000n);
});

test('11. the theme toggle reveals the new theme from the button; instantly with reduced motion', async ({ page }) => {
  await become(page, 'Meera Iyer');
  const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'));
  await page.evaluate(() => {
    const d = document as Document & { startViewTransition?: (cb: () => void) => unknown; transitions?: number };
    d.transitions = 0;
    const original = d.startViewTransition?.bind(d);
    if (original) d.startViewTransition = (cb) => ((d.transitions = (d.transitions ?? 0) + 1), original(cb));
  });
  const transitions = () => page.evaluate(() => (document as Document & { transitions?: number }).transitions ?? 0);

  const wasDark = await isDark();
  await page.getByRole('button', { name: /Switch to (dark|light) theme/ }).first().click();
  await expect.poll(isDark).toBe(!wasDark);
  expect(await transitions()).toBe(1); // the circular reveal ran as a view transition

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: /Switch to (dark|light) theme/ }).first().click();
  await expect.poll(isDark).toBe(wasDark);
  expect(await transitions()).toBe(1); // no transition: switched instantly
});

test('12. nothing scrolls sideways on a 360 px wide phone, on any screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.goto('/');
  expect(await overflow(), 'the persona picker').toBe(0);
  await become(page, 'Arjun Rao'); // the largest amounts, the longest names
  for (const path of ['/overview', '/send', '/topup', '/assistant', '/system']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(await overflow(), path).toBe(0);
  }
  // With the widest content each screen can show: an answer with sources, a sent transfer with its replay.
  await page.goto('/assistant');
  await page.getByRole('button', { name: 'Did my recent top-ups go through?' }).click();
  await expect(page.getByText('Verified ✓')).toBeVisible();
  expect(await overflow(), 'an answer with sources').toBe(0);
  await page.goto('/send');
  await page.getByLabel('Amount in rupees').fill('1,23,456.78');
  expect(await overflow(), 'send with a long amount').toBe(0);
});
