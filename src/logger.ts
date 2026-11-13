import { pino, type DestinationStream, type Logger } from 'pino';
import { currentRequestId } from './context.js';

// JSON logs, one object per line, on stdout. Docker / Kubernetes collect stdout.
//
// Rules for what we log (see STEP-06A-EXPLAINED):
//   * every line written inside a request or an outbox row carries request_id
//   * never secrets, never the Provider-Signature header, never raw webhook bodies
// The `redact` list below is a SAFETY NET for mistakes; the primary rule is
// simply not to pass those values to the logger in the first place.

const REDACT_PATHS = [
  'password',
  'secret',
  'webhookSecret',
  'signature',
  'rawBody',
  'raw_body',
  'headers.authorization',
  'headers["provider-signature"]',
  'headers.cookie',
  '*.password',
  '*.secret',
  '*.webhookSecret',
  '*.signature',
  '*.rawBody',
  '*.raw_body',
];

export function createLogger(options: { level?: string; service?: string } = {}, destination?: DestinationStream): Logger {
  return pino(
    {
      level: options.level ?? process.env.LOG_LEVEL ?? 'info',
      base: { service: options.service ?? process.env.SERVICE_NAME ?? 'ledger' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      // Added to every line: the request id of the work in progress, if any.
      mixin() {
        const requestId = currentRequestId();
        return requestId ? { request_id: requestId } : {};
      },
    },
    destination,
  );
}

/**
 * The process-wide logger. A live binding: tests swap it with useLogger() to
 * capture lines, and every module that imported `logger` sees the new one.
 */
export let logger: Logger = createLogger();

export function useLogger(next: Logger): Logger {
  const previous = logger;
  logger = next;
  return previous;
}
