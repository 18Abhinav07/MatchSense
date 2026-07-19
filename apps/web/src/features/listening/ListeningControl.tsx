import { useEffect, useRef } from "react";

import { type ListeningMoment, useListening } from "../../ListeningProvider.js";

export interface ListeningControlProps {
  fixtureId: string;
  /** The newest confirmed live Moment, never a replay or provisional event. */
  moment?: ListeningMoment | null | undefined;
  perspectiveTeam: string;
  terminal?: boolean;
}

function identity(moment: ListeningMoment) {
  return `${moment.fixtureId}:${moment.familyId}:${moment.revision}`;
}

/**
 * A host passes confirmed Moment revisions into this leaf. It never starts
 * audio by itself: the fan's tap is the only route into Listening Mode.
 */
export function ListeningControl({
  fixtureId,
  moment,
  perspectiveTeam,
  terminal = false,
}: ListeningControlProps) {
  const listening = useListening();
  const announced = useRef<string | null>(null);

  useEffect(() => {
    announced.current = null;
    void listening.prepare({ fixtureId, perspectiveTeam });
    return () => {
      void listening.stop();
    };
  }, [fixtureId, listening.prepare, listening.stop, perspectiveTeam]);

  useEffect(() => {
    if (
      !moment ||
      (listening.state !== "listening" && listening.state !== "connecting")
    )
      return;
    const next = identity(moment);
    if (announced.current === next) return;
    announced.current = next;
    listening.announce(moment);
  }, [listening.announce, listening.state, moment]);

  const start = async () => {
    if (!listening.prepared) {
      await listening.prepare({ fixtureId, perspectiveTeam });
    }
    await listening.start();
    if (!moment || listening.state === "blocked") return;
    announced.current = identity(moment);
    listening.announce(moment);
  };

  const action =
    listening.state === "blocked"
      ? () => void listening.retry()
      : listening.state === "paused"
        ? () => void listening.retry()
        : listening.state === "stopped"
          ? () => void start()
          : listening.pause;

  const actionLabel =
    listening.state === "blocked"
      ? "Retry audio"
      : listening.state === "paused"
        ? "Resume live"
        : listening.state === "stopped"
          ? "Start listening"
          : "Pause listening";

  return (
    <section aria-label="Listening Mode" className="ms-listening-control">
      <span>LISTENING MODE</span>
      <b>
        {listening.state === "listening"
          ? "Pocket commentary is live"
          : listening.state === "connecting"
            ? "Joining the live audio edge"
            : listening.state === "paused"
              ? "Pocket commentary is paused"
              : "Follow the match by sound"}
      </b>
      <p>
        {listening.lastCueText ??
          "Audio starts only after you tap, and MatchSense only speaks a confirmed update."}
      </p>
      <button onClick={action} type="button">
        {actionLabel}
      </button>
      {terminal && listening.state !== "stopped" ? (
        <button onClick={() => void listening.stop()} type="button">
          End listening
        </button>
      ) : null}
      {listening.error ? <small role="alert">{listening.error}</small> : null}
    </section>
  );
}
