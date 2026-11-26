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

Pending: one manual check by the user, at most 5 real questions, recorded here afterwards.
