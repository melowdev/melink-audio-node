// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { requestPublicResponse } from '../src/audio/safe-http.js';

const execFileAsync = promisify(execFile);
const TEST_GUILD_ID = process.env.DISCORD_GUILD_ID;
const TEST_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID;
const SECOND_GUILD_ID = process.env.DISCORD_SECOND_GUILD_ID;
const SECOND_CHANNEL_ID = process.env.DISCORD_SECOND_VOICE_CHANNEL_ID;
const HAS_SECOND_TEST_GUILD =
  /^\d{15,22}$/.test(SECOND_GUILD_ID || '') &&
  /^\d{15,22}$/.test(SECOND_CHANNEL_ID || '');
const TEST_AUDIO_URL = process.env.AUDIO_NODE_TEST_AUDIO_URL;
const SECOND_AUDIO_URL = process.env.AUDIO_NODE_TEST_SECOND_AUDIO_URL;
const BAD_AUDIO_URL = process.env.AUDIO_NODE_TEST_BAD_AUDIO_URL;
const CORRUPT_AUDIO_URL = process.env.AUDIO_NODE_TEST_CORRUPT_AUDIO_URL;
const LONG_AUDIO_URL = process.env.AUDIO_NODE_LONG_AUDIO_URL;
const BASE_URL = process.env.AUDIO_NODE_URL;
const NODE_TOKEN = process.env.AUDIO_NODE_TOKEN;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const QUICK_MODE = process.argv.includes('--quick');
const CONFIRMATION = 'I_CONTROL_THIS_TEST_GUILD_AND_TEST_NODE';
const STRESS_DURATION_MS = 30 * 60 * 1000;
const TEST_TIMEOUT_MS = 60_000;

const CORE_TESTS = [
  'Discord Gateway connection',
  'Test audio source reachability preflight',
  'Audio Node session and WebSocket authentication',
  'Controlled voice channel is empty and bot permissions are adequate',
  'Voice channel connection readiness',
  'Pending stream cancellation on destroy',
  'FFmpeg output reaches Audio Player',
  'AudioResource and AudioPlayer playing state',
  'TrackStartEvent',
  'Pause and resume',
  'Volume change',
  'Track replacement and TrackEndEvent',
  'Stop and TrackEndEvent',
  'Natural TrackEndEvent',
  'Voice disconnect and rejoin',
  'Source failure and player recovery',
  'Corrupt audio and player recovery',
  'Unexpected FFmpeg process termination and recovery',
  'Unexpected Discord voice transport loss',
  'Rapid track replacement',
  'Player destroy and recreation',
  'FFmpeg process cleanup',
  'Two-guild playback isolation',
  '30-minute playback and resource monitoring',
  'Discord outgoing packet verification',
  'Human audible-output confirmation',
];

const results = [];

function record(test, status, detail) {
  results.push({ test, status, detail });
}

function summarize() {
  return {
    PASS: results.filter(({ status }) => status === 'PASS').length,
    FAIL: results.filter(({ status }) => status === 'FAIL').length,
    BLOCKED: results.filter(({ status }) => status === 'BLOCKED').length,
    SKIP: results.filter(({ status }) => status === 'SKIP').length,
  };
}

function printReport(extra = {}) {
  process.stdout.write(`${JSON.stringify({
    report: 'Melink Audio Node live playback validation',
    results,
    summary: summarize(),
    ...extra,
  }, null, 2)}\n`);
}

function requiredEnvironment() {
  const required = [
    'DISCORD_BOT_TOKEN',
    'DISCORD_GUILD_ID',
    'DISCORD_VOICE_CHANNEL_ID',
    'AUDIO_NODE_URL',
    'AUDIO_NODE_TOKEN',
    'AUDIO_NODE_TEST_AUDIO_URL',
  ];
  return required.filter((name) => !process.env[name]?.trim());
}

function isLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function validateEnvironment() {
  const baseUrl = new URL(BASE_URL);
  if (!['http:', 'https:'].includes(baseUrl.protocol) ||
      baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('AUDIO_NODE_URL must be an origin without credentials or query values');
  }
  if (baseUrl.pathname !== '/') {
    throw new Error('AUDIO_NODE_URL must be an origin without a path');
  }
  if (baseUrl.protocol !== 'https:' && !isLoopback(baseUrl.hostname)) {
    throw new Error('AUDIO_NODE_URL must use HTTPS unless it targets loopback');
  }
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '') || '/';
  if (!/^\d{15,22}$/.test(TEST_GUILD_ID) ||
      !/^\d{15,22}$/.test(TEST_CHANNEL_ID)) {
    throw new Error('Primary test guild and channel IDs must be Discord snowflakes');
  }
  validateHttpsUrl('AUDIO_NODE_TEST_AUDIO_URL', TEST_AUDIO_URL);
  return baseUrl;
}

function validateHttpsUrl(name, value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${name} must be an HTTPS URL without embedded credentials`);
  }
  return url;
}

async function probeTestAudioSource() {
  const response = await requestPublicResponse(TEST_AUDIO_URL, {
    headers: { range: 'bytes=0-0' },
    signal: AbortSignal.timeout(10_000),
  });
  try {
    for await (const chunk of response) {
      if (chunk.length > 0) {
        return 'HTTPS media bytes were reachable from the test runner; node-host reachability is verified only during playback';
      }
    }
  } finally {
    response.destroy();
  }
  throw new Error('Test audio URL returned no media bytes');
}

function safeFailureName(error) {
  const name = typeof error?.name === 'string' ? error.name : 'Error';
  return /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(name) ? name : 'Error';
}

async function runTest(test, action) {
  try {
    const detail = await action();
    record(test, 'PASS', detail || 'Completed and verified');
    return true;
  } catch (error) {
    record(test, 'FAIL', `Failed (${safeFailureName(error)}); sensitive error details omitted`);
    return false;
  }
}

async function waitUntil(check, timeoutMs = TEST_TIMEOUT_MS, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error('Timed out while waiting for a test condition');
}

class EventInbox {
  #events = [];
  #waiters = new Set();
  #sequence = 0;

  push(packet) {
    const entry = { ...packet, sequence: ++this.#sequence };
    this.#events.push(entry);
    if (this.#events.length > 200) this.#events.shift();
    for (const waiter of this.#waiters) {
      if (entry.sequence > waiter.after && waiter.matches(entry)) {
        this.#waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(entry);
      }
    }
  }

  mark() {
    return this.#sequence;
  }

  wait(matches, after = this.#sequence, timeoutMs = TEST_TIMEOUT_MS) {
    const found = this.#events.find((event) =>
      event.sequence > after && matches(event));
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = {
        after,
        matches,
        resolve,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error('Timed out waiting for a Discord playback event'));
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.#waiters.add(waiter);
    });
  }

  close() {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Live test is shutting down'));
    }
    this.#waiters.clear();
  }
}

function createApi(baseUrl, session) {
  async function request(path, { token = session.sessionToken, method = 'GET' } = {}) {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`Node API returned HTTP ${response.status}`);
    return body;
  }

  return {
    player: (guildId) => request(
      `/v1/sessions/${session.sessionId}/players/${guildId}`,
    ),
    nodeStats: () => request('/v1/stats', { token: NODE_TOKEN }),
    lavalinkStats: () => request('/v4/stats', { token: NODE_TOKEN }),
  };
}

async function ffmpegProcessCount() {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '(Get-Process -Name ffmpeg -ErrorAction SilentlyContinue | Measure-Object).Count',
  ], { windowsHide: true, timeout: 5000 });
  const count = Number(stdout.trim());
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Could not measure FFmpeg process count');
  }
  return count;
}

function isLocalNode(baseUrl) {
  return isLoopback(baseUrl.hostname);
}

async function assertEmptyVoiceChannel(discord, guildId, channelId) {
  const guild = await discord.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);
  if (!channel?.isVoiceBased?.()) {
    throw new Error('Configured channel is not a voice channel');
  }
  const botMember = await guild.members.fetchMe();
  const permissions = channel.permissionsFor(botMember);
  const permissionFlags = [
    discord.PermissionFlagsBits.ViewChannel,
    discord.PermissionFlagsBits.Connect,
    discord.PermissionFlagsBits.Speak,
  ];
  if (!permissions || permissionFlags.some((flag) => !permissions.has(flag))) {
    throw new Error('Test bot lacks a required voice-channel permission');
  }
  if ([...channel.members.values()].some((member) => member.id !== discord.user.id)) {
    throw new Error('Test voice channel is not empty');
  }
}

async function loadTrack(audio, url) {
  const loaded = await audio.loadTracks(url);
  const track = loaded.tracks?.[0];
  if (!track?.encoded) throw new Error('Test URL did not resolve to a playable track');
  return track;
}

async function main() {
  const missing = requiredEnvironment();
  if (process.env.MELINK_LIVE_CONFIRM !== CONFIRMATION) {
    missing.push('MELINK_LIVE_CONFIRM');
  }
  if (missing.length) {
    for (const test of CORE_TESTS) {
      record(test, 'BLOCKED', 'Live prerequisites are missing; no Discord or Audio Node connection was attempted');
    }
    printReport({ missingPrerequisites: [...new Set(missing)] });
    process.exitCode = 2;
    return;
  }

  let baseUrl;
  try {
    baseUrl = validateEnvironment();
  } catch (error) {
    for (const test of CORE_TESTS) {
      record(test, 'BLOCKED', `Invalid test configuration (${safeFailureName(error)}); no connection was attempted`);
    }
    printReport();
    process.exitCode = 2;
    return;
  }

  const optionalUrlErrors = new Set();
  const optionalUrls = QUICK_MODE ? [] : [
    ['AUDIO_NODE_TEST_SECOND_AUDIO_URL', SECOND_AUDIO_URL],
    ['AUDIO_NODE_TEST_BAD_AUDIO_URL', BAD_AUDIO_URL],
    ['AUDIO_NODE_TEST_CORRUPT_AUDIO_URL', CORRUPT_AUDIO_URL],
    ...(process.env.MELINK_LIVE_STRESS === '1'
      ? [['AUDIO_NODE_LONG_AUDIO_URL', LONG_AUDIO_URL]]
      : []),
  ];
  for (const [name, value] of optionalUrls) {
    if (!value) continue;
    try {
      validateHttpsUrl(name, value);
    } catch {
      optionalUrlErrors.add(name);
    }
  }

  if (QUICK_MODE) {
    for (const test of [
      'Track replacement and TrackEndEvent',
      'Natural TrackEndEvent',
      'Voice disconnect and rejoin',
      'Source failure and player recovery',
      'Corrupt audio and player recovery',
      'Rapid track replacement',
      'Player destroy and recreation',
      'Two-guild playback isolation',
    ]) {
      record(test, 'SKIP', 'Omitted by --quick mode');
    }
  } else {
    if (!SECOND_AUDIO_URL || optionalUrlErrors.has('AUDIO_NODE_TEST_SECOND_AUDIO_URL')) {
      record('Track replacement and TrackEndEvent', 'BLOCKED', 'Set a valid HTTPS AUDIO_NODE_TEST_SECOND_AUDIO_URL');
    }
    if (!HAS_SECOND_TEST_GUILD) {
      record('Two-guild playback isolation', 'BLOCKED', 'Set both second-guild environment values to controlled test locations');
    }
    if (!BAD_AUDIO_URL || optionalUrlErrors.has('AUDIO_NODE_TEST_BAD_AUDIO_URL')) {
      record('Source failure and player recovery', 'BLOCKED', 'Set a valid HTTPS AUDIO_NODE_TEST_BAD_AUDIO_URL on a controlled host');
    }
    if (!CORRUPT_AUDIO_URL || optionalUrlErrors.has('AUDIO_NODE_TEST_CORRUPT_AUDIO_URL')) {
      record('Corrupt audio and player recovery', 'BLOCKED', 'Set a valid HTTPS AUDIO_NODE_TEST_CORRUPT_AUDIO_URL on a controlled host');
    }
  }
  if (!QUICK_MODE && process.env.MELINK_LIVE_STRESS !== '1') {
    record('30-minute playback and resource monitoring', 'SKIP', 'Set MELINK_LIVE_STRESS=1 and AUDIO_NODE_LONG_AUDIO_URL to opt in');
  } else if (!QUICK_MODE && (!LONG_AUDIO_URL || optionalUrlErrors.has('AUDIO_NODE_LONG_AUDIO_URL'))) {
    record('30-minute playback and resource monitoring', 'BLOCKED', 'A valid HTTPS AUDIO_NODE_LONG_AUDIO_URL is required for the opt-in stress run');
  }
  record(
    'Pending stream cancellation on destroy',
    'BLOCKED',
    'The public API has no deterministic pending-start barrier; the existing unit test covers controlled AbortSignal cancellation',
  );
  record(
    'Unexpected FFmpeg process termination and recovery',
    'BLOCKED',
    'The harness will not kill host FFmpeg processes; this requires isolated node-side process instrumentation',
  );
  record(
    'Unexpected Discord voice transport loss',
    'BLOCKED',
    'The harness validates controlled bot leave/rejoin only; it does not inject network faults',
  );

  const sourceProbePassed = await runTest(
    'Test audio source reachability preflight',
    probeTestAudioSource,
  );
  if (!sourceProbePassed) {
    for (const test of CORE_TESTS) {
      if (!results.some((result) => result.test === test)) {
        record(test, 'BLOCKED', 'Test audio source preflight failed; no Discord or Audio Node connection was attempted');
      }
    }
    printReport();
    process.exitCode = 1;
    return;
  }

  let discord;
  let nodeClient;
  let api;
  const inbox = new EventInbox();
  let playerErrorCount = 0;
  let currentGuildReady = false;
  let guildCheckPassed = false;
  let gatewayReady = false;
  let nodeReady = false;
  let ffmpegCountAvailable = false;

  try {
    let discordModule;
    try {
      discordModule = await import('discord.js');
    } catch {
      for (const test of CORE_TESTS) {
        if (!results.some((result) => result.test === test)) {
          record(test, 'BLOCKED', 'Install discord.js in the test-bot environment before running the live harness');
        }
      }
      printReport({ missingPrerequisites: ['discord.js test-bot dependency'] });
      process.exitCode = 2;
      return;
    }

    const { AudioNodeClient } = await import('../packages/audio-node-client/index.js');
    discord = new discordModule.Client({
      intents: [
        discordModule.GatewayIntentBits.Guilds,
        discordModule.GatewayIntentBits.GuildVoiceStates,
      ],
    });
    discord.on('error', () => { playerErrorCount++; });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Discord Gateway readiness timeout')), 30_000);
      timer.unref?.();
      discord.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await Promise.all([discord.login(BOT_TOKEN), ready]);
    gatewayReady = true;
    record('Discord Gateway connection', 'PASS', 'Bot reached the Discord ready state');

    await assertEmptyVoiceChannel(discord, TEST_GUILD_ID, TEST_CHANNEL_ID);
    guildCheckPassed = true;
    record(
      'Controlled voice channel is empty and bot permissions are adequate',
      'PASS',
      'The configured voice channel is empty and has View Channel, Connect, and Speak permissions',
    );

    nodeClient = new AudioNodeClient({
      baseUrl: baseUrl.origin,
      token: NODE_TOKEN,
      discordClient: discord,
      clientName: 'melink-live-playback-validation',
    });
    nodeClient.on('error', () => { playerErrorCount++; });
    nodeClient.on('event', (packet) => {
      if (packet.type === 'TrackExceptionEvent' || packet.type === 'TrackStuckEvent') {
        playerErrorCount++;
      }
      inbox.push(packet);
    });
    await nodeClient.connect();
    nodeReady = true;
    api = createApi(baseUrl, nodeClient.session);
    record('Audio Node session and WebSocket authentication', 'PASS', 'Session and authenticated WebSocket established');

    await nodeClient.join(TEST_GUILD_ID, TEST_CHANNEL_ID);
    const connectedPlayer = await waitUntil(async () => {
      const player = await api.player(TEST_GUILD_ID);
      return player.connected ? player : null;
    });
    currentGuildReady = true;
    record('Voice channel connection readiness', 'PASS', `Voice connection reached Ready; player state is ${connectedPlayer.state}`);

    let firstTrack;
    let secondTrack;
    let ffmpegBefore;
    let ffmpegDuring;
    if (isLocalNode(baseUrl)) {
      try {
        ffmpegBefore = await ffmpegProcessCount();
        if (ffmpegBefore !== 0) {
          record(
            'FFmpeg process cleanup',
            'BLOCKED',
            'Existing host FFmpeg processes prevent attributing process counts to this test',
          );
          ffmpegBefore = undefined;
        } else ffmpegCountAvailable = true;
      } catch {
        record('FFmpeg process cleanup', 'BLOCKED', 'Could not query local FFmpeg process count');
      }
    } else {
      record('FFmpeg process cleanup', 'BLOCKED', 'Node is remote; local process count cannot verify its FFmpeg children');
    }

    await runTest('FFmpeg output reaches Audio Player', async () => {
      firstTrack = await loadTrack(nodeClient, TEST_AUDIO_URL);
      const marker = inbox.mark();
      const started = inbox.wait((event) =>
        event.type === 'TrackStartEvent' && event.guildId === TEST_GUILD_ID, marker);
      await Promise.all([
        nodeClient.play(TEST_GUILD_ID, firstTrack),
        started,
      ]);
      return 'TrackStartEvent followed FFmpeg-backed Ogg/Opus stream startup';
    });
    await runTest('AudioResource and AudioPlayer playing state', async () => {
      const player = await waitUntil(async () => {
        const state = await api.player(TEST_GUILD_ID);
        return state.state === 'playing' ? state : null;
      });
      if (!player.track) throw new Error('Playing state did not include a track');
      if (ffmpegBefore !== undefined) {
        try {
          ffmpegDuring = await ffmpegProcessCount();
          ffmpegCountAvailable = true;
        } catch {
          ffmpegCountAvailable = false;
        }
      }
      return 'AudioResource was accepted and the AudioPlayer reported Playing';
    });
    await runTest('TrackStartEvent', async () => {
      const player = await api.player(TEST_GUILD_ID);
      if (player.state !== 'playing' || !player.track) {
        throw new Error('TrackStartEvent was not followed by an active player');
      }
      return 'TrackStartEvent was observed for the configured test guild';
    });

    await runTest('Pause and resume', async () => {
      await nodeClient.pause(TEST_GUILD_ID, true);
      const paused = await waitUntil(async () => {
        const player = await api.player(TEST_GUILD_ID);
        return player.state === 'paused' ? player : null;
      });
      if (!paused.track) throw new Error('Paused player lost its track');
      await nodeClient.pause(TEST_GUILD_ID, false);
      await waitUntil(async () => {
        const player = await api.player(TEST_GUILD_ID);
        return player.state === 'playing' ? player : null;
      });
      return 'Player reported Paused and then Playing for the same track';
    });

    await runTest('Volume change', async () => {
      const result = await nodeClient.setVolume(TEST_GUILD_ID, 37);
      if (result.volume !== 37) throw new Error('Volume response did not match the request');
      const player = await api.player(TEST_GUILD_ID);
      if (player.volume !== 37) throw new Error('Player snapshot did not retain volume');
      return 'Volume 37 was applied and retained in player state';
    });

    if (SECOND_AUDIO_URL) {
      if (!QUICK_MODE && SECOND_AUDIO_URL) await runTest('Track replacement and TrackEndEvent', async () => {
        secondTrack = await loadTrack(nodeClient, SECOND_AUDIO_URL);
        const marker = inbox.mark();
        const ended = inbox.wait((event) =>
          event.type === 'TrackEndEvent' &&
          event.guildId === TEST_GUILD_ID &&
          event.reason === 'replaced', marker);
        const started = inbox.wait((event) =>
          event.type === 'TrackStartEvent' && event.guildId === TEST_GUILD_ID, marker);
        await Promise.all([
          nodeClient.play(TEST_GUILD_ID, secondTrack),
          ended,
          started,
        ]);
        const player = await api.player(TEST_GUILD_ID);
        if (player.state !== 'playing') throw new Error('Replacement track is not playing');
        return 'Replacement ended the prior track once and started the next track';
      });
    }

    await runTest('Stop and TrackEndEvent', async () => {
      const marker = inbox.mark();
      const ended = inbox.wait((event) =>
        event.type === 'TrackEndEvent' &&
        event.guildId === TEST_GUILD_ID &&
        event.reason === 'stopped', marker);
      await Promise.all([
        nodeClient.stop(TEST_GUILD_ID),
        ended,
      ]);
      const player = await api.player(TEST_GUILD_ID);
      if (player.state !== 'idle') throw new Error('Player did not return to Idle after stop');
      return 'Stop emitted TrackEndEvent and returned the player to Idle';
    });

    if (!QUICK_MODE) await runTest('Natural TrackEndEvent', async () => {
      const track = firstTrack || await loadTrack(nodeClient, TEST_AUDIO_URL);
      const marker = inbox.mark();
      const ended = inbox.wait((event) =>
        event.type === 'TrackEndEvent' &&
        event.guildId === TEST_GUILD_ID &&
        event.reason === 'finished', marker, 120_000);
      await Promise.all([
        nodeClient.play(TEST_GUILD_ID, track),
        ended,
      ]);
      return 'Finite test audio reached its natural TrackEndEvent';
    });

    if (!QUICK_MODE) await runTest('Voice disconnect and rejoin', async () => {
      const guild = await discord.guilds.fetch(TEST_GUILD_ID);
      const botMember = await guild.members.fetchMe();
      if (!botMember.voice.channelId || typeof botMember.voice.disconnect !== 'function') {
        throw new Error('Bot voice disconnect control is unavailable');
      }
      await botMember.voice.disconnect();
      await waitUntil(async () => {
        const player = await api.player(TEST_GUILD_ID);
        return player.connected ? null : player;
      }, 20_000);
      await nodeClient.join(TEST_GUILD_ID, TEST_CHANNEL_ID);
      await waitUntil(async () => {
        const player = await api.player(TEST_GUILD_ID);
        return player.connected ? player : null;
      });
      return 'Controlled voice leave was observed and the bot rejoined the test channel';
    });

    if (!QUICK_MODE) for (const [label, url] of [
      ['Source failure and player recovery', BAD_AUDIO_URL],
      ['Corrupt audio and player recovery', CORRUPT_AUDIO_URL],
    ]) {
      if (!url) continue;
      await runTest(label, async () => {
        const track = await loadTrack(nodeClient, url);
        const marker = inbox.mark();
        const failureEvent = inbox.wait((event) =>
          event.guildId === TEST_GUILD_ID &&
          (event.type === 'TrackExceptionEvent' || event.type === 'TrackStuckEvent'),
        marker, 15_000).then(() => true, () => false);
        let failed = false;
        try {
          await nodeClient.play(TEST_GUILD_ID, track);
        } catch {
          failed = true;
        }
        if (!failed) {
          failed = await failureEvent;
        }
        if (!failed) throw new Error('Invalid source did not fail');
        await nodeClient.stop(TEST_GUILD_ID).catch(() => {});
        const goodTrack = firstTrack || await loadTrack(nodeClient, TEST_AUDIO_URL);
        const recoveryMarker = inbox.mark();
        const started = inbox.wait((event) =>
          event.type === 'TrackStartEvent' && event.guildId === TEST_GUILD_ID, recoveryMarker);
        await Promise.all([
          nodeClient.play(TEST_GUILD_ID, goodTrack),
          started,
        ]);
        await nodeClient.stop(TEST_GUILD_ID);
        return 'Expected source failure was followed by successful playback on the same guild player';
      });
    }

    if (!QUICK_MODE && SECOND_AUDIO_URL) {
      await runTest('Rapid track replacement', async () => {
        let track = firstTrack || await loadTrack(nodeClient, TEST_AUDIO_URL);
        for (let index = 0; index < 3; index++) {
          const nextTrack = index % 2 === 0
            ? secondTrack || await loadTrack(nodeClient, SECOND_AUDIO_URL)
            : firstTrack || await loadTrack(nodeClient, TEST_AUDIO_URL);
          const marker = inbox.mark();
          const started = inbox.wait((event) =>
            event.type === 'TrackStartEvent' && event.guildId === TEST_GUILD_ID, marker);
          await Promise.all([
            nodeClient.play(TEST_GUILD_ID, nextTrack),
            started,
          ]);
          track = nextTrack;
        }
        const player = await api.player(TEST_GUILD_ID);
        if (player.state !== 'playing' || !player.track) throw new Error('Player failed after replacements');
        await nodeClient.stop(TEST_GUILD_ID);
        return `Three rapid replacements completed; final track ${track.info.sourceName || 'unknown'} remained active`;
      });
    }

    if (!QUICK_MODE) await runTest('Player destroy and recreation', async () => {
      await nodeClient.leave(TEST_GUILD_ID);
      await nodeClient.join(TEST_GUILD_ID, TEST_CHANNEL_ID);
      await waitUntil(async () => {
        const player = await api.player(TEST_GUILD_ID);
        return player.connected ? player : null;
      });
      return 'Player was destroyed through leave and a new voice player became ready';
    });

    if (!QUICK_MODE && HAS_SECOND_TEST_GUILD) {
      await runTest('Two-guild playback isolation', async () => {
        await assertEmptyVoiceChannel(discord, SECOND_GUILD_ID, SECOND_CHANNEL_ID);
        await nodeClient.join(SECOND_GUILD_ID, SECOND_CHANNEL_ID);
        await waitUntil(async () => {
          const player = await api.player(SECOND_GUILD_ID);
          return player.connected ? player : null;
        });
        const trackA = firstTrack || await loadTrack(nodeClient, TEST_AUDIO_URL);
        const trackB = secondTrack || await loadTrack(nodeClient, SECOND_AUDIO_URL || TEST_AUDIO_URL);
        const marker = inbox.mark();
        const starts = Promise.all([
          inbox.wait((event) =>
            event.type === 'TrackStartEvent' && event.guildId === TEST_GUILD_ID, marker),
          inbox.wait((event) =>
            event.type === 'TrackStartEvent' && event.guildId === SECOND_GUILD_ID, marker),
        ]);
        await Promise.all([
          nodeClient.play(TEST_GUILD_ID, trackA),
          nodeClient.play(SECOND_GUILD_ID, trackB),
          starts,
        ]);
        const [first, second] = await Promise.all([
          api.player(TEST_GUILD_ID),
          api.player(SECOND_GUILD_ID),
        ]);
        if (first.state !== 'playing' || second.state !== 'playing') {
          throw new Error('Both guild players did not remain active');
        }
        await nodeClient.stop(TEST_GUILD_ID);
        const remaining = await api.player(SECOND_GUILD_ID);
        if (remaining.state !== 'playing') throw new Error('Stopping one guild affected the other');
        await nodeClient.stop(SECOND_GUILD_ID);
        return 'Both guilds played independently; stopping one left the other playing';
      });
    }

    if (ffmpegBefore !== undefined) {
      if (ffmpegDuring === undefined || ffmpegDuring <= ffmpegBefore) {
        record(
          'FFmpeg process cleanup',
          'BLOCKED',
          'The host process counter did not observe a test FFmpeg process during playback',
        );
      } else {
        await runTest('FFmpeg process cleanup', async () => {
          await nodeClient.stop(TEST_GUILD_ID).catch(() => {});
          await delay(1500);
          const after = await ffmpegProcessCount();
          if (after > ffmpegBefore) {
            throw new Error('FFmpeg process count did not return to baseline');
          }
          return `FFmpeg process count returned to baseline (${ffmpegBefore} before, ${after} after)`;
        });
      }
    }

    if (!QUICK_MODE && process.env.MELINK_LIVE_STRESS === '1' && LONG_AUDIO_URL) {
      await runTest('30-minute playback and resource monitoring', async () => {
        const track = await loadTrack(nodeClient, LONG_AUDIO_URL);
        const marker = inbox.mark();
        const started = inbox.wait((event) =>
          event.type === 'TrackStartEvent' && event.guildId === TEST_GUILD_ID, marker);
        await Promise.all([
          nodeClient.play(TEST_GUILD_ID, track),
          started,
        ]);
        const samples = [];
        const start = Date.now();
        while (Date.now() - start < STRESS_DURATION_MS) {
          const [player, nodeStats, lavalinkStats] = await Promise.all([
            api.player(TEST_GUILD_ID),
            api.nodeStats(),
            api.lavalinkStats(),
          ]);
          if (player.state !== 'playing') throw new Error('Long playback stopped unexpectedly');
          samples.push({
            elapsedMs: Date.now() - start,
            rssBytes: nodeStats.memory?.rss ?? null,
            heapUsedBytes: nodeStats.memory?.heapUsed ?? null,
            cpuLoad: lavalinkStats.cpu?.lavalinkLoad ?? null,
            systemLoad: lavalinkStats.cpu?.systemLoad ?? null,
            ffmpegProcesses: isLocalNode(baseUrl)
              ? await ffmpegProcessCount().catch(() => null)
              : null,
            playerErrors: playerErrorCount,
          });
          await delay(10_000);
        }
        await nodeClient.stop(TEST_GUILD_ID);
        const numbers = (key) => samples.map((sample) => sample[key])
          .filter((value) => typeof value === 'number');
        const range = (key) => {
          const values = numbers(key);
          return values.length
            ? { min: Math.min(...values), max: Math.max(...values), last: values.at(-1) }
            : null;
        };
        return JSON.stringify({
          durationMs: Date.now() - start,
          samples: samples.length,
          rssBytes: range('rssBytes'),
          heapUsedBytes: range('heapUsedBytes'),
          cpuLoad: range('cpuLoad'),
          systemLoad: range('systemLoad'),
          ffmpegProcesses: range('ffmpegProcesses'),
          playerErrors: playerErrorCount,
        });
      });
    }
  } catch (error) {
    if (!gatewayReady) record('Discord Gateway connection', 'FAIL', `Failed (${safeFailureName(error)}); sensitive error details omitted`);
    else if (!guildCheckPassed) record('Controlled voice channel is empty and bot permissions are adequate', 'FAIL', `Failed (${safeFailureName(error)}); sensitive error details omitted`);
    else if (!nodeReady) record('Audio Node session and WebSocket authentication', 'FAIL', `Failed (${safeFailureName(error)}); sensitive error details omitted`);
    else if (!currentGuildReady) record('Voice channel connection readiness', 'FAIL', `Failed (${safeFailureName(error)}); sensitive error details omitted`);

    for (const test of CORE_TESTS) {
      if (!results.some((result) => result.test === test)) {
        record(test, 'BLOCKED', 'A prerequisite scenario did not complete');
      }
    }
  } finally {
    inbox.close();
    if (nodeClient) {
      try {
        await nodeClient.destroy();
        record(
          'Audio Node session/player/voice cleanup',
          'PASS',
          'Authenticated session deletion completed; its players and voice connections were released',
        );
      } catch {
        record('Audio Node session/player/voice cleanup', 'FAIL', 'Session cleanup failed; sensitive error details omitted');
      }
    }
    if (discord) {
      try {
        discord.destroy();
        record('Discord test bot cleanup', 'PASS', 'Discord client was destroyed');
      } catch {
        record('Discord test bot cleanup', 'FAIL', 'Discord client cleanup failed; sensitive error details omitted');
      }
    }
  }

  if (!results.some(({ test }) => test === 'Discord outgoing packet verification')) {
    record(
      'Discord outgoing packet verification',
      'BLOCKED',
      'The public client/Audio Node APIs expose no outbound RTP packet counter',
    );
  }
  if (!results.some(({ test }) => test === 'Human audible-output confirmation')) {
    record(
      'Human audible-output confirmation',
      'BLOCKED',
      'A user must listen in the controlled test channel and confirm audible output',
    );
  }
  printReport({
    monitoring: {
      playerErrors: playerErrorCount,
      ffmpegProcessCountAvailable: ffmpegCountAvailable,
    },
  });
  if (results.some(({ status }) => status === 'FAIL')) process.exitCode = 1;
  else if (results.some(({ status }) => status === 'BLOCKED')) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
