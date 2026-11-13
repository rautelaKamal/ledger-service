// The outbox has two LANES, so a payment command never waits behind a
// backlog of notifications (head-of-line blocking, found by the 6a load test):
//
//   commands  provider.*      someone is waiting on these (a top-up needs its payment)
//   events    everything else notifications: at-least-once, unordered, may lag
//
// A worker runs one lane, or 'all'. In 'all' mode every claim tries commands
// FIRST, then events, so even a single loop puts payments ahead of the backlog.
// Running the lanes as separate workers (compose: worker-commands, worker-events)
// goes further: a slow or dead notification sink can never delay a payment.

export type Lane = 'commands' | 'events';
export type LaneSetting = Lane | 'all';

export const LANES: readonly Lane[] = ['commands', 'events'];

/**
 * SQL predicate per lane. Written exactly like the partial indexes in
 * migration 007, so Postgres can use them for the claim query.
 */
export const LANE_PREDICATE: Record<Lane, string> = {
  commands: `type LIKE 'provider.%'`,
  events: `type NOT LIKE 'provider.%'`,
};

export function laneOf(type: string): Lane {
  return type.startsWith('provider.') ? 'commands' : 'events';
}

/** The order a worker in this lane setting tries lanes in. */
export function claimOrder(setting: LaneSetting): readonly Lane[] {
  return setting === 'all' ? LANES : [setting];
}
