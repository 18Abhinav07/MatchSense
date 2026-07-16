import { createDeterministicFallbackCue, wrapPcm16MonoAsWav } from "./audio.js";
import type {
  CommentaryEvent,
  CommentaryInput,
  CommentaryLanguage,
} from "./index.js";

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_TTS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent";
const GROQ_MODEL = "openai/gpt-oss-20b";
const GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const ALLOWED_ATMOSPHERE_PHRASES = [
  "The stadium finds its voice.",
  "The crowd erupts.",
  "The noise rolls around the ground.",
  "Listen to that roar.",
] as const;

export interface ProviderEnvironment {
  GEMINI_API_KEY?: string | undefined;
  GOOGLE_API_KEY?: string | undefined;
  GROQ_API_KEY?: string | undefined;
}

export interface AtmosphereResult {
  delivery: "celebratory" | "urgent" | "held";
  fallbackReason: string | null;
  model: typeof GROQ_MODEL | "deterministic-fallback";
  phrase: string;
}

export interface SpeechResult {
  bytes: Buffer;
  fallbackReason: string | null;
  mimeType: "audio/wav";
  model: typeof GEMINI_TTS_MODEL | "deterministic-two-tone-v1";
  provider: "gemini" | "deterministic-cue";
}

function isDelivery(
  value: unknown,
): value is "celebratory" | "urgent" | "held" {
  return value === "celebratory" || value === "urgent" || value === "held";
}

function deterministicAtmosphere(
  language: CommentaryLanguage,
  reason: string,
): AtmosphereResult {
  return {
    delivery: "celebratory",
    fallbackReason: reason,
    model: "deterministic-fallback",
    phrase: language === "hi" ? "क्या शानदार पल है।" : "What a moment.",
  };
}

function providerFailure(error: unknown, prefix: string) {
  const name = error instanceof Error ? error.name : "";
  return `${prefix}_${
    name === "TimeoutError" || name === "AbortError"
      ? "timeout"
      : "request_failed"
  }`;
}

function expectedDelivery(input: CommentaryInput) {
  if (input.event.status !== "confirmed") return "held" as const;
  return "celebratory" as const;
}

function abstractMatchState(event: CommentaryEvent) {
  if (event.status !== "confirmed")
    return "possible event awaiting confirmation";
  const eventSide = event.eventTeamId === event.homeTeam.id ? "home" : "away";
  const eventScore = eventSide === "home" ? event.score.home : event.score.away;
  const otherScore = eventSide === "home" ? event.score.away : event.score.home;
  if (eventScore === otherScore) return "confirmed equaliser";
  if (eventScore > otherScore) {
    return "confirmed goal that puts the scoring side ahead";
  }
  return "confirmed goal that reduces the deficit";
}

function sanitizeAtmospherePhrase(value: unknown, input: CommentaryInput) {
  const phrase = typeof value === "string" ? value.trim() : "";
  if (!(ALLOWED_ATMOSPHERE_PHRASES as readonly string[]).includes(phrase)) {
    return null;
  }
  const forbiddenFootballClaims =
    /\b(assist(?:ed)?|cross|header|headed|penalty|shot|left[- ]foot|right[- ]foot|top corner|bottom corner|goalkeeper|keeper|woodwork|deflection)\b/i;
  const forbiddenScoreClaims =
    /\b(goal|scores?|scored|equalis(?:e|er|ed)|lead|leads|ahead|behind|level|winner|nil|zero|one|two|three|four|five|six|seven|eight|nine|ten|minute)\b/i;
  const knownNames = [
    input.event.homeTeam.name,
    input.event.awayTeam.name,
    input.event.playerDisplayName,
  ].filter((name): name is string => Boolean(name));
  const containsKnownName = knownNames.some((name) =>
    phrase.toLocaleLowerCase().includes(name.toLocaleLowerCase()),
  );
  const containsInventedProperName =
    /(?:^|[.!?]\s+)[A-Z][a-z]+\s+[A-Z][a-z]+/.test(phrase);
  const unsafe =
    phrase.length < 3 ||
    phrase.length > 90 ||
    /\d/.test(phrase) ||
    containsKnownName ||
    containsInventedProperName ||
    forbiddenFootballClaims.test(phrase) ||
    forbiddenScoreClaims.test(phrase);
  return unsafe ? null : phrase;
}

