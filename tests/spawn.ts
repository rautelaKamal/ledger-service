import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Run a TypeScript entry point (src/worker/main.ts, src/reconcile/main.ts) as a
 * real child process, the way production runs it: ONE node process.
 *
 * Why not `npx tsx file.ts`? That is three processes (npx -> tsx -> node), and
 * on Linux `npx` does not forward signals: a SIGTERM sent to it kills npx and
 * leaves the real program running as an orphan, which never hears the signal.
 * (That is exactly how CI failed: the orphaned worker kept polling ledger_test
 * and stole the next test's outbox row.) `node --import tsx` loads TypeScript
 * inside a single node process, so the pid we signal IS the program.
 */
export function spawnTs(entry: string, args: string[] = [], env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Resolves when the child exits; `signal` is set if it was killed instead of exiting. */
export function exitOf(child: ChildProcessWithoutNullStreams): Promise<ExitStatus> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

/**
 * Like exitOf, but gives up after `ms` and resolves to 'still running'. A test
 * must never wait on a child without a bound: if the test's own timeout fires
 * first, its `finally` never runs, the child is never killed, and it lives on
 * as an orphan that interferes with later tests.
 */
export function exitWithin(child: ChildProcessWithoutNullStreams, ms: number): Promise<ExitStatus | 'still running'> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<'still running'>((resolve) => {
    timer = setTimeout(() => resolve('still running'), ms);
  });
  return Promise.race([exitOf(child), timeout]).finally(() => clearTimeout(timer));
}

/** A TCP port that was free a moment ago (for child processes that need a fixed PORT). */
export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
