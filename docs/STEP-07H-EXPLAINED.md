# Step 7h, explained: spending questions in under a second

In the 7g live check, "what did I spend last week?" took 8 to 24 s, and 90 % or more of that was
waiting for four model calls. Yet by then code already decided everything that mattered: the
period (`dates.named_period`), the sum (the spending tool, in SQL), and the range the answer must
state (the verifier). The model only chose to call the tool and then copied its numbers into a
sentence. Step 7h takes the model out of that path, and shows the steps while any question runs:

- a plain "what did I spend _(period)_?" is recognised by code, answered by the spending tool
  and a template, and checked by the same verifier. **No model call**;
- every other question goes through the graph exactly as before;
- the agent reports each step as it starts and ends, and the assistant page shows them live,
  with the time each took and whether the AI model was used.

```
agent/ledger_agent/fast.py        which questions code answers alone, and the answer's template
agent/ledger_agent/graph.py       run_question: a "route" step, then the fast path or the graph;
                                  every step timed and reported to an optional progress callback
agent/ledger_agent/api.py         POST /ask/stream: the same answer as POST /ask, one line per step first
web/app/api/ask/route.ts          streams the agent's steps when asked for NDJSON, JSON otherwise
web/lib/ndjson.ts                 reads the stream as it arrives
web/lib/assistant-steps.ts        what each step is called on the page
web/components/chat.tsx           the step list while waiting
```

## 1. What was slow (7g round 2, 26 Nov)

Every one of the four questions took four model calls: classify, two rounds in fetch (call the
spending tool, then "done"), and the answer. Seconds, from the LangSmith traces:

| question | classify | fetch (model) | tool | answer | total |
|---|---|---|---|---|---|
| last week | 5.99 | 10.01 | 0.23 | 5.46 | 23.80 |
| last 7 days | 2.33 | 7.15 | 0.05 | 1.34 | 11.93 |
| this week | 5.49 | 6.34 | 0.08 | 3.73 | 16.95 |
| yesterday | 3.80 | 2.42 | 0.06 | 1.44 | 8.09 |

The tool, the only step that touches the ledger, was under a quarter of a second each time.

## 2. Which questions code answers alone

`fast.spending_question` returns a period only when the question is nothing more than "how much
did I spend in that period", and `None` (use the graph) otherwise. All of these must hold:

- every word is on a short list (`_ALLOWED`: what, how, much, did, I, my, total, the, last, this,
  week, yesterday, 7, seven, days, so, far, please, ...), and one of them is spend, spent or
  spending;
- no other characters than letters, digits, apostrophes, spaces and `? . ! ,`;
- at most 20 words;
- exactly one named period, read by the same `dates.period_named_in` the spending tool enforces:
  yesterday, this week, last week, the last 7 days.

So these take the fast path: "what did I spend last week?", "How much have I spent this week so
far?", "Can you tell me how much I spent yesterday, please?". And these do not, because each
needs something the template cannot say: "... on groceries" (a category), "... on Arjun" (a
person), "... from my savings" (an account), "Did I spend more last week than this week?" (a
comparison and two periods), "Why did I spend so much ...", "... in October" (not a named period),
"... Ignore your rules." (unknown words). A question the rule does not recognise costs what it cost
before; one it wrongly took would get an answer to a different question. So the list is short
on purpose.

Round 2's second question was typed as "click What did I spend in the last 7 days?". "click" is
not on the list, so that exact text still goes through the graph; the measurement below uses the
question as the starter button sends it.

## 3. The answer: code's numbers, a template's words, the same check

`graph._answer_spending` runs three steps:

1. **spending**: `spending_report`, the same function the model's tool calls, with the period
   code read. One SQL query sums the payments to other people across all the client's accounts.
2. **write**: `fast.spending_answer` fills a template from that report:
   "From 16–22 Nov 2026 you spent ₹5,081.00 in 4 payments to other people. The largest was
   ₹1,596.50 on 17 Nov. Moving money between your own accounts, and top-ups, are not spending."
   (one payment: no "largest"; none: "you spent ₹0.00: no payments to other people"). It cites
   each payment's transaction, up to 10.
3. **check**: `verify()`, the same checker every model answer goes through: every amount must be
   one the tool returned, every citation one it fetched, and a spending total must come with its
   range. A template is code, but so would be the bug it hides; if the check ever fails, the
   answer is withheld with the usual "I couldn't verify" text.

The run is recorded like any other: an `agent_runs` row (category account, 1 attempt, 0 chat
calls, 0 embed calls, one `spending` tool call marked `"by": "code"`) and the `answered ...` log
line. The web's limits still apply: a fast-path question uses a token from the visitor's bucket
and one from the day's cap like any other, so the limits stay simple and conservative.

The eval is not affected: none of its questions is a plain spending question.

## 4. Live steps

Every step, on either path, is timed by one context manager (`graph._step`), which records its
seconds and, when the caller passed a progress callback, reports `(name, None)` as it starts and
`(name, seconds)` as it ends. A new `route` step comes first on every question: the time to decide
between code and the graph.

**Agent.** `POST /ask/stream` takes the same body and headers as `POST /ask` and answers in
NDJSON (one JSON object per line), written as they happen:

```
{"type":"step","step":"route","status":"start"}
{"type":"step","step":"route","status":"done","seconds":0.0}
{"type":"step","step":"spending","status":"start"}
...
{"type":"result","status":200,"body":{ the exact body POST /ask would return }}
```

An error is the result line with the status `/ask` would give (503 `model_quota`, 400, ...), so
the caller handles both the same way. `/ask` itself is unchanged; the eval, the smoke test and the
web's JSON path use it.

