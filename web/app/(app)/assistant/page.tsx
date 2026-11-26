import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Chat } from '@/components/chat';
import { SUGGESTED, assistantMode, liveLimits } from '@/lib/server/assistant';
import { currentPersona } from '@/lib/server/identity';

export const metadata: Metadata = { title: 'Assistant' };

export default async function AssistantPage() {
  const persona = await currentPersona();
  if (!persona) redirect('/');
  const mode = assistantMode();
  const limits = liveLimits();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-4xl font-semibold">Assistant</h1>
        <p className="mt-2 max-w-[62ch] text-ink-soft">
          {mode === 'scripted'
            ? 'Running in demo mode: answers come from a small script over your live data, with no AI model, so they cost nothing. The same citations and checks apply.'
            : `Ask anything about your own money or the service's rules: the live assistant answers, it can only read your own data, and code checks every amount before you see it. It runs on a free quota, so you can ask ${limits.burst} questions in a row, then one more every ${limits.refillMinutes} minute${limits.refillMinutes === 1 ? '' : 's'}, and the whole demo has ${limits.dailyCap} live questions a day. When the live assistant cannot answer, a script does, and the answer says so.`}
        </p>
      </div>
      <Chat suggested={SUGGESTED} />
    </div>
  );
}
