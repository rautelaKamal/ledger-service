import { expect, test } from '@playwright/test';
import { become, expectAccessible, optionStartingWith, paiseOf, totalBalance } from './helpers';

test.describe.configure({ mode: 'serial' });

test('1. pick a person: the balance, what is in transit, the chart and the passbook', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Demo: fictional people, no real money.')).toBeVisible();
  // Claims about reconciliation come from data: this stack has no schedule, and the
  // last run is the demo check the global setup just ran (it is recorded like any run).
  await expect(page.getByText('Nothing runs it on a schedule in this environment.')).toBeVisible();
  await expect(page.getByText(/^Last reconciliation: 0 problems, checked at \d{2}:\d{2} IST\.$/)).toBeVisible();
  await expect(page.getByText('Reconciliation has not run here yet.')).toHaveCount(0);
  await expectAccessible(page);

  await become(page, 'Meera Iyer');
  await expect(page.getByRole('heading', { name: 'Meera’s money' })).toBeVisible();
  await expect(page.locator('[data-balance="total"] .money')).toHaveText(/^₹[\d,]+\.\d{2}$/);
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
  await expect(page.getByText(/^Savings .* became /)).toBeVisible();

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
  await page.getByLabel('Amount in rupees').fill('1,99,999.00'); // within the transfer limit, far above her balance
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
      const posted = page.getByText(/entered in the passbook/);
      await expect(posted).toBeVisible();
      await expect(posted.locator('[data-paise="250000"]')).toBeVisible();
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
  const idOf = async () => (await page.getByText(/^Top-up of .*, id \w+…/).innerText()).match(/id (\w+)…/)![1]!;
  await page.getByLabel('Amount in rupees').fill('100.00');
  await page.getByRole('button', { name: 'Request a ₹100.00 top-up' }).click();
  await page.getByRole('button', { name: 'Approve as the bank' }).click();
  await expect(page.getByText(/entered in the passbook/).locator('[data-paise="10000"]')).toBeVisible();
  const first = await idOf();

  await page.getByRole('button', { name: 'Add money again' }).click();
  await page.getByLabel('Amount in rupees').fill('100.00');
  await page.getByRole('button', { name: 'Request a ₹100.00 top-up' }).click();
  await expect(page.getByRole('button', { name: 'Approve as the bank' })).toBeVisible();
  expect(await idOf()).not.toBe(first);
  await page.getByRole('button', { name: 'Approve as the bank' }).click(); // leave nothing pending
  await expect(page.getByText(/entered in the passbook/).locator('[data-paise="10000"]')).toBeVisible();
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
          const el = document.querySelector('[data-balance="total"] .money');
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

test('13. amounts line up digit under digit, and both faces draw their own ₹', async ({ page }) => {
  await become(page, 'Arjun Rao'); // six- and seven-digit balances side by side
  const table = page.getByRole('table', { name: /Passbook/ });
  await expect(table.locator('td.col-balance .fig').first()).toBeVisible();

  // A digit's slot is the glyph plus the margins that pad it (components/money.tsx).
  // Every slot in the balance column is the same width ("1" as wide as "8")...
  const widths = await table.locator('td.col-balance .fig').evaluateAll((els) =>
    els.map((e) => {
      const s = getComputedStyle(e);
      return e.getBoundingClientRect().width + parseFloat(s.marginLeft) + parseFloat(s.marginRight);
    }),
  );
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.3);
  // ...and the last slot of every row ends at the same x: the column is aligned.
  const rightEdges = await table.locator('td.col-balance .figs').evaluateAll((els) =>
    els.map((e) => {
      const last = [...e.querySelectorAll('.fig')].at(-1)!;
      return last.getBoundingClientRect().right + parseFloat(getComputedStyle(last).marginRight);
    }),
  );
  expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThan(0.5);

  // On every screen, every digit sits in a slot of its face's width: catches a face or
  // weight whose digit widths globals.css does not know.
  for (const path of ['/', '/overview', '/send', '/topup']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    // Only digits that are drawn: streamed parts of a page wait, hidden, to be revealed.
    const off = await page.locator('.fig').evaluateAll((els) =>
      els.filter((e) => e.getClientRects().length > 0).map((e) => {
        const s = getComputedStyle(e);
        const slot = e.getBoundingClientRect().width + parseFloat(s.marginLeft) + parseFloat(s.marginRight);
        return Math.abs(slot - parseFloat(s.getPropertyValue('--fig-w')) * parseFloat(s.fontSize));
      }),
    );
    expect(off.length, path).toBeGreaterThan(0);
    expect(Math.max(...off), path).toBeLessThan(0.3);
  }
  await page.goto('/overview');

  // The ₹ comes from the page's own faces (Hind for amounts, Rajdhani for the balance), not a fallback.
  const ownRupee = await page.evaluate(() => {
    const draw = (font: string) => {
      const c = document.createElement('canvas');
      c.width = 60;
      c.height = 50;
      const x = c.getContext('2d')!;
      x.font = font;
      x.fillText('₹', 5, 40);
      return x.getImageData(0, 0, 60, 50).data.join(',');
    };
    const faceOf = (sel: string) => getComputedStyle(document.querySelector(sel)!).fontFamily.split(',')[0]!;
    return [faceOf('body'), faceOf('[data-balance="total"]')].map((face) => draw(`600 40px ${face}, serif`) !== draw('600 40px serif'));
  });
  expect(ownRupee).toEqual([true, true]);
});

