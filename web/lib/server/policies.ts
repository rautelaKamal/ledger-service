import 'server-only';
import excerpts from './policies.json';

// Exact sections of the (fictional) policy documents in agent/policies/, quoted by
// the scripted demo answers. They live in policies.json so that
// scripts/check-policy-excerpts.mjs can fail CI if any of them drifts from the
// file it claims to quote.
export interface PolicyExcerpt {
  /** The document's own title (its first heading). */
  title: string;
  source: string;
  heading: string;
  text: string;
}

export const POLICIES: Record<keyof typeof excerpts, PolicyExcerpt> = excerpts;
