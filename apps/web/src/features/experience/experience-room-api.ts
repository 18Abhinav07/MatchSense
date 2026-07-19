export type ExperienceCall =
  | {
      answer: "HOME" | "DRAW" | "AWAY";
      confidence: 1 | 2 | 3;
      target: "result";
    }
  | { answer: "YES" | "NO"; confidence: 1 | 2 | 3; target: "goals" | "cards" };

export interface ExperienceRoomMember {
  hasCalls: boolean;
  id: string;
  isDemoSupporter: boolean;
  isHost: boolean;
  lockedAt: number | null;
  nickname: string;
  role: "PLAYER" | "SPECTATOR";
  teamCode: string | null;
}

export interface ExperienceRoomView {
  createdAt: number;
  currentMoment: {
    momentId: string;
    revision: number;
    varState: string;
  } | null;
  experience: {
    label: string;
    lobbyDeadlineAt: number;
    provenance: "synthetic_txline_shaped";
    runId: string;
    startedAt: number | null;
  };
  fixture: {
    awayTeam: string;
    homeTeam: string;
    minute: string;
    phase: string;
    score: { away: number; home: number } | null;
  };
  friendPointsLabel: string;
  hostParticipantId: string;
  id: string;
  kickoffAt: number;
  leaderboard: readonly {
    correctCalls: number;
    nickname: string;
    participantId: string;
    provisional: boolean;
    rank: number;
    score: number;
    voidCalls: number;
  }[];
  members: readonly ExperienceRoomMember[];
  moments: readonly { momentId: string; revision: number; varState: string }[];
  myCalls: {
    calls: {
      cards: Extract<ExperienceCall, { target: "cards" }>;
      goals: Extract<ExperienceCall, { target: "goals" }>;
      result: Extract<ExperienceCall, { target: "result" }>;
    };
    lockedAt: number | null;
  } | null;
  name: string;
  reactions: readonly {
    id: string;
    kind: "ROAR" | "COLD" | "CALLED_IT";
    momentId: string;
    recipientNickname: string;
    revision: number;
    senderNickname: string;
    status: "VISIBLE" | "OVERTURNED";
  }[];
  revision: number;
  status: "PRE_KICKOFF" | "LIVE" | "FINAL";
  targets: Record<string, { answer: string | null; state: string } | null>;
  viewerParticipantId: string;
}

export interface ExperienceRoomPreview {
  callsLocked: boolean;
  experience: ExperienceRoomView["experience"];
  expiresAt: number;
  fixture: ExperienceRoomView["fixture"];
  hostNickname: string;
  memberCount: number;
  memberNicknames: readonly string[];
  name: string;
  roomId: string;
  status: ExperienceRoomView["status"];
}

function csrfHeaders() {
  if (typeof document === "undefined") return {};
  const value = document.cookie
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("matchsense_csrf="));
  return value
    ? {
        "x-matchsense-csrf": decodeURIComponent(
          value.split("=").slice(1).join("="),
        ),
      }
    : {};
}

async function json<T>(response: Response, fallback: string): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as {
    message?: string;
  } | null;
  throw new Error(body?.message ?? fallback);
}

function mutation(
  fetcher: typeof fetch,
  path: string,
  method: string,
  body: unknown,
) {
  return fetcher(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...csrfHeaders() },
    method,
  });
}

export function createExperienceRoomApi(
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
) {
  return {
    async create(input: {
      addDemoSupporters: boolean;
      awayTeam: string;
      homeTeam: string;
      nickname: string;
      name: string;
      teamCode: string | null;
    }) {
      return json<{
        inviteCode: string;
        invitePath: string;
        room: ExperienceRoomView;
      }>(
        await mutation(fetcher, "/api/v1/experience/rooms", "POST", {
          addDemoSupporters: input.addDemoSupporters,
          awayTeam: input.awayTeam,
          homeTeam: input.homeTeam,
          host: {
            nickname: input.nickname,
            ...(input.teamCode ? { teamCode: input.teamCode } : {}),
          },
          name: input.name,
        }),
        "The Experience Room could not be created",
      );
    },
    async get(roomId: string) {
      return json<ExperienceRoomView>(
        await fetcher(`/api/v1/experience/rooms/${encodeURIComponent(roomId)}`),
        "The Experience Room is unavailable",
      );
    },
    async join(input: {
      inviteCode: string;
      nickname: string;
      teamCode: string | null;
    }) {
      return json<ExperienceRoomView>(
        await mutation(fetcher, "/api/v1/experience/rooms/join", "POST", {
          inviteCode: input.inviteCode,
          nickname: input.nickname,
          ...(input.teamCode ? { teamCode: input.teamCode } : {}),
        }),
        "You could not join this Experience Room",
      );
    },
    async lock(roomId: string) {
      return json<ExperienceRoomView>(
        await mutation(
          fetcher,
          `/api/v1/experience/rooms/${encodeURIComponent(roomId)}/calls/lock`,
          "POST",
          {},
        ),
        "Your calls could not be locked",
      );
    },
    async preview(inviteCode: string) {
      return json<ExperienceRoomPreview>(
        await fetcher(
          `/api/v1/experience/rooms/invites/${encodeURIComponent(inviteCode)}/preview`,
        ),
        "This Experience invite is unavailable",
      );
    },
    async react(
      roomId: string,
      input: {
        kind: string;
        momentId: string;
        recipientParticipantId: string;
        revision: number;
      },
    ) {
      const result = await json<{ room: ExperienceRoomView }>(
        await mutation(
          fetcher,
          `/api/v1/experience/rooms/${encodeURIComponent(roomId)}/reactions`,
          "POST",
          input,
        ),
        "Reaction could not be sent",
      );
      return result.room;
    },
    async saveCalls(roomId: string, calls: readonly ExperienceCall[]) {
      return json<ExperienceRoomView>(
        await mutation(
          fetcher,
          `/api/v1/experience/rooms/${encodeURIComponent(roomId)}/calls`,
          "PUT",
          { calls },
        ),
        "Your calls could not be saved",
      );
    },
    async start(roomId: string) {
      return json<ExperienceRoomView>(
        await mutation(
          fetcher,
          `/api/v1/experience/rooms/${encodeURIComponent(roomId)}/start`,
          "POST",
          {},
        ),
        "The Experience Match could not start",
      );
    },
    stream(roomId: string, onRoom: (room: ExperienceRoomView) => void) {
      const source = new EventSource(
        `/api/v1/experience/rooms/${encodeURIComponent(roomId)}/stream`,
        { withCredentials: true },
      );
      for (const type of ["room.snapshot", "room.updated"]) {
        source.addEventListener(type, (event) => {
          try {
            onRoom(
              (JSON.parse(event.data) as { room: ExperienceRoomView }).room,
            );
          } catch {
            // The next authoritative room revision will repair the surface.
          }
        });
      }
      return { close: () => source.close() };
    },
  };
}

export type ExperienceRoomApi = ReturnType<typeof createExperienceRoomApi>;
