import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export async function become(page: Page, name: 'Meera Iyer' | 'Arjun Rao' | 'Kavya Nair'): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page).toHaveURL(/\/overview$/);
}

/** WCAG 2.2 A/AA rules, the whole page. */
export async function expectAccessible(page: Page): Promise<void> {
  // Let running animations finish first: text caught mid-fade (the stamp lands
  // from opacity 0) is semi-transparent, and axe would report its contrast.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  // @axe-core/playwright types `page` with its own peer copy of playwright-core (1.65.1);
  // @playwright/test brings 1.65.0. Same API, different type identity: bridge it here.
  const options = { page } as unknown as ConstructorParameters<typeof AxeBuilder>[0];
  const results = await new AxeBuilder(options).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

/** "₹1,24,560.50" -> 12456050n */
export function paiseOf(text: string): bigint {
  const m = /(−|-)?₹([\d,]+)\.(\d{2})/.exec(text);
  if (!m) throw new Error(`no amount in "${text}"`);
  const v = BigInt(m[2]!.replace(/,/g, '')) * 100n + BigInt(m[3]!);
  return m[1] ? -v : v;
}

export async function totalBalance(page: Page): Promise<bigint> {
  await page.goto('/overview');
  return paiseOf((await page.locator('#balance-heading + p').innerText()).trim());
}

/** The label of the first <option> whose text starts with `prefix` (labels carry balances that change). */
export async function optionStartingWith(page: Page, prefix: string): Promise<string> {
  const labels = await page.locator('option').allInnerTexts();
  const found = labels.find((l) => l.startsWith(prefix));
  if (!found) throw new Error(`no option starting with "${prefix}"`);
  return found;
}
