import { NextResponse } from 'next/server';
import { getSystemStatus } from '@/lib/server/ledger';

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await getSystemStatus());
  } catch {
    return NextResponse.json({ error: 'the ledger’s internal port did not answer' }, { status: 502 });
  }
}
