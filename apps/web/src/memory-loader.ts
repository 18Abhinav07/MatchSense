import type { VerifiedFixtureMemory } from "./memory-api.js";

export async function loadVerifiedMemory(input: {
  fetchRemote(): Promise<VerifiedFixtureMemory>;
}): Promise<{ memory: VerifiedFixtureMemory; source: "archive-verified" }> {
  return { memory: await input.fetchRemote(), source: "archive-verified" };
}

export async function loadVerifiedMemoryHistory(input: {
  fetchRemote(): Promise<readonly VerifiedFixtureMemory[]>;
}): Promise<{
  entries: readonly VerifiedFixtureMemory[];
  source: "archive-verified";
}> {
  return { entries: await input.fetchRemote(), source: "archive-verified" };
}
