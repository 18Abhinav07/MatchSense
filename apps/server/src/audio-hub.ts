import type { EventEmitter } from "node:events";

import { createPacedMp3Chunks } from "./mp3.js";

export interface AudioWritable {
  write(bytes: Buffer): boolean;
  end?(): void;
  destroy?(): void;
  once?: EventEmitter["once"];
  removeListener?: EventEmitter["removeListener"];
}

interface ClientState {
  blocked: boolean;
  media: Buffer[];
  mediaBytes: number;
  queued: Buffer[];
  queuedBytes: number;
  drain: (() => void) | null;
  disconnect: (() => void) | null;
}

interface ClientEntry {
  client: AudioWritable;
  sessionId: string;
  state: ClientState;
}

export function createAudioHub(options: {
  silenceBytes: Buffer;
  cueBytes: Buffer;
  writeIntervalMs: number;
  createMediaChunks?: (bytes: Buffer) => readonly Buffer[];
  maxClientBacklogBytes?: number;
}) {
  // The proven Spike 0 contract tracks the outgoing response itself. A mobile
  // reconnect can open a replacement response before the prior response emits
  // close, so sessionId is a fan-out group, never a uniqueness key.
  const clients = new Map<AudioWritable, ClientEntry>();
  const acceptedEventIds = new Set<string>();
  const maxBacklog = options.maxClientBacklogBytes ?? 512 * 1024;
  const createMediaChunks =
    options.createMediaChunks ??
    ((bytes: Buffer) => createPacedMp3Chunks(bytes, options.silenceBytes));
  let timer: ReturnType<typeof setInterval> | null = null;

  const detachResponse = (client: AudioWritable) => {
    const entry = clients.get(client);
    if (!entry) return false;
    clients.delete(client);
    const { state } = entry;
    if (state.disconnect) {
      client.removeListener?.("close", state.disconnect);
      client.removeListener?.("error", state.disconnect);
    }
    if (state.drain) client.removeListener?.("drain", state.drain);
    state.queued.length = 0;
    state.queuedBytes = 0;
    state.media.length = 0;
    state.mediaBytes = 0;
    return true;
  };

  const closeResponse = (client: AudioWritable) => {
    if (!detachResponse(client)) return false;
    try {
      if (client.end) client.end();
      else client.destroy?.();
    } catch {
      client.destroy?.();
    }
    return true;
  };

  const dropResponse = (client: AudioWritable) => {
    if (!detachResponse(client)) return;
    client.destroy?.();
  };

  const flush = (client: AudioWritable) => {
    const entry = clients.get(client);
    if (!entry) return;
    const { state } = entry;
    while (!state.blocked && state.queued.length > 0) {
      const bytes = state.queued.shift();
      if (!bytes) return;
      state.queuedBytes -= bytes.length;
      try {
        if (!client.write(bytes)) {
          state.blocked = true;
          attachDrain(client);
        }
      } catch {
        dropResponse(client);
      }
    }
  };

  const attachDrain = (client: AudioWritable) => {
    const entry = clients.get(client);
    if (!entry || entry.state.drain || !client.once) return;
    const drain = () => {
      const current = clients.get(client);
      if (!current) return;
      current.state.drain = null;
      current.state.blocked = false;
      flush(client);
    };
    entry.state.drain = drain;
    client.once("drain", drain);
  };

  const write = (client: AudioWritable, bytes: Buffer) => {
    const entry = clients.get(client);
    if (!entry) return;
    const { state } = entry;
    if (state.blocked) {
      if (state.queuedBytes + bytes.length > maxBacklog) {
        dropResponse(client);
        return;
      }
      state.queued.push(bytes);
      state.queuedBytes += bytes.length;
      return;
    }
    try {
      if (!client.write(bytes)) {
        state.blocked = true;
        attachDrain(client);
      }
    } catch {
      dropResponse(client);
    }
  };

  const addClient = (sessionId: string, client: AudioWritable) => {
    if (clients.has(client)) return false;
    const disconnect = () => detachResponse(client);
    clients.set(client, {
      client,
      sessionId,
      state: {
        blocked: false,
        disconnect,
        drain: null,
        media: [],
        mediaBytes: 0,
        queued: [],
        queuedBytes: 0,
      },
    });
    client.once?.("close", disconnect);
    client.once?.("error", disconnect);
    // Give the decoder valid bytes immediately, then an audible cue so iOS
    // promotes the stream to Now Playing before later commentary arrives.
    write(client, options.silenceBytes);
    write(client, options.cueBytes);
    return true;
  };

  const inject = (
    eventId: string,
    sessionIds: readonly string[],
    bytes = options.cueBytes,
  ) => {
    if (acceptedEventIds.has(eventId)) return false;
    const targetSessions = new Set(sessionIds);
    const attached = [...clients.values()].filter((entry) =>
      targetSessions.has(entry.sessionId),
    );
    if (attached.length === 0) return false;
    acceptedEventIds.add(eventId);
    const chunks = createMediaChunks(bytes);
    for (const entry of attached) {
      for (const chunk of chunks) {
        if (entry.state.mediaBytes + chunk.length > maxBacklog) {
          dropResponse(entry.client);
          break;
        }
        entry.state.media.push(Buffer.from(chunk));
        entry.state.mediaBytes += chunk.length;
      }
    }
    return true;
  };

  const writeSilence = () => {
    for (const entry of [...clients.values()]) {
      const media = entry.state.media.shift();
      if (media) entry.state.mediaBytes -= media.length;
      write(entry.client, media ?? options.silenceBytes);
    }
  };

  const removeClient = (sessionId: string) => {
    let removed = false;
    for (const entry of [...clients.values()]) {
      if (entry.sessionId === sessionId) {
        removed = closeResponse(entry.client) || removed;
      }
    }
    return removed;
  };

  const start = () => {
    if (timer) return false;
    timer = setInterval(writeSilence, options.writeIntervalMs);
    timer.unref?.();
    return true;
  };

  const stop = () => {
    let changed = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
      changed = true;
    }
    for (const client of [...clients.keys()]) {
      changed = closeResponse(client) || changed;
    }
    return changed;
  };

  return {
    addClient,
    inject,
    removeClient,
    start,
    status: () => ({
      eventCount: acceptedEventIds.size,
      listenerCount: clients.size,
    }),
    stop,
    writeSilence,
  };
}

export type AudioHub = ReturnType<typeof createAudioHub>;
