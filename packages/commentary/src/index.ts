import { sha256 } from "./audio.js";
import {
  generateGroqAtmosphere,
  synthesizeGeminiSpeech,
  type ProviderEnvironment,
} from "./providers.js";

export const commentaryWorkspace = "@matchsense/commentary" as const;

export type CommentaryLanguage = "en" | "hi";
export type CommentaryEventMode = "live" | "replay";

export interface CommentaryTeam {
  id: string;
  name: string;
}

export interface CommentaryEvent {
  awayTeam: CommentaryTeam;
  eventTeamId: string;
  fixtureId: string;
  homeTeam: CommentaryTeam;
  kind: "goal";
  minute: string;
  momentId: string;
  playerDisplayName: string | null;
  revision: number;
  score: { away: number; home: number };
  status: "confirmed" | "provisional";
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
      this.#byCacheKey.set(cacheKey, artifact);
      this.#byId.set(artifact.commentaryId, artifact);
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
  return input.event.eventTeamId === input.event.homeTeam.id
    ? input.event.homeTeam
    : input.event.awayTeam;
}

function opponentTeam(input: CommentaryInput) {
  return input.event.eventTeamId === input.event.homeTeam.id
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
  const scoringTeam = eventTeam(input);
  const opponent = opponentTeam(input);
  if (input.event.status !== "confirmed") {
    return `Possible goal for ${scoringTeam.name}, but it is not confirmed yet. Celebration held.`;
  }
  const scorer = input.event.playerDisplayName
    ? `${input.event.playerDisplayName} scores for ${scoringTeam.name}.`
    : `${scoringTeam.name} score.`;
  const minute = parseDisplayMinute(input.event.minute);
  const minutePhrase =
    minute === null
      ? ""
      : minute.added === null
        ? ` in the ${ordinal(minute.base)} minute`
        : ` in stoppage time at ${minute.base} plus ${minute.added}`;
  const score = eventScore(input);
  const state =
    score.for === score.against
      ? `It is now ${input.event.homeTeam.name} ${input.event.score.home}–${input.event.score.away} ${input.event.awayTeam.name}${minutePhrase}.`
      : score.for > score.against
        ? `${scoringTeam.name} lead ${opponent.name} ${score.for}–${score.against}${minutePhrase}.`
        : `${scoringTeam.name} pull one back. It is ${input.event.homeTeam.name} ${input.event.score.home}–${input.event.score.away} ${input.event.awayTeam.name}${minutePhrase}.`;
  return `Goal! ${scorer} ${state} ${atmosphere}`;
}

function renderHindiTranscript(input: CommentaryInput, atmosphere: string) {
  const scoringTeam = eventTeam(input);
  const opponent = opponentTeam(input);
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
    const atmosphere = await generateGroqAtmosphere(input, {
      apiKey: env.GROQ_API_KEY,
      fetchImpl,
      timeoutMs: groqTimeoutMs,
    });
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

  return {
    find: (commentaryId: string) => store.findById(commentaryId),
    generate,
    status: () => store.status(),
  };
}

export type CommentaryPipeline = ReturnType<typeof createCommentaryPipeline>;

export type { ProviderEnvironment } from "./providers.js";
