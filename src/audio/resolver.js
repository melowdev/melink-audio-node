// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { buildAudioFilterChain } from './filters.js';
import { requestPublicResponse } from './safe-http.js';

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

export function decodeTrackUri(track) {
  try {
    const decoded = JSON.parse(Buffer.from(track?.encoded, 'base64url').toString('utf8'));
    return parseMediaUrl(decoded.uri).href;
  } catch {
    throw new Error('Invalid encoded media track');
  }
}

export async function openAudioStream(identifier, { signal } = {}) {
  return requestPublicResponse(parseMediaUrl(identifier), { signal });
}

export class OggReadStream extends Readable {
  constructor(track, {
    startPositionMs = 0,
    filters = {},
    sourceFactory,
    ffmpegPath = FFMPEG_PATH,
    signal,
  } = {}) {
    super({ highWaterMark: 64 * 1024 });
    this.uri = decodeTrackUri(track);
    if (!Number.isSafeInteger(startPositionMs) || startPositionMs < 0) {
      throw new Error('Seek position must be a non-negative integer');
    }
    this.startPositionMs = startPositionMs;
    this.filters = buildAudioFilterChain(filters);
    this.sourceFactory = sourceFactory || ((sourceSignal) =>
      openAudioStream(this.uri, { signal: sourceSignal }));
    this.ffmpegPath = ffmpegPath;
    this.abortController = new AbortController();
    this.externalSignal = signal;
    this.externalAbortHandler = null;
    if (signal) {
      this.externalAbortHandler = () => {
        this.abortController.abort(signal.reason);
      };
      if (signal.aborted) this.externalAbortHandler();
      else signal.addEventListener('abort', this.externalAbortHandler, { once: true });
    }
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
    const source = await this.sourceFactory(this.abortController.signal);
    if (this.destroyed || this.abortController.signal.aborted) {
      source.destroy();
      throw new Error('Audio stream was closed before playback started');
    }

    const ffmpegCommand = this.ffmpegPath && existsSync(this.ffmpegPath)
      ? this.ffmpegPath
      : 'ffmpeg';
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      ...(this.startPositionMs > 0
        ? ['-ss', String(this.startPositionMs / 1000)]
        : []),
      '-vn',
      ...(this.filters.length ? ['-af', this.filters.join(',')] : []),
      '-c:a', 'libopus',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'ogg',
      'pipe:1',
    ];
    const process = spawn(ffmpegCommand, args, { stdio: ['pipe', 'pipe', 'pipe'] });

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
        const startupError = error.code === 'ENOENT'
          ? new Error('FFmpeg was not found; install ffmpeg-static or add ffmpeg to PATH')
          : new Error('FFmpeg could not be started');
        startupError.cause = error;
        startupError.retryable = error.code === 'EAGAIN';
        reject(startupError);
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
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(error || new Error('Audio stream was closed'));
    }
    if (this.externalAbortHandler) {
      this.externalSignal.removeEventListener('abort', this.externalAbortHandler);
    }
    this.source?.destroy();
    this.process?.stdin?.destroy();
    if (this.process && this.process.exitCode === null) {
      this.process.once('close', () => callback(error));
      if (!this.process.killed) this.process.kill();
      return;
    }
    callback(error);
  }
}
