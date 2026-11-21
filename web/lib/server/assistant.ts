import 'server-only';
import { dayLabel } from '@/lib/dates';
import { formatPaise, sumPaise } from '@/lib/money';
import { PERSONAS, type Persona } from '@/lib/personas';
import type { Account, PassbookRow } from '@/lib/types';
import { env } from './env';
import { clientIdOf } from './identity';
import { getAccounts, getPassbook, UpstreamError } from './ledger';
import { POLICIES, type PolicyExcerpt } from './policies';

export interface Citation {
  n: number;
  kind: 'account' | 'transaction' | 'policy';
  title: string;
  lines: string[];
}

export interface AssistantAnswer {
  /** 'scripted': no model; a script answered from live data. 'agent': the real assistant. */
  mode: 'scripted' | 'agent';
  /** Text with [n] markers that point at citations. */
  answer: string;
  /** true / false: checked against the fetched data. null: there was nothing to check (a refusal). */
  verified: boolean | null;
  citations: Citation[];
  /** What it did, in order. null when the assistant does not report its steps. */
  steps: string[] | null;
}

export const SUGGESTED = [
  'How much do I have in total?',
  'Did my recent top-ups go through?',
  'What did I spend in the last 7 days?',
  'What happens if I send the same transfer twice?',
] as const;

const short = (name: string) => name.split(', ').at(-1) ?? name;
const AMOUNT = /₹[\d,]+\.\d{2}/g;

/**
 * Which supported question is this, if any? Deliberately narrow: the script answers
 * only when the question clearly is one of the four it can answer; anything else
 * gets the list (no amounts, nothing to verify), and a question about someone else's
 * money is refused before any data is read: this person can only see their own.
 */
export type Intent = 'total' | 'topups' | 'spent7' | 'duplicates' | { someoneElse: string } | 'unsupported';

