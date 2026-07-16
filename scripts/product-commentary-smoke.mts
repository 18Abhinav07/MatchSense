import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:4200";
const fixtureId = "arg-fra-demo";
const timeout = AbortSignal.timeout(35_000);
const cueBytes = await readFile(
  new URL("../apps/server/assets/goal-cue.mp3", import.meta.url),
);
const silenceBytes = await readFile(
  new URL("../apps/server/assets/silence.mp3", import.meta.url),
);

const listenerResponse = await fetch(
  `${baseUrl}/api/v1/fixtures/${fixtureId}/listening-sessions`,
  {
    body: JSON.stringify({ perspectiveTeam: "ARG" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: timeout,
  },
);
assert.equal(listenerResponse.status, 201);
const listener = (await listenerResponse.json()) as { id: string };

const audioController = new AbortController();
const audioResponse = await fetch(
  `${baseUrl}/api/v1/listening-sessions/${listener.id}/stream.mp3`,
  { signal: audioController.signal },
);
assert.equal(audioResponse.status, 200);
assert.match(audioResponse.headers.get("content-type") ?? "", /^audio\/mpeg/u);
const audioChunks: Buffer[] = [];
const audioReader = audioResponse.body!.getReader();
const audioTask = (async () => {
  try {
    while (true) {
      const chunk = await audioReader.read();
      if (chunk.done) return;
      audioChunks.push(Buffer.from(chunk.value));
    }
  } catch (error) {
    if (!audioController.signal.aborted) throw error;
  }
})();

const eventController = new AbortController();
const eventResponse = await fetch(
  `${baseUrl}/api/v1/fixtures/${fixtureId}/stream`,
  { signal: eventController.signal },
);
assert.equal(eventResponse.status, 200);
const eventReader = eventResponse.body!.getReader();
const commentaryReady = (async () => {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await eventReader.read();
    assert.equal(chunk.done, false);
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      if (!frame.includes("event: commentary.ready")) continue;
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      return JSON.parse(data) as {
        commentary: { provider: string; text: string; usedFallback: boolean };
      };
    }
  }
})();

const replayResponse = await fetch(`${baseUrl}/api/v1/replay/sessions`, {
  body: JSON.stringify({ fixtureId }),
  headers: { "Content-Type": "application/json" },
  method: "POST",
  signal: timeout,
});
assert.equal(replayResponse.status, 201);
const replay = (await replayResponse.json()) as { id: string };
const commandResponse = await fetch(
  `${baseUrl}/api/v1/replay/sessions/${replay.id}/commands`,
  {
    body: JSON.stringify({
      listeningSessionId: listener.id,
      marker: "goal",
      type: "advance_to_marker",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: timeout,
  },
);
assert.ok(commandResponse.status === 200 || commandResponse.status === 202);

const commentaryEvent = await commentaryReady;
await new Promise((resolve) => setTimeout(resolve, 1_200));
eventController.abort();
audioController.abort();
await audioTask;

const stream = Buffer.concat(audioChunks);
const cueOffset = stream.indexOf(cueBytes);
assert.ok(
  cueOffset >= silenceBytes.length,
  "goal cue did not reach the stream",
);
let cursor = cueOffset + cueBytes.length;
while (
  stream.subarray(cursor, cursor + silenceBytes.length).equals(silenceBytes)
) {
  cursor += silenceBytes.length;
}
const nextSilence = stream.indexOf(silenceBytes, cursor);
const generatedBytes =
  (nextSilence === -1 ? stream.length : nextSilence) - cursor;

assert.match(commentaryEvent.commentary.provider, /^(gemini|deterministic)$/u);
assert.match(commentaryEvent.commentary.text, /Argentina lead France 1–0/u);
assert.ok(generatedBytes > 1_000, "commentary audio was not injected");

await fetch(`${baseUrl}/api/v1/listening-sessions/${listener.id}`, {
  method: "DELETE",
}).catch(() => undefined);
process.stdout.write(
  `${JSON.stringify({
    generatedBytes,
    provider: commentaryEvent.commentary.provider,
    usedFallback: commentaryEvent.commentary.usedFallback,
    streamBytes: stream.length,
    transcript: commentaryEvent.commentary.text,
  })}\n`,
);
