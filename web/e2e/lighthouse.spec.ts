import { chromium, expect, test } from '@playwright/test';
import lighthouse from 'lighthouse';

// Lighthouse accessibility, every screen, phone and desktop form factors: each
// score must be at least 95. Runs inside Playwright so the whole stack is up;
// uses Playwright's own Chromium (opened with a debugging port Lighthouse drives), signed in as a demo person via the real
// session route (so the pages behind the persona cookie are measured too).
const PAGES = ['/', '/overview', '/send', '/topup', '/assistant', '/system'];
const MIN = 95;
const DEBUG_PORT = 9333;

test('Lighthouse accessibility is at least 95 on every screen', async ({ baseURL }) => {
  test.setTimeout(240_000);
  const res = await fetch(`${baseURL}/api/session`, { method: 'POST', body: new URLSearchParams({ persona: 'meera' }), redirect: 'manual' });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  expect(cookie).toMatch(/^demo_persona=meera\./);

  const browser = await chromium.launch({ args: [`--remote-debugging-port=${DEBUG_PORT}`] });
  const scores: string[] = [];
  const failures: string[] = [];
  try {
    for (const formFactor of ['mobile', 'desktop'] as const) {
      for (const path of PAGES) {
        const result = await lighthouse(
          `${baseURL}${path}`,
          { port: DEBUG_PORT, onlyCategories: ['accessibility'], extraHeaders: { Cookie: cookie! }, logLevel: 'error' },
          {
            extends: 'lighthouse:default',
            settings: {
              formFactor,
              screenEmulation: formFactor === 'desktop' ? { mobile: false, width: 1366, height: 900, deviceScaleFactor: 1, disabled: false } : undefined,
            },
          },
        );
        const lhr = result!.lhr;
        const score = Math.round((lhr.categories.accessibility!.score ?? 0) * 100);
        scores.push(`${formFactor.padEnd(8)} ${path.padEnd(11)} ${score}`);
        if (score < MIN) {
          const failed = Object.values(lhr.audits)
            .filter((a) => a.score === 0)
            .map((a) => a.id);
          failures.push(`${formFactor} ${path}: ${score} (${failed.join(', ')})`);
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`Lighthouse accessibility\n${scores.join('\n')}`);
  expect(failures).toEqual([]);
});
