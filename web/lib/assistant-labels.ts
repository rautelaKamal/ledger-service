// What the page says when an answer did NOT come from the live assistant. Shared by
// the server (which attaches it), the chat (which shows it above the answer) and the
// browser tests (which check it word for word). A scripted answer is never shown
// without one of these, so it can never pass for a live one.
export const FALLBACK_NOTICE = {
  quota: "Saved/scripted answer: the live assistant is over today's free limit",
  limiterDown: 'Saved/scripted answer: the live assistant is paused because its rate limiter is unavailable',
  notConfigured: 'Saved/scripted answer: the live assistant is not configured on this server',
} as const;

export type FallbackReason = keyof typeof FALLBACK_NOTICE;
