// The live assistant's progress: reading the NDJSON stream as it arrives, and the steps it shows.
//   npm run test:unit
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isResultEvent, isStepEvent, readNdjson } from '../lib/ndjson.ts';
import { applyStep, stepLabel } from '../lib/assistant-steps.ts';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function all(chunks: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const v of readNdjson(streamOf(chunks))) out.push(v);
  return out;
}

test('lines split across chunks are joined, blank lines skipped, the last line may lack its newline', async () => {
  assert.deepEqual(await all(['{"type":"st', 'ep","step":"route","status":"start"}\n\n{"a":', '1}\n{"b":"₹1,853.00"}']), [
    { type: 'step', step: 'route', status: 'start' },
    { a: 1 },
    { b: '₹1,853.00' },
  ]);
});

test('a multi-byte character split between chunks survives', async () => {
  const bytes = new TextEncoder().encode('{"t":"₹"}\n');
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.slice(0, 7)); // in the middle of the rupee sign
      c.enqueue(bytes.slice(7));
      c.close();
    },
  });
  const out: unknown[] = [];
  for await (const v of readNdjson(stream)) out.push(v);
  assert.deepEqual(out, [{ t: '₹' }]);
});

test('steps and the result are told apart; anything else is neither', () => {
  assert.ok(isStepEvent({ type: 'step', step: 'classify', status: 'done', seconds: 2.31 }));
  assert.ok(isResultEvent({ type: 'result', status: 503, body: { error: { code: 'model_quota' } } }));
  assert.ok(!isStepEvent({ type: 'step', step: 'classify', status: 'maybe' }));
  assert.ok(!isResultEvent({ type: 'result', status: '200' }));
  assert.ok(!isStepEvent(null) && !isResultEvent('text'));
});

test('each step shows once it starts and gets its time when it ends; a repeated step shows again', () => {
  let steps = applyStep([], { step: 'answer', status: 'start' });
  steps = applyStep(steps, { step: 'answer', status: 'done', seconds: 3.7 });
  steps = applyStep(steps, { step: 'check', status: 'start' });
  steps = applyStep(steps, { step: 'check', status: 'done', seconds: 0.01 });
  steps = applyStep(steps, { step: 'answer', status: 'start' }); // the verifier sent it back once
  assert.deepEqual(steps, [{ step: 'answer', seconds: 3.7 }, { step: 'check', seconds: 0.01 }, { step: 'answer' }]);
  steps = applyStep(steps, { step: 'answer', status: 'done', seconds: 2.0 });
  assert.deepEqual(steps.at(-1), { step: 'answer', seconds: 2.0 });
});

test('the fast path says it used no AI model; the graph says where it did', () => {
  assert.match(stepLabel('write'), /without the AI model/);
  assert.match(stepLabel('classify'), /\(AI model\)/);
  assert.equal(stepLabel('something new'), 'something new'); // an unknown step still shows, by its name
});
