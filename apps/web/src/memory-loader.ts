import type { MatchMemoryRecord } from "./memory-api.js";
import type { MatchMemoryView } from "./memory-view.js";

export async function loadMemoryHistory(input: {
  fetchRemote(): Promise<readonly MatchMemoryRecord[]>;
  readLocal(): MatchMemoryView[];
  toView(memory: MatchMemoryRecord): MatchMemoryView;
}): Promise<{
  entries: MatchMemoryView[];
  source: "local-fallback" | "server";
}> {
  try {
    return {
      entries: (await input.fetchRemote()).map(input.toView),
      source: "server",
    };
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") throw error;
    return { entries: input.readLocal(), source: "local-fallback" };
  }
}

export async function loadOneMemory(input: {
  fetchRemote(fixtureId: string): Promise<MatchMemoryRecord>;
  fixtureId: string;
  readLocal(fixtureId: string): MatchMemoryView | null;
  toView(memory: MatchMemoryRecord): MatchMemoryView;
}): Promise<{
  source: "local-fallback" | "server";
  view: MatchMemoryView;
}> {
  try {
    return {
      source: "server",
      view: input.toView(await input.fetchRemote(input.fixtureId)),
    };
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") throw error;
    const local = input.readLocal(input.fixtureId);
    if (!local) throw error;
    return { source: "local-fallback", view: local };
  }
}