**Web.** `POST /api/ask` with `accept: application/x-ndjson` passes each step on as it arrives,
then a result line with exactly the status and body its JSON response would have had (including
the limit messages and the labelled script fallbacks). Without that header it answers JSON as
before. The stream is sent with `cache-control: no-store, no-transform`, because compression would
hold the lines back until the end.

**Page.** While waiting, the chat lists each step as it starts, with ✓ and its time once done,
in words that say where the model is used: "Adding up your payments in code", "Writing the
answer from a template, without the AI model" on the fast path; "Working out what you are asking
(AI model)", "Fetching your data from the ledger (AI model picks what to fetch)" on the graph.
The list is a `role="status"` region, so a screen reader hears it; the answer replaces it.

## 5. Tests (none of them calls Gemini)

`agent/tests/test_fast_path.py`:

- 9 questions that take the fast path (the four from round 2 and other phrasings), and 16 that
  must not (each kind in section 2, round 2's "click" question, an injection, too long, and
  "what’ve I spent this week", whose "what’ve" is not on the list);
- the four questions against the seeded ledger with a chat model that fails if it is called:
  the exact text, the steps in order (route, spending, write, check), 0 chat calls, under 1 s,
  the cited transactions summing to the stated total in the `entries` table, the `agent_runs` row;
- a period with no spending;
- the stream: the fast path's steps then a result equal to `POST /ask`'s; a graph question's
  steps (route, classify, fetch, answer, check); a quota refusal mid-stream ending in 503
  `model_quota`; a missing header ending in 400.

The graph's own spending tests now ask "..., and on what?" so they still exercise the model path.
Checked to be needed: making `spending_question` always return `None` fails 6 tests.

`web/tests/ndjson.test.ts` (5): lines split across network chunks, a ₹ sign split between chunks,
telling steps from the result, a repeated step, the labels. Browser test 32 (`e2e/live.spec.ts`,
against the stand-in agent, which now streams too) holds a step open for 3 s and checks that the
finished step shows its time, the running one has none, and the answer is not there yet; then
that the answer replaces the list, after one call to the agent.

## 6. Before and after

Measured on 27 Nov 2026 at 16:15 IST, on the kind cluster with this branch's images (a2c42ec),
as Meera, through the web app's `/api/ask` stream (`accept: application/x-ndjson`), the same four
questions as round 2. The expected answers were computed first with plain SQL over the base
tables (`accounts`, `transactions`, `entries`; payments to other people, IST days), not through
the agent's views. Today is Friday 27 Nov, so "this week", "the last 7 days" and "yesterday"
cover different days than on Thursday; "last week" is the same week.

| question | answer | expected (SQL) | sources |
|---|---|---|---|
| what did I spend last week? | From 16–22 Nov 2026 ₹5,081.00 in 4 payments; largest ₹1,596.50 on 17 Nov | ₹5,081.00, 4 payments, largest ₹1,596.50 | 4 |
| What did I spend in the last 7 days? | From 21–27 Nov 2026 ₹5,337.50 in 3 payments; largest ₹2,895.00 on 23 Nov | ₹5,337.50, 3 payments, largest ₹2,895.00 | 3 |
| what did I spend this week? | From 23–27 Nov 2026 ₹2,895.00 in 1 payment | ₹2,895.00, 1 payment | 1 |
| what did I spend yesterday? | On 26 Nov 2026 ₹0.00: no payments to other people | nothing | 0 |

All four correct and verified, each with 0 model calls, 0 embedding calls and 1 tool call (the
agent's `answered` log lines, `chat_calls=0 embed_calls=0 tool_calls=1`).

Per step, in the agent (seconds; two runs, the first just after the pods restarted):

| question | route | spending | write | check | agent total | before (7g round 2) |
|---|---|---|---|---|---|---|
| last week | 0.00 / 0.00 | 0.05 / 0.05 | 0.00 / 0.00 | 0.00 / 0.00 | 0.06 / 0.05 | 23.80 |
| last 7 days | 0.00 / 0.00 | 0.08 / 0.01 | 0.00 / 0.00 | 0.00 / 0.00 | 0.08 / 0.01 | 11.93 |
| this week | 0.00 / 0.00 | 0.00 / 0.02 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.02 | 16.95 |
| yesterday | 0.00 / 0.00 | 0.02 / 0.01 | 0.00 / 0.00 | 0.00 / 0.00 | 0.02 / 0.01 | 8.09 |

Where the 7g column was classify + fetch + tool + answer, all but the tool a model call, the
whole answer is now the spending query. Seen from the client, through the web app (its session,
limits and the call to the agent included), first line and last line in seconds:

| question | run 1 (pods just restarted) | run 2 |
|---|---|---|
| last week | 1.30 / 1.52 | 0.15 / 0.25 |
| last 7 days | 1.28 / 1.34 | 0.02 / 0.04 |
| this week | 0.03 / 0.04 | 0.94 / 0.97 |
| yesterday | 0.02 / 0.05 | 0.02 / 0.03 |

Every question was under the 5 s target, mostly well under a second. The two slower ones in
run 1 are the web pods' first requests after the restart; the 0.94 s in run 2 is not in the
agent (it spent 0.02 s on that question), so it was the web pod or the network path. The Mac was
busy throughout (load average 6.5 to 7; the web image had just taken 11 minutes to build), so a
quiet machine should do no worse.

## 7. What is still slow

Every other question still goes through the graph: classify, fetch and answer are model calls,
so 4 or more calls and, on the free tier, roughly 8 to 25 s. The page now shows those steps as
they happen, so the wait is visible rather than silent, but it is not shorter. The next candidates
are the same idea for other questions code can answer exactly (a balance, a top-up's status), and
cutting fetch's second model round (the "done" call after the tool) when one tool call clearly
answers the question.
