// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { ResolverRegistry } from '../audio/resolver-registry.js';
import { createCatalogSearch, createSoundCloudResolver } from '../audio/catalog-search.js';
import { createLogger } from '../logger.js';
import { Player } from '../core/player.js';
import { FixedWindowRateLimiter } from './rate-limiter.js';
import { NodeMetrics } from './metrics.js';
import { createLavalinkCompat } from '../lavalink/compat.js';
import { createSourceManager } from '../sources/builtins.js';

const MAX_BODY_BYTES = 64 * 1024;
const SESSION_PATH = /^\/v1\/sessions\/([0-9a-f-]{36})$/i;
const LOADTRACKS_PATH = /^\/v1\/sessions\/([0-9a-f-]{36})\/loadtracks$/i;
const SEARCH_PATH = /^\/v1\/sessions\/([0-9a-f-]{36})\/search$/i;
const CATALOG_PATH = /^\/v1\/sessions\/([0-9a-f-]{36})\/catalog$/i;
const METADATA_PATH = /^\/v1\/sessions\/([0-9a-f-]{36})\/metadata$/i;
const PUBLIC_METADATA_FIELDS = new Set([
  'title',
  'author',
  'artist',
  'album',
  'length',
  'duration',
  'releaseDate',
  'isrc',
  'sourceName',
]);

function publicMetadata(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([key, field]) =>
      PUBLIC_METADATA_FIELDS.has(key) &&
      (typeof field === 'string' || (typeof field === 'number' && Number.isFinite(field)))),
  );
}
const PLAYER_PATH = /^\/v1\/sessions\/([0-9a-f-]{36})\/players\/(\d{15,22})$/i;

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function applyRateLimit(response, decision) {
  response.setHeader('ratelimit-limit', String(decision.limit));
  response.setHeader('ratelimit-remaining', String(decision.remaining));
  response.setHeader('ratelimit-reset', String(decision.retryAfterSeconds));
  if (decision.allowed) return true;

  response.setHeader('retry-after', String(decision.retryAfterSeconds));
  sendJson(response, 429, {
    error: 'Rate limit exceeded',
    retryAfterSeconds: decision.retryAfterSeconds,
  });
  return false;
}

