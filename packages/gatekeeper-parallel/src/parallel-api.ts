import type {
  ParallelExtractError,
  ParallelExtractResponse,
  ParallelExtractResult,
  ParallelRequestOptions,
  ParallelSearchResponse,
  ParallelSearchResult,
} from "./types.js";

const DEFAULT_API_BASE_URL = "https://api.parallel.ai";
const REQUEST_TIMEOUT_MS = 60_000;

type RawSearchResponse = {
  search_id: string;
  session_id: string;
  results: Array<{
    url: string;
    title: string;
    publish_date?: string;
    excerpts: string[];
  }>;
};

type RawExtractResponse = {
  extract_id: string;
  session_id: string;
  results: Array<{
    url: string;
    title?: string;
    publish_date?: string;
    excerpts: string[];
    full_content?: string;
  }>;
  errors: Array<{
    url: string;
    error_type: string;
    http_status_code?: number;
    content?: string;
  }>;
};

function requestOptions(options?: ParallelRequestOptions): Record<string, unknown> {
  if (!options) return {};
  const result: Record<string, unknown> = {};
  if (options.maxCharsTotal !== undefined) {
    if (!Number.isSafeInteger(options.maxCharsTotal) || options.maxCharsTotal <= 0) {
      throw new TypeError("maxCharsTotal must be a positive integer.");
    }
    result.max_chars_total = options.maxCharsTotal;
  }
  if (options.sessionId !== undefined) {
    if (!options.sessionId.trim() || options.sessionId.length > 1_000) {
      throw new TypeError("sessionId must contain 1-1000 characters.");
    }
    result.session_id = options.sessionId;
  }
  if (options.clientModel !== undefined) {
    if (!options.clientModel.trim()) throw new TypeError("clientModel cannot be empty.");
    result.client_model = options.clientModel;
  }
  return result;
}

function nonEmptyStrings(values: string[], name: string): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${name} must contain at least one value.`);
  }
  const normalized = values.map(value => value.trim());
  if (normalized.some(value => !value)) {
    throw new TypeError(`${name} cannot contain empty values.`);
  }
  return normalized;
}

/** Thin, credential-hiding client for Parallel's synchronous web APIs. */
export class ParallelApi {
  readonly #apiKey: string;
  readonly #baseUrl: string;

  constructor(apiKey: string, baseUrl = DEFAULT_API_BASE_URL) {
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async search(
    objective: string,
    searchQueries: string[],
    options?: ParallelRequestOptions,
  ): Promise<ParallelSearchResponse> {
    if (!objective.trim()) throw new TypeError("objective cannot be empty.");
    const raw = await this.#post<RawSearchResponse>("/v1/search", {
      objective: objective.trim(),
      search_queries: nonEmptyStrings(searchQueries, "searchQueries"),
      ...requestOptions(options),
    });
    return {
      searchId: raw.search_id,
      sessionId: raw.session_id,
      results: raw.results.map(mapSearchResult),
    };
  }

  async extract(
    urls: string[],
    objective?: string,
    options?: ParallelRequestOptions,
  ): Promise<ParallelExtractResponse> {
    const normalizedUrls = nonEmptyStrings(urls, "urls");
    if (normalizedUrls.length > 20) throw new TypeError("extract accepts at most 20 URLs.");
    for (const url of normalizedUrls) {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new TypeError("extract URLs must use HTTP or HTTPS.");
      }
    }
    const raw = await this.#post<RawExtractResponse>("/v1/extract", {
      urls: normalizedUrls,
      ...(objective?.trim() ? { objective: objective.trim() } : {}),
      ...requestOptions(options),
    });
    return {
      extractId: raw.extract_id,
      sessionId: raw.session_id,
      results: raw.results.map(mapExtractResult),
      errors: raw.errors.map(mapExtractError),
    };
  }

  async #post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": this.#apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Parallel API request failed (${response.status} ${response.statusText}).`);
    }
    return await response.json() as T;
  }
}

function mapSearchResult(result: RawSearchResponse["results"][number]): ParallelSearchResult {
  return {
    url: result.url,
    title: result.title,
    ...(result.publish_date ? { publishDate: result.publish_date } : {}),
    excerpts: result.excerpts,
  };
}

function mapExtractResult(result: RawExtractResponse["results"][number]): ParallelExtractResult {
  return {
    url: result.url,
    ...(result.title ? { title: result.title } : {}),
    ...(result.publish_date ? { publishDate: result.publish_date } : {}),
    excerpts: result.excerpts,
    ...(result.full_content ? { fullContent: result.full_content } : {}),
  };
}

function mapExtractError(error: RawExtractResponse["errors"][number]): ParallelExtractError {
  return {
    url: error.url,
    errorType: error.error_type,
    ...(error.http_status_code !== undefined ? { httpStatusCode: error.http_status_code } : {}),
    ...(error.content ? { content: error.content } : {}),
  };
}
