import { NextResponse } from 'next/server';
import { runChaos } from '@/lib/server/chaos';
import { currentPersona } from '@/lib/server/identity';

export const maxDuration = 60;

export async function POST(): Promise<NextResponse> {
  if (!(await currentPersona())) return NextResponse.json({ error: 'pick a demo person first' }, { status: 401 });
  try {
    const result = await runChaos();
    if (!result.ok) {
      return NextResponse.json(
        { error: `The chaos test can run once a minute. Try again in ${result.retryAfterSeconds} s.`, retryAfterSeconds: result.retryAfterSeconds },
        { status: 429 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'the chaos test did not finish' }, { status: 502 });
  }
}