function errorStatus(error, fallback) {
  return Number.isInteger(error?.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode <= 599
    ? error.statusCode
    : fallback;
}

function requestPath(request) {
  try {
    return new URL(request.url, 'http://localhost').pathname;
  } catch {
    return '/invalid-request-path';
  }
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      throw error;
    }
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function bearerToken(request) {
  const header = request.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function createSessionApi({
  config,
  sessions,
  logger,
  metrics,
  lavalinkCompat,
  sourceManager,
  isReady,
}) {
  const rateLimitWindowMs = config.rateLimitWindowMs ?? 60_000;
  const sessionCreateLimiter = new FixedWindowRateLimiter({
    limit: config.sessionCreateLimit ?? 10,
    windowMs: rateLimitWindowMs,
  });
  const sessionRequestLimiter = new FixedWindowRateLimiter({
    limit: config.sessionRequestLimit ?? 120,
    windowMs: rateLimitWindowMs,
  });

  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(response, 200, { status: 'ok' });
    }

    if (request.method === 'GET' && url.pathname === '/readyz') {
      const ready = isReady();
      return sendJson(response, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
      });
    }

    if (request.method === 'GET' && url.pathname === '/metrics') {
      if (bearerToken(request) !== config.token) {
        return sendJson(response, 401, { error: 'Unauthorized' });
      }
      response.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(metrics.render(sessions.stats(), {
        lavalinkSessions: lavalinkCompat.sessionCount(),
      }));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/sessions') {
      if (!applyRateLimit(response, sessionCreateLimiter.consume(
        request.socket.remoteAddress || 'unknown',
      ))) return;
      if (bearerToken(request) !== config.token) {
        return sendJson(response, 401, { error: 'Unauthorized' });
      }
      const body = await readJson(request);
      const session = sessions.create(body.clientName);
      logger.info({ sessionId: session.id }, 'Client session created');
      return sendJson(response, 201, {
        sessionId: session.id,
        sessionToken: session.token,
        websocketUrl: '/v1/ws',
      });
    }

    if (request.method === 'GET' && url.pathname === '/v1/stats') {
      if (bearerToken(request) !== config.token) {
        return sendJson(response, 401, { error: 'Unauthorized' });
      }
      if (!applyRateLimit(response, sessionRequestLimiter.consume('node-token'))) return;
      return sendJson(response, 200, sessions.stats());
    }

    if (request.method === 'GET' && url.pathname === '/v1/sources') {
      if (bearerToken(request) !== config.token) {
        return sendJson(response, 401, { error: 'Unauthorized' });
      }
      if (!applyRateLimit(response, sessionRequestLimiter.consume('node-token'))) return;
      return sendJson(response, 200, { sources: sourceManager.listSources() });
    }

    const sessionMatch = url.pathname.match(SESSION_PATH);
    const loadTracksMatch = url.pathname.match(LOADTRACKS_PATH);
    const searchMatch = url.pathname.match(SEARCH_PATH);
    const catalogMatch = url.pathname.match(CATALOG_PATH);
    const metadataMatch = url.pathname.match(METADATA_PATH);
    if (sessionMatch && request.method === 'DELETE') {
      const [, sessionId] = sessionMatch;
      const session = sessions.authenticate(sessionId, bearerToken(request));
      if (!session) {
        return sendJson(response, 401, { error: 'Unauthorized' });
      }
      if (!applyRateLimit(response, sessionRequestLimiter.consume(session.id))) return;
      sessions.remove(sessionId);
      return sendJson(response, 200, { deleted: true });
    }

    if (!url.pathname.startsWith('/v1/sessions/')) {
      return sendJson(response, 404, { error: 'Not found' });
    }

    const playerMatch = url.pathname.match(PLAYER_PATH);
    const sessionId = playerMatch?.[1] || loadTracksMatch?.[1] ||
      searchMatch?.[1] || catalogMatch?.[1] || metadataMatch?.[1] || sessionMatch?.[1];
    const session = sessionId && sessions.authenticate(sessionId, bearerToken(request));
    if (!session) return sendJson(response, 401, { error: 'Unauthorized' });
    if (!applyRateLimit(response, sessionRequestLimiter.consume(session.id))) return;

    if (request.method === 'POST' && loadTracksMatch) {
      const body = await readJson(request);
      if (typeof body.identifier !== 'string') {
        return sendJson(response, 400, { error: 'identifier must be a URL string' });
      }
      try {
        if (body.source !== undefined) {
          if (typeof body.source !== 'string') {
            return sendJson(response, 400, { error: 'source must be a string' });
          }
          const playlist = await sourceManager.resolvePlaylist(body.source, body.identifier);
          return sendJson(response, 200, {
            loadType: 'playlist',
            playlistInfo: {
              name: playlist.name,
              selectedTrack: playlist.selectedTrack,
            },
            tracks: playlist.tracks,
          });
        }
        const loaded = await sourceManager.load(body.identifier);
        if (loaded.loadType === 'playlist') {
          return sendJson(response, 200, {
            loadType: 'playlist',
            playlistInfo: {
              name: loaded.playlist.name,
              selectedTrack: loaded.playlist.selectedTrack,
            },
            tracks: loaded.playlist.tracks,
          });
        }
        return sendJson(response, 200, { loadType: 'track', tracks: [loaded.track] });
      } catch (error) {
        logger.warn({
          sourceId: error.message.match(/Source "([^"]+)"/)?.[1] || null,
          errorType: error.name,
          statusCode: error.statusCode || 400,
        }, 'Track resolution failed');
        return sendJson(response, errorStatus(error, 400), { error: error.message });
      }
    }

    if (request.method === 'POST' && searchMatch) {
      const body = await readJson(request);
      if (typeof body.query !== 'string' ||
          (body.source !== undefined && typeof body.source !== 'string')) {
        return sendJson(response, 400, {
          error: 'query must be a string and source, when provided, must be a string',
        });
      }
      try {
        if (body.source !== undefined) {
          const tracks = await sourceManager.search(
            body.source,
            body.query,
            { limit: body.limit },
          );
          return sendJson(response, 200, {
            loadType: 'search',
            source: body.source,
            tracks,
          });
        }
        return sendJson(response, 200, await sourceManager.searchAll(
          body.query,
          { limit: body.limit },
        ));
      } catch (error) {
        logger.warn({
          sourceId: body.source ?? null,
          errorType: error.name,
          statusCode: error.statusCode || 502,
        }, 'Catalog search failed');
        return sendJson(response, errorStatus(error, 502), { error: error.message });
      }
    }

    if (request.method === 'POST' && (catalogMatch || metadataMatch)) {
      const body = await readJson(request);
      if (typeof body.source !== 'string' || typeof body.identifier !== 'string') {
        return sendJson(response, 400, {
          error: 'source and identifier must be strings',
        });
      }
      try {
        const result = catalogMatch
          ? await sourceManager.resolveCatalog(body.source, body.identifier)
          : await sourceManager.getMetadata(body.source, body.identifier);
        return sendJson(response, 200, catalogMatch
          ? {
            playable: result.playable === true,
            info: publicMetadata(result.info),
          }
          : publicMetadata(result));
      } catch (error) {
        logger.warn({
          sourceId: body.source,
          operation: catalogMatch ? 'catalog' : 'metadata',
          errorType: error.name,
          statusCode: error.statusCode || 502,
        }, 'Source metadata operation failed');
        return sendJson(response, errorStatus(error, 502), { error: error.message });
      }
    }

    if (!playerMatch) return sendJson(response, 404, { error: 'Not found' });
    const [, , guildId] = playerMatch;
    let player = session.players.get(guildId);

    if (request.method === 'POST') {
      const body = await readJson(request);
      if (body.op === 'join') {
        if (typeof body.channelId !== 'string' || !/^\d{15,22}$/.test(body.channelId)) {
          return sendJson(response, 400, { error: 'channelId must be a Discord snowflake' });
        }
        if (!player && session.players.size >= sessions.maxPlayers) {
          return sendJson(response, 429, { error: 'Player limit reached' });
        }
        if (!player) {
          player = new Player({
            session,
            guildId,
            idleTimeoutMs: sessions.idleTimeoutMs,
            logger: logger.child({ sessionId: session.id, guildId }),
            metrics,
            onDestroy: (id) => session.players.delete(id),
          });
          session.players.set(guildId, player);
        }
        try {
          player.join(body);
          return sendJson(response, 200, player.snapshot());
        } catch (error) {
          return sendJson(response, 400, { error: error.message });
        }
      }
      if (body.op === 'stop' && player) {
        return sendJson(response, 200, player.stop());
      }
      return sendJson(response, 404, { error: 'Player not found or operation unsupported' });
    }

    if (request.method === 'PATCH') {
      if (!player) return sendJson(response, 404, { error: 'Player not found' });
      const body = await readJson(request);
      try {
        if (body.op === 'play') return sendJson(response, 200, await player.play(body.track));
        if (body.op === 'pause') {
          if (typeof body.paused !== 'boolean') {
            return sendJson(response, 400, { error: 'paused must be a boolean' });
          }
          return sendJson(response, 200, player.pause(body.paused));
        }
        if (body.op === 'seek') return sendJson(response, 200, await player.seek(body.position));
        if (body.op === 'volume') return sendJson(response, 200, player.setVolume(body.volume));
        if (body.op === 'filters') return sendJson(response, 200, await player.setFilters(body.filters));
        return sendJson(response, 400, { error: 'Unsupported player operation' });
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }

    if (request.method === 'GET') {
      if (!player) return sendJson(response, 404, { error: 'Player not found' });
      return sendJson(response, 200, player.snapshot());
    }

    if (request.method === 'DELETE') {
      if (!player) return sendJson(response, 404, { error: 'Player not found' });
      player.destroy();
      session.players.delete(guildId);
      return sendJson(response, 200, { deleted: true });
    }

    return sendJson(response, 405, { error: 'Method not allowed' });
  };
}