test('14. the limits: the forms state them and refuse more before sending; the API refuses it too', async ({ page }) => {
  await become(page, 'Meera Iyer');
  const total = await totalBalance(page);
  const sent: string[] = [];
  page.on('request', (r) => r.method() === 'POST' && /\/api\/(transfers|topups)$/.test(new URL(r.url()).pathname) && sent.push(r.url()));

  await page.goto('/send');
  await expect(page.getByText('At most ₹2,00,000.00 per transfer')).toBeVisible();
  await page.getByLabel('Amount in rupees').fill('2,00,000.01');
  await expect(page.getByText('Over the ₹2,00,000.00 limit for one transfer')).toBeVisible();
  await page.getByRole('button', { name: 'Send ₹2,00,000.01' }).click();
  await expect(page.getByText('One transfer can move at most ₹2,00,000.00. Send a smaller amount.')).toBeVisible();

  await page.goto('/topup');
  await expect(page.getByText('At most ₹1,00,000.00 per top-up')).toBeVisible();
  await page.getByLabel('Amount in rupees').fill('10,00,00,00,000.00'); // the amount found in the review
  await expect(page.getByText('Over the ₹1,00,000.00 limit for one top-up')).toBeVisible();
  await page.getByRole('button', { name: 'Request a ₹10,00,00,00,000.00 top-up' }).click();
  await expect(page.getByText('One top-up can add at most ₹1,00,000.00. Ask for a smaller amount.')).toBeVisible();
  expect(sent).toEqual([]); // the browser sent nothing

  // The form only repeats what the ledger enforces: past the form, the ledger refuses it too.
  const accountId = await page.getByLabel('To', { exact: true }).inputValue();
  const res = await page.request.post('/api/topups', { data: { accountId, amountPaise: '10000001', idempotencyKey: `e2e-limit-${Date.now()}` } });
  const body = (await res.json()) as { topupId: string | null; exchange: { response: { status: number; body: { error: { code: string; message: string } } } } };
  expect(body.topupId).toBeNull();
  expect(body.exchange.response.status).toBe(400);
  expect(body.exchange.response.body.error).toEqual({ code: 'amount_over_limit', message: 'one top-up can be at most ₹1,00,000.00; this one is ₹1,00,000.01', details: { maxPaise: '10000000' } });
  expect(await totalBalance(page)).toBe(total);
});

