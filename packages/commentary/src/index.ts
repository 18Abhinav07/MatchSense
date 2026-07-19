import { sha256 } from "./audio.js";
import {
  generateGroqAtmosphere,
  synthesizeGeminiSpeech,
  type ProviderEnvironment,
} from "./providers.js";

export const commentaryWorkspace = "@matchsense/commentary" as const;

export type CommentaryLanguage = "en" | "hi";
export type CommentaryEventMode = "live" | "replay";
export type CommentaryEventKind =
  | "phase.kickoff"
  | "goal"
  | "card.yellow"
  | "card.red"
  | "corner"
  | "penalty.awarded"
  | "penalty.scored"
  | "penalty.missed"
  | "var.started"
  | "var.stands"
  | "var.overturned"
  | "phase.half_time"
  | "phase.second_half_start"
  | "phase.regulation_end"
  | "phase.extra_time_start"
  | "phase.extra_time_half"
  | "phase.extra_time_second_half_start"
  | "phase.shootout_start"
  | "shootout.kick_scored"
  | "shootout.kick_missed"
  | "phase.full_time"
  | "correction";
export type CommentaryEventStatus =
  "provisional" | "confirmed" | "under_review" | "overturned" | "corrected";

export interface CommentaryTeam {
  id: string;
  name: string;
}

export interface CommentaryEvent {
  awayTeam: CommentaryTeam;
  eventTeamId: string | null;
  fixtureId: string;
  homeTeam: CommentaryTeam;
  kind: CommentaryEventKind;
  minute: string;
  momentId: string;
  playerDisplayName: string | null;
  revision: number;
  score: { away: number; home: number };
  status: CommentaryEventStatus;
}

export interface FanCommentaryContext {
  eventMode: CommentaryEventMode;
  language: CommentaryLanguage;
  locale: string;
  perspectiveTeamId: string | null;
  voice: { name: string; revision: string };
}

export interface CommentaryInput {
  event: CommentaryEvent;
  fan: FanCommentaryContext;
}

export interface CommentaryArtifact {
  audio: {
    byteLength: number;
    bytes: Buffer;
    mimeType: "audio/wav";
    path: string;
    sha256: string;
  };
  cacheKey: string;
  commentaryId: string;
  createdAt: string;
  eventMode: CommentaryEventMode;
  language: CommentaryLanguage;
  locale: string;
  momentIdentity: string;
  provenance: {
    atmosphereFallbackReason: string | null;
    atmosphereModel: string;
    speechFallbackReason: string | null;
    speechModel: string;
    speechProvider: "gemini" | "deterministic-cue";
  };
  transcript: string;
  voiceRevision: string;
}

export interface CommentaryArtifactStore {
  findByCacheKey(cacheKey: string): Promise<CommentaryArtifact | null>;
  findById(commentaryId: string): Promise<CommentaryArtifact | null>;
  getOrCreate(
    cacheKey: string,
    create: () => Promise<CommentaryArtifact>,
  ): Promise<{
    artifact: CommentaryArtifact;
    cache: "generated" | "hit" | "inflight";
  }>;
  status(): { cached: number; inflight: number };
}

class MemoryCommentaryArtifactStore implements CommentaryArtifactStore {
  readonly #byCacheKey = new Map<string, CommentaryArtifact>();
  readonly #byId = new Map<string, CommentaryArtifact>();
  readonly #inflight = new Map<string, Promise<CommentaryArtifact>>();

  async findByCacheKey(cacheKey: string) {
    return this.#byCacheKey.get(cacheKey) ?? null;
  }

  async findById(commentaryId: string) {
    return this.#byId.get(commentaryId) ?? null;
  }

  async getOrCreate(
    cacheKey: string,
    create: () => Promise<CommentaryArtifact>,
  ) {
    const cached = this.#byCacheKey.get(cacheKey);
    if (cached) return { artifact: cached, cache: "hit" as const };

    const active = this.#inflight.get(cacheKey);
    if (active) {
      return { artifact: await active, cache: "inflight" as const };
    }

    const work = (async () => {
      const artifact = await create();
      if (artifact.cacheKey !== cacheKey) {
        throw new Error("commentary artifact cache key does not match claim");
      }
      // A deterministic cue keeps the live stream audible, but it is not a
      // successful narration artifact. Do not let a transient provider
      // failure poison this cache key; the next request must be able to retry
      // real speech generation.
      if (artifact.provenance.speechProvider === "gemini") {
        this.#byCacheKey.set(cacheKey, artifact);
        this.#byId.set(artifact.commentaryId, artifact);
      }
      return artifact;
    })();
    this.#inflight.set(cacheKey, work);
    try {
      return { artifact: await work, cache: "generated" as const };
    } finally {
      this.#inflight.delete(cacheKey);
    }
  }

