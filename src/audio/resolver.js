// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const FFMPEG_PATH = require('ffmpeg-static');
const MAX_URL_LENGTH = 4096;

function parseMediaUrl(identifier) {
  let url;
  try {
    url = new URL(identifier);
  } catch {
    throw new Error('Only direct HTTP(S) media URLs are supported');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('The media URL must use HTTP(S) and must not contain credentials');
  }
  if (url.href.length > MAX_URL_LENGTH) throw new Error('The media URL is too long');
  return url;
}

export function resolveIdentifier(identifier) {
  const url = parseMediaUrl(identifier);
  let fileName = url.pathname.split('/').pop() || '';
  try {
    fileName = decodeURIComponent(fileName);
  } catch {
    fileName = '';
  }
  const title = fileName.replace(/\.[^.]+$/, '') || url.hostname;

  return {
    encoded: Buffer.from(JSON.stringify({ uri: url.href })).toString('base64url'),
    info: {
      identifier: url.href,
      title,
      author: '',
      length: 0,
      uri: url.href,
      sourceName: 'direct',
      isSeekable: false,
      isStream: true,
    },
  };
}

function decodeTrackUri(track) {
  try {
    const decoded = JSON.parse(Buffer.from(track?.encoded, 'base64url').toString('utf8'));
    return parseMediaUrl(decoded.uri).href;
  } catch {
    throw new Error('Invalid encoded media track');
  }
}

export async function openAudioStream(identifier) {
  return requestPublicStream(parseMediaUrl(identifier), 3);
}

async function requestPublicStream(url, redirectsLeft) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });

  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Media host must resolve only to public IP addresses');
  }

  const target = addresses[0];
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    let settled = false;
    let headerTimer;
    const req = request(url, {
      headers: { 'user-agent': 'MelinkAudioNode/0.1' },
      lookup: (_host, options, callback) => {
        const result = { address: target.address, family: target.family };
        callback(null, options?.all ? [result] : result.address, result.family);
      },
    }, (response) => {
      clearTimeout(headerTimer);
      response.on('error', () => {
        if (!settled) {
          settled = true;
          reject(new Error('Media stream failed'));
        }
      });

      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft === 0) {
          settled = true;
          reject(new Error('Media URL redirected too many times'));
          return;
        }
        let redirectUrl;
        try {
          redirectUrl = parseMediaUrl(new URL(response.headers.location, url).href);
        } catch {
          settled = true;
          reject(new Error('Media URL redirect is invalid'));
          return;
        }
        requestPublicStream(redirectUrl, redirectsLeft - 1)
          .then((stream) => {
            settled = true;
            resolve(stream);
          }, reject);
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        settled = true;
        reject(new Error(`Media request failed with HTTP ${response.statusCode}`));
        return;
      }

      settled = true;
      resolve(response);
    });

    headerTimer = setTimeout(() => req.destroy(new Error('Media request timed out')), 15_000);
    headerTimer.unref?.();
    req.setTimeout(30_000, () => req.destroy(new Error('Media stream timed out')));
    req.once('error', () => {
      clearTimeout(headerTimer);
      if (!settled) {
        settled = true;
        reject(new Error('Media request failed'));
      }
    });
    req.end();
  });
}

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice(7);
      return isIP(mapped) === 4 && isPublicAddress(mapped);
    }
    const firstSegment = Number.parseInt(normalized.split(':')[0] || '0', 16);
    return firstSegment >= 0x2000 && firstSegment <= 0x3fff &&
      !normalized.startsWith('2001:db8:');
  }
  return false;
}

export class OggReadStream extends Readable {
  constructor(track) {
    super({ highWaterMark: 64 * 1024 });
    this.uri = decodeTrackUri(track);
    this.process = null;
    this.source = null;
    this.startPromise = null;
  }

  _read() {
    this.process?.stdout?.resume();
  }

  start() {
    if (!this.startPromise) this.startPromise = this.#start();
    return this.startPromise;
  }

  async #start() {
    const source = await openAudioStream(this.uri);
    if (this.destroyed) {
      source.destroy();
      throw new Error('Audio stream was closed before playback started');
    }

    const ffmpegCommand = FFMPEG_PATH && existsSync(FFMPEG_PATH) ? FFMPEG_PATH : 'ffmpeg';
    const process = spawn(ffmpegCommand, [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn',
      '-c:a', 'libopus',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'ogg',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.process = process;
    this.source = source;
    let stderr = '';
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    source.once('error', () => process.stdin.destroy(new Error('Media stream failed')));
    source.once('aborted', () => process.stdin.destroy(new Error('Media response was interrupted')));
    process.stdin.once('error', (error) => {
      if (error.code !== 'EPIPE' && !this.destroyed) {
        this.destroy(new Error('Could not send media to FFmpeg'));
      }
    });

    const startup = new Promise((resolve, reject) => {
      let started = false;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        process.kill();
        reject(new Error('FFmpeg did not produce audio before the startup timeout'));
      }, 15_000);
      timer.unref?.();

      process.stdout.on('data', (chunk) => {
        if (!this.destroyed && !this.push(chunk)) process.stdout.pause();
        if (!started) {
          started = true;
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });

      process.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error.code === 'ENOENT'
          ? new Error('FFmpeg was not found; install ffmpeg-static or add ffmpeg to PATH')
          : new Error('FFmpeg could not be started'));
      });

      process.once('close', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`FFmpeg exited before producing audio (code ${code ?? 'unknown'}): ${stderr.trim()}`));
        } else if (code !== 0 && !this.destroyed) {
          this.destroy(new Error(`FFmpeg exited with code ${code ?? 'unknown'}: ${stderr.trim()}`));
        } else if (!this.destroyed) {
          this.push(null);
        }
      });

      source.pipe(process.stdin);
    });

    try {
      await startup;
    } catch (error) {
      this.destroy();
      throw error;
    }
    return this;
  }

  _destroy(error, callback) {
    this.source?.destroy();
    if (this.process && this.process.exitCode === null && !this.process.killed) {
      this.process.kill();
    }
    callback(error);
  }
}
