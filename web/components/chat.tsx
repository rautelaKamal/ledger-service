'use client';

import { useId, useRef, useState } from 'react';
import { Stamp } from '@/components/stamp';
import { Button } from '@/components/ui/button';
import type { AssistantAnswer, Citation } from '@/lib/server/assistant';
import { applyStep, stepLabel, type LiveStep } from '@/lib/assistant-steps';
import { isResultEvent, isStepEvent, NDJSON, readNdjson } from '@/lib/ndjson';
import { cn } from '@/lib/utils';

type Turn = { id: number; question: string } & (
  // steps: the live assistant's, as they happen (empty for the script, which answers at once)
  | { state: 'waiting'; steps: LiveStep[] }
  | { state: 'done'; answer: AssistantAnswer }
  | { state: 'error'; message: string }
  // Over a limit: the question was never sent to the model. Not a failure of the service.
  | { state: 'limited'; message: string }
);

const FOOTNOTE: Record<AssistantAnswer['mode'], string> = {
  scripted: 'Demo mode: a script answered from your live ledger data; no AI model was called.',
  agent: 'Answered by the live assistant; every amount was checked by code.',
  fallback: 'A script answered from your live ledger data; no AI model was called.',
};
// The live assistant's answer failed the check twice, so the agent sent its refusal instead.
// "Every amount was checked" would read as if the withheld answer had passed.
export const WITHHELD = 'The live assistant answered, but code could not confirm the amounts, so the answer was withheld.';

function footnote(answer: AssistantAnswer): string {
  return answer.mode === 'agent' && answer.verified === false ? WITHHELD : FOOTNOTE[answer.mode];
}

type Reply = AssistantAnswer | { error: string; limited?: boolean };

const KIND: Record<Citation['kind'], string> = { account: 'Account', transaction: 'Transaction', policy: 'Policy' };