  status() {
    return { cached: this.#byCacheKey.size, inflight: this.#inflight.size };
  }
}

export function createMemoryCommentaryArtifactStore(): CommentaryArtifactStore {
  return new MemoryCommentaryArtifactStore();
}

function requiredText(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label} is required`);
  if (value.includes("|")) throw new Error(`${label} cannot include |`);
  return value.trim();
}

function validateInput(input: CommentaryInput) {
  requiredText(input.event.momentId, "momentId");
  requiredText(input.event.fixtureId, "fixtureId");
  requiredText(input.fan.locale, "locale");
  requiredText(input.fan.voice.revision, "voice revision");
  requiredText(input.fan.voice.name, "voice name");
  if (!Number.isInteger(input.event.revision) || input.event.revision < 1) {
    throw new Error("revision must be a positive integer");
  }
  if (
    input.event.eventTeamId !== null &&
    input.event.eventTeamId !== input.event.homeTeam.id &&
    input.event.eventTeamId !== input.event.awayTeam.id
  ) {
    throw new Error("event team must match a fixture participant");
  }
  for (const [label, score] of Object.entries(input.event.score)) {
    if (!Number.isInteger(score) || score < 0) {
      throw new Error(`${label} score must be a non-negative integer`);
    }
  }
}

export function createCommentaryCacheKey(input: CommentaryInput) {
  validateInput(input);
  return [
    `${input.event.momentId}:${input.event.revision}`,
    input.fan.language,
    input.fan.locale,
    input.fan.eventMode,
    input.fan.voice.revision,
  ].join("|");
}

function eventTeam(input: CommentaryInput) {
  if (input.event.eventTeamId === input.event.homeTeam.id) {
    return input.event.homeTeam;
  }
  if (input.event.eventTeamId === input.event.awayTeam.id) {
    return input.event.awayTeam;
  }
  return null;
}

function opponentTeam(input: CommentaryInput, team: CommentaryTeam) {
  return team.id === input.event.homeTeam.id
    ? input.event.awayTeam
    : input.event.homeTeam;
}

function eventScore(input: CommentaryInput) {
  const isHome = input.event.eventTeamId === input.event.homeTeam.id;
  return {
    against: isHome ? input.event.score.away : input.event.score.home,
    for: isHome ? input.event.score.home : input.event.score.away,
  };
}

function englishScoreline(input: CommentaryInput) {
  return `${input.event.homeTeam.name} ${input.event.score.home}–${input.event.score.away} ${input.event.awayTeam.name}`;
}

function englishMinutePhrase(minute: string) {
  const parsed = parseDisplayMinute(minute);
  if (parsed === null) return "";
  return parsed.added === null
    ? ` in the ${ordinal(parsed.base)} minute`
    : ` in stoppage time at ${parsed.base} plus ${parsed.added}`;
}

function eventTeamSuffix(input: CommentaryInput) {
  const team = eventTeam(input);
  return team ? ` for ${team.name}` : "";
}

function parseDisplayMinute(minute: string) {
  const match = /^(\d+)(?:\+(\d+))?'?$/.exec(minute.trim());
  if (!match) return null;
  const base = Number(match[1]);
  const added = match[2] === undefined ? null : Number(match[2]);
  if (!Number.isInteger(base) || base < 1) return null;
  if (added !== null && (!Number.isInteger(added) || added < 1)) return null;
  return { added, base };
}

function ordinal(value: number) {
  const modulo100 = value % 100;
  if (modulo100 >= 11 && modulo100 <= 13) return `${value}th`;
  if (value % 10 === 1) return `${value}st`;
  if (value % 10 === 2) return `${value}nd`;
  if (value % 10 === 3) return `${value}rd`;
  return `${value}th`;
}

const HINDI_TEAM_NAMES: Readonly<Record<string, string>> = {
  ARG: "अर्जेंटीना",
  BRA: "ब्राज़ील",
  FRA: "फ्रांस",
  JPN: "जापान",
};

function hindiTeam(team: CommentaryTeam) {
  return HINDI_TEAM_NAMES[team.id] ?? team.name;
}

function renderEnglishTranscript(input: CommentaryInput, atmosphere: string) {
  const team = eventTeam(input);
  const teamName = team?.name;
  const minutePhrase = englishMinutePhrase(input.event.minute);

  if (input.event.kind === "goal") {
    if (input.event.status === "under_review") {
      return teamName
        ? `${teamName}'s possible goal is under review. Celebration held until the decision is confirmed.`
        : "A possible goal is under review. Celebration held until the decision is confirmed.";
    }
    if (input.event.status !== "confirmed") {
      return teamName
        ? `Possible goal for ${teamName}, but it is not confirmed yet. Celebration held.`
        : "Possible goal, but it is not confirmed yet. Celebration held.";
    }
    if (!team) {
      return `Goal confirmed. ${englishScoreline(input)}${minutePhrase}.`;
    }
    const opponent = opponentTeam(input, team);
    const scorer = input.event.playerDisplayName
      ? `${input.event.playerDisplayName} scores for ${team.name}.`
      : `${team.name} score.`;
    const score = eventScore(input);
    const state =
      score.for === score.against
        ? `It is now ${englishScoreline(input)}${minutePhrase}.`
        : score.for > score.against
          ? `${team.name} lead ${opponent.name} ${score.for}–${score.against}${minutePhrase}.`
          : `${team.name} pull one back. It is ${englishScoreline(input)}${minutePhrase}.`;
    return `Goal! ${scorer} ${state} ${atmosphere}`;
  }

  switch (input.event.kind) {
    case "var.started":
      return `VAR review underway${eventTeamSuffix(input)}. The decision is being checked. Celebration held.`;
    case "var.stands":
      return `VAR check complete. The decision${eventTeamSuffix(input)} stands.`;
    case "var.overturned":
      return `VAR overturns the decision${eventTeamSuffix(input)}. No celebration.`;
    case "card.yellow":
      return `Yellow card${eventTeamSuffix(input)}${minutePhrase}.`;
    case "card.red":
      return `Red card${eventTeamSuffix(input)}${minutePhrase}.`;
    case "corner":
      return teamName
        ? `Corner to ${teamName}${minutePhrase}.`
        : `Corner awarded${minutePhrase}.`;
    case "penalty.awarded":
      return teamName
        ? `Penalty awarded to ${teamName}${minutePhrase}.`
        : `Penalty awarded${minutePhrase}.`;
    case "penalty.scored":
      return teamName
        ? `Penalty scored by ${teamName}${minutePhrase}. ${englishScoreline(input)}.`
        : `Penalty scored${minutePhrase}. ${englishScoreline(input)}.`;
    case "penalty.missed":
      return teamName
        ? `Penalty missed by ${teamName}${minutePhrase}.`
        : `Penalty missed${minutePhrase}.`;
    case "phase.kickoff":
      return `Kickoff. ${input.event.homeTeam.name} against ${input.event.awayTeam.name} is underway.`;
    case "phase.half_time":
      return `Half-time. ${englishScoreline(input)}.`;
    case "phase.second_half_start":
      return `The second half is underway. ${englishScoreline(input)}.`;
    case "phase.regulation_end":
      return `Regulation time is over. ${englishScoreline(input)}.`;
    case "phase.extra_time_start":
      return `Extra time is underway. ${englishScoreline(input)}.`;
    case "phase.extra_time_half":
      return `Half-time in extra time. ${englishScoreline(input)}.`;
    case "phase.extra_time_second_half_start":
      return `The second half of extra time is underway. ${englishScoreline(input)}.`;
    case "phase.shootout_start":
      return `The penalty shootout is underway. ${englishScoreline(input)}.`;
    case "shootout.kick_scored":
      return teamName
        ? `${teamName} score in the shootout.`
        : "The shootout kick is scored.";
    case "shootout.kick_missed":
      return teamName
        ? `${teamName} miss in the shootout.`
        : "The shootout kick is missed.";
    case "phase.full_time":
      return `Full-time. ${englishScoreline(input)}.`;
    case "correction":
      return `The match record has been corrected. ${englishScoreline(input)}.`;
  }
}

