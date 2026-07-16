import { createTxlineLiveScoreSource } from "../packages/txline-adapter/src/index.ts";

const apiToken = process.env.TXLINE_API_TOKEN;
if (!apiToken) throw new Error("TXLINE_API_TOKEN is required");

const controller = new AbortController();
const timeout = setTimeout(() => {
  controller.abort();
  process.stderr.write("TxLINE smoke timed out before a confirmed goal\n");
  process.exit(1);
}, 25_000);
let observedGoal = false;
const source = createTxlineLiveScoreSource({
  apiToken,
  fixtures: [
    {
      fixtureId: "18237038",
      participant1: { id: "1999", name: "France" },
      participant1IsHome: true,
      participant2: { id: "3021", name: "Spain" },
    },
  ],
  onEvent: (event) => {
    if (event.action !== "goal" || event.confirmed !== true) return;
    observedGoal = true;
    process.stdout.write(
      `${JSON.stringify({
        action: event.action,
        delivery: event.delivery,
        fixtureId: event.fixtureId,
        provenance: event.provenance,
        revision: event.revision,
        score: event.score,
      })}\n`,
    );
    controller.abort();
    setImmediate(() => process.exit(0));
  },
});

await source.run(controller.signal);
clearTimeout(timeout);
if (!observedGoal) {
  throw new Error("TxLINE smoke ended before a confirmed goal was observed");
}
