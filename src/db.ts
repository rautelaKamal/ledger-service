import pg from 'pg';

// ── How we read BIGINT (money) from Postgres ──────────────────────────────
// Postgres BIGINT ("int8", type id 20) can hold up to 9.2 * 10^18.
// A JS `number` is exact only up to 2^53 (~9.0 * 10^15); beyond that it
// silently rounds. node-postgres therefore returns int8 as a *string* by default.
//
// We go one step further and parse int8 into a JS `bigint`:
//   * arithmetic is exact integer math: 100n + 50n === 150n
//     (with strings, "100" + "50" === "10050")
//   * TypeScript refuses to mix bigint with number, so a float can't sneak in
//   * JSON.stringify(10n) throws, which forces us to decide explicitly how
//     money is serialised in API responses (we will send it as a string).
//
// Note: SUM(bigint) returns NUMERIC, which node-postgres returns as a string.
// Cast it in SQL (SUM(x)::bigint) when you want a bigint back.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => BigInt(value));

export function createPool(connectionString: string, options: { max?: number } = {}): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    // Fail instead of waiting forever when every connection is busy.
    connectionTimeoutMillis: 10_000,
  });
}

export type { Pool, PoolClient } from 'pg';