/** Answer text with its [n] markers turned into links to the numbered source cards. */
function AnswerText({ text, prefix }: { text: string; prefix: string }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <p className="max-w-[65ch] text-lg leading-relaxed">
      {parts.map((part, i) => {
        const m = /^\[(\d+)\]$/.exec(part);
        return m ? (
          <a key={i} href={`#${prefix}-${m[1]}`} className="ml-0.5 rounded-sm px-0.5 align-baseline text-base font-medium text-stamp underline underline-offset-2" aria-label={`source ${m[1]}`}>
            [{m[1]}]
          </a>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </p>
  );
}

function Answer({ turn, answer }: { turn: Turn; answer: AssistantAnswer }) {
  const prefix = `t${turn.id}-src`;
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_17rem]">
      <div className="flex flex-col gap-3">
        {answer.mode === 'fallback' && answer.notice ? (
          <p role="note" className="border-l-4 border-pending bg-surface py-1.5 pl-3 font-medium">
            {answer.notice}
          </p>
        ) : null}
        <AnswerText text={answer.answer} prefix={prefix} />
        <div className="flex flex-wrap items-center gap-3">
          {answer.verified === true ? <Stamp land>Verified ✓</Stamp> : null}
          {answer.verified === false ? (
            <span className="rounded-sm border border-failed px-2 py-0.5 text-failed">Couldn&rsquo;t verify</span>
          ) : null}
          <span className="text-sm text-ink-soft">{footnote(answer)}</span>
        </div>
        {answer.steps ? (
          <details>
            <summary className="cursor-pointer text-ink-soft hover:text-ink">How it answered</summary>
            <ol className="mt-2 list-decimal pl-6 text-ink-soft">
              {answer.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </details>
        ) : (
          <p className="text-sm text-ink-soft">This assistant version does not report its steps.</p>
        )}
      </div>
      {answer.citations.length ? (
        <aside aria-label="Sources" className="flex flex-col gap-2">
          {answer.citations.map((c) => (
            <div key={c.n} id={`${prefix}-${c.n}`} className="scroll-mt-24 border-l-2 border-stamp bg-surface py-1.5 pr-2 pl-3 target:bg-accent">
              <p className="text-sm text-ink-soft">
                [{c.n}] {KIND[c.kind]}
              </p>
              <p className="font-medium">{c.title}</p>
              {c.lines.map((l, i) => (
                <p key={i} className={cn('text-sm', c.kind === 'policy' ? 'text-ink' : 'break-all text-ink-soft')}>
                  {l}
                </p>
              ))}
              {c.quote !== undefined ? (
                <figure className="mt-1">
                  <figcaption className="text-sm text-ink-soft">Note, as it was typed</figcaption>
                  <blockquote className="border-l-2 border-rule pl-2 text-sm whitespace-pre-wrap break-words text-ink">{c.quote}</blockquote>
                </figure>
              ) : null}
            </div>
          ))}
        </aside>
      ) : null}
    </div>
  );
}

/** The live assistant at work: each step as it starts, with its time once it is done. */
function Progress({ steps }: { steps: LiveStep[] }) {
  return (
    <div role="status" className="flex flex-col gap-1 text-ink-soft">
      <p>Fetching your data and checking every amount…</p>
      {steps.length ? (
        <ol aria-label="Steps so far" className="flex flex-col gap-0.5 pl-1 text-sm">
          {steps.map((s, i) => (
            <li key={i} className={cn('flex gap-2', s.seconds === undefined ? 'text-ink' : '')}>
              <span aria-hidden="true" className="w-4 shrink-0 text-center">
                {s.seconds === undefined ? '…' : '✓'}
              </span>
              <span>
                {stepLabel(s.step)}
                {s.seconds === undefined ? null : <span className="tabular-nums"> ({s.seconds.toFixed(1)} s)</span>}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function Chat({ suggested }: { suggested: readonly string[] }) {
  const ids = useId();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const next = useRef(1);
  const busy = turns.some((t) => t.state === 'waiting');

  async function ask(q: string): Promise<void> {
    const text = q.trim();
    if (!text || busy) return;
    const id = next.current++;
    setTurns((t) => [...t, { id, question: text, state: 'waiting', steps: [] }]);
    setQuestion('');
    try {
      const res = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json', accept: `${NDJSON}, application/json` }, body: JSON.stringify({ question: text }) });
      let status = res.status;
      let body: Reply | null = null;
      if (res.body && res.headers.get('content-type')?.startsWith(NDJSON)) {
        for await (const event of readNdjson(res.body)) {
          if (isStepEvent(event)) setTurns((t) => t.map((x) => (x.id === id && x.state === 'waiting' ? { ...x, steps: applyStep(x.steps, event) } : x)));
          else if (isResultEvent(event)) [status, body] = [event.status, event.body as Reply | null];
        }
      } else {
        body = (await res.json()) as Reply;
      }
      const reply = body as Reply | null; // assigned in the loop above: TypeScript cannot follow that into turn()
      const turn = (): Turn => {
        const body = reply;
        if (!body) return { id, question: text, state: 'error', message: 'the answer was cut off' };
        if ('error' in body) return body.limited ? { id, question: text, state: 'limited', message: body.error } : { id, question: text, state: 'error', message: body.error };
        if (status !== 200) return { id, question: text, state: 'error', message: `status ${status}` };
        return { id, question: text, state: 'done', answer: body };
      };
      setTurns((t) => t.map((x) => (x.id !== id ? x : turn())));
    } catch {
      setTurns((t) => t.map((x) => (x.id === id ? { id, question: text, state: 'error', message: 'the web server did not answer' } : x)));
    }
  }

  return (
    <div className="flex max-w-5xl flex-col gap-8">
      {turns.length === 0 ? (
        <p className="text-ink-soft">Ask about your own money or the service&rsquo;s rules. Every amount in an answer is checked against your ledger before you see it.</p>
      ) : (
        <ol className="flex flex-col gap-10" aria-live="polite">
          {turns.map((turn) => (
            <li key={turn.id} className="flex flex-col gap-3 border-t border-rule pt-5">
              <p className="font-medium">
                <span className="sr-only">You asked: </span>
                {turn.question}
              </p>
              {turn.state === 'waiting' ? <Progress steps={turn.steps} /> : null}
              {turn.state === 'error' ? (
                <p role="alert" className="border-l-2 border-failed pl-3 text-failed">
                  No answer: {turn.message}.
                </p>
              ) : null}
              {turn.state === 'limited' ? (
                <p role="status" className="border-l-4 border-pending pl-3">
                  Not sent to the live assistant: {turn.message}.
                </p>
              ) : null}
              {turn.state === 'done' ? <Answer turn={turn} answer={turn.answer} /> : null}
            </li>
          ))}
        </ol>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
        className="flex flex-col gap-3 border-t-2 border-ink pt-4"
      >
        <label htmlFor={`${ids}-q`} className="font-medium">
          Ask about your money
        </label>
        <div className="flex gap-2">
          <input
            id={`${ids}-q`}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={500}
            placeholder="Did my recent top-ups go through?"
            className="min-w-0 flex-1 rounded-md border border-input bg-surface px-3 py-2"
          />
          <Button type="submit" disabled={busy || !question.trim()}>
            Ask
          </Button>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Suggested questions">
          {suggested.map((s) => (
            <button key={s} type="button" onClick={() => void ask(s)} disabled={busy} className="rounded-full border border-rule px-3 py-1 text-sm hover:border-ink disabled:opacity-60">
              {s}
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
