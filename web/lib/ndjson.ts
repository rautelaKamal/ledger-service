// Newline-delimited JSON, read as it arrives: the agent's POST /ask/stream and this
// app's /api/ask (when asked for it) send one JSON value per line, step by step.
// Used by the web server (reading the agent) and by the browser (reading /api/ask).

export const NDJSON = 'application/x-ndjson';

/** One step of the assistant's work, as the agent reports it (agent/ledger_agent/api.py, ask_stream). */
export interface StepEvent {
  type: 'step';
  step: string;
  status: 'start' | 'done';
  seconds?: number;
}

/** The last line: the HTTP status and body the non-streaming endpoint would have sent. */
export interface ResultEvent {
  type: 'result';
  status: number;
  body: unknown;
}

export type StreamEvent = StepEvent | ResultEvent;

/** Every complete line of the stream, parsed. A line split across chunks is joined; blank lines are skipped. */
export async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffered.split('\n');
      buffered = done ? '' : (lines.pop() ?? '');
      for (const line of lines) if (line.trim()) yield JSON.parse(line);
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

export function isStepEvent(value: unknown): value is StepEvent {
  const v = value as Partial<StepEvent> | null;
  return v?.type === 'step' && typeof v.step === 'string' && (v.status === 'start' || v.status === 'done');
}

export function isResultEvent(value: unknown): value is ResultEvent {
  const v = value as Partial<ResultEvent> | null;
  return v?.type === 'result' && typeof v.status === 'number';
}
