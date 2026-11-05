import type { Pool } from '../db.js';

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amountPaise: bigint;
  note?: string;
}

export interface TransferResult {
  transactionId: string;
}

export class InvalidAmountError extends Error {
  override name = 'InvalidAmountError';
}

export class SameAccountError extends Error {
  override name = 'SameAccountError';
}

export class CurrencyMismatchError extends Error {
  override name = 'CurrencyMismatchError';
}

export class AccountNotFoundError extends Error {
  override name = 'AccountNotFoundError';
}

export class InsufficientFundsError extends Error {
  override name = 'InsufficientFundsError';
}

export async function transfer(pool: Pool, input: TransferInput): Promise<TransferResult> {
  throw new Error('not implemented: Kamal writes this');
}