function renderHindiTranscript(input: CommentaryInput, atmosphere: string) {
  const scoringTeam = eventTeam(input);
  if (input.event.kind !== "goal") {
    return renderEnglishTranscript(input, atmosphere);
  }
  if (!scoringTeam) {
    return `गोल की पुष्टि हुई। स्कोर ${input.event.score.home}–${input.event.score.away} है।`;
  }
  const opponent = opponentTeam(input, scoringTeam);
  const scoringTeamName = hindiTeam(scoringTeam);
  if (input.event.status !== "confirmed") {
    return `${scoringTeamName} के लिए संभावित गोल, लेकिन अभी पुष्टि नहीं हुई है। जश्न रोक दिया गया है।`;
  }
  const minute = parseDisplayMinute(input.event.minute);
  const minutePhrase =
    minute === null
      ? ""
      : minute.added === null
        ? `${minute.base}वें मिनट में `
        : `स्टॉपेज टाइम में ${minute.base} प्लस ${minute.added} पर `;
  const score = eventScore(input);
  const scorer = input.event.playerDisplayName
    ? `${input.event.playerDisplayName} ने ${scoringTeamName} के लिए गोल किया।`
    : `${scoringTeamName} ने गोल किया।`;
  const state =
    score.for === score.against
      ? `${minutePhrase}स्कोर ${input.event.score.home}–${input.event.score.away} से बराबर है।`
      : score.for > score.against
        ? `${minutePhrase}${scoringTeamName} ${hindiTeam(opponent)} से ${score.for}–${score.against} आगे है।`
        : `${minutePhrase}${scoringTeamName} ने अंतर कम किया। स्कोर ${input.event.score.home}–${input.event.score.away} है।`;
  return `गोल! ${scorer} ${state} ${atmosphere}`;
}

