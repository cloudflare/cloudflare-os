import type { RpcTarget } from "cloudflare:workers";

/** Read-only access to Parallel's web search and extraction APIs. */
export interface ParallelSession extends RpcTarget {
  /**
   * Search the live web for an objective. Provide 2-3 concise, varied keyword queries for the best
   * results; each query should include the key entity or topic.
   */
  search(
    objective: string,
    searchQueries: string[],
    options?: ParallelRequestOptions,
  ): Promise<ParallelSearchResponse>;

  /** Extract relevant content from 1-20 public URLs. */
  extract(
    urls: string[],
    objective?: string,
    options?: ParallelRequestOptions,
  ): Promise<ParallelExtractResponse>;
}

/** Options shared by related search and extract calls. */
export interface ParallelRequestOptions {
  /** Maximum total characters of excerpts returned across all results. */
  maxCharsTotal?: number;
  /** Reuse a prior response's session ID to improve continuity across related calls. */
  sessionId?: string;
  /** Model consuming the result, used by Parallel to optimize output. */
  clientModel?: string;
}

/** One ranked web search result. */
export interface ParallelSearchResult {
  url: string;
  title: string;
  publishDate?: string;
  excerpts: string[];
}

/** A successful web search response. */
export interface ParallelSearchResponse {
  searchId: string;
  sessionId: string;
  results: ParallelSearchResult[];
}

/** Extracted content for one URL. */
export interface ParallelExtractResult {
  url: string;
  title?: string;
  publishDate?: string;
  excerpts: string[];
  fullContent?: string;
}

/** A URL that Parallel could not extract. */
export interface ParallelExtractError {
  url: string;
  errorType: string;
  httpStatusCode?: number;
  content?: string;
}

/** A successful extraction response, including any per-URL failures. */
export interface ParallelExtractResponse {
  extractId: string;
  sessionId: string;
  results: ParallelExtractResult[];
  errors: ParallelExtractError[];
}
