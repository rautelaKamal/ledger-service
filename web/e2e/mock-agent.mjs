// A stand-in for the assistant service (agent/), for the browser tests: the same
// POST /ask and POST /ask/stream contracts (agent/ledger_agent/api.py), no model, no
// Gemini, no quota. The agent's own tests run its real graph against a fake Gemini;
// these tests are about what the web server does with the agent's answers and refusals.
//
//   POST /ask         answers, or (mode "quota") 503 model_quota, as the agent does when
//                     Gemini refuses on a rate/quota limit
//   POST /ask/stream  the same, as NDJSON: the graph's steps (route, classify, fetch,
//                     answer, check), then {"type": "result", status, body}. With holdMs,
//                     the fetch step stays open that long, so a test can watch it.
//   GET  /calls       every question that reached it, so a test can prove "no model call"
//   POST /mode        {"mode": "answer" | "quota" | "unverified", "holdMs"?: number}
//   POST /reset       forget the calls, back to "answer" and no hold
import { createServer } from 'node:http';

const port = Number(process.env.MOCK_AGENT_PORT ?? 8201);
let mode = 'answer';
let holdMs = 0;
const calls = [];

const read = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the agent would answer in the current mode: [status, body]. */
function reply(question) {
  if (mode === 'unverified') {
    // What the agent sends when its answer failed the check twice (prompts.FALLBACK_TEXT).
    return [
      200,
      {
        answer: "I couldn't verify this answer against your records, so I would rather not state it. Please contact support with your question, or try asking in a different way.",
        verified: false,
        citations: [],
        notes: [],
      },
    ];
  }
  if (mode === 'quota') return [503, { error: { code: 'model_quota', message: 'The assistant is temporarily unavailable. Please try again in a moment.' } }];
  return [200, { answer: `Live answer from the stand-in agent to: ${question}`, verified: true, citations: [], notes: [] }];
}

createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/healthz') return send(200, { status: 'alive' });
  if (req.method === 'GET' && req.url === '/calls') return send(200, { calls });
  if (req.method === 'POST' && req.url === '/mode') {
    const body = await read(req);
    mode = body.mode;
    holdMs = Number(body.holdMs ?? 0);
    return send(200, { mode, holdMs });
  }
  if (req.method === 'POST' && req.url === '/reset') {
    calls.length = 0;
    mode = 'answer';
    holdMs = 0;
    return send(200, {});
  }
  if (req.method === 'POST' && (req.url === '/ask' || req.url === '/ask/stream')) {
    const { question } = await read(req);
    calls.push({ question, clientId: req.headers['x-client-id'] });
    const [status, body] = reply(question);
    if (req.url === '/ask') return send(status, body);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const line = (event) => res.write(`${JSON.stringify(event)}\n`);
    const step = async (name, ms) => {
      line({ type: 'step', step: name, status: 'start' });
      await sleep(ms);
      line({ type: 'step', step: name, status: 'done', seconds: ms / 1000 });
    };
    await step('route', 0);
    if (mode === 'quota') {
      line({ type: 'step', step: 'classify', status: 'start' }); // Gemini refuses during classify
    } else {
      await step('classify', 50);
      await step('fetch', 50 + holdMs);
      await step('answer', 50);
      await step('check', 0);
    }
    line({ type: 'result', status, body });
    return res.end();
  }
  return send(404, { error: 'not found' });
}).listen(port, '127.0.0.1');
