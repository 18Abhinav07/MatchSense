import { useEffect, useMemo, useRef, useState } from "react";

import type { ProductCatalog } from "../../live-api.js";
import {
  enableMomentPush,
  triggerTestMomentPush,
} from "../../push-notifications.js";
import type { LiveMoment, LiveSnapshot } from "../../product-state.js";
import {
  createExperienceApi,
  type ExperienceApi,
  type ExperienceRun,
  type ExperienceStreamEvent,
} from "./experience-api.js";
import { ExperienceMatch } from "./ExperienceMatch.js";
import type { ExperienceTranscript } from "./ExperienceMemory.js";
import { ExperienceSetup } from "./ExperienceSetup.js";
import "./experience.css";

function replaceFamily(timeline: readonly LiveMoment[], moment: LiveMoment) {
  const familyId = moment.id;
  const existing = timeline.findIndex((entry) => entry.id === familyId);
  if (existing < 0) return [...timeline, moment];
  const next = [...timeline];
  next[existing] = moment;
  return next;
}

function shouldOpen(moment: LiveMoment) {
  return (
    moment.celebratesGoal ||
    moment.kind === "goal" ||
    moment.kind.startsWith("var.") ||
    moment.kind.startsWith("card.") ||
    moment.kind.startsWith("penalty.") ||
    moment.kind === "phase.full_time"
  );
}

function hydrateHistory(events: readonly ExperienceStreamEvent[]) {
  const timeline: LiveMoment[] = [];
  const revisionHistory: LiveMoment[] = [];
  const transcripts: ExperienceTranscript[] = [];
  for (const event of events) {
    if (event.event === "moment.created" || event.event === "moment.revised") {
      const next = replaceFamily(timeline, event.moment);
      timeline.splice(0, timeline.length, ...next);
      if (
        !revisionHistory.some(
          (entry) => entry.identity === event.moment.identity,
        )
      ) {
        revisionHistory.push(event.moment);
      }
    } else if (event.event === "commentary.ready") {
      if (
        !transcripts.some(
          (entry) => entry.momentIdentity === event.commentary.momentIdentity,
        )
      ) {
        transcripts.push(event.commentary);
      }
    }
  }
  return { revisionHistory, timeline, transcripts };
}

