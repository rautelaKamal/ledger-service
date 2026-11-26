// Step 7g: the assistant page with the live assistant, inside its limits, against a
// stand-in agent (e2e/mock-agent.mjs: no Gemini) and a real Redis. CI makes no model call.
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createClient } from '@redis/client';
import { FALLBACK_NOTICE } from '../lib/assistant-labels';
import { quotaDay } from '../lib/server/limits';
import { become, expectAccessible } from './helpers';

const WEB_LIVE = 'http://127.0.0.1:3201';
const WEB_NO_REDIS = 'http://127.0.0.1:3202';
const AGENT = 'http://127.0.0.1:8201';
const PREFIX = 'e2e-assistant'; // ASSISTANT_REDIS_PREFIX of both live servers
const LIVE_FOOTNOTE = 'Answered by the live assistant; every amount was checked by code.';
const SCRIPT_FOOTNOTE = 'A script answered from your live ledger data; no AI model was called.';

test.describe.configure({ mode: 'serial' });

const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' });

test.beforeAll(async () => {
  await redis.connect();
  for await (const keys of redis.scanIterator({ MATCH: `${PREFIX}:*`, COUNT: 1000 })) if (keys.length) await redis.del(keys);
});
test.afterAll(async () => {
  for await (const keys of redis.scanIterator({ MATCH: `${PREFIX}:*`, COUNT: 1000 })) if (keys.length) await redis.del(keys);
  await redis.close();
});
test.beforeEach(async ({ request }) => {
  await request.post(`${AGENT}/reset`);
});

async function agentCalls(request: APIRequestContext): Promise<Array<{ question: string; clientId: string }>> {
  return ((await (await request.get(`${AGENT}/calls`)).json()) as { calls: Array<{ question: string; clientId: string }> }).calls;
}

async function ask(page: Page, question: string): Promise<Locator> {
  await page.getByLabel('Ask about your money').fill(question);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  return page.getByRole('listitem').filter({ hasText: question });
}

