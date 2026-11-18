// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class SessionManager {
  #sessions = new Map();
  #maxPlayers;
  #idleTimeoutMs;

  constructor({ maxPlayers, idleTimeoutMs }) {
    this.#maxPlayers = maxPlayers;
    this.#idleTimeoutMs = idleTimeoutMs;
  }

  create(clientName = 'unknown') {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const session = {
      id,
      token,
      clientName: String(clientName).slice(0, 100),
      createdAt: new Date().toISOString(),
      players: new Map(),
      socket: null,
      send(op, data = {}) {
        if (!this.socket || this.socket.readyState !== 1) return false;
        this.socket.send(JSON.stringify({ op, ...data }));
        return true;
      },
    };
    this.#sessions.set(id, session);
    return session;
  }

  get(id) {
    return this.#sessions.get(id);
  }

  authenticate(id, token) {
    const session = this.#sessions.get(id);
    return session && typeof token === 'string' && constantTimeEqual(session.token, token)
      ? session
      : undefined;
  }

  remove(id) {
    const session = this.#sessions.get(id);
    if (!session) return false;
    for (const player of session.players.values()) player.destroy();
    session.socket?.close(1000, 'Session closed');
    this.#sessions.delete(id);
    return true;
  }

  get maxPlayers() {
    return this.#maxPlayers;
  }

  get idleTimeoutMs() {
    return this.#idleTimeoutMs;
  }

  stats() {
    let playerCount = 0;
    for (const session of this.#sessions.values()) playerCount += session.players.size;
    return {
      sessions: this.#sessions.size,
      players: playerCount,
      uptime: Math.floor(process.uptime()),
      memory: process.memoryUsage(),
    };
  }

  values() {
    return this.#sessions.values();
  }
}
