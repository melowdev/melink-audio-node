// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { OggReadStream, resolveIdentifier } from '../src/audio/resolver.js';
import {
  activeFilterNames,
  buildAudioFilterChain,
  SUPPORTED_FILTERS,
} from '../src/audio/filters.js';

const require = createRequire(import.meta.url);
const ffmpegPath = require('ffmpeg-static');
const canRunFfmpeg = Boolean(ffmpegPath && existsSync(ffmpegPath));
const SAMPLE_RATE = 48_000;

function createToneWave(durationSeconds, frequencyAt) {
  const sampleCount = Math.floor(SAMPLE_RATE * durationSeconds);
  const dataLength = sampleCount * 2 * 2;
  const wave = Buffer.alloc(44 + dataLength);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(36 + dataLength, 4);
  wave.write('WAVE', 8);
  wave.write('fmt ', 12);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(2, 22);
  wave.writeUInt32LE(SAMPLE_RATE, 24);
  wave.writeUInt32LE(SAMPLE_RATE * 4, 28);
  wave.writeUInt16LE(4, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(dataLength, 40);

  let phase = 0;
  for (let index = 0; index < sampleCount; index++) {
    const time = index / SAMPLE_RATE;
    const frequency = frequencyAt(time);
    phase += (2 * Math.PI * frequency) / SAMPLE_RATE;
    const sample = Math.round(Math.sin(phase) * 5000);
    const offset = 44 + index * 4;
    wave.writeInt16LE(sample, offset);
    wave.writeInt16LE(sample, offset + 2);
  }
  return wave;
}

async function encodeWithPipeline(sourceFactory, options = {}) {
  const track = resolveIdentifier('https://media.example.net/fixture.wav');
  const stream = new OggReadStream(track, {
    ffmpegPath,
    sourceFactory,
    ...options,
  });
  await stream.start();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.notEqual(stream.process.exitCode, null, 'FFmpeg should exit when its output ends');
  return Buffer.concat(chunks);
}

async function decodeOgg(ogg) {
  const process = spawn(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-f', 's16le',
    '-acodec', 'pcm_s16le',
    '-ar', String(SAMPLE_RATE),
    '-ac', '2',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  let stderr = '';
  process.stdout.on('data', (chunk) => chunks.push(chunk));
  process.stderr.setEncoding('utf8');
  process.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not decode generated Ogg stream: ${stderr}`));
    });
  });
  process.stdin.end(ogg);
  await closed;
  return Buffer.concat(chunks);
}

function estimateFrequency(pcm, startSeconds = 0.1, endSeconds = 0.8) {
  const start = Math.floor(startSeconds * SAMPLE_RATE);
  const end = Math.min(Math.floor(endSeconds * SAMPLE_RATE), pcm.length / 4);
  let crossings = 0;
  let previous = pcm.readInt16LE(start * 4);
  for (let index = start + 1; index < end; index++) {
    const current = pcm.readInt16LE(index * 4);
    if ((previous <= 0 && current > 0) || (previous > 0 && current <= 0)) crossings++;
    previous = current;
  }
  return crossings / (2 * ((end - start) / SAMPLE_RATE));
}

function rms(pcm) {
  let sum = 0;
  const samples = pcm.length / 2;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

test('FFmpeg filter validation exposes only the supported Lavalink filter set', () => {
  assert.deepEqual(SUPPORTED_FILTERS, [
    'volume',
    'equalizer',
    'timescale',
    'karaoke',
    'tremolo',
    'vibrato',
    'lowPass',
    'highPass',
    'rotation',
    'channelMix',
  ]);
  const filters = {
    volume: 0.5,
    equalizer: [{ band: 8, gain: 0.25 }],
    timescale: { speed: 1.2 },
    karaoke: {},
    tremolo: {},
    vibrato: {},
    lowPass: { smoothing: 5000 },
    highPass: { smoothing: 60 },
    rotation: { rotationHz: 0.1 },
    channelMix: { leftToLeft: 1, rightToRight: 1 },
  };
  assert.equal(buildAudioFilterChain(filters).length >= 10, true);
  assert.deepEqual(activeFilterNames(filters), SUPPORTED_FILTERS);
  assert.throws(() => buildAudioFilterChain({ unsupported: {} }), /Unsupported audio filter/);
  assert.throws(() => buildAudioFilterChain({ volume: 10 }), /volume.*from 0 to 5/);
  assert.throws(
    () => buildAudioFilterChain({ equalizer: [{ band: 15, gain: 0.5 }] }),
    /band.*from 0 to 14/,
  );
  assert.throws(
    () => buildAudioFilterChain({ channelMix: { leftToLeft: Number.NaN } }),
    /channelMix.leftToLeft/,
  );
});

test('FFmpeg pipeline applies filters, performs seek, and closes child processes', {
  skip: !canRunFfmpeg,
}, async () => {
  const wave = createToneWave(2.4, (time) => time < 1.2 ? 220 : 880);
  const directory = await mkdtemp(join(tmpdir(), 'melink-audio-pipeline-'));
  const inputPath = join(directory, 'fixture.wav');
  await writeFile(inputPath, wave);
  const sourceFactory = async () => createReadStream(inputPath);
  try {
    const baselineOgg = await encodeWithPipeline(sourceFactory);
    const baselinePcm = await decodeOgg(baselineOgg);
    const seekOgg = await encodeWithPipeline(sourceFactory, { startPositionMs: 1200 });
    const seekPcm = await decodeOgg(seekOgg);
    const filteredOgg = await encodeWithPipeline(sourceFactory, {
      filters: {
        volume: 0.4,
        equalizer: [{ band: 8, gain: 0.25 }],
        timescale: { speed: 1.1 },
        karaoke: { level: 0.8, monoLevel: 0.8 },
        tremolo: { frequency: 2, depth: 0.2 },
        vibrato: { frequency: 2, depth: 0.1 },
        lowPass: { smoothing: 8000 },
        highPass: { smoothing: 50 },
        rotation: { rotationHz: 0.1 },
        channelMix: { leftToLeft: 1, rightToRight: 1 },
      },
    });
    const filteredPcm = await decodeOgg(filteredOgg);

    assert.ok(baselineOgg.length > 1000);
    assert.ok(seekPcm.length < baselinePcm.length * 0.65);
    assert.ok(Math.abs(estimateFrequency(seekPcm) - 880) < 70);
    assert.ok(rms(filteredPcm) < rms(baselinePcm));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('destroying active FFmpeg playback closes its source and child process', {
  skip: !canRunFfmpeg,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'melink-audio-destroy-'));
  const inputPath = join(directory, 'fixture.wav');
  await writeFile(inputPath, createToneWave(30, () => 440));
  let source;
  const stream = new OggReadStream(resolveIdentifier('https://media.example.net/fixture.wav'), {
    ffmpegPath,
    sourceFactory: async () => {
      source = createReadStream(inputPath);
      return source;
    },
  });

  try {
    await stream.start();
    const process = stream.process;
    assert.equal(process.exitCode, null, 'FFmpeg should still be active before destroy');
    const processClosed = once(process, 'close');
    const streamClosed = once(stream, 'close');
    stream.destroy();
    await Promise.all([processClosed, streamClosed]);

    assert.equal(source.destroyed, true);
    assert.equal(process.killed, true);
    assert.ok(process.exitCode !== null || process.signalCode !== null);
  } finally {
    stream.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