test.describe('live mode', () => {
  test.use({ baseURL: WEB_LIVE });

  test('26. free text and the suggestions both go to the live assistant, and say so', async ({ page, request }) => {
    await become(page, 'Meera Iyer');
    await page.goto('/assistant');
    await expect(page.getByText(/you can ask 2 questions in a row, then one more every 10 minutes, and the whole demo has 100 live questions a day/)).toBeVisible();

    const free = await ask(page, 'Why is my balance lower than last week?');
    await expect(free.getByText('Live answer from the stand-in agent to: Why is my balance lower than last week?')).toBeVisible();
    await expect(free.getByText(LIVE_FOOTNOTE)).toBeVisible();
    await expect(free.getByRole('note')).toHaveCount(0); // no fallback label on a live answer

    await page.getByRole('button', { name: 'How much do I have in total?' }).click(); // still a suggestion, still live
    const suggested = page.getByRole('listitem').filter({ hasText: 'How much do I have in total?' });
    await expect(suggested.getByText('Live answer from the stand-in agent to: How much do I have in total?')).toBeVisible();
    await expectAccessible(page);

    const calls = await agentCalls(request);
    expect(calls.map((c) => c.question)).toEqual(['Why is my balance lower than last week?', 'How much do I have in total?']);
    expect(calls.every((c) => c.clientId === 'demo-meera')).toBe(true); // added by the server, never by the browser
  });

  test('27. per visitor: after the burst, a clear message and no model call; another visitor is unaffected', async ({ page, request, browser }) => {
    await become(page, 'Meera Iyer');
    await page.goto('/assistant');
    await expect((await ask(page, 'First question')).getByText(LIVE_FOOTNOTE)).toBeVisible();
    await expect((await ask(page, 'Second question')).getByText(LIVE_FOOTNOTE)).toBeVisible();
    const third = await ask(page, 'Third question');
    await expect(third.getByRole('status')).toHaveText(
      'Not sent to the live assistant: You can ask the live assistant 2 questions in a row, then one more every 10 minutes. Your next question can go in about 10 minutes.',
    );
    expect((await agentCalls(request)).map((c) => c.question)).toEqual(['First question', 'Second question']);

    // Another browser, being the same person: its own bucket.
    const other = await browser.newContext({ baseURL: WEB_LIVE });
    const otherPage = await other.newPage();
    await become(otherPage, 'Meera Iyer');
    await otherPage.goto('/assistant');
    await expect((await ask(otherPage, 'A question from another visitor')).getByText(LIVE_FOOTNOTE)).toBeVisible();
    await other.close();
    expect(await agentCalls(request)).toHaveLength(3);
  });

  test('28. global: once the day’s cap is used, every visitor gets a clear message and no model call', async ({ page, request }) => {
    const key = `${PREFIX}:global:${quotaDay().day}`;
    await redis.set(key, '100', { EX: 600 }); // as if 100 live questions were asked today
    try {
      await become(page, 'Arjun Rao');
      await page.goto('/assistant');
      const turn = await ask(page, 'How much do I have in total?');
      await expect(turn.getByRole('status')).toContainText("Not sent to the live assistant: The live assistant has answered all 100 of today's questions, the limit that keeps this demo inside Gemini's free quota. It starts again at");
      expect(await agentCalls(request)).toHaveLength(0);
    } finally {
      await redis.del(key);
    }
  });

  test('29. Gemini over its quota: the script answers, labelled, never as if live', async ({ page, request }) => {
    await request.post(`${AGENT}/mode`, { data: { mode: 'quota' } });
    await become(page, 'Meera Iyer');
    await page.goto('/assistant');
    const turn = await ask(page, 'How much do I have in total?');
    await expect(turn.getByRole('note')).toHaveText(FALLBACK_NOTICE.quota);
    await expect(turn.getByRole('note')).toHaveText("Saved/scripted answer: the live assistant is over today's free limit");
    await expect(turn.getByText(SCRIPT_FOOTNOTE)).toBeVisible();
    await expect(turn.getByText(LIVE_FOOTNOTE)).toHaveCount(0);
    await expect(turn.getByText('Verified ✓')).toBeVisible(); // the script's figures are checked too
    await expectAccessible(page);
    expect(await agentCalls(request)).toHaveLength(1); // asked once; it refused
  });
});

test.describe('live mode, an answer code could not confirm', () => {
  test.use({ baseURL: WEB_LIVE });

  test('31. a withheld answer is not labelled "every amount was checked"', async ({ page, request }) => {
    await request.post(`${AGENT}/mode`, { data: { mode: 'unverified' } });
    await become(page, 'Arjun Rao');
    await page.goto('/assistant');
    const turn = await ask(page, 'what did I spend last week?');
    await expect(turn.getByText('Couldn’t verify')).toBeVisible();
    await expect(turn.getByText('The live assistant answered, but code could not confirm the amounts, so the answer was withheld.')).toBeVisible();
    await expect(turn.getByText(LIVE_FOOTNOTE)).toHaveCount(0);
    await expectAccessible(page);
  });
});

test.describe('Redis down', () => {
  test.use({ baseURL: WEB_NO_REDIS });

  test('30. fail safe: every question gets the labelled script, and the agent is never called', async ({ page, request }) => {
    await become(page, 'Kavya Nair');
    await page.goto('/assistant');
    // More questions than the burst of 2: an unreachable limiter must not mean unlimited.
    for (const q of ['How much do I have in total?', 'Did my recent top-ups go through?', 'What did I spend in the last 7 days?', 'Why is my balance lower?']) {
      const turn = await ask(page, q);
      await expect(turn.getByRole('note')).toHaveText(FALLBACK_NOTICE.limiterDown);
      await expect(turn.getByText(SCRIPT_FOOTNOTE)).toBeVisible();
    }
    expect(await agentCalls(request)).toHaveLength(0);
  });
});
