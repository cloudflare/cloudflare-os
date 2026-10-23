import "cloudflare:workers";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";

// ---------------------------------------------------------------------------
// HTTP wrapper around the Canva Connect API (https://api.canva.com/rest/v1).
//
// This module only speaks HTTP: typed request functions, one error class, and the raw response
// shapes. It knows nothing about observations, actions, or the approval queue — that is canva.ts.
// Token acquisition and refresh live in canva-oauth.ts; this client is handed a callback that
// returns a valid bearer token.

const API_BASE_URL = "https://api.canva.com/rest/v1/";
const REQUEST_TIMEOUT_MS = 30_000;
/** Canva listing responses are small (metadata plus thumbnails); 1 MiB is generous. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class CanvaApiError extends Error {
  status: number;
  /** Canva's machine-readable error code, e.g. "permission_denied" or "not_found", when present. */
  code: string | undefined;
  details: unknown;
  /** 401 = expired/invalid token. 403 is a scope or permission problem, not an auth failure. */
  isAuthError: boolean;

  /**
   * `message` is Canva's own text, which is often generic ("Unable to fetch designs"). The thrown
   * message prefixes the status and code so a log line or an agent-visible error says whether the
   * request was malformed (400), rate limited (429), or failed on Canva's side (5xx).
   */
  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(`Canva API ${status}${code ? ` (${code})` : ""}: ${message}`);
    this.name = "CanvaApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.isAuthError = status === 401;
  }
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  const text = await readTextCapped(response, MAX_RESPONSE_BYTES);
  if (text.length === 0) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return JSON.parse(text);
  return text;
}

// ---------------------------------------------------------------------------
// Raw Canva Connect API response shapes (only the fields we consume).
//
// Timestamps are Unix seconds, not ISO strings; canva.ts converts them.

export type CanvaThumbnailResponse = { width: number; height: number; url: string };

export type CanvaTeamUserResponse = { user_id: string; team_id: string };

export type CanvaDesignResponse = {
  id: string;
  title?: string;
  /** Absent on the design summary a generation job returns. */
  owner?: CanvaTeamUserResponse;
  thumbnail?: CanvaThumbnailResponse;
  urls: { edit_url: string; view_url: string };
  created_at: number;
  updated_at: number;
  page_count?: number;
};

export type CanvaFolderResponse = {
  id: string;
  name: string;
  thumbnail?: CanvaThumbnailResponse;
  created_at: number;
  updated_at: number;
};

export type CanvaImageAssetResponse = {
  id: string;
  name: string;
  tags?: string[];
  thumbnail?: CanvaThumbnailResponse;
  created_at: number;
  updated_at: number;
  /** Present on a full asset (GET /assets/{id}, transformation results), absent in folder listings. */
  type?: "image" | "video";
  owner?: CanvaTeamUserResponse;
  metadata?: { type: "image" | "video"; width?: number; height?: number };
};

export type CanvaFolderItemResponse =
  | { type: "folder"; folder: CanvaFolderResponse }
  | { type: "design"; design: CanvaDesignResponse }
  | { type: "image"; image: CanvaImageAssetResponse };

/** A paginated listing: `continuation` is present when more pages exist. */
export type CanvaListResponse<T> = { items: T[]; continuation?: string };

export type CanvaDesignTypeRequest =
  | { type: "preset"; name: "doc" | "whiteboard" | "presentation" }
  | { type: "custom"; width: number; height: number };

export type CanvaCreateDesignRequest = {
  design_type: CanvaDesignTypeRequest;
  title?: string;
  asset_id?: string;
};

// Design generation (POST /generations, GET /generations/{jobId}). A preview API: Canva may change it
// without a version bump, and public integrations that use it cannot pass Canva's review.

export type CanvaGenerationDesignTypeRequest = { type: "preset"; name: "doc" | "presentation" };

export type CanvaCreateGenerationRequest = {
  brief: string;
  design_type: CanvaGenerationDesignTypeRequest;
  outline?: { sections: { title: string; description?: string; points?: string[] }[] };
};

export type CanvaGenerationJobResponse = {
  id: string;
  status: "in_progress" | "success" | "failed";
  /** Present only when `status` is "success". */
  result?: { design: CanvaDesignResponse };
  /** Present only when `status` is "failed". */
  error?: { code: string; message: string };
};

// Image transformation (POST /image-transformations, GET /image-transformations/{jobId}). Also a
// preview API. Needs asset:read and asset:write.

export type CanvaImageTransformationRequest = { type: "background_removal" };

export type CanvaCreateImageTransformationRequest = {
  asset_id: string;
  transformations: CanvaImageTransformationRequest[];
  name?: string;
};

export type CanvaImageTransformationJobResponse = {
  /** Absent when the job finished during creation: there is then nothing to poll. */
  id?: string;
  status: "in_progress" | "success" | "failed";
  /** Present only when `status` is "success". */
  result?: { asset: CanvaImageAssetResponse };
  /** Present only when `status` is "failed". */
  error?: { code: string; message: string };
};

// ---------------------------------------------------------------------------
// Client

type QueryValue = string | number | boolean | undefined;

type RequestOptions = {
  query?: Record<string, QueryValue>;
  body?: unknown;
};

export class CanvaApi {
  #getToken: () => Promise<string>;

