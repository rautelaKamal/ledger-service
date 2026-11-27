// What each of the live assistant's steps is called on the page, while it works.
// The names are the agent's (agent/ledger_agent/graph.py): `route` decides whether code
// can answer alone (fast.py); the graph's steps call the AI model, the fast path's do not.

export const STEP_LABEL: Record<string, string> = {
  route: 'Reading your question',
  spending: 'Adding up your payments in code',
  write: 'Writing the answer from a template, without the AI model',
  classify: 'Working out what you are asking (AI model)',
  fetch: 'Fetching your data from the ledger (AI model picks what to fetch)',
  retrieve: 'Searching the service’s policies',
  answer: 'Writing the answer (AI model)',
  check: 'Checking every amount against your ledger',
  refuse: 'Declining: the question is not about your own money or the service’s rules',
};

export const stepLabel = (step: string): string => STEP_LABEL[step] ?? step;

export interface LiveStep {
  step: string;
  /** Seconds once the step has finished; undefined while it runs. */
  seconds?: number;
}

/** Steps in the order they started; a repeated step (a second answer, check) is shown again. */
export function applyStep(steps: LiveStep[], event: { step: string; status: 'start' | 'done'; seconds?: number }): LiveStep[] {
  if (event.status === 'start') return [...steps, { step: event.step }];
  const i = steps.findLastIndex((s) => s.step === event.step && s.seconds === undefined);
  if (i === -1) return [...steps, { step: event.step, seconds: event.seconds ?? 0 }];
  return steps.map((s, j) => (j === i ? { ...s, seconds: event.seconds ?? 0 } : s));
}
