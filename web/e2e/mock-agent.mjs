// A stand-in for the assistant service (agent/), for the browser tests: the same
// POST /ask contract (agent/ledger_agent/api.py), no model, no Gemini, no quota.
// The agent's own tests run its real graph against a fake Gemini; these tests are
// about what the web server does with the agent's answers and refusals.
//
//   POST /ask     answers, or (mode "quota") 503 model_quota, as the agent does when
//                 Gemini refuses on a rate/quota limit
//   GET  /calls   every question that reached it, so a test can prove "no model call"
//   POST /mode    {"mode": "answer" | "quota" | "unverified"}
//   POST /reset   forget the calls, back to "answer"
import { createServer } from 'node:http';

const port = Number(process.env.MOCK_AGENT_PORT ?? 8201);
let mode = 'answer';
const calls = [];

const read = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });

createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/healthz') return send(200, { status: 'alive' });
  if (req.method === 'GET' && req.url === '/calls') return send(200, { calls });
  if (req.method === 'POST' && req.url === '/mode') return send(200, { mode: (mode = (await read(req)).mode) });
  if (req.method === 'POST' && req.url === '/reset') {
    calls.length = 0;
    mode = 'answer';
    return send(200, {});
  }
  if (req.method === 'POST' && req.url === '/ask') {
    const { question } = await read(req);
    calls.push({ question, clientId: req.headers['x-client-id'] });
    if (mode === 'unverified') {
      // What the agent sends when its answer failed the check twice (prompts.FALLBACK_TEXT).
      return send(200, {
        answer: "I couldn't verify this answer against your records, so I would rather not state it. Please contact support with your question, or try asking in a different way.",
        verified: false,
        citations: [],
        notes: [],
      });
    }
    if (mode === 'quota') {
      return send(503, { error: { code: 'model_quota', message: 'The assistant is temporarily unavailable. Please try again in a moment.' } });
    }
    return send(200, { answer: `Live answer from the stand-in agent to: ${question}`, verified: true, citations: [], notes: [] });
  }
  return send(404, { error: 'not found' });
}).listen(port, '127.0.0.1');