export function ExperienceJourney({
  api,
  catalog,
  favoriteTeam,
  initialMomentIdentity,
  onBack,
  onCreateRoom,
  onOpenRun,
  onRestart,
  runId,
}: {
  api?: ExperienceApi;
  catalog: ProductCatalog;
  favoriteTeam: string | null;
  initialMomentIdentity?: string | null;
  onBack(): void;
  onCreateRoom(input: { awayTeam: string; homeTeam: string }): void;
  onOpenRun(runId: string): void;
  onRestart(): void;
  runId?: string | null;
}) {
  const client = useMemo(() => api ?? createExperienceApi(), [api]);
  const [run, setRun] = useState<ExperienceRun | null>(null);
  const [fixture, setFixture] = useState<LiveSnapshot | null>(null);
  const [timeline, setTimeline] = useState<readonly LiveMoment[]>([]);
  const [revisionHistory, setRevisionHistory] = useState<readonly LiveMoment[]>(
    [],
  );
  const [openMoment, setOpenMoment] = useState<LiveMoment | null>(null);
  const [commentary, setCommentary] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<
    readonly ExperienceTranscript[]
  >([]);
  const [catchupCount, setCatchupCount] = useState(0);
  const [streamPaused, setStreamPaused] = useState(false);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const [reconnectExercised, setReconnectExercised] = useState(false);
  const lastEventId = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [pushState, setPushState] = useState<
    "idle" | "enabling" | "enabled" | "unavailable"
  >("idle");
  const [pushRegistrationId, setPushRegistrationId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    setError(null);
    Promise.all([
      client.fetchRun(runId, controller.signal),
      client.fetchTimeline(runId, controller.signal),
    ])
      .then(([nextRun, stored]) => {
        const history = hydrateHistory(stored.events);
        lastEventId.current = stored.cursor;
        setRun(nextRun);
        setFixture(stored.fixture);
        setTimeline(history.timeline);
        setRevisionHistory(history.revisionHistory);
        setTranscripts(history.transcripts);
        setCommentary(history.transcripts.at(-1)?.text ?? null);
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string }).name !== "AbortError") {
          setError(
            reason instanceof Error ? reason.message : "Experience unavailable",
          );
        }
      });
    return () => controller.abort();
  }, [client, runId]);

  useEffect(() => {
    if (!runId) return;
    const refresh = () => {
      void client
        .fetchRun(runId)
        .then(setRun)
        .catch(() => undefined);
    };
    const timer = setInterval(refresh, 2_000);
    return () => clearInterval(timer);
  }, [client, runId]);

  useEffect(() => {
    if (!runId || !fixture || streamPaused) return;
    const subscription = client.stream(
      runId,
      (event: ExperienceStreamEvent) => {
        if (event.event === "snapshot") {
          setFixture(event.snapshot);
          return;
        }
        if (event.event === "commentary.ready") {
          lastEventId.current = event.id;
          setCommentary(event.commentary.text);
          setTranscripts((current) =>
            current.some(
              (entry) =>
                entry.momentIdentity === event.commentary.momentIdentity,
            )
              ? current
              : [...current, event.commentary],
          );
          setFixture(event.snapshot);
          return;
        }
        if (event.event === "catchup.ready") {
          lastEventId.current = event.id;
          setCatchupCount(event.catchup.moments.length);
          setTimeline((current) =>
            event.catchup.moments.reduce(replaceFamily, current),
          );
          setRevisionHistory((current) => [
            ...current,
            ...event.catchup.moments.filter(
              (moment) =>
                !current.some((entry) => entry.identity === moment.identity),
            ),
          ]);
          setFixture(event.snapshot);
          return;
        }
        lastEventId.current = event.id;
        setFixture(event.snapshot);
        setTimeline((current) => replaceFamily(current, event.moment));
        setRevisionHistory((current) =>
          current.some((entry) => entry.identity === event.moment.identity)
            ? current
            : [...current, event.moment],
        );
        if (event.moment.kind === "card.red" && !reconnectExercised) {
          setReconnectExercised(true);
          setStreamPaused(true);
        }
        if (shouldOpen(event.moment)) setOpenMoment(event.moment);
      },
      lastEventId.current,
    );
    return () => subscription.close();
  }, [
    client,
    fixture?.fixtureId,
    reconnectExercised,
    runId,
    streamEpoch,
    streamPaused,
  ]);

  useEffect(() => {
    if (!streamPaused) return;
    const timer = setTimeout(() => {
      setStreamPaused(false);
      setStreamEpoch((value) => value + 1);
    }, 25_000);
    return () => clearTimeout(timer);
  }, [streamPaused]);

  useEffect(() => {
    if (!runId || !initialMomentIdentity) return;
    const controller = new AbortController();
    void client
      .fetchMoment(runId, initialMomentIdentity, controller.signal)
      .then((resolution) => {
        setFixture(resolution.snapshot);
        setOpenMoment(resolution.latest);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, initialMomentIdentity, runId]);

  useEffect(() => {
    if (!openMoment) return;
    if (
      openMoment.status === "under_review" ||
      openMoment.status === "provisional"
    ) {
      return;
    }
    const timer = setTimeout(() => setOpenMoment(null), 6_000);
    return () => clearTimeout(timer);
  }, [openMoment]);

  const enableAlerts = async () => {
    setPushState("enabling");
    try {
      const response = await fetch("/api/v1/push/config");
      if (!response.ok) throw new Error("Push is unavailable");
      const config = (await response.json()) as {
        applicationServerKey?: unknown;
        supported?: unknown;
      };
      if (
        config.supported !== true ||
        typeof config.applicationServerKey !== "string"
      ) {
        throw new Error("Push is unavailable");
      }
      const registration = await enableMomentPush({
        applicationServerKey: config.applicationServerKey,
      });
      setPushRegistrationId(registration.id);
      setPushState("enabled");
    } catch {
      setPushState("unavailable");
    }
  };

  const start = async (teams: { awayTeam: string; homeTeam: string }) => {
    setStarting(true);
    setError(null);
    try {
      const next = await client.start(teams);
      setRun(next);
      if (pushRegistrationId) {
        await triggerTestMomentPush(pushRegistrationId, {
          body: "Your five-minute match is starting. Real match events follow next.",
          familyId: "readiness",
          fixtureId: next.fixtureId,
          momentId: "readiness",
          occurredAt: new Date().toISOString(),
          revision: 1,
          title: "EXPERIENCE TEST ALERT — MatchSense is ready",
        }).catch(() => undefined);
      }
      onOpenRun(next.id);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Experience could not start",
      );
    } finally {
      setStarting(false);
    }
  };

  if (!runId) {
    return (
      <ExperienceSetup
        catalog={catalog}
        error={error}
        favoriteTeam={favoriteTeam}
        onBack={onBack}
        onCreateRoom={onCreateRoom}
        onEnableAlerts={() => void enableAlerts()}
        onStart={(teams) => void start(teams)}
        pushState={pushState}
        starting={starting}
      />
    );
  }

  if (!run || !fixture) {
    return (
      <main className="ms-experience ms-experience--loading" id="main-content">
        <span />
        <p>{error ?? "Preparing the server-owned match"}</p>
        <button onClick={onBack} type="button">
          Back to match day
        </button>
      </main>
    );
  }

  return (
    <ExperienceMatch
      catalog={catalog}
      catchupCount={catchupCount}
      commentary={commentary}
      favoriteTeam={favoriteTeam}
      fixture={fixture}
      moment={openMoment}
      onBack={onBack}
      onCloseMoment={() => setOpenMoment(null)}
      onRestart={onRestart}
      run={run}
      streamPaused={streamPaused}
      timeline={timeline}
      revisionHistory={revisionHistory}
      transcripts={transcripts}
    />
  );
}