export async function generateGroqAtmosphere(
  input: CommentaryInput,
  options: {
    apiKey?: string | undefined;
    fetchImpl: typeof fetch;
    timeoutMs: number;
  },
): Promise<AtmosphereResult> {
  if (input.fan.language !== "en") {
    return deterministicAtmosphere(
      input.fan.language,
      "groq_language_fallback",
    );
  }
  if (!options.apiKey) {
    return deterministicAtmosphere(input.fan.language, "groq_missing_key");
  }

  const expected = expectedDelivery(input);
  try {
    const response = await options.fetchImpl(GROQ_CHAT_URL, {
      body: JSON.stringify({
        messages: [
          {
            content: [
              "Write one short atmospheric football reaction sentence.",
              "The application adds every match fact separately.",
              "Do not use names, teams, scores, numbers, minute, assists, body parts, shot details, or other match facts.",
              "Use at most twelve words and no proper nouns.",
            ].join(" "),
            role: "system",
          },
          {
            content: JSON.stringify({
              delivery: expected,
              phase:
                Number.parseInt(input.event.minute, 10) >= 80
                  ? "late"
                  : "open_play",
              state: abstractMatchState(input.event),
            }),
            role: "user",
          },
        ],
        model: GROQ_MODEL,
        response_format: {
          json_schema: {
            name: "match_commentary_color",
            schema: {
              additionalProperties: false,
              properties: {
                colorPhrase: {
                  enum: ALLOWED_ATMOSPHERE_PHRASES,
                  type: "string",
                },
                delivery: {
                  enum: ["celebratory", "urgent", "held"],
                  type: "string",
                },
              },
              required: ["colorPhrase", "delivery"],
              type: "object",
            },
            strict: true,
          },
          type: "json_schema",
        },
        temperature: 0.45,
      }),
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      return deterministicAtmosphere(
        input.fan.language,
        `groq_http_${response.status}`,
      );
    }

    const completion = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const rawContent = completion.choices?.[0]?.message?.content;
    if (typeof rawContent !== "string") {
      return deterministicAtmosphere(input.fan.language, "groq_invalid_schema");
    }
    const parsed = JSON.parse(rawContent) as {
      colorPhrase?: unknown;
      delivery?: unknown;
    };
    if (!isDelivery(parsed.delivery) || parsed.delivery !== expected) {
      return deterministicAtmosphere(input.fan.language, "groq_invalid_schema");
    }
    const phrase = sanitizeAtmospherePhrase(parsed.colorPhrase, input);
    if (!phrase) {
      return deterministicAtmosphere(input.fan.language, "groq_unsafe_color");
    }
    return {
      delivery: parsed.delivery,
      fallbackReason: null,
      model: GROQ_MODEL,
      phrase,
    };
  } catch (error) {
    return deterministicAtmosphere(
      input.fan.language,
      providerFailure(error, "groq"),
    );
  }
}

function deterministicSpeech(reason: string): SpeechResult {
  return {
    bytes: createDeterministicFallbackCue(),
    fallbackReason: reason,
    mimeType: "audio/wav",
    model: "deterministic-two-tone-v1",
    provider: "deterministic-cue",
  };
}

function pcmSampleRate(mimeType: string) {
  const [mediaType, ...rawParameters] = mimeType.split(";");
  if (mediaType?.trim().toLocaleLowerCase() !== "audio/l16") return null;
  const parameters = new Map(
    rawParameters.map((parameter) => {
      const separator = parameter.indexOf("=");
      if (separator < 1) return [parameter.trim().toLocaleLowerCase(), ""];
      return [
        parameter.slice(0, separator).trim().toLocaleLowerCase(),
        parameter
          .slice(separator + 1)
          .trim()
          .toLocaleLowerCase(),
      ];
    }),
  );
  const codec = parameters.get("codec");
  if (codec && codec !== "pcm") return null;
  if (parameters.has("channels") && parameters.get("channels") !== "1") {
    return null;
  }
  const rate = Number(parameters.get("rate"));
  return Number.isInteger(rate) && rate >= 8_000 && rate <= 48_000
    ? rate
    : null;
}

function decodePcmBase64(encoded: string) {
  const normalized = encoded.trim();
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      normalized,
    )
  ) {
    return null;
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 0 || bytes.length % 2 !== 0) return null;
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  return canonical === normalized.replace(/=+$/, "") ? bytes : null;
}

export async function synthesizeGeminiSpeech(
  transcript: string,
  voiceName: string,
  options: {
    apiKey?: string | undefined;
    fetchImpl: typeof fetch;
    timeoutMs: number;
  },
): Promise<SpeechResult> {
  if (!options.apiKey) return deterministicSpeech("gemini_missing_key");

  try {
    const response = await options.fetchImpl(GEMINI_TTS_URL, {
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Speak like an energetic live football commentator. Transcript: ${transcript}`,
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      }),
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": options.apiKey,
      },
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      return deterministicSpeech(`gemini_http_${response.status}`);
    }

    const result = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { data?: unknown; mimeType?: unknown };
          }>;
        };
      }>;
    };
    const inlineData = result.candidates?.[0]?.content?.parts
      ?.map((part) => part.inlineData)
      .find(
        (value): value is { data: string; mimeType?: unknown } =>
          typeof value?.data === "string",
      );
    if (!inlineData) {
      return deterministicSpeech("gemini_missing_audio");
    }
    const encoded = inlineData.data;
    const mimeType =
      typeof inlineData.mimeType === "string" ? inlineData.mimeType : "";
    const sampleRate = pcmSampleRate(mimeType);
    if (sampleRate === null) {
      return deterministicSpeech("gemini_unsupported_audio");
    }
    const pcm = decodePcmBase64(encoded);
    if (!pcm) return deterministicSpeech("gemini_invalid_audio");
    return {
      bytes: wrapPcm16MonoAsWav(pcm, sampleRate),
      fallbackReason: null,
      mimeType: "audio/wav",
      model: GEMINI_TTS_MODEL,
      provider: "gemini",
    };
  } catch (error) {
    return deterministicSpeech(providerFailure(error, "gemini"));
  }
}