export function classify(question: string, self: Persona): Intent {
  const q = question.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
  const has = (re: RegExp) => re.test(q);
  for (const other of PERSONAS.filter((p) => p.key !== self.key)) {
    const n = other.firstName.toLowerCase();
    // "Arjun's balance", or Arjun as the one who has or spends money ("what does
    // Kavya have"), but not Arjun as the other side of the person's own transfer
    // ("send to Arjun": that is their own data, just not a question the script knows).
    const possessive = has(new RegExp(`\\b${n}'s?\\b`)) && !has(new RegExp(`\\b(to|from|with|for) ${n}\\b`));
    const theirMoney = has(new RegExp(`\\b${n}\\b`)) && !has(new RegExp(`\\b(to|from|with|for) ${n}\\b`)) && has(/\b(balance|accounts?|money|savings|has|have|spend|spent|spending|top.?ups?)\b/);
    if (possessive || theirMoney) return { someoneElse: other.name };
  }
  if (has(/\b(someone else|other people|everyone|anybody|somebody)('s)?\b/)) return { someoneElse: 'anyone else' };

  const moneyOut = has(/\b(spen[dt]|spending|sent|send|paid|pay|outgoing)\b/);
  const aboutSomeone = has(/\b(to|at|on|for) (?!the\b|a\b)\w/);
  if (has(/\b(twice|duplicate|double)\b|\bsame (transfer|request|payment)\b/) && has(/\b(send|sent|pay|paid|transfer|request|payment|charged)\b/)) return 'duplicates';
  if (has(/\btop[- ]?ups?\b/) && !moneyOut) return 'topups';
  if (moneyOut && has(/\b(last|past) (7|seven) days\b|\bthis week\b/) && !aboutSomeone) return 'spent7';
  if (!moneyOut && !has(/\b(this|last) (month|year|week)\b|\btop.?up/) && (has(/\b(total|altogether|in all|overall)\b/) || has(/\bhow much (money )?(do i have|have i got|is in my)\b/) || has(/\b(my|what'?s my|what is my) (total )?balances?\b/))) return 'total';
  return 'unsupported';
}

/** The verifier's rule, in plain code: every amount in the answer must be one the script fetched or computed. */
export function verifyAmounts(answer: string, facts: Set<string>): boolean {
  return (answer.match(AMOUNT) ?? []).every((a) => facts.has(a));
}

async function scripted(persona: Persona, question: string): Promise<AssistantAnswer> {
  const intent = classify(question, persona);
  const clientId = clientIdOf(persona);
  const steps: string[] = [];
  const citations: Citation[] = [];
  const facts = new Set<string>();
  const fact = (paise: string | bigint) => {
    const text = formatPaise(paise);
    facts.add(text);
    return text;
  };
  const cite = (c: Omit<Citation, 'n'>) => {
    const n = citations.length + 1;
    citations.push({ ...c, n });
    return `[${n}]`;
  };
  const citePolicy = (p: PolicyExcerpt) => cite({ kind: 'policy', title: `${p.title}: ${p.heading}`, lines: [p.text] });

  const loadAccounts = async (): Promise<Account[]> => {
    const accounts = await getAccounts(clientId);
    steps.push(`Fetched your ${accounts.length === 1 ? 'account' : `${accounts.length} accounts`} from the ledger API.`);
    return accounts;
  };
  const loadRows = async (accounts: Account[]): Promise<Array<PassbookRow & { account: string }>> => {
    const pages = await Promise.all(accounts.map((a) => getPassbook(clientId, a.id, undefined, 100).then((p) => p.transactions.map((r) => ({ ...r, account: short(a.name) })))));
    const rows = pages.flat();
    steps.push(`Read the newest ${rows.length} passbook entries.`);
    return rows;
  };
  const finish = (answer: string): AssistantAnswer => {
    const verified = verifyAmounts(answer, facts);
    const n = (answer.match(AMOUNT) ?? []).length;
    steps.push(`Checked ${n === 1 ? 'the 1 amount' : `${n} amounts`} in the answer against the fetched data: ${verified ? (n === 1 ? 'found' : 'all found') : 'not all found'}.`);
    return { mode: 'scripted', answer, verified, citations, steps };
  };

  const list = SUGGESTED.map((s) => `"${s}"`).join(', ');
  if (typeof intent === 'object') {
    steps.push('The question is about someone else\'s money: refused without reading any data.');
    return {
      mode: 'scripted',
      answer: `I can only see your own accounts, so I cannot tell you anything about ${intent.someoneElse === 'anyone else' ? 'anyone else\'s' : `${intent.someoneElse}'s`} money. Ask about yours, for example: ${list}.`,
      verified: null,
      citations: [],
      steps,
    };
  }

  if (intent === 'duplicates') {
    steps.push('Matched the policy on duplicate payments.');
    return finish(`You cannot pay twice by sending the same request again: the ledger returns the original result instead of moving money a second time${citePolicy(POLICIES.duplicates)}. The Send page lets you try it.`);
  }

  if (intent === 'topups') {
    const accounts = await loadAccounts();
    const rows = (await loadRows(accounts)).filter((r) => r.kind === 'topup' && Date.now() - new Date(r.createdAt).getTime() < 14 * 86_400_000);
    if (rows.length === 0) return finish('You have no top-ups in the last 14 days.');
    // Complete in counts, readable in detail: every top-up is counted by status;
    // the newest few are listed with their sources.
    const SHOWN = 5;
    const count = (s: PassbookRow['status']) => rows.filter((r) => r.status === s).length;
    const tally = [
      count('posted') && `${count('posted')} went through`,
      count('pending') && `${count('pending')} ${count('pending') === 1 ? 'is' : 'are'} still waiting for the bank`,
      count('failed') && `${count('failed')} failed`,
    ].filter(Boolean);
    const parts = rows.slice(0, SHOWN).map((r) => {
      const ref = cite({ kind: 'transaction', title: `Top-up to ${r.account}`, lines: [`${dayLabel(r.createdAt)}, ${r.status}`, `id ${r.id.slice(0, 8)}…`] });
      const word = r.status === 'posted' ? 'went through' : r.status === 'pending' ? 'is still waiting for the bank' : 'failed';
      return `${fact(r.amountPaise)} to ${r.account} on ${dayLabel(r.createdAt)} ${word}${ref}`;
    });
    let answer =
      rows.length === 1
        ? `In the last 14 days you have one top-up: ${parts[0]}.`
        : `In the last 14 days you have ${rows.length} top-ups: ${tally.join(', ')}. ${rows.length > SHOWN ? `The newest ${SHOWN}` : 'They are'}: ${parts.join('; ')}.`;
    if (rows.some((r) => r.status === 'failed')) answer += ` A failed top-up never credited your account; if money left your bank for it, UPI and bank refunds take 1 to 3 business days${citePolicy(POLICIES.refunds)}.`;
    if (rows.some((r) => r.status === 'pending')) answer += ` A pending top-up is not part of your balance until the bank confirms it${citePolicy(POLICIES.pendingTopups)}.`;
    return finish(answer);
  }

  if (intent === 'spent7') {
    const accounts = await loadAccounts();
    const out = (await loadRows(accounts)).filter((r) => r.status === 'posted' && BigInt(r.amountPaise) < 0n && Date.now() - new Date(r.createdAt).getTime() < 7 * 86_400_000);
    if (out.length === 0) return finish('You sent nothing in the last 7 days.');
    const total = -sumPaise(out.map((r) => r.amountPaise));
    steps.push(`Added up ${out.length} outgoing entries in code.`);
    const biggest = [...out].sort((a, b) => (BigInt(a.amountPaise) < BigInt(b.amountPaise) ? -1 : 1)).slice(0, 3);
    const list = biggest.map((r) => {
      const ref = cite({ kind: 'transaction', title: r.counterparty ? `To ${r.counterparty.name}` : 'Transfer', lines: [`${dayLabel(r.createdAt)}, from ${r.account}`, `id ${r.id.slice(0, 8)}…`] });
      return `${fact(-BigInt(r.amountPaise))} to ${r.counterparty?.name ?? 'an account'}${ref}`;
    });
    return finish(`In the last 7 days you sent ${fact(total)} in ${out.length} transfer${out.length === 1 ? '' : 's'}. The largest: ${list.join(', ')}.`);
  }

  if (intent === 'total') {
    const accounts = await loadAccounts();
    const total = sumPaise(accounts.map((a) => a.balancePaise));
    steps.push('Added the balances in code.');
    const parts = accounts.map((a) => `${short(a.name)} ${fact(a.balancePaise)}${cite({ kind: 'account', title: short(a.name), lines: [`balance ${formatPaise(a.balancePaise)}`] })}`);
    const pending = sumPaise(accounts.map((a) => a.pendingTopupsPaise));
    let answer = accounts.length === 1 ? `You have ${fact(total)} in ${parts[0]}.` : `You have ${fact(total)} in total: ${parts.join(' and ')}.`;
    if (pending > 0n) answer += ` Another ${fact(pending)} in top-ups is waiting for the bank and is not in that total${citePolicy(POLICIES.pendingTopups)}.`;
    return finish(answer);
  }

  steps.push('The question is not one of the few this demo script answers: nothing was read.');
  return {
    mode: 'scripted',
    answer: `In this demo the assistant answers only these questions, without a language model: ${list}.`,
    verified: null,
    citations: [],
    steps,
  };
}

async function viaAgent(persona: Persona, question: string): Promise<AssistantAnswer> {
  const res = await fetch(`${env.AGENT_URL}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': clientIdOf(persona) },
    body: JSON.stringify({ question }),
    cache: 'no-store',
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => null)) as { answer?: string; verified?: boolean; citations?: Array<{ type: string; id: string }> } | null;
  if (!res.ok || !body?.answer) throw new UpstreamError(res.status, body, 'assistant');
  const citations: Citation[] = (body.citations ?? []).map((c, i) => ({
    n: i + 1,
    kind: c.type === 'policy' ? 'policy' : 'transaction',
    title: c.type === 'policy' ? `Policy section ${c.id}` : `Transaction ${c.id.slice(0, 8)}…`,
    lines: [`id ${c.id}`],
  }));
  const markers = citations.map((c) => `[${c.n}]`).join(' ');
  return { mode: 'agent', answer: markers ? `${body.answer} ${markers}` : body.answer, verified: body.verified ?? false, citations, steps: null };
}

export function ask(persona: Persona, question: string): Promise<AssistantAnswer> {
  return env.ASSISTANT_MODE === 'agent' ? viaAgent(persona, question) : scripted(persona, question);
}

export const assistantMode = (): 'scripted' | 'agent' => (env.ASSISTANT_MODE === 'agent' ? 'agent' : 'scripted');