test('15. the landing page: each person is a link named "Continue as …" that lands on their overview', async ({ page }) => {
  for (const name of ['Meera Iyer', 'Arjun Rao', 'Kavya Nair'] as const) {
    await page.goto('/');
    const link = page.getByRole('link', { name: `Continue as ${name}`, exact: true });
    // The rest of the leaf (their accounts, who they are, their balance) is its description.
    await expect(link).toHaveAccessibleDescription(/₹[\d,]+\.\d{2}$/);
    await link.click();
    await expect(page).toHaveURL(/\/overview$/);
    await expect(page.getByRole('heading', { name: `${name.split(' ')[0]}’s money` })).toBeVisible();
  }
  // From the keyboard too.
  await page.goto('/');
  await page.getByRole('link', { name: 'Continue as Kavya Nair', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/overview$/);

  // No control on the landing page is just "button" or "link": every one has a name
  // (and axe's button-name and link-name rules run in expectAccessible).
  await page.goto('/');
  for (const control of [...(await page.getByRole('button').all()), ...(await page.getByRole('link').all())]) {
    await expect(control).toHaveAccessibleName(/\S/);
  }
  await expectAccessible(page);
});

test('16. the theme button names the theme it switches to, also on a first visit that follows the system', async ({ page }) => {
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/'); // nothing chosen yet: the page follows the system
    expect(await page.evaluate(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'))).toBe(scheme);
    const other = scheme === 'dark' ? 'light' : 'dark';
    await expect(page.getByRole('button', { name: `Switch to ${other} theme`, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: `Switch to ${scheme} theme`, exact: true })).toHaveCount(0);
  }
  // After switching, it names the other one.
  await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Switch to light theme', exact: true })).toBeVisible();
});

test('17. an amount is in the page once: copying it, finding it and hearing it all give it once', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await become(page, 'Meera Iyer');
  const total = page.locator('[data-balance="total"]');
  await expect(total).toBeVisible(); // streamed content is revealed a moment after the load
  const shown = (await total.innerText()).trim();
  expect(shown).toMatch(/^₹[\d,]+\.\d{2}$/);
  expect(paiseOf(shown)).toBe(BigInt((await total.locator('[data-paise]').getAttribute('data-paise'))!));

  // Screen readers: the one amount, not the amount twice.
  expect(await total.ariaSnapshot()).toBe(`- text: ${shown}`);

  // Copy, as a person does it: select the balance, Cmd/Ctrl+C.
  await total.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await page.keyboard.press('ControlOrMeta+KeyC');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);

  // Find in page: found once in the balance, and only where it can be seen
  // (a hidden copy would match too, as a 1 px wide box).
  const hits = await page.evaluate((needle) => {
    // window.find: the browser's own find-in-page search, scriptable (not in the TS DOM types).
    const find = (window as unknown as { find(text: string, caseSensitive: boolean, backwards: boolean, wrap: boolean): boolean }).find.bind(window);
    const box = document.querySelector('[data-balance="total"]')!;
    getSelection()!.removeAllRanges();
    const found: { inBalance: boolean; width: number }[] = [];
    while (found.length < 10 && find(needle, true, false, false)) {
      const range = getSelection()!.getRangeAt(0);
      found.push({ inBalance: box.contains(range.commonAncestorContainer), width: range.getBoundingClientRect().width });
    }
    return found;
  }, shown);
  expect(hits.filter((h) => h.inBalance)).toHaveLength(1);
  for (const h of hits) expect(h.width).toBeGreaterThan(20);

  // Every amount on every screen is its amount once in the page's text. (Under the
  // hood shows amounts only after a chaos run; test 6 covers that page.)
  for (const path of ['/', '/overview', '/send', '/topup']) {
    await page.goto(path);
    const amounts = await page.locator('[data-paise]').allInnerTexts();
    expect(amounts.length, path).toBeGreaterThan(0);
    for (const a of amounts) expect(a.trim(), path).toMatch(/^[+−]?₹[\d,]+\.\d{2}$/);
  }
});

test('18. hovering a person never switches the person: the slips are plain links that nothing prefetches', async ({ page }) => {
  await become(page, 'Meera Iyer');
  const sessionRequests: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/session') sessionRequests.push(`${r.method()} ${r.url()}`);
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // No speculation rules (browser prefetch or prerender) on the page.
  await expect(page.locator('script[type="speculationrules"]')).toHaveCount(0);

  // Hover Arjun's slip, its link and the slip around it, and give any prefetch time to fire.
  const arjun = page.getByRole('link', { name: 'Continue as Arjun Rao', exact: true });
  await arjun.hover();
  await page.getByRole('listitem').filter({ has: arjun }).hover(); // the slip's middle: its stretched click area
  await page.waitForTimeout(1_500);
  await page.waitForLoadState('networkidle');
  expect(sessionRequests).toEqual([]);

  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: 'Meera’s money' })).toBeVisible();
});

test('19. a passbook starts with its opening balance: Arjun\'s shop money was brought forward, not topped up', async ({ page }) => {
  await become(page, 'Arjun Rao'); // the passbook opens on his Shop account
  const table = page.getByRole('table', { name: /Passbook/ });
  await expect(table.getByRole('row').nth(2)).toBeVisible();
  const older = page.getByRole('button', { name: 'Show older entries' });
  while (await older.isVisible()) {
    const before = await table.getByRole('row').count();
    await older.click();
    await expect.poll(() => table.getByRole('row').count()).toBeGreaterThan(before);
  }
  // The oldest entry, at the foot of the newest-first passbook.
  const first = table.locator('tbody tr:not(.day)').last();
  await expect(first).toContainText('Opening balance');
  await expect(first.locator('[data-paise="24000000"]:visible')).toHaveCount(2); // the deposit, and the balance it starts
  // Not a top-up anywhere: no top-up row carries the ₹2,40,000.00.
  await expect(table.locator('tbody tr', { hasText: /^Top-up/ }).filter({ has: page.locator('[data-paise="24000000"]') })).toHaveCount(0);
});