export function createAudioNode(
  config,
  sessions,
  {
    logger = createLogger(config.logLevel),
    resolverRegistry = new ResolverRegistry([createSoundCloudResolver(config)]),
    catalogSearch = createCatalogSearch(config),
    sourceManager,
    pluginManager,
    metrics = new NodeMetrics(),
    lavalinkPlayerFactory,
  } = {},
) {
  const activeSourceManager = sourceManager || createSourceManager({
    resolverRegistry,
    catalogSearch,
    config,
    pluginManager,
    logger,
  });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });
  const lavalinkCompat = createLavalinkCompat({
    config,
    sessions,
    sourceManager: activeSourceManager,
    pluginManager,
    logger,
    metrics,
    ...(lavalinkPlayerFactory ? { playerFactory: lavalinkPlayerFactory } : {}),
  });
  let ready = false;
  const sessionApi = createSessionApi({
    config,
    sessions,
    logger,
    metrics,
    lavalinkCompat,
    sourceManager: activeSourceManager,
    isReady: () => ready,
  });
  const server = createHttpServer((request, response) => {
    const requestId = randomUUID();
    response.setHeader('x-request-id', requestId);
    response.once('finish', () => metrics.recordHttpRequest(request.method, response.statusCode));
    Promise.resolve().then(async () => {
      if (await lavalinkCompat.handleRequest(request, response)) return;
      await sessionApi(request, response);
    }).catch((error) => {
      logger.error({
        err: error,
        requestId,
        method: request.method,
        path: requestPath(request),
      }, 'HTTP request failed');
      if (!response.headersSent) {
        sendJson(response, error.statusCode || 500, {
          error: error.statusCode ? error.message : 'Internal server error',
        });
      } else {
        response.destroy(error);
      }
    });
  });

  server.on('upgrade', (request, socket, head) => {
    if (lavalinkCompat.handleUpgrade(request, socket, head)) return;
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/v1/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket);
    });
  });

  websocketServer.on('connection', (websocket) => {
    let session;
    const authTimer = setTimeout(() => websocket.close(1008, 'Authentication required'), 5000);
    authTimer.unref?.();
    websocket.on('error', (error) => {
      logger.warn({ errorCode: error.code, errorType: error.name }, 'WebSocket error');
    });

    websocket.on('message', (message) => {
      let packet;
      try {
        packet = JSON.parse(message.toString());
      } catch {
        websocket.close(1007, 'Invalid JSON');
        return;
      }

      if (!session) {
        if (packet.op !== 'authenticate' || typeof packet.sessionId !== 'string') {
          websocket.close(1008, 'Authenticate first');
          return;
        }
        session = sessions.authenticate(packet.sessionId, packet.sessionToken);
        if (!session) {
          websocket.close(1008, 'Invalid session credentials');
          return;
        }
        clearTimeout(authTimer);
        session.socket?.close(1000, 'Replaced by a newer connection');
        session.socket = websocket;
        websocket.send(JSON.stringify({ op: 'ready', sessionId: session.id }));
        return;
      }

      if (packet.op === 'voice:update') {
        const player = session.players.get(packet.guildId);
        try {
          if (!player) throw new Error('Player not found');
          player.updateVoice(packet.event, packet.data);
        } catch (error) {
          websocket.send(JSON.stringify({
            op: 'error',
            error: error.message,
            guildId: packet.guildId,
          }));
        }
      }
    });

    websocket.on('close', () => {
      clearTimeout(authTimer);
      if (session?.socket === websocket) session.socket = null;
    });
  });

  return {
    server,
    websocketServer,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          ready = true;
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      ready = false;
      for (const session of sessions.values()) sessions.remove(session.id);
      lavalinkCompat.close();
      websocketServer.close();
      const shutdownErrors = [];
      try {
        await new Promise((resolve, reject) => {
          if (!server.listening) return resolve();
          server.close((error) => error ? reject(error) : resolve());
        });
      } catch (error) {
        shutdownErrors.push(error);
      }
      try {
        await pluginManager?.close?.();
      } catch (error) {
        shutdownErrors.push(error);
      }
      if (shutdownErrors.length) {
        throw new AggregateError(shutdownErrors, 'Audio Node shutdown failed');
      }
    },
  };
}
