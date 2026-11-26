import 'server-only';
import { dayLabel } from '@/lib/dates';
import { formatPaise, sumPaise } from '@/lib/money';
import { PERSONAS, type Persona } from '@/lib/personas';
import type { Account, PassbookRow } from '@/lib/types';
import { fromAgentBody, type AgentBody } from '@/lib/agent-answer';
import { FALLBACK_NOTICE, type FallbackReason } from '@/lib/assistant-labels';
import { env } from './env';
import { clientIdOf } from './identity';
import { redisLimiter, type Limiter } from './limits';
import { getAccounts, getPassbook, UpstreamError } from './ledger';
import { POLICIES, type PolicyExcerpt } from './policies';

export interface Citation {
  n: number;
  kind: 'account' | 'transaction' | 'policy';
  title: string;
  lines: string[];
  /** A cited transaction's note, from the ledger: shown in full as quoted user text, never as markup. */
  quote?: string;
}

export interface AssistantAnswer {
  /**
   * 'scripted': demo mode, no model; a script answered from live data.
   * 'agent': the live assistant.
   * 'fallback': the live assistant was asked for but could not be used (over the free
   * quota, or its rate limiter is down), so the script answered; `notice` says so.
   */
  mode: 'scripted' | 'agent' | 'fallback';
  /** Shown above a fallback answer, word for word (FALLBACK_NOTICE). */
  notice?: string;
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
  const body = (await res.json().catch(() => null)) as Partial<AgentBody> | null;
  if (!res.ok || !body?.answer) throw new UpstreamError(res.status, body, 'assistant');
  return fromAgentBody({ ...body, answer: body.answer });
}

/** What /api/ask sends back: an answer, or a clear reason why the question was not sent. */
export type AskOutcome = { kind: 'answer'; answer: AssistantAnswer } | { kind: 'limited'; message: string };

let limiter: Limiter | undefined;
function theLimiter(): Limiter {
  limiter ??= redisLimiter(
    env.REDIS_URL,
    { burst: env.ASSISTANT_BURST, refillMs: env.ASSISTANT_REFILL_SECONDS * 1000, dailyCap: env.ASSISTANT_DAILY_CAP, timeoutMs: env.REDIS_TIMEOUT_MS },
    env.ASSISTANT_REDIS_PREFIX,
  );
  return limiter;
}

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const istTime = (ms: number) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + ms));

async function fallback(persona: Persona, question: string, reason: FallbackReason): Promise<AskOutcome> {
  const answer = await scripted(persona, question);
  return { kind: 'answer', answer: { ...answer, mode: 'fallback', notice: FALLBACK_NOTICE[reason] } };
}

/**
 * The live assistant, inside its limits. In order:
 *   1. the visitor's bucket and the global daily cap (Redis, atomic). Over either: a
 *      clear message and no model call. Redis unreachable: the script answers, labelled.
 *   2. the agent. Over Gemini's quota (503 model_quota) or not configured: the script
 *      answers, labelled. The agent's own per-person daily limit (429): a message.
 *      Anything else is an error, as before.
 */
async function live(persona: Persona, visitor: string, question: string): Promise<AskOutcome> {
  const decision = await theLimiter().take(visitor);
  if (!decision.ok) {
    if (decision.reason === 'unavailable') return fallback(persona, question, 'limiterDown');
    if (decision.reason === 'visitor') {
      return {
        kind: 'limited',
        message: `You can ask the live assistant ${plural(env.ASSISTANT_BURST, 'question')} in a row, then one more every ${plural(minutes(env.ASSISTANT_REFILL_SECONDS * 1000), 'minute')}. Your next question can go in about ${plural(minutes(decision.retryAfterMs), 'minute')}`,
      };
    }
    return {
      kind: 'limited',
      message: `The live assistant has answered all ${env.ASSISTANT_DAILY_CAP} of today's questions, the limit that keeps this demo inside Gemini's free quota. It starts again at ${istTime(decision.resetsInMs)} IST`,
    };
  }
  try {
    return { kind: 'answer', answer: await viaAgent(persona, question) };
  } catch (err) {
    if (!(err instanceof UpstreamError) || err.service !== 'assistant') throw err;
    const code = (err.body as { error?: { code?: string } } | null)?.error?.code;
    if (err.status === 503 && code === 'model_quota') return fallback(persona, question, 'quota');
    if (err.status === 503 && code === 'model_not_configured') return fallback(persona, question, 'notConfigured');
    if (err.status === 429) return { kind: 'limited', message: 'The assistant’s daily limit for this person is reached; try tomorrow' };
    throw err;
  }
}

export async function ask(persona: Persona, visitor: string, question: string): Promise<AskOutcome> {
  if (env.ASSISTANT_MODE === 'agent') return live(persona, visitor, question);
  return { kind: 'answer', answer: await scripted(persona, question) };
}

/** What the page tells the visitor about the limits before they ask. */
export const liveLimits = () => ({ burst: env.ASSISTANT_BURST, refillMinutes: minutes(env.ASSISTANT_REFILL_SECONDS * 1000), dailyCap: env.ASSISTANT_DAILY_CAP });

export const assistantMode = (): 'scripted' | 'agent' => (env.ASSISTANT_MODE === 'agent' ? 'agent' : 'scripted');
