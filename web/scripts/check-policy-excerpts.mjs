// Fails when a policy excerpt quoted by the web demo (lib/server/policies.json)
// is not, word for word, in the section of agent/policies/<source> it names.
//   node scripts/check-policy-excerpts.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const excerpts = JSON.parse(readFileSync(join(here, '../lib/server/policies.json'), 'utf8'));
const squash = (s) => s.replace(/\s+/g, ' ').trim();
let bad = 0;
for (const [key, e] of Object.entries(excerpts)) {
  const md = readFileSync(join(here, '../../agent/policies', e.source), 'utf8');
  const title = /^# (.+)$/m.exec(md)?.[1]?.trim();
  const section = md.split(/^## /m).find((s) => s.startsWith(`${e.heading}\n`));
  const problems = [];
  if (title !== e.title) problems.push(`title is "${title}", not "${e.title}"`);
  if (!section) problems.push(`no section "## ${e.heading}"`);
  else if (!squash(section).includes(squash(e.text))) problems.push('the text is not in that section, word for word');
  if (problems.length) {
    bad++;
    console.error(`${key} (${e.source}): ${problems.join('; ')}`);
  }
}
if (bad) process.exit(1);
console.log(`${Object.keys(excerpts).length} policy excerpts match agent/policies word for word`);
