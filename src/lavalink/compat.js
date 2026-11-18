// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import v8 from 'node:v8';
import { WebSocketServer } from 'ws';
import { FixedWindowRateLimiter } from '../http/rate-limiter.js';
import { Player } from '../core/player.js';
import { decodeTrackUri } from '../audio/resolver.js';
import {
  buildAudioFilterChain,
  LAVALINK_FILTERS,
  MELINK_ONLY_FILTERS,
} from '../audio/filters.js';

const COMPAT_VERSION = '4.0.0-melink.0';
const SESSION_PATH = /^\/v4\/sessions\/([0-9a-f-]{36})$/i;
const PLAYER_PATH = /^\/v4\/sessions\/([0-9a-f-]{36})\/players(?:\/(\d{15,22}))?$/i;
const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_RESUME_TIMEOUT_SECONDS = 60;
const MAX_RESUME_TIMEOUT_SECONDS = 600;
const PLAYER_UPDATE_INTERVAL_MS = 5_000;
const STATS_INTERVAL_MS = 60_000;
const startedAt = Date.now();
const initialCpuUsage = process.cpuUsage();

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, message, path) {
  const error = status === 404
    ? 'Not Found'
    : status === 501
      ? 'Not Implemented'
      : status === 429
        ? 'Too Many Requests'
        : status >= 500
          ? 'Internal Server Error'
          : 'Bad Request';
  return sendJson(response, status, {
    timestamp: Date.now(),
    status,
    error,
    message,
    path,
  });
}

function responseStatus(error, fallback = 400) {
  return Number.isInteger(error?.statusCode) &&
    error.statusCode >= 400 && error.statusCode <= 599
    ? error.statusCode
    : fallback;
}

function applyRateLimit(response, decision) {
  response.setHeader('ratelimit-limit', String(decision.limit));
  response.setHeader('ratelimit-remaining', String(decision.remaining));
  response.setHeader('ratelimit-reset', String(decision.retryAfterSeconds));
  if (decision.allowed) return true;
  response.setHeader('retry-after', String(decision.retryAfterSeconds));
  sendJson(response, 429, { error: 'Rate limit exceeded' });
  return false;
}

function hasNodeToken(request, token) {
  const header = request.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : header;
  return supplied === token;
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    }
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 });
  }
}

