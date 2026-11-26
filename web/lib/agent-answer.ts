import type { AssistantAnswer, Citation } from '@/lib/server/assistant';

/** The agent's POST /ask body (agent/ledger_agent/api.py, AskResponse). */
export interface AgentBody {
  answer: string;
  verified?: boolean;
  citations?: Array<{ type: string; id: string }>;
  /** Cited transactions' notes, read from the ledger by the agent's code, never written by the model. */
  notes?: Array<{ transaction_id: string; text: string }>;
}

/**
 * The agent's answer as the chat shows it: numbered sources, and on a cited transaction its note,
 * in full, as quoted user text (the chat renders it as text, so nothing in it can become markup).
 * The model never has to repeat a note, and the agent refuses an answer that copies a long one.
 */
export function fromAgentBody(body: AgentBody): AssistantAnswer {
  const notes = new Map((body.notes ?? []).map((n) => [n.transaction_id.toLowerCase(), n.text]));
  const citations: Citation[] = (body.citations ?? []).map((c, i) => {
    const note = c.type === 'transaction' ? notes.get(c.id.toLowerCase()) : undefined;
    return {
      n: i + 1,
      kind: c.type === 'policy' ? 'policy' : 'transaction',
      title: c.type === 'policy' ? `Policy section ${c.id}` : `Transaction ${c.id.slice(0, 8)}…`,
      lines: [`id ${c.id}`],
      ...(note === undefined ? {} : { quote: note }),
    };
  });
  const markers = citations.map((c) => `[${c.n}]`).join(' ');
  return { mode: 'agent', answer: markers ? `${body.answer} ${markers}` : body.answer, verified: body.verified ?? false, citations, steps: null };
}
