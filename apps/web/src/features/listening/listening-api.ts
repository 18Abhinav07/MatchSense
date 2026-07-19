export interface ListeningSessionInput {
  fixtureId: string;
  perspectiveTeam: string;
}

export interface ListeningSessionResponse {
  id: string;
  fixtureId?: string;
  perspectiveTeam?: string;
}

export interface ListeningApi {
  create(input: ListeningSessionInput): Promise<ListeningSessionResponse>;
  remove(sessionId: string): Promise<void>;
  streamUrl(sessionId: string): string;
}

async function responseError(response: Response) {
  const detail = await response.text().catch(() => "");
  return new Error(detail || `Listening service returned ${response.status}`);
}

function csrfHeader(cookie: string) {
  const entry = cookie
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("matchsense_csrf="));
  if (!entry) return {};
  try {
    return {
      "x-matchsense-csrf": decodeURIComponent(
        entry.slice("matchsense_csrf=".length),
      ),
    };
  } catch {
    return {};
  }
}

export function createListeningApi(
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  cookieSource: () => string = () =>
    typeof document === "undefined" ? "" : document.cookie,
): ListeningApi {
  return {
    async create(input) {
      const response = await fetcher(
        `/api/v1/fixtures/${encodeURIComponent(input.fixtureId)}/listening-sessions`,
        {
          body: JSON.stringify({ perspectiveTeam: input.perspectiveTeam }),
          headers: {
            "content-type": "application/json",
            ...csrfHeader(cookieSource()),
          },
          method: "POST",
        },
      );
      if (!response.ok) throw await responseError(response);
      return (await response.json()) as ListeningSessionResponse;
    },

    async remove(sessionId) {
      const response = await fetcher(
        `/api/v1/listening-sessions/${encodeURIComponent(sessionId)}`,
        { headers: csrfHeader(cookieSource()), method: "DELETE" },
      );
      if (!response.ok && response.status !== 404) {
        throw await responseError(response);
      }
    },

    streamUrl(sessionId) {
      return `/api/v1/listening-sessions/${encodeURIComponent(sessionId)}/stream.mp3`;
    },
  };
}
