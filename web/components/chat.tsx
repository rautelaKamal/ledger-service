'use client';

import { useId, useRef, useState } from 'react';
import { Stamp } from '@/components/stamp';
import { Button } from '@/components/ui/button';
import type { AssistantAnswer, Citation } from '@/lib/server/assistant';
import { cn } from '@/lib/utils';

type Turn = { id: number; question: string } & ({ state: 'waiting' } | { state: 'done'; answer: AssistantAnswer } | { state: 'error'; message: string });

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
        <AnswerText text={answer.answer} prefix={prefix} />
        <div className="flex flex-wrap items-center gap-3">
          {answer.verified === true ? <Stamp land>Verified ✓</Stamp> : null}
          {answer.verified === false ? (
            <span className="rounded-sm border border-failed px-2 py-0.5 text-failed">Couldn&rsquo;t verify</span>
          ) : null}
          <span className="text-sm text-ink-soft">
            {answer.mode === 'scripted' ? 'Demo mode: a script answered from your live ledger data; no AI model was called.' : 'Answered by the assistant; every amount was checked by code.'}
          </span>
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
    setTurns((t) => [...t, { id, question: text, state: 'waiting' }]);
    setQuestion('');
    try {
      const res = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: text }) });
      const body = (await res.json()) as AssistantAnswer | { error: string };
      setTurns((t) =>
        t.map((x) => (x.id !== id ? x : 'error' in body || !res.ok ? { id, question: text, state: 'error', message: 'error' in body ? body.error : `status ${res.status}` } : { id, question: text, state: 'done', answer: body })),
      );
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
              {turn.state === 'waiting' ? <p className="text-ink-soft">Fetching your data and checking every amount…</p> : null}
              {turn.state === 'error' ? (
                <p role="alert" className="border-l-2 border-failed pl-3 text-failed">
                  No answer: {turn.message}.
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
