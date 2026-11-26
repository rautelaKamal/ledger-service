# Step 7g, explained: the live assistant on a free quota

Until now the assistant page answered from a small script unless someone switched the web
app to `ASSISTANT_MODE=agent` by hand, and nothing stopped a busy demo from spending the
Gemini quota in minutes. Step 7g turns the live assistant on, inside two limits, and makes
every way it can run out honest:

- free-text questions go to the live agent; the four starter questions stay as clickable
  suggestions and go there too. The 7e features stay off (`AGENT_FEATURES` is not set);
- each visitor has a **token bucket**, and all visitors share a **daily cap** below the free
  limit. Over either: a clear "not sent" message, and no model call;
- when Gemini refuses on its quota, or the limiter cannot be reached, the script answers,
  under a label that says so. A scripted answer is never shown as if it were live.

```
web/lib/server/limits.ts          the two limits: one Lua script in Redis, fail safe
web/lib/server/assistant.ts       live(): limits, then the agent, then the labelled fallbacks
web/lib/assistant-labels.ts       the fallback labels, word for word (server, chat, tests)
web/lib/server/identity.ts        the signed visitor cookie the bucket is keyed on
agent/ledger_agent/llm.py         is_quota_error: 429 / RESOURCE_EXHAUSTED, by type and code
agent/ledger_agent/api.py         a quota refusal is 503 model_quota (not model_unavailable)
k8s/base/redis/                   Redis: no persistence, 48 Mi limit, only web pods may connect
```

## 1. What happens to a question

```
browser ──POST /api/ask──▶ web server (2 replicas)
                             │ 1. Redis: take a token from this visitor's bucket AND one
                             │    from today's global count, atomically (one Lua script)
                             │      over the bucket or the cap ─▶ 429 "Not sent to the live
                             │                                    assistant: ..." (no model call)
                             │      Redis unreachable/silent  ─▶ script, labelled (no model call)
                             │ 2. agent POST /ask (X-Client-Id added here, never by the browser)
                             │      200                       ─▶ the live answer
                             │      503 model_quota           ─▶ script, labelled
                             │      503 model_not_configured  ─▶ script, labelled
                             │      429 (the agent's own 20 per person per day) ─▶ a message
                             ▼      anything else             ─▶ "not answering right now"
```

The labels, exactly as the page shows them above the answer:

| why | label |
|---|---|
| Gemini refused on its rate or quota limit | Saved/scripted answer: the live assistant is over today's free limit |
| Redis could not be reached in 300 ms | Saved/scripted answer: the live assistant is paused because its rate limiter is unavailable |
| the agent has no Gemini key | Saved/scripted answer: the live assistant is not configured on this server |

Under every scripted answer the footnote says "A script answered from your live ledger
data; no AI model was called." A live answer says "Answered by the live assistant; every
amount was checked by code." The script's own figures are still checked against the data it
fetched, so a scripted answer can carry the Verified stamp; the label above it is what
tells the visitor where it came from.

## 2. The limits, and why these numbers

