import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';

export interface SearchOptions {
  limit?: number;
}

export interface SearchTrackInfo {
  identifier?: string;
  title?: string;
  author?: string;
  length?: number;
  uri?: string;
  sourceName?: string;
  isSeekable?: boolean;
  isStream?: boolean;
  position?: number;
}

export interface SearchTrack {
  playable: boolean;
  info: SearchTrackInfo;
}

export interface SingleSourceSearchResult {
  loadType: 'search';
  source: string;
  tracks: SearchTrack[];
}

export interface SearchSourceResult {
  source: string;
  success: boolean;
  count: number;
}

export interface SearchSourceError {
  source: string;
  message: string;
  statusCode: number;
}

export interface MultiSourceSearchResult {
  loadType: 'search';
  query: string;
  total: number;
  tracks: SearchTrack[];
  sources: SearchSourceResult[];
  errors: SearchSourceError[];
  successfulSources: number;
  failedSources: number;
}

export interface LoadedTrack {
  encoded?: string;
  info: SearchTrackInfo;
}

export interface LoadTracksResult {
  loadType: 'track' | 'playlist' | 'search' | 'empty';
  tracks: LoadedTrack[];
  playlistInfo?: {
    name: string;
    selectedTrack: number;
  };
}

export interface AudioNodeClientOptions {
  baseUrl: string;
  token: string;
  discordClient: Client;
  clientName?: string;
}

export class AudioNodeClient extends EventEmitter {
  constructor(options: AudioNodeClientOptions);

  session: {
    sessionId: string;
    sessionToken: string;
    websocketUrl: string;
  } | null;

  connect(): Promise<this>;
  join(
    guildId: string,
    channelId: string,
    options?: { selfDeaf?: boolean; selfMute?: boolean },
  ): Promise<unknown>;
  loadTracks(identifier: string): Promise<LoadTracksResult>;
  searchTracks(
    source: string,
    query: string,
    options?: SearchOptions,
  ): Promise<SingleSourceSearchResult>;
  searchTracks(
    query: string,
    options?: SearchOptions,
  ): Promise<MultiSourceSearchResult>;
  play(guildId: string, track: LoadedTrack): Promise<unknown>;
  pause(guildId: string, paused?: boolean): Promise<unknown>;
  seek(guildId: string, position: number): Promise<unknown>;
  setVolume(guildId: string, volume: number): Promise<unknown>;
  setFilters(guildId: string, filters: Record<string, unknown>): Promise<unknown>;
  stop(guildId: string): Promise<unknown>;
  leave(guildId: string): Promise<unknown>;
  destroy(): Promise<void>;
}
