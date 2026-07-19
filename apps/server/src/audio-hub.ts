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

export function createAudioHub(options: {
  silenceBytes: Buffer;
  cueBytes: Buffer;
  writeIntervalMs: number;
  createMediaChunks?: (bytes: Buffer) => readonly Buffer[];
  maxClientBacklogBytes?: number;
}) {
  const clients = new Map<
    string,
    { client: AudioWritable; state: ClientState }
  >();
  const acceptedEventIds = new Set<string>();
  const maxBacklog = options.maxClientBacklogBytes ?? 512 * 1024;
  const createMediaChunks =
    options.createMediaChunks ??
    ((bytes: Buffer) => createPacedMp3Chunks(bytes, options.silenceBytes));
  let timer: ReturnType<typeof setInterval> | null = null;

  const detachClient = (sessionId: string) => {
    const entry = clients.get(sessionId);
    if (!entry) return false;
    clients.delete(sessionId);
    const { client, state } = entry;
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

  const removeClient = (sessionId: string) => {
    const entry = clients.get(sessionId);
    if (!entry || !detachClient(sessionId)) return false;
    try {
      if (entry.client.end) entry.client.end();
      else entry.client.destroy?.();
    } catch {
      entry.client.destroy?.();
    }
    return true;
  };

  const dropClient = (sessionId: string) => {
    const entry = clients.get(sessionId);
    if (!entry) return;
    detachClient(sessionId);
    entry.client.destroy?.();
  };

  const flush = (sessionId: string) => {
    const entry = clients.get(sessionId);
    if (!entry) return;
    const { client, state } = entry;
    while (!state.blocked && state.queued.length > 0) {
      const bytes = state.queued.shift();
      if (!bytes) return;
      state.queuedBytes -= bytes.length;
      try {
        if (!client.write(bytes)) {
          state.blocked = true;
          attachDrain(sessionId);
        }
      } catch {
        dropClient(sessionId);
      }
    }
  };

  const attachDrain = (sessionId: string) => {
    const entry = clients.get(sessionId);
    if (!entry || entry.state.drain || !entry.client.once) return;
    const drain = () => {
      const current = clients.get(sessionId);
      if (!current) return;
      current.state.drain = null;
      current.state.blocked = false;
      flush(sessionId);
    };
    entry.state.drain = drain;
    entry.client.once("drain", drain);
  };

  const write = (sessionId: string, bytes: Buffer) => {
    const entry = clients.get(sessionId);
    if (!entry) return;
    const { client, state } = entry;
    if (state.blocked) {
      if (state.queuedBytes + bytes.length > maxBacklog) {
        dropClient(sessionId);
        return;
      }
      state.queued.push(bytes);
      state.queuedBytes += bytes.length;
      return;
    }
    try {
      if (!client.write(bytes)) {
        state.blocked = true;
        attachDrain(sessionId);
      }
    } catch {
      dropClient(sessionId);
    }
  };

  const addClient = (sessionId: string, client: AudioWritable) => {
    if (clients.has(sessionId)) return false;
    const disconnect = () => detachClient(sessionId);
    clients.set(sessionId, {
      client,
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
    // Send one complete silent frame group before the audible connection cue
    // so decoders lock onto the stream contract before sound begins. The cue
    // is intentional: iOS promotes an actually-audible HTML audio stream to
    // Now Playing / lock-screen media controls, while an indefinitely silent
    // stream can remain invisible even though bytes are being consumed.
    write(sessionId, options.silenceBytes);
    write(sessionId, options.cueBytes);
    return true;
  };

  const inject = (
    eventId: string,
    sessionIds: readonly string[],
    bytes = options.cueBytes,
  ) => {
    if (acceptedEventIds.has(eventId)) return false;
    const attached = sessionIds.filter((sessionId) => clients.has(sessionId));
    if (attached.length === 0) return false;
    acceptedEventIds.add(eventId);
    const chunks = createMediaChunks(bytes);
    for (const sessionId of attached) {
      const entry = clients.get(sessionId);
      if (!entry) continue;
      for (const chunk of chunks) {
        if (entry.state.mediaBytes + chunk.length > maxBacklog) {
          dropClient(sessionId);
          break;
        }
        entry.state.media.push(Buffer.from(chunk));
        entry.state.mediaBytes += chunk.length;
      }
    }
    return true;
  };

  const writeSilence = () => {
    for (const [sessionId, entry] of clients) {
      const media = entry.state.media.shift();
      if (media) entry.state.mediaBytes -= media.length;
      write(sessionId, media ?? options.silenceBytes);
    }
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
    for (const sessionId of [...clients.keys()]) {
      changed = removeClient(sessionId) || changed;
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
