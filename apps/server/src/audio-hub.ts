import type { EventEmitter } from "node:events";

export interface AudioWritable {
  write(bytes: Buffer): boolean;
  end?(): void;
  destroy?(): void;
  once?: EventEmitter["once"];
  removeListener?: EventEmitter["removeListener"];
}

interface ClientState {
  blocked: boolean;
  queued: Buffer[];
  queuedBytes: number;
  drain: (() => void) | null;
  disconnect: (() => void) | null;
}

export function createAudioHub(options: {
  silenceBytes: Buffer;
  cueBytes: Buffer;
  writeIntervalMs: number;
  maxClientBacklogBytes?: number;
}) {
  const clients = new Map<
    string,
    { client: AudioWritable; state: ClientState }
  >();
  const acceptedEventIds = new Set<string>();
  const maxBacklog = options.maxClientBacklogBytes ?? 512 * 1024;
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
        queued: [],
        queuedBytes: 0,
      },
    });
    client.once?.("close", disconnect);
    client.once?.("error", disconnect);
    write(sessionId, options.silenceBytes);
    return true;
  };

  const inject = (
    eventId: string,
    sessionIds: readonly string[],
    bytes = options.cueBytes,
  ) => {
    if (acceptedEventIds.has(eventId)) return false;
    acceptedEventIds.add(eventId);
    for (const sessionId of sessionIds) write(sessionId, bytes);
    return true;
  };

  const writeSilence = () => {
    for (const sessionId of clients.keys()) {
      write(sessionId, options.silenceBytes);
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
