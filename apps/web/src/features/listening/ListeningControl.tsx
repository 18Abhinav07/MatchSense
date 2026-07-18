import { useEffect, useRef } from "react";

import { type ListeningMoment, useListening } from "../../ListeningProvider.js";

export interface ListeningControlProps {
  /** The newest confirmed live Moment, never a replay or provisional event. */
  moment?: ListeningMoment | null | undefined;
}

function identity(moment: ListeningMoment) {
  return `${moment.fixtureId}:${moment.familyId}:${moment.revision}`;
}

/**
 * A host passes confirmed Moment revisions into this leaf. It never starts
 * audio by itself: the fan's tap is the only route into Listening Mode.
 */
export function ListeningControl({ moment }: ListeningControlProps) {
  const listening = useListening();
  const announced = useRef<string | null>(null);

  useEffect(() => {
    if (!moment || listening.state === "stopped") return;
    const next = identity(moment);
    if (announced.current === next) return;
    announced.current = next;
    void listening.announce(moment);
  }, [listening, moment]);

  const start = async () => {
    await listening.start();
    if (!moment || listening.state === "blocked") return;
    announced.current = identity(moment);
    await listening.announce(moment);
  };

  const action =
    listening.state === "blocked"
      ? () => void listening.retry()
      : listening.state === "stopped"
        ? () => void start()
        : listening.stop;

  const actionLabel =
    listening.state === "blocked"
      ? "Retry audio"
      : listening.state === "stopped"
        ? "Start listening"
        : "Stop listening";

  return (
    <section aria-label="Listening Mode" className="ms-listening-control">
      <span>LISTENING MODE</span>
      <b>
        {listening.state === "speaking"
          ? "Commentary is playing"
          : listening.state === "reconnecting"
            ? "Commentary is preparing"
            : "Follow the match by sound"}
      </b>
      <p>
        {listening.lastCueText ??
          "Audio starts only after you tap, and MatchSense only speaks a confirmed update."}
      </p>
      <button onClick={action} type="button">
        {actionLabel}
      </button>
    </section>
  );
}