  constructor(getToken: () => Promise<string>) {
    this.#getToken = getToken;
  }

  async #request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(path, API_BASE_URL);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${await this.#getToken()}`,
    });
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }

    const response = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const parsed = await parseBody(response);
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      let code: string | undefined;
      if (parsed && typeof parsed === "object") {
        const error = parsed as { code?: string; message?: string };
        if (typeof error.code === "string") code = error.code;
        if (typeof error.message === "string" && error.message.length > 0) message = error.message;
      } else if (typeof parsed === "string" && parsed.length > 0) {
        message = parsed;
      }
      throw new CanvaApiError(response.status, message, code, parsed);
    }
    return parsed as T;
  }

  // --- Users ---

  /** GET /users/me: the connected user's and team's IDs. */
  getCurrentUser(): Promise<{ team_user: CanvaTeamUserResponse }> {
    return this.#request("GET", "users/me");
  }

  /** GET /users/me/profile: the connected user's display name. */
  getProfile(): Promise<{ profile: { display_name: string } }> {
    return this.#request("GET", "users/me/profile");
  }

  /**
   * GET /users/me/capabilities: which plan-gated features this user has, e.g. "design_generation".
   * Rate limited to 10 requests per minute per user, so callers should not poll it.
   */
  getCapabilities(): Promise<{ capabilities: string[] }> {
    return this.#request("GET", "users/me/capabilities");
  }

  // --- Designs ---

  /** GET /designs: list or search the user's designs, one page at a time. */
  listDesigns(query: {
    query?: string;
    ownership?: string;
    sort_by?: string;
    continuation?: string;
  }): Promise<CanvaListResponse<CanvaDesignResponse>> {
    return this.#request("GET", "designs", { query });
  }

  /** GET /designs/{id}: metadata for one design. 404 if missing or inaccessible. */
  async getDesign(designId: string): Promise<CanvaDesignResponse> {
    const result = await this.#request<{ design: CanvaDesignResponse }>(
      "GET", `designs/${encodeURIComponent(designId)}`);
    return result.design;
  }

  /** POST /designs: create a new, empty design. */
  async createDesign(body: CanvaCreateDesignRequest): Promise<CanvaDesignResponse> {
    const result = await this.#request<{ design: CanvaDesignResponse }>("POST", "designs", { body });
    return result.design;
  }

  // --- Design generation ---

  /**
   * POST /generations: start an AI design generation job. Spends the user's AI credits. Returns the
   * job, usually still "in_progress"; a 429 with code "credit_quota_exceeded" means the allowance is
   * used up, and a 403 means generation isn't available to this user.
   */
  async createDesignGeneration(body: CanvaCreateGenerationRequest): Promise<CanvaGenerationJobResponse> {
    const result = await this.#request<{ job: CanvaGenerationJobResponse }>("POST", "generations", { body });
    return result.job;
  }

  /** GET /generations/{jobId}: poll a generation job. Free to call; jobs expire after 24 hours (404). */
  async getDesignGeneration(jobId: string): Promise<CanvaGenerationJobResponse> {
    const result = await this.#request<{ job: CanvaGenerationJobResponse }>(
      "GET", `generations/${encodeURIComponent(jobId)}`);
    return result.job;
  }

  // --- Assets ---

  /** GET /assets/{id}: one asset (image or video) with owner and dimensions. 404 if missing. */
  async getAsset(assetId: string): Promise<CanvaImageAssetResponse> {
    const result = await this.#request<{ asset: CanvaImageAssetResponse }>(
      "GET", `assets/${encodeURIComponent(assetId)}`);
    return result.asset;
  }

  // --- Image transformation ---

  /**
   * POST /image-transformations: start a transformation job. Spends the user's AI credits. The job
   * may already be finished in the response, in which case it carries no `id`.
   */
  async createImageTransformation(
    body: CanvaCreateImageTransformationRequest,
  ): Promise<CanvaImageTransformationJobResponse> {
    const result = await this.#request<{ job: CanvaImageTransformationJobResponse }>(
      "POST", "image-transformations", { body });
    return result.job;
  }

  /** GET /image-transformations/{jobId}: poll a transformation job. Free to call. */
  async getImageTransformation(jobId: string): Promise<CanvaImageTransformationJobResponse> {
    const result = await this.#request<{ job: CanvaImageTransformationJobResponse }>(
      "GET", `image-transformations/${encodeURIComponent(jobId)}`);
    return result.job;
  }

  // --- Folders ---

  /** GET /folders/{id}: metadata for one folder. "root" and "uploads" are well-known IDs. */
  async getFolder(folderId: string): Promise<CanvaFolderResponse> {
    const result = await this.#request<{ folder: CanvaFolderResponse }>(
      "GET", `folders/${encodeURIComponent(folderId)}`);
    return result.folder;
  }

  /** GET /folders/{id}/items: the folder's contents, one page at a time. */
  listFolderItems(folderId: string, query: {
    item_types?: string[];
    sort_by?: string;
    continuation?: string;
  }): Promise<CanvaListResponse<CanvaFolderItemResponse>> {
    return this.#request("GET", `folders/${encodeURIComponent(folderId)}/items`, {
      query: {
        item_types: query.item_types?.join(","),
        sort_by: query.sort_by,
        continuation: query.continuation,
      },
    });
  }
}