| limit | value | where |
|---|---|---|
| per visitor | 5 questions in a row, then 1 more every 3 minutes | `ASSISTANT_BURST`, `ASSISTANT_REFILL_SECONDS` |
| all visitors | 40 live questions per Gemini quota day | `ASSISTANT_DAILY_CAP` |
| per person (unchanged, the agent's own) | 20 questions per client per 24 hours | agent, Postgres `agent_runs` |

A question costs 2 to 8 model calls (the graph is bounded at 8; the 7e run averaged about
3). Forty questions are therefore at most 320 calls and typically about 130: inside the
free tier's daily limit for `gemini-3.5-flash-lite`, with room left for an eval run on the
same project the same day. The exact free limits are shown per project in AI Studio, not in
Google's docs, so the cap is a setting, not a constant.

**The quota day is Pacific time.** Gemini's free quota resets at midnight in California
(13:30 IST in winter). A cap that reset at midnight IST would let up to twice the cap
through within one quota day. `quotaDay()` keys the counter by the Pacific date, and the
"starts again at" time in the message is that midnight, shown in IST.

**The visitor** is a random id in a signed, http-only cookie (`demo_visitor`), set the first
time a browser asks. It is not the persona: many visitors can be Meera at once, and each has
their own bucket. A visitor who clears their cookies gets a new id and a fresh bucket; the
global cap is what bounds that, which is why it exists.

## 3. Why Redis for the limits

- **Atomic counters with an expiry, in one step.** The bucket (tokens and the time it was
  last refilled) and the day's count are read, checked and updated by one Lua script.
  Redis runs a script to completion before any other command, so two web replicas asking at
  the same instant cannot both take the last token, and a question refused by the cap does
  not cost the visitor a token. The script reads the time from Redis (`TIME`), so replicas
  whose clocks disagree still agree on the bucket. Expiry is built in: the day's counter
  expires an hour after its quota day ends, and an idle bucket expires once it would be full
  again, so nothing needs cleaning up.
- **Shared across replicas.** The web app runs as 2 replicas behind one Service. Counters
  in each process's memory would give every visitor twice the burst and the demo twice the
  cap, and a restart would reset them. Every replica asks the same Redis.
- **Cheap to lose.** Redis here has no persistence at all. If it restarts, the counters
  start from zero: at worst, a few more questions that day, still far below the free limit.
- **Postgres could count, but at a cost.** It would put a write transaction, with a lock on
  one hot row (the day's count), in front of every question, on the database that holds
  the money, for data that has no business being durable.

## 4. Why idempotency stays in Postgres

An idempotency key is part of the money movement, not traffic control. The key, the stored
response and the ledger entries are written in **one Postgres transaction**: either the
transfer happened and its key records it, or neither did. Redis cannot join that
transaction. A key kept in Redis could be written before a transfer that then rolls back
(a replay would return a response for money that never moved), or the transfer could commit
and the key be lost to a restart or an eviction (a replay would move the money a second
time). Losing a rate-limit counter costs a few extra questions; losing an idempotency key
costs someone a double payment. So the two live where their failure is acceptable.

## 5. Fail safe: no limiter means no live answers

`limits.ts` answers `unavailable` whenever Redis cannot be reached or does not answer within
300 ms (`REDIS_TIMEOUT_MS`): connection refused, a server that accepts the connection and
never replies, a full Redis that refuses writes (`noeviction`). Commands sent while
disconnected fail at once (`disableOfflineQueue`); they never wait for Redis to come back.
`unavailable` sends the question to the script, labelled, and the agent is not called. The
only ways to reach the model are through a token that Redis granted.

## 6. Tests (none of them calls Gemini)

| test | what it proves | fails without |
|---|---|---|
| `agent/tests/test_ask_api.py` quota tests (3) | a chat 429 and an embedding 429 become 503 `model_quota` and do not count against the person; text that merely says "429" does not | the agent change (3 failed against the old code) |
| `web/tests/limits.test.ts` (9, `npm run test:unit`, real Redis) | the burst and its refill; the cap across visitors, without spending tokens; 30 concurrent questions: exactly the burst / exactly the cap get through, also from two "replicas"; both kinds of key expire; refused connection and a silent server are `unavailable` within the deadline; the Pacific quota day | `limits.ts` |
| browser test 26 | free text and a suggestion both reach the live agent, labelled live, with the client id added by the server | |
| browser test 27 | after the burst: "Not sent to the live assistant: ...", no call reached the agent; another visitor as the same person still gets answers | the limiter (checked: fails with the limiter removed) |
| browser test 28 | with the day's count at the cap: the cap message, no call reached the agent | the limiter (checked) |
| browser test 29 | Gemini over quota: the label "Saved/scripted answer: the live assistant is over today's free limit", the script's footnote, not the live one | the quota fallback (checked) |
| browser test 30 | Redis unreachable: four questions, more than the burst, all scripted and labelled; the agent is never called | the fail-safe (checked) |

The browser tests run a second and third copy of the web app in live mode, against
`web/e2e/mock-agent.mjs`, a stand-in that speaks the agent's `POST /ask` contract and
records every question it receives (so "no model call" is checked, not assumed). The
agent's own tests run its real graph against a fake Gemini. CI runs Redis as a service; it
has no Gemini key and makes no model call.

## 7. Kubernetes

Redis runs as one pod (`k8s/base/redis/`): `redis:8.10.3-alpine` as the image's non-root
user, read-only root filesystem, no snapshots and no append-only file, `maxmemory 16mb` with
`noeviction` (when full it refuses writes, which the limiter treats as unavailable, rather
than silently dropping a counter). Requests 16 Mi, limit 48 Mi. Its NetworkPolicy admits
only pods labelled `app=web` on 6379 and allows no egress at all; Redis has no password, so
that policy is its door. The web app's own egress policy gained exactly one rule: to Redis
on 6379. `web-config` switches the cluster to `ASSISTANT_MODE: agent` with the limits above;
`AGENT_FEATURES` is still not set anywhere in `k8s/`.

`scripts/k8s/smoke.sh` gained a section, still without any model call: Redis answers PING;
web → Redis allowed; api → Redis and agent → Redis blocked; and with the day's count set to
the cap in Redis, one question through the web app comes back 429 "not sent".

**Measured on kind (26 Nov, after the smoke test):** the node container uses **1.75 GiB of
3.83 GiB** with everything running (api ×2, both workers, agent ×2, web ×2, Redis, Postgres,
the mock provider, Prometheus, Grafana, metrics-server). Redis itself: **8 Mi**. No pod and no
control-plane component restarted. The smoke test passed all 9 sections. With Redis scaled to
0, a question through the web app came back `mode: fallback` with the "rate limiter is
unavailable" label; Redis was then scaled back to 1.

One hiccup, recorded because it will happen again on this laptop: while the cluster started,
the Mac was overloaded (load average 17 on 8 cores, 9 GB of swap in use) and `deploy.sh`'s
wait for the migrate Job timed out although the Job had completed in 28 s, because `kubectl`
calls were not being answered. The pods were all running; re-running `deploy.sh` (it is
idempotent) finished every rollout. During the same start-up burst the HPA scaled the api to
4 replicas and back to 2.

## 8. The live check

### Round 1 (26 Nov, 19:57 IST, as Meera): one question, withheld

"what did I spend last week?" came back after **30.4 s** as the assistant's refusal ("I couldn't
verify this answer..."), with the Couldn't verify badge. Safe, but a common question unanswered.
From the LangSmith trace and the `agent_runs` row:

| step | calls | seconds |
|---|---|---|
| classify | 1 chat | 4.03 |
| fetch | 3 chat; `list_my_accounts`, `list_transactions` × 2 (15 to 21 Nov) | 3.51 + 2.68 + 5.48 model, 0.18 tools |
| answer | 1 chat | 8.10 |
| answer again (the check failed) | 1 chat | 3.89 |
| total | **6 chat calls**, 0 embeddings, 3 tools; 11,162 tokens in, 1,445 out | 30.4 (27.7 of it the model) |

**Why the check failed.** Not a disagreement about dates: the verifier never looks at dates, only
at amounts. Every amount in both answers was a hundred times too large. The tools return paise,
and the model wrote 104200 paise as ₹1,04,200.00 (it is ₹1,042.00) and the Savings account's
total out, 990125 paise, as ₹9,90,125.00. None of those is in the data, so the verifier refused
both answers, correctly. The prompt said "never convert amounts yourself" while giving the model
only paise, so every rupee figure was a conversion. Two more problems sat underneath: the "total
out" included ₹5,912.25 that Meera moved from Savings to her own Current account, which is not
spending; and the model chose the week itself, Sunday 15 to Saturday 21 Nov.

**What changed** (commits 79cd9ea, bbb9563, 80f8497):

- **One meaning, set by code** (`dates.named_period`; weeks run Monday to Sunday, IST). On Thursday
  26 Nov 2026:

  | the question says | the period | dates |
  |---|---|---|
  | yesterday | yesterday | 25 Nov |
  | this week | this_week | Mon 23 Nov to today, 26 Nov |
  | last week, previous week | last_week | Mon 16 Nov to Sun 22 Nov |
  | last 7 days, past seven days, past week | last_7_days | 20 Nov to 26 Nov (today and the 6 days before) |

- **A spending tool.** It resolves the period, sums payments to other people across every
  account in SQL (moves between the client's own accounts and top-ups are not spending), and
  returns `period_text` ("16–22 Nov 2026"). When the question names a period, code reads it
  (`period_named_in`) and the tool refuses any other: the model cannot pick its own week.
- **Rupees written by code.** Every `*_paise` amount in every tool result now comes with its
  `*_inr` twin ("₹1,042.00"), and the prompt says to copy it, never to convert.
- **The checker holds the answer to the same range.** An answer that states a spending total
  must state its `period_text` with it ("From 16–22 Nov 2026 you spent ₹X"); otherwise it goes
  back to the model once, like any other failure.
- **The web wording.** A withheld live answer no longer sits next to "every amount was checked
  by code". It now reads: "The live assistant answered, but code could not confirm the amounts,
  so the answer was withheld."
- **Where the time goes, logged.** Every answered question logs one line with no question text:
  `answered run=… category=… verified=… attempts=… chat_calls=… embed_calls=… tool_calls=…
  total_s=… model_s=… tool_s=… steps=classify:… fetch:… answer:… check:…`.

New tests (`agent/tests/test_spending.py`, 24): the four periods and their edges (a Monday, a
Sunday, across a month and a year); the phrases a question uses, and none or two forcing nothing;
the rupee twins; the range rule (a hyphen is the same range, the model's Sunday-to-Saturday week
is not); the spending query (own-account move and top-up excluded, both accounts counted); and the
whole question for "last week", "this week", "last 7 days" and "yesterday", each answered with
its range and a verified total. Each part was checked to be needed: without the range rule, two
tests fail; without the period enforcement, one; without the rupee twins, five. Browser test 31
and test 5 cover the withheld wording; `test_ask_api` covers the log line.

These change what the model sees for every account question (the `*_inr` fields, a new tool), so
the eval's recorded numbers are from before them. Re-running it costs quota and was not done.

### Round 2 (26 Nov, 20:48 to 20:50 IST, as Meera): 4 questions, all correct and verified

The expected answers were computed first, with plain SQL over the cluster's ledger (payments to
other people, IST calendar days), and the user compared each answer against them:

| question | answer | expected | sources | time | model calls |
|---|---|---|---|---|---|
| what did I spend last week? | From 16–22 Nov 2026 ₹5,081.00 | ₹5,081.00, 4 payments | 4 | 23.8 s | 4 |
| What did I spend in the last 7 days? (typed) | From 20–26 Nov 2026 ₹5,337.50 | ₹5,337.50, 3 payments | 3 | 11.9 s | 4 |
| what did I spend this week? | From 23–26 Nov 2026 ₹2,895.00 | ₹2,895.00, 1 payment | 1 | 17.0 s | 4 |
| what did I spend yesterday? | On 25 Nov 2026 ₹0.00 | nothing | 0 | 8.1 s | 4 |

Every answer took one attempt and one tool call (`spending`), and four model calls: classify, two
rounds in fetch (call the tool, then "done"), and the answer. The model was 90 % or more of every
total. Per step, from the LangSmith traces (seconds):

| question | classify | fetch (model) | tool | answer | total |
|---|---|---|---|---|---|
| last week | 5.99 | 10.01 | 0.23 | 5.46 | 23.80 |
| last 7 days | 2.33 | 7.15 | 0.05 | 1.34 | 11.93 |
| this week | 5.49 | 6.34 | 0.08 | 3.73 | 16.95 |
| yesterday | 3.80 | 2.42 | 0.06 | 1.44 | 8.09 |

The Mac was overloaded at the time (load average 15 to 20, 9.5 GB of swap; the web pods had
restarted at 20:44 when their startup probe timed out), which inflates these numbers. The next
step is to take the model out of the path for these questions (step 7h).

**One more bug, found here.** The per-question timing line (79cd9ea) never reached the pod log:
the agent's logger had no handler and inherited Python's default WARNING level, so every INFO line
was dropped, including the existing "tracing: on" line at start-up. The test had passed because
pytest's log capture raises the level itself. Fixed in dc1cf4e, with a test that starts
from a fresh process's logging state; the times above come from LangSmith instead.