export function createLavalinkCompat({
  config,
  sessions,
  sourceManager,
  pluginManager,
  logger,
  metrics,
  playerFactory = (options) => new Player(options),
}) {
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });
  const requestLimiter = new FixedWindowRateLimiter({
    limit: config.sessionRequestLimit ?? 120,
    windowMs: config.rateLimitWindowMs ?? 60_000,
  });
  const sessionsById = new Map();
  const sessionsByUserId = new Map();

  function sendSocket(session, packet) {
    if (session.socket?.readyState === 1) {
      session.socket.send(JSON.stringify(packet));
    }
  }

  function sendPlayerMessage(session, type, data) {
    const state = session.players.get(data.guildId);
    if (!state) return;

    if (type === 'TrackStartEvent' || type === 'TrackEndEvent') {
      if (type === 'TrackStartEvent' && data.trackPayload) {
        state.track = data.trackPayload;
      }
      const eventTrack = data.trackPayload || state.track ||
        state.player.currentTrackPayload || (data.track ? { info: data.track } : undefined);
      sendSocket(session, {
        op: 'event',
        type,
        guildId: data.guildId,
        track: eventTrack,
        ...(type === 'TrackEndEvent' ? { reason: data.reason } : {}),
      });
      if (type === 'TrackEndEvent') {
        if (!data.trackPayload ||
            state.track?.encoded === data.trackPayload.encoded) {
          state.track = null;
          state.position = 0;
        }
      }
      return;
    }

    if (type === 'PlayerErrorEvent') {
      sendSocket(session, {
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: data.guildId,
        track: state.track || state.player.currentTrackPayload,
        exception: {
          message: data.message,
          severity: 'fault',
          cause: data.message,
        },
      });
    }

    if (type === 'TrackStuckEvent' || type === 'WebSocketClosedEvent') {
      sendSocket(session, {
        op: 'event',
        type,
        guildId: data.guildId,
        ...(type === 'TrackStuckEvent'
          ? {
            track: state.track || state.player.currentTrackPayload,
            thresholdMs: data.thresholdMs,
          }
          : {
            code: data.code,
            reason: data.reason,
            byRemote: data.byRemote,
          }),
      });
    }
  }

  function playerState(session, guildId) {
    let state = session.players.get(guildId);
    if (state) return state;
    const maxPlayers = sessions.maxPlayers ?? config.maxPlayers ?? 5;
    if (session.players.size >= maxPlayers) return null;

    const player = playerFactory({
      session: {
        send: (type, data) => sendPlayerMessage(session, type, data),
      },
      guildId,
      idleTimeoutMs: config.idleTimeoutMs ?? sessions.idleTimeoutMs ?? 30_000,
      logger: logger.child({ lavalinkSessionId: session.id, guildId }),
      metrics,
      onDestroy: () => session.players.delete(guildId),
    });
    state = {
      player,
      track: null,
      voice: null,
      volume: 100,
      paused: false,
      position: 0,
      filters: {},
    };
    session.players.set(guildId, state);
    return state;
  }

  function playerResponse(guildId, state) {
    const snapshot = state.player.snapshot();
    return {
      guildId,
      track: state.track,
      volume: state.volume,
      paused: state.paused,
      state: {
        time: Date.now(),
        position: snapshot.position,
        connected: snapshot.connected,
        ping: -1,
      },
      voice: state.voice || {
        token: '',
        endpoint: '',
        sessionId: '',
        channelId: null,
      },
      filters: state.filters,
    };
  }

  function getStats() {
    const nodeStats = sessions.stats();
    let players = 0;
    let playingPlayers = 0;
    for (const session of sessionsById.values()) {
      for (const state of session.players.values()) {
        players++;
        if (state.player.snapshot().state === 'playing') playingPlayers++;
      }
    }

    const memory = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    const cpu = process.cpuUsage(initialCpuUsage);
    const elapsedMicroseconds = Math.max(1, (Date.now() - startedAt) * 1000 * os.cpus().length);

    return {
      players,
      playingPlayers,
      melinkPlayers: nodeStats.players,
      melinkPlayingPlayers: [...sessions.values()]
        .reduce((count, session) => count + [...session.players.values()]
          .filter((player) => player.snapshot().state === 'playing').length, 0),
      uptime: Math.floor(process.uptime() * 1000),
      memory: {
        free: Math.max(0, memory.heapTotal - memory.heapUsed),
        used: memory.heapUsed,
        allocated: memory.heapTotal,
        reservable: Math.max(0, heap.heap_size_limit - memory.heapTotal),
      },
      cpu: {
        cores: os.cpus().length,
        systemLoad: os.loadavg()[0] / Math.max(1, os.cpus().length),
        lavalinkLoad: Math.min(1, (cpu.user + cpu.system) / elapsedMicroseconds),
      },
      frameStats: null,
    };
  }

  function sendStats(session) {
    sendSocket(session, { op: 'stats', ...getStats() });
  }

  function removeSession(session) {
    if (session.expirationTimer) clearTimeout(session.expirationTimer);
    if (session.playerUpdateTimer) clearInterval(session.playerUpdateTimer);
    if (session.statsTimer) clearInterval(session.statsTimer);
    for (const state of session.players.values()) state.player.destroy();
    session.players.clear();
    if (session.socket) session.socket.close(1000, 'Lavalink session expired');
    sessionsById.delete(session.id);
    if (sessionsByUserId.get(session.userId) === session) {
      sessionsByUserId.delete(session.userId);
    }
  }

  function createSession(userId, clientName) {
    const session = {
      id: randomUUID(),
      userId,
      clientName,
      socket: null,
      players: new Map(),
      resuming: false,
      timeoutSeconds: DEFAULT_RESUME_TIMEOUT_SECONDS,
      expirationTimer: null,
      playerUpdateTimer: setInterval(() => {
        for (const [guildId, state] of session.players) {
          const snapshot = state.player.snapshot();
          sendSocket(session, {
            op: 'playerUpdate',
            guildId,
            state: {
              time: Date.now(),
              position: snapshot.position,
              connected: snapshot.connected,
              ping: -1,
            },
          });
        }
      }, PLAYER_UPDATE_INTERVAL_MS),
      statsTimer: setInterval(() => sendStats(session), STATS_INTERVAL_MS),
    };
    session.playerUpdateTimer.unref?.();
    session.statsTimer.unref?.();
    sessionsById.set(session.id, session);
    sessionsByUserId.set(userId, session);
    return session;
  }

  function scheduleExpiration(session) {
    if (session.expirationTimer) clearTimeout(session.expirationTimer);
    if (!session.resuming) {
      removeSession(session);
      return;
    }
    session.expirationTimer = setTimeout(
      () => removeSession(session),
      session.timeoutSeconds * 1000,
    );
    session.expirationTimer.unref?.();
  }

  async function handlePlayerRoute(request, response, session, guildId, url) {
    if (!guildId) {
      if (request.method !== 'GET') {
        sendError(response, 405, 'Only GET is supported for the player collection', url.pathname);
        return true;
      }
      sendJson(response, 200, [...session.players.entries()].map(([id, state]) =>
        playerResponse(id, state)));
      return true;
    }

    const existing = session.players.get(guildId);
    if (request.method === 'GET') {
      if (!existing) {
        sendError(response, 404, 'Player not found', url.pathname);
        return true;
      }
      sendJson(response, 200, playerResponse(guildId, existing));
      return true;
    }

    if (request.method === 'DELETE') {
      if (existing) {
        existing.player.destroy();
        session.players.delete(guildId);
      }
      response.writeHead(204);
      response.end();
      return true;
    }

    if (request.method !== 'PATCH') {
      sendError(response, 405, 'Method not allowed', url.pathname);
      return true;
    }

    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendError(response, 400, 'Player update must be a JSON object', url.pathname);
      return true;
    }

    const filters = body.filters;
    if (filters !== undefined && filters !== null &&
        (typeof filters !== 'object' || Array.isArray(filters))) {
      sendError(response, 400, '"filters" must be an object', url.pathname);
      return true;
    }
    if (filters) {
      try {
        buildAudioFilterChain(filters);
      } catch (error) {
        sendError(response, 400, error.message, url.pathname);
        return true;
      }
    }
    if (body.position !== undefined &&
        (!Number.isSafeInteger(body.position) || body.position < 0)) {
      sendError(response, 400, '"position" must be a non-negative integer', url.pathname);
      return true;
    }
    if (body.endTime !== undefined && body.endTime !== null) {
      sendError(response, 501, 'Track end-time limits are not supported by this node', url.pathname);
      return true;
    }
    if (body.paused !== undefined && typeof body.paused !== 'boolean') {
      sendError(response, 400, '"paused" must be a boolean', url.pathname);
      return true;
    }
    if (body.volume !== undefined &&
        (!Number.isSafeInteger(body.volume) || body.volume < 0 || body.volume > 1000)) {
      sendError(response, 400, '"volume" must be an integer from 0 to 1000', url.pathname);
      return true;
    }

    const state = existing || playerState(session, guildId);
    if (!state) {
      sendError(response, 429, 'Player limit reached', url.pathname);
      return true;
    }
    if (body.voice !== undefined) {
      if (body.voice === null) {
        state.player.disconnectVoice();
        state.voice = null;
      } else {
        const voice = body.voice;
        if (
          !voice ||
          typeof voice !== 'object' ||
          typeof voice.token !== 'string' ||
          !voice.token ||
          typeof voice.endpoint !== 'string' ||
          !voice.endpoint ||
          typeof voice.sessionId !== 'string' ||
          !voice.sessionId ||
          typeof voice.channelId !== 'string' ||
          !/^\d{15,22}$/.test(voice.channelId)
        ) {
          sendError(response, 400, '"voice" must include token, endpoint, sessionId, and channelId', url.pathname);
          return true;
        }
        state.player.joinLavalinkVoice({ ...voice, userId: session.userId });
        state.voice = {
          token: voice.token,
          endpoint: voice.endpoint,
          sessionId: voice.sessionId,
          channelId: voice.channelId,
        };
      }
    }

    if (body.volume !== undefined) {
      state.player.setVolume(body.volume);
      state.volume = body.volume;
    }
    const track = body.track;
    const encodedTrack = body.encodedTrack;
    const identifier = body.identifier;
    const hasTrackUpdate = track !== undefined ||
      encodedTrack !== undefined ||
      identifier !== undefined;
    const noReplaceValue = url.searchParams.get('noReplace');
    if (noReplaceValue !== null && !['true', 'false'].includes(noReplaceValue)) {
      sendError(response, 400, '"noReplace" must be true or false', url.pathname);
      return true;
    }
    const noReplace = noReplaceValue === 'true';
    let stoppedTrack = false;
    const nextFilters = filters === null
      ? {}
      : filters
        ? { ...state.filters, ...filters }
        : state.filters;

    if (hasTrackUpdate && !(noReplace && state.track)) {
      const suppliedTrack = track && typeof track === 'object' && !Array.isArray(track)
        ? track
        : null;
      const suppliedEncoded = suppliedTrack?.encoded ?? encodedTrack;
      const suppliedIdentifier = suppliedTrack?.identifier ?? identifier;
      const shouldStop = suppliedTrack?.encoded === null ||
        (track === null && suppliedIdentifier === undefined) ||
        suppliedEncoded === null;

      if (shouldStop) {
        state.player.stop();
        state.track = null;
        stoppedTrack = true;
      } else {
        let loadedTrack;
        if (typeof suppliedIdentifier === 'string') {
          try {
            loadedTrack = await sourceManager.resolve(suppliedIdentifier);
          } catch (error) {
            logger.warn({
              errorType: error.name,
              statusCode: error.statusCode || 400,
            }, 'Lavalink player track resolution failed');
            sendError(response, error.statusCode || 400, error.message, url.pathname);
            return true;
          }
        } else if (typeof suppliedEncoded === 'string' && suppliedEncoded) {
          if (suppliedTrack?.info && typeof suppliedTrack.info.title === 'string' &&
              suppliedTrack.info.title) {
            loadedTrack = {
              encoded: suppliedEncoded,
              info: suppliedTrack.info,
              pluginInfo: suppliedTrack.pluginInfo || {},
              ...(suppliedTrack.userData !== undefined
                ? { userData: suppliedTrack.userData }
                : {}),
            };
          } else {
            try {
              loadedTrack = await sourceManager.resolve(
                decodeTrackUri({ encoded: suppliedEncoded }),
              );
            } catch (error) {
              logger.warn({
                errorType: error.name,
                statusCode: error.statusCode || 400,
              }, 'Lavalink player encoded-track resolution failed');
              sendError(response, error.statusCode || 400, error.message, url.pathname);
              return true;
            }
          }
        } else {
          sendError(response, 400, 'Track update requires an encoded track or identifier', url.pathname);
          return true;
        }

        if (!state.voice) {
          sendError(response, 400, 'Voice state must be set before playing a track', url.pathname);
          return true;
        }
        try {
          await state.player.play(loadedTrack, { filters: nextFilters });
          state.track = loadedTrack;
          state.paused = false;
          state.filters = nextFilters;
        } catch (error) {
          sendError(response, 400, error.message, url.pathname);
          return true;
        }
      }
    }

    if (filters !== undefined && !hasTrackUpdate) {
      try {
        await state.player.setFilters(nextFilters);
        state.filters = nextFilters;
      } catch (error) {
        sendError(response, 400, error.message, url.pathname);
        return true;
      }
    }

    if (body.position !== undefined && !stoppedTrack) {
      try {
        await state.player.seek(body.position);
      } catch (error) {
        sendError(response, 400, error.message, url.pathname);
        return true;
      }
    }

    if (body.paused !== undefined) {
      const result = state.player.pause(body.paused);
      state.paused = typeof result?.paused === 'boolean' ? result.paused : body.paused;
    }

    sendJson(response, 200, playerResponse(guildId, state));
    return true;
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/version') {
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(COMPAT_VERSION);
      return true;
    }
    if (!url.pathname.startsWith('/v4/')) return false;
    if (!hasNodeToken(request, config.token)) {
      sendJson(response, 401, { error: 'Unauthorized' });
      return true;
    }
    if (!applyRateLimit(response, requestLimiter.consume('lavalink-node-token'))) return true;

    if (request.method === 'GET' && url.pathname === '/v4/info') {
      sendJson(response, 200, {
        version: {
          semver: COMPAT_VERSION,
          major: 4,
          minor: 0,
          patch: 0,
          preRelease: 'melink.0',
          build: null,
        },
        buildTime: null,
        git: null,
        sourceManagers: sourceManager.sourceManagerNames(),
        filters: LAVALINK_FILTERS,
        melinkFilters: MELINK_ONLY_FILTERS,
        plugins: pluginManager?.listPlugins({ enabledOnly: true }) || [],
      });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/v4/stats') {
      sendJson(response, 200, getStats());
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/v4/loadtracks') {
      const identifier = url.searchParams.get('identifier');
      if (!identifier) {
        sendError(response, 400, 'Query parameter "identifier" is required', url.pathname);
        return true;
      }
      try {
        const loaded = await sourceManager.load(identifier);
        if (loaded.loadType === 'playlist') {
          sendJson(response, 200, {
            loadType: 'playlist',
            data: {
              info: {
                name: loaded.playlist.name,
                selectedTrack: loaded.playlist.selectedTrack,
              },
              tracks: loaded.playlist.tracks.map((track) => ({
                ...track,
                info: { ...track.info, position: 0 },
                pluginInfo: {},
              })),
              pluginInfo: {},
            },
          });
        } else {
          const track = loaded.track;
          sendJson(response, 200, {
            loadType: 'track',
            data: {
              ...track,
              info: { ...track.info, position: 0 },
              pluginInfo: {},
            },
          });
        }
      } catch (error) {
        logger.warn({
          sourceId: error.message.match(/Source "([^"]+)"/)?.[1] || null,
          errorType: error.name,
          statusCode: error.statusCode || 400,
        }, 'Lavalink track resolution failed');
        sendError(response, responseStatus(error), error.message, url.pathname);
      }
      return true;
    }

    if (url.pathname === '/v4/encodetracks' || url.pathname === '/v4/decodetracks') {
      if (request.method !== 'POST') {
        sendError(response, 405, 'Method not allowed', url.pathname);
      } else {
        sendError(response, 501, 'Track encoding and decoding are not supported', url.pathname);
      }
      return true;
    }

    const sessionMatch = url.pathname.match(SESSION_PATH);
    if (sessionMatch && request.method === 'PATCH') {
      const session = sessionsById.get(sessionMatch[1]);
      if (!session) {
        sendError(response, 404, 'Lavalink session not found', url.pathname);
        return true;
      }
      const body = await readJson(request);
      if (typeof body.resuming !== 'boolean') {
        sendError(response, 400, '"resuming" must be a boolean', url.pathname);
        return true;
      }
      const timeoutSeconds = body.timeout ?? session.timeoutSeconds;
      if (
        !Number.isSafeInteger(timeoutSeconds) ||
        timeoutSeconds < 1 ||
        timeoutSeconds > MAX_RESUME_TIMEOUT_SECONDS
      ) {
        sendError(
          response,
          400,
          `"timeout" must be an integer from 1 to ${MAX_RESUME_TIMEOUT_SECONDS}`,
          url.pathname,
        );
        return true;
      }
      session.resuming = body.resuming;
      session.timeoutSeconds = timeoutSeconds;
      if (!session.resuming && session.expirationTimer) {
        clearTimeout(session.expirationTimer);
        session.expirationTimer = null;
        if (!session.socket) removeSession(session);
      }
      sendJson(response, 200, {
        resumingKey: session.id,
        timeout: session.timeoutSeconds,
      });
      return true;
    }

    const playerMatch = url.pathname.match(PLAYER_PATH);
    if (playerMatch) {
      const session = sessionsById.get(playerMatch[1]);
      if (!session) {
        sendError(response, 404, 'Lavalink session not found', url.pathname);
        return true;
      }
      return handlePlayerRoute(request, response, session, playerMatch[2], url);
    }

    sendError(response, 404, 'Lavalink compatibility route not found', url.pathname);
    return true;
  }

  function rejectUpgrade(socket, status, reason, headers = {}) {
    const extraHeaders = Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('');
    socket.write(`HTTP/1.1 ${status} ${reason}\r\n${extraHeaders}Connection: close\r\n\r\n`);
    socket.destroy();
  }

  function handleUpgrade(request, socket, head) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/v4/websocket') return false;
    const userId = request.headers['user-id'];
    if (!hasNodeToken(request, config.token) || typeof userId !== 'string' || !/^\d{15,22}$/.test(userId)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return true;
    }
    const decision = requestLimiter.consume(`lavalink-ws:${userId}`);
    if (!decision.allowed) {
      rejectUpgrade(socket, 429, 'Too Many Requests', {
        'Retry-After': String(decision.retryAfterSeconds),
      });
      return true;
    }

    request.lavalinkSessionResumed = Boolean(sessionsByUserId.get(userId)?.resuming);
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket, request);
    });
    return true;
  }

  websocketServer.on('headers', (headers, request) => {
    headers.push('Lavalink-Api-Version: v4');
    headers.push(`Session-Resumed: ${request.lavalinkSessionResumed ? 'true' : 'false'}`);
  });

  websocketServer.on('connection', (websocket, request) => {
    const userId = request.headers['user-id'];
    const previous = sessionsByUserId.get(userId);
    let session;
    let resumed = false;
    if (previous?.resuming) {
      session = previous;
      resumed = true;
      if (session.expirationTimer) clearTimeout(session.expirationTimer);
      session.expirationTimer = null;
      session.socket?.close(4000, 'Session resumed by a newer connection');
    } else {
      if (previous) removeSession(previous);
      session = createSession(userId, request.headers['client-name'] || 'unknown');
    }

    session.socket = websocket;
    websocket.on('error', (error) => {
      logger.warn({ errorCode: error.code, errorType: error.name }, 'Lavalink WebSocket error');
    });
    websocket.on('close', () => {
      if (session.socket !== websocket) return;
      session.socket = null;
      scheduleExpiration(session);
    });
    websocket.send(JSON.stringify({
      op: 'ready',
      resumed,
      sessionId: session.id,
    }));
    sendStats(session);
  });

  return {
    handleRequest,
    handleUpgrade,
    sessionCount() {
      return sessionsById.size;
    },
    close() {
      for (const session of sessionsById.values()) {
        session.resuming = false;
        removeSession(session);
      }
      websocketServer.close();
    },
  };
}
