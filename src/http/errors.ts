import {
  AccountNotFoundError,
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidAmountError,
  SameAccountError,
} from '../ledger/transfer.js';

/** The JSON shape of every error response from this API. */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}

/**
 * Map a business error thrown by transfer() to an HTTP status and error code.
 * Returns null for anything else (an unexpected error, which becomes a 500).
 */
export function mapBusinessError(err: unknown): { status: number; body: ErrorBody } | null {
  // Unreachable over HTTP (the body schema only accepts positive integers),
  // kept so transfer() stays fully mapped if another caller ever appears.
  if (err instanceof InvalidAmountError) return { status: 400, body: errorBody('invalid_amount', err.message) };
  if (err instanceof SameAccountError) return { status: 400, body: errorBody('same_account', err.message) };
  if (err instanceof AccountNotFoundError) return { status: 404, body: errorBody('account_not_found', err.message) };
  if (err instanceof CurrencyMismatchError) return { status: 422, body: errorBody('currency_mismatch', err.message) };
  if (err instanceof InsufficientFundsError) return { status: 422, body: errorBody('insufficient_funds', err.message) };
  return null;
}