function renderTranscript(input: CommentaryInput, atmosphere: string) {
  return input.fan.language === "hi"
    ? renderHindiTranscript(input, atmosphere)
    : renderEnglishTranscript(input, atmosphere);
}

export function createCommentaryPipeline(options?: {
  env?: ProviderEnvironment;
  fetchImpl?: typeof fetch;
  groqTimeoutMs?: number;
  now?: () => Date;
  store?: CommentaryArtifactStore;
  ttsTimeoutMs?: number;
}) {
  const env = options?.env ?? process.env;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const store = options?.store ?? createMemoryCommentaryArtifactStore();
  const now = options?.now ?? (() => new Date());
  const groqTimeoutMs = options?.groqTimeoutMs ?? 5_000;
  const ttsTimeoutMs = options?.ttsTimeoutMs ?? 15_000;

  const generateArtifact = async (
    input: CommentaryInput,
    cacheKey: string,
  ): Promise<CommentaryArtifact> => {
    // Match facts are rendered deterministically. Groq only supplies a
    // tightly allowlisted atmosphere sentence after a confirmed goal; every
    // other beat goes directly to speech synthesis without spending quota.
    const atmosphere =
      input.event.kind === "goal" && input.event.status === "confirmed"
        ? await generateGroqAtmosphere(input, {
            apiKey: env.GROQ_API_KEY,
            fetchImpl,
            timeoutMs: groqTimeoutMs,
          })
        : {
            delivery: "held" as const,
            fallbackReason: null,
            model: "deterministic-fallback" as const,
            phrase: "",
          };
    const transcript = renderTranscript(input, atmosphere.phrase);
    const speech = await synthesizeGeminiSpeech(
      transcript,
      input.fan.voice.name,
      {
        apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY,
        fetchImpl,
        timeoutMs: ttsTimeoutMs,
      },
    );
    const commentaryId = `cm_${sha256(cacheKey).slice(0, 24)}`;
    const artifact: CommentaryArtifact = {
      audio: {
        byteLength: speech.bytes.length,
        bytes: speech.bytes,
        mimeType: speech.mimeType,
        path: `/api/v1/commentary/${commentaryId}/audio`,
        sha256: sha256(speech.bytes),
      },
      cacheKey,
      commentaryId,
      createdAt: now().toISOString(),
      eventMode: input.fan.eventMode,
      language: input.fan.language,
      locale: input.fan.locale,
      momentIdentity: `${input.event.momentId}:${input.event.revision}`,
      provenance: {
        atmosphereFallbackReason: atmosphere.fallbackReason,
        atmosphereModel: atmosphere.model,
        speechFallbackReason: speech.fallbackReason,
        speechModel: speech.model,
        speechProvider: speech.provider,
      },
      transcript,
      voiceRevision: input.fan.voice.revision,
    };
    return artifact;
  };

  const generate = async (input: CommentaryInput) => {
    const cacheKey = createCommentaryCacheKey(input);
    return store.getOrCreate(cacheKey, () => generateArtifact(input, cacheKey));
  };

  const synthesize = (transcript: string, voiceName = "Kore") =>
    synthesizeGeminiSpeech(requiredText(transcript, "transcript"), voiceName, {
      apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY,
      fetchImpl,
      timeoutMs: ttsTimeoutMs,
    });

  return {
    find: (commentaryId: string) => store.findById(commentaryId),
    generate,
    synthesize,
    status: () => store.status(),
  };
}

export type CommentaryPipeline = ReturnType<typeof createCommentaryPipeline>;

export type { ProviderEnvironment } from "./providers.js";
