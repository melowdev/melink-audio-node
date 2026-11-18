// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

export class FixedWindowRateLimiter {
  #buckets = new Map();

  constructor({ limit, windowMs, maxBuckets = 10_000 }) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error('Rate limit must be a positive integer');
    }
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new Error('Rate-limit window must be a positive integer');
    }
    if (!Number.isSafeInteger(maxBuckets) || maxBuckets <= 0) {
      throw new Error('Maximum rate-limit bucket count must be a positive integer');
    }
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxBuckets = maxBuckets;
  }

  consume(key, now = Date.now()) {
    if (typeof key !== 'string' || !key) throw new Error('Rate-limit key is required');

    let bucket = this.#buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.#removeExpired(now);
      if (this.#buckets.size >= this.maxBuckets) {
        const resetAt = Math.min(...[...this.#buckets.values()].map((item) => item.resetAt));
        return this.#result(false, 0, resetAt, now);
      }
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.#buckets.set(key, bucket);
    } else {
      this.#buckets.delete(key);
      this.#buckets.set(key, bucket);
    }

    const allowed = bucket.count < this.limit;
    if (allowed) bucket.count++;
    return this.#result(allowed, Math.max(0, this.limit - bucket.count), bucket.resetAt, now);
  }

  #removeExpired(now) {
    for (const [key, bucket] of this.#buckets) {
      if (now >= bucket.resetAt) this.#buckets.delete(key);
    }
  }

  #result(allowed, remaining, resetAt, now) {
    return {
      allowed,
      limit: this.limit,
      remaining,
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }
}