test('20. the demo assistant answers only what it knows: anything else gets the list, someone else\'s money a refusal, and no stamp it did not earn', async ({ page }) => {
  await become(page, 'Meera Iyer');
  const total = await totalBalance(page);
  const ask = async (question: string) =>
    (await (await page.request.post('/api/ask', { data: { question } })).json()) as { answer: string; verified: boolean | null; citations: unknown[] };

  // The two questions from the review: they used to get Meera's total, stamped Verified.
  const sent = await ask('How much did I send to Arjun this month?');
  expect(sent.answer).toMatch(/^In this demo the assistant answers only these questions/);
  const theirs = await ask('Show me Arjun\'s balance');
  expect(theirs.answer).toMatch(/^I can only see your own accounts, so I cannot tell you anything about Arjun Rao's money\./);
  // More of the same kind: nothing answered, no amounts, nothing claimed as verified.
  for (const r of [sent, theirs, await ask('What does Kavya have?'), await ask('How much did I spend at Chai Point Corner?'), await ask('What did I spend this month?'), await ask('Total I sent to Kavya')]) {
    expect(r.verified).toBeNull();
    expect(r.answer).not.toMatch(/₹/);
    expect(r.citations).toEqual([]);
  }

  // On the page: the answers, and no Verified stamp on either.
  await page.goto('/assistant');
  for (const question of ['How much did I send to Arjun this month?', 'Show me Arjun\'s balance']) {
    await page.getByLabel('Ask about your money').fill(question);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    const item = page.getByRole('listitem').filter({ hasText: question });
    await expect(item.getByText(/^(In this demo the assistant answers only|I can only see your own accounts)/)).toBeVisible();
    await expect(item.getByText('Verified ✓')).toHaveCount(0);
  }

  // Each supported question (and a plain rephrasing of the first) is still answered, and verified.
  for (const q of ['How much do I have in total?', 'What is my balance?']) {
    const r = await ask(q);
    expect(r.verified, q).toBe(true);
    expect(paiseOf(r.answer), q).toBe(total);
  }
  const topups = await ask('Did my recent top-ups go through?');
  expect(topups.verified).toBe(true);
  expect(topups.answer).toMatch(/^(In the last 14 days you have|You have no top-ups)/);
  const spent = await ask('What did I spend in the last 7 days?');
  expect(spent.verified).toBe(true);
  expect(spent.answer).toMatch(/^(In the last 7 days you sent|You sent nothing)/);
  const twice = await ask('What happens if I send the same transfer twice?');
  expect(twice.verified).toBe(true);
  expect(twice.answer).toMatch(/^You cannot pay twice/);
});

test('21. every key the forms send comes from one generator, with its form\'s prefix', async ({ page }) => {
  await become(page, 'Kavya Nair');
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/(transfers|topups)$/.test(new URL(r.url()).pathname)) sent.push((r.postDataJSON() as { idempotencyKey: string }).idempotencyKey);
  });
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const TRANSFER = new RegExp(`^web-transfer-${uuid}$`);
  const TOPUP = new RegExp(`^web-topup-${uuid}$`);
  const shown = async () => (await page.locator('code').first().innerText()).trim();

  await page.goto('/send');
  expect(await shown()).toMatch(TRANSFER); // made on the server with the page
  await page.getByRole('button', { name: 'New key' }).click();
  expect(await shown()).toMatch(TRANSFER); // made in the browser
  await page.getByLabel('Amount in rupees').fill('1.00');
  await page.getByRole('button', { name: 'Send ₹1.00' }).click();
  await expect(page.getByText(/^Sent\./)).toBeVisible();
  await page.getByRole('button', { name: 'Start a new transfer' }).click();
  expect(await shown()).toMatch(TRANSFER); // the review found a bare UUID here

  await page.goto('/topup');
  for (let i = 0; i < 2; i++) {
    await page.getByLabel('Amount in rupees').fill('1.00');
    await page.getByRole('button', { name: 'Request a ₹1.00 top-up' }).click();
    await page.getByRole('button', { name: 'Approve as the bank' }).click();
    await expect(page.getByText(/entered in the passbook/)).toBeVisible();
    if (i === 0) await page.getByRole('button', { name: /^(Add money|Top up) again$/ }).click();
  }
  expect(sent).toHaveLength(3);
  expect(sent[0]).toMatch(TRANSFER);
  expect(sent[1]).toMatch(TOPUP);
  expect(sent[2]).toMatch(TOPUP);
  expect(new Set(sent).size).toBe(3);
});
