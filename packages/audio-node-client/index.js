// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class AudioNodeClient extends EventEmitter {
  #destroyed = false;
  #connected = false;
  #reconnectTimer = null;
  #reconnectAttempts = 0;

  constructor({ baseUrl, token, discordClient, clientName = 'discord-bot' }) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.discordClient = discordClient;
    this.clientName = clientName;
    this.session = null;
    this.socket = null;
    this.adapters = new Map();
  }

  async connect() {
    if (this.#connected) return this;
    this.#destroyed = false;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#reconnectAttempts = 0;
    if (!this.session) await this.#createSession();
    await this.#openSocket();
    return this;
  }

  async #createSession() {
    const response = await fetch(`${this.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ clientName: this.clientName }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Could not create Audio Node session');
    this.session = body;
  }

  async #openSocket() {
    const wsUrl = new URL(this.session.websocketUrl, this.baseUrl);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(wsUrl, { maxPayload: 64 * 1024 });
    this.socket = socket;
    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error('Audio Node WebSocket authentication timed out'));
      }, 5000);
      socket.once('open', () => {
        socket.send(JSON.stringify({
          op: 'authenticate',
          sessionId: this.session.sessionId,
          sessionToken: this.session.sessionToken,
        }));
      });
      socket.on('message', (data) => {
        try {
          const packet = JSON.parse(data.toString());
          if (packet.op === 'ready') {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            this.#connected = true;
            resolve();
          } else {
            this.#onPacket(packet);
          }
        } catch (error) {
          if (settled) {
            this.emit('error', error);
          } else {
            settled = true;
            clearTimeout(timeout);
            reject(error);
          }
        }
      });
      socket.on('error', (error) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(error);
        } else this.emit('error', error);
      });
      socket.once('close', (code, reason) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error('Audio Node closed the WebSocket before authentication'));
        }
        if (this.socket === socket) this.socket = null;
        const wasConnected = this.#connected;
        this.#connected = false;
        if (!wasConnected) return;
        this.emit('disconnect', { code, reason: reason.toString() });
        this.#scheduleReconnect();
      });
    });
  }

  #scheduleReconnect(lastError) {
    if (this.#destroyed || this.#reconnectTimer) return;
    if (this.#reconnectAttempts >= 8) {
      this.emit('reconnectFailed', lastError || new Error('Audio Node reconnect attempts exhausted'));
      return;
    }

    const attempt = this.#reconnectAttempts + 1;
    const delayMs = Math.min(250 * (2 ** (attempt - 1)), 10_000);
    this.emit('reconnecting', { attempt, delayMs });
    this.#reconnectTimer = setTimeout(async () => {
      this.#reconnectTimer = null;
      this.#reconnectAttempts = attempt;
      try {
        await this.#openSocket();
        this.#reconnectAttempts = 0;
        this.emit('reconnect', { attempts: attempt });
      } catch (error) {
        this.emit('reconnectAttemptFailed', { attempt, error });
        this.#scheduleReconnect(error);
      }
    }, delayMs);
    this.#reconnectTimer.unref?.();
  }

  async join(guildId, channelId, { selfDeaf = true, selfMute = false } = {}) {
    const guild = await this.discordClient.guilds.fetch(guildId);
    if (!guild) throw new Error(`Guild ${guildId} was not found`);
    if (!this.adapters.has(guildId)) {
      const adapter = guild.voiceAdapterCreator({
        onVoiceStateUpdate: (data) => this.#send({
          op: 'voice:update', guildId, event: 'state', data,
        }),
        onVoiceServerUpdate: (data) => this.#send({
          op: 'voice:update', guildId, event: 'server', data,
        }),
      });
      this.adapters.set(guildId, adapter);
    }
    return this.#request(`/v1/sessions/${this.session.sessionId}/players/${guildId}`, {
      method: 'POST',
      body: { op: 'join', channelId, selfDeaf, selfMute },
    });
  }

  async loadTracks(identifier) {
    return this.#request(`/v1/sessions/${this.session.sessionId}/loadtracks`, {
      method: 'POST',
      body: { identifier },
    });
  }

  async searchTracks(sourceOrQuery, queryOrOptions, options = {}) {
    let source;
    let query;
    let requestOptions;
    if (typeof queryOrOptions === 'string') {
      source = sourceOrQuery;
      query = queryOrOptions;
      requestOptions = options;
    } else {
      query = sourceOrQuery;
      requestOptions = queryOrOptions || {};
    }

    if (!requestOptions || typeof requestOptions !== 'object' ||
        Array.isArray(requestOptions)) {
      throw new TypeError('Search options must be an object');
    }
    const body = {
      ...(source === undefined ? {} : { source }),
      query,
      ...(requestOptions.limit === undefined ? {} : { limit: requestOptions.limit }),
    };
    return this.#request(`/v1/sessions/${this.session.sessionId}/search`, {
      method: 'POST',
      body,
    });
  }

  async play(guildId, track) {
    return this.#playerRequest(guildId, 'PATCH', { op: 'play', track });
  }

  async pause(guildId, paused = true) {
    return this.#playerRequest(guildId, 'PATCH', { op: 'pause', paused });
  }

  async seek(guildId, position) {
    return this.#playerRequest(guildId, 'PATCH', { op: 'seek', position });
  }

  async setVolume(guildId, volume) {
    return this.#playerRequest(guildId, 'PATCH', { op: 'volume', volume });
  }

  async setFilters(guildId, filters) {
    return this.#playerRequest(guildId, 'PATCH', { op: 'filters', filters });
  }

  async stop(guildId) {
    return this.#playerRequest(guildId, 'POST', { op: 'stop' });
  }

  async leave(guildId) {
    const result = await this.#playerRequest(guildId, 'DELETE');
    this.adapters.get(guildId)?.destroy();
    this.adapters.delete(guildId);
    return result;
  }

  async destroy() {
    this.#destroyed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#connected = false;
    this.socket?.close(1000, 'Client destroyed');
    for (const adapter of this.adapters.values()) adapter.destroy();
    this.adapters.clear();
    const session = this.session;
    try {
      if (session) {
        await this.#request(`/v1/sessions/${session.sessionId}`, { method: 'DELETE' });
      }
    } finally {
      this.session = null;
    }
  }

  #onPacket(packet) {
    if (packet.op === 'voice:payload') {
      const adapter = this.adapters.get(packet.guildId);
      if (!adapter) {
        this.emit('error', new Error(`No Discord voice adapter for guild ${packet.guildId}`));
        return;
      }
      adapter.sendPayload(packet.payload);
      return;
    }
    if (packet.op === 'error') {
      this.emit('error', new Error(packet.error));
      return;
    }
    this.emit(packet.op, packet);
  }

  async #playerRequest(guildId, method, body) {
    return this.#request(
      `/v1/sessions/${this.session.sessionId}/players/${guildId}`,
      { method, body },
    );
  }

  async #request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.session.sessionToken}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Audio Node returned HTTP ${response.status}`);
    return result;
  }

  #send(packet) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.emit('error', new Error('Audio Node WebSocket is not connected'));
      return;
    }
    this.socket.send(JSON.stringify(packet));
  }
}
