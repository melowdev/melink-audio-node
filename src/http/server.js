// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { createServer as createHttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { resolveIdentifier } from '../audio/resolver.js';
import { Player } from '../core/player.js';

const MAX_BODY_BYTES = 64 * 1024;
const SESSION_PATH = /^\/v1\/sessions\/([0-9a-f-]{36})$/i;
const LOADTRACKS_PATH = /^\/v1\/sessions\/([0-9a-f-]{36})\/loadtracks$/i;
const PLAYER_PATH = /^\/v1\/sessions\/([0-9a-f-]{36})\/players\/(\d{15,22})$/i;

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
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

function createSessionApi({ config, sessions }) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(response, 200, { status: 'ok' });
    }

    if (request.method === 'POST' && url.pathname === '/v1/sessions') {
      if (bearerToken(request) !== config.token) {
        return sendJson(response, 401, { error: 'Unauthorized' });
      }
      const body = await readJson(request);
      const session = sessions.create(body.clientName);
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
      return sendJson(response, 200, sessions.stats());
    }

    const sessionMatch = url.pathname.match(SESSION_PATH);
    const loadTracksMatch = url.pathname.match(LOADTRACKS_PATH);
    if (sessionMatch && request.method === 'DELETE') {
      const [, sessionId] = sessionMatch;
      if (!sessions.authenticate(sessionId, bearerToken(request))) {
        return sendJson(response, 401, { error: 'Unauthorized' });
      }
      sessions.remove(sessionId);
      return sendJson(response, 200, { deleted: true });
    }

    if (!url.pathname.startsWith('/v1/sessions/')) {
      return sendJson(response, 404, { error: 'Not found' });
    }

    const playerMatch = url.pathname.match(PLAYER_PATH);
    const sessionId = playerMatch?.[1] || loadTracksMatch?.[1] || sessionMatch?.[1];
    const session = sessionId && sessions.authenticate(sessionId, bearerToken(request));
    if (!session) return sendJson(response, 401, { error: 'Unauthorized' });

    if (request.method === 'POST' && loadTracksMatch) {
      const body = await readJson(request);
      if (typeof body.identifier !== 'string') {
        return sendJson(response, 400, { error: 'identifier must be a URL string' });
      }
      try {
        const track = resolveIdentifier(body.identifier);
        return sendJson(response, 200, { loadType: 'track', tracks: [track] });
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
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
        if (body.op === 'pause') return sendJson(response, 200, player.pause(Boolean(body.paused)));
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

export function createAudioNode(config, sessions) {
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });
  const server = createHttpServer((request, response) => {
    createSessionApi({ config, sessions })(request, response).catch((error) => {
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
      console.error(`WebSocket error: ${error.message}`);
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
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      for (const session of sessions.values()) sessions.remove(session.id);
      websocketServer.close();
      return new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
