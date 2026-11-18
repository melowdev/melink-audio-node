// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const IPV4_SPECIAL_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const IPV6_SPECIAL_RANGES = [
  ['2000::', 16],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
];

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function networkError(message, { statusCode, retryable = false, cause } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  if (statusCode !== undefined) error.statusCode = statusCode;
  error.retryable = retryable;
  return error;
}

function ipv4ToBigInt(address) {
  return address.split('.').reduce(
    (result, octet) => (result << 8n) | BigInt(Number(octet)),
    0n,
  );
}

function ipv6ToBigInt(address) {
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const ipv4 = ipv4ToBigInt(value.slice(lastColon + 1));
    value = `${value.slice(0, lastColon + 1)}${(ipv4 >> 16n).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
  }

  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  const segments = halves.length === 1
    ? left
    : [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  return segments.reduce(
    (result, segment) => (result << 16n) | BigInt(Number.parseInt(segment || '0', 16)),
    0n,
  );
}

function inRange(address, network, prefixLength, family) {
  const toBigInt = family === 4 ? ipv4ToBigInt : ipv6ToBigInt;
  const bitLength = family === 4 ? 32n : 128n;
  const prefix = BigInt(prefixLength);
  const shift = bitLength - prefix;
  return (toBigInt(address) >> shift) === (toBigInt(network) >> shift);
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    return !IPV4_SPECIAL_RANGES.some(([network, prefix]) =>
      inRange(address, network, prefix, 4));
  }
  if (family !== 6) return false;

  const normalized = address.toLowerCase();
  const value = ipv6ToBigInt(normalized);
  const mappedPrefix = 0xffffn;
  if (value >> 32n === mappedPrefix) {
    const mapped = [
      Number((value >> 24n) & 0xffn),
      Number((value >> 16n) & 0xffn),
      Number((value >> 8n) & 0xffn),
      Number(value & 0xffn),
    ].join('.');
    return isPublicAddress(mapped);
  }

  const globalUnicast = inRange(normalized, '2000::', 3, 6);
  return globalUnicast && !IPV6_SPECIAL_RANGES.some(([network, prefix]) =>
    inRange(normalized, network, prefix, 6));
}

function parseHttpUrl(input) {
  let url;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new Error('URL must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('URL must use HTTP(S) and must not contain credentials');
  }
  return url;
}

function validateAllowedHost(url, allowedHosts) {
  if (!allowedHosts) return;
  if (url.protocol !== 'https:') {
    throw new Error('Allowed provider URLs must use HTTPS');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!allowedHosts.has(hostname)) {
    throw new Error('URL host is not an allowed provider host');
  }
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error('Request was aborted'), { name: 'AbortError' });
}

async function awaitWithAbortAndTimeout(promise, signal, timeoutMs) {
  let timer;
  let abortHandler;
  const racers = [promise];
  if (signal) {
    racers.push(new Promise((_, reject) => {
      abortHandler = () => reject(abortError(signal));
      if (signal.aborted) abortHandler();
      else signal.addEventListener('abort', abortHandler, { once: true });
    }));
  }
  racers.push(new Promise((_, reject) => {
    timer = setTimeout(() => reject(networkError('Media host lookup timed out', {
      retryable: true,
      cause: Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEDOUT' }),
    })), timeoutMs);
    timer.unref?.();
  }));
  try {
    return await Promise.race(racers);
  } finally {
    clearTimeout(timer);
    if (abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}

async function resolvePublicTarget(hostname, signal) {
  const normalized = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  let addresses;
  try {
    addresses = isIP(normalized)
      ? [{ address: normalized, family: isIP(normalized) }]
      : await awaitWithAbortAndTimeout(
        lookup(normalized, { all: true, verbatim: true }),
        signal,
        10_000,
      );
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw networkError('Media host lookup failed', {
      retryable: ['EAI_AGAIN', 'ETIMEDOUT'].includes(error.code),
      cause: error,
    });
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Media host must resolve only to public IP addresses');
  }
  return addresses[0];
}

export async function requestPublicResponse(input, {
  headers = {},
  signal,
  redirectsLeft = 3,
  allowedHosts,
} = {}) {
  const url = parseHttpUrl(input);
  validateAllowedHost(url, allowedHosts);
  if (signal?.aborted) throw abortError(signal);
  const target = await resolvePublicTarget(url.hostname, signal);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    let settled = false;
    let headerTimer;
    let req;
    const abortHandler = signal ? () => req?.destroy(abortError(signal)) : null;
    const cleanup = () => {
      clearTimeout(headerTimer);
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
    };
    req = request(url, {
      headers: { 'user-agent': 'MelinkAudioNode/0.1', ...headers },
      lookup: (_host, options, callback) => {
        const result = { address: target.address, family: target.family };
        callback(null, options?.all ? [result] : result.address, result.family);
      },
    }, (response) => {
      clearTimeout(headerTimer);
      if (REDIRECT_CODES.has(response.statusCode)) {
        const location = response.headers.location;
        response.resume();
        cleanup();
        if (!location) {
          settled = true;
          reject(new Error('Media redirect did not include a location'));
          return;
        }
        if (redirectsLeft <= 0) {
          settled = true;
          reject(new Error('Media URL redirected too many times'));
          return;
        }
        let redirectUrl;
        try {
          redirectUrl = resolveRedirectUrl(url, location, allowedHosts);
        } catch {
          settled = true;
          reject(new Error('Media URL redirect is invalid or not allowed'));
          return;
        }
        requestPublicResponse(redirectUrl, {
          headers,
          signal,
          redirectsLeft: redirectsLeft - 1,
          allowedHosts,
        }).then((redirectResponse) => {
          settled = true;
          resolve(redirectResponse);
        }, (error) => {
          settled = true;
          reject(error);
        });
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        cleanup();
        settled = true;
        reject(networkError(`Media request failed with HTTP ${response.statusCode}`, {
          statusCode: response.statusCode,
          retryable: response.statusCode === 408 || response.statusCode >= 500,
        }));
        return;
      }

      if (signal?.aborted) {
        abortHandler();
        response.destroy(abortError(signal));
        cleanup();
        settled = true;
        reject(abortError(signal));
        return;
      }
      response.once('end', cleanup);
      response.once('close', cleanup);
      settled = true;
      resolve(response);
    });

    headerTimer = setTimeout(() => {
      req.destroy(networkError('Media request timed out', {
        retryable: true,
        cause: Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }),
      }));
    }, 15_000);
    headerTimer.unref?.();
    req.setTimeout(30_000, () => {
      req.destroy(networkError('Media stream timed out', {
        retryable: true,
        cause: Object.assign(new Error('Stream timed out'), { code: 'ETIMEDOUT' }),
      }));
    });
    if (signal) {
      if (signal.aborted) abortHandler();
      else signal.addEventListener('abort', abortHandler, { once: true });
    }
    req.once('error', (error) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    req.end();
  });
}

export function resolveRedirectUrl(currentUrl, location, allowedHosts) {
  const sourceUrl = parseHttpUrl(currentUrl);
  const redirectUrl = parseHttpUrl(new URL(location, sourceUrl));
  if (sourceUrl.protocol === 'https:' && redirectUrl.protocol !== 'https:') {
    throw new Error('HTTPS redirects must not downgrade to HTTP');
  }
  validateAllowedHost(redirectUrl, allowedHosts);
  return redirectUrl;
}
