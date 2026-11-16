// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class AudioNodeClient extends EventEmitter {
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

    const wsUrl = new URL(body.websocketUrl, this.baseUrl);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(wsUrl, { maxPayload: 64 * 1024 });
    await new Promise((resolve, reject) => {
      let authenticated = false;
      const timeout = setTimeout(
        () => reject(new Error('Audio Node WebSocket authentication timed out')),
        5000,
      );
      this.socket.once('open', () => {
        this.socket.send(JSON.stringify({
          op: 'authenticate',
          sessionId: body.sessionId,
          sessionToken: body.sessionToken,
        }));
      });
      this.socket.on('message', (data) => {
        try {
          const packet = JSON.parse(data.toString());
          if (packet.op === 'ready') {
            authenticated = true;
            clearTimeout(timeout);
            resolve();
          } else {
            this.#onPacket(packet);
          }
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
      this.socket.once('error', (error) => {
        clearTimeout(timeout);
        if (!authenticated) reject(error);
        else this.emit('error', error);
      });
      this.socket.once('close', (code, reason) => {
        clearTimeout(timeout);
        if (!authenticated) reject(new Error('Audio Node closed the WebSocket before authentication'));
        if (!this.session) return;
        this.emit('disconnect', { code, reason: reason.toString() });
      });
    });
    return this;
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

  async play(guildId, track) {
    return this.#playerRequest(guildId, 'PATCH', { op: 'play', track });
  }

  async pause(guildId, paused = true) {
    return this.#playerRequest(guildId, 'PATCH', { op: 'pause', paused });
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
    this.socket?.close(1000, 'Client destroyed');
    for (const adapter of this.adapters.values()) adapter.destroy();
    this.adapters.clear();
    if (this.session) {
      await this.#request(`/v1/sessions/${this.session.sessionId}`, { method: 'DELETE' });
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
