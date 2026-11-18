// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function retryTransient(
  operation,
  {
    maxAttempts = 3,
    initialDelayMs = 250,
    maxDelayMs = 2_000,
    wait = sleep,
    onRetry = () => {},
  } = {},
) {
  if (typeof operation !== 'function') throw new Error('Retry operation must be a function');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('Retry attempts must be a positive integer');
  }

  let delayMs = initialDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!error?.retryable || attempt === maxAttempts) throw error;
      onRetry(error, { attempt: attempt + 1, delayMs });
      await wait(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
  throw new Error('Retry operation ended unexpectedly');
}
