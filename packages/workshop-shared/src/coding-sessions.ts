import type { WorkerEntrypoint } from "cloudflare:workers";
import type { ActionDescription, ObservationDescription } from "./gatekeeper.js";
import type {
  CodingSessionApplicationCapability,
  CodingSessionAttachCapability,
  CodingSessionDevelopmentCatalog,
  CodingSessionDevelopmentPlan,
  CodingSessionDevelopmentStatus,
  CodingSessionEditorCapability,
  CodingSessionFileUploadRequest,
  CodingSessionFileUploadResult,
  CodingSessionOpenCodeCapability,
  CodingSessionRepository,
  CodingSessionSummary,
  CodingSessionTerminalKind,
  CreateCodingSessionRequest,
  OpenCodeUserCustomization,
} from "./api.js";
import type { ProductFeedbackStatus, ProductFeedbackSubmissionResult } from "./product-feedback.js";

/** Maximum number of repositories accepted for one coding session. */
export const MAX_CODING_SESSION_REPOSITORIES = 8;

/** Maximum number of bytes accepted for one coding-session file upload (10 MiB). */
export const MAX_CODING_SESSION_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Maximum UTF-16 code units accepted from a user-supplied upload filename. */
export const MAX_CODING_SESSION_UPLOAD_FILENAME_LENGTH = 255;

const MAX_OPENCODE_PLUGINS = 20;
const MAX_OPENCODE_SKILLS = 20;
const MAX_OPENCODE_SKILL_NAME_LENGTH = 64;
const MAX_OPENCODE_SKILL_DESCRIPTION_LENGTH = 1024;
const MAX_OPENCODE_SKILL_INSTRUCTIONS_LENGTH = 65536;
const MAX_OPENCODE_CUSTOMIZATION_BYTES = 256 * 1024;
const OPENCODE_SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NPM_PACKAGE_WITH_OPTIONAL_VERSION_REGEX = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)(?:@(?:\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?|[~^]?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?|[<>]=?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?))?$/;

/** Authenticated Workshop identity supplied to the Sessions service over a private binding. */
export interface CodingSessionOwner {
  /** Stable Workshop user Durable Object identifier. */
  userId: string;
  /** Verified user identity used for model authorization and audit logs. */
  email: string;
  /** Connected GitHub login, when the provider exposes one. */
  githubLogin?: string;
}

/** One MCP tool made available to an authenticated coding session. */
export interface CodingSessionTool {
  /** Stable name exposed through the Workshop MCP server. */
  name: string;
  /** Optional display title supplied by the connected service. */
  title?: string;
  /** Optional tool description supplied by the connected service. */
  description?: string;
  /** JSON Schema describing the tool arguments. */
  inputSchema?: unknown;
  /** JSON Schema describing structured tool output. */
  outputSchema?: unknown;
  /** Standard MCP authorization schemes declared by the upstream tool. */
  securitySchemes?: unknown[];
  /** Standard MCP Apps metadata, with its resource URI rewritten by Workshop when proxied. */
  _meta?: { ui?: { resourceUri?: string; visibility?: ("model" | "app")[] } };
}

/** One namespaced MCP Apps resource exposed to a coding session. */
export interface CodingSessionResource {
  /** Workshop-owned URI used for subsequent `resources/read` requests. */
  uri: string;
  /** Upstream resource name. */
  name: string;
  /** Optional upstream display title. */
  title?: string;
  /** Optional upstream resource description. */
  description?: string;
  /** Optional upstream media type. */
  mimeType?: string;
  /** Optional upstream resource size in bytes. */
  size?: number;
  /** Bounded standard metadata supplied with the resource. */
  _meta?: Record<string, unknown>;
}

/** One resource body returned through the Workshop MCP proxy. */
export interface CodingSessionResourceContent {
  /** Workshop-owned URI corresponding to the requested upstream resource. */
  uri: string;
  /** Optional upstream media type. */
  mimeType?: string;
  /** UTF-8 resource body, when the upstream resource is textual. */
  text?: string;
  /** Base64 resource body, when the upstream resource is binary. */
  blob?: string;
  /** Bounded standard MCP Apps metadata supplied with the resource body. */
  _meta?: Record<string, unknown>;
}

/** Result of reading one coding-session MCP Apps resource. */
export interface CodingSessionReadResourceResult {
  /** Resource bodies returned by the connected MCP server. */
  contents: CodingSessionResourceContent[];
}

/** Result of invoking a coding-session MCP tool. */
export interface CodingSessionToolResult {
  /** MCP content blocks returned to OpenCode. */
  content: unknown[];
  /** Whether the connected tool reported an application-level failure. */
  isError?: boolean;
  /** Optional structured result returned by the connected tool. */
  structuredContent?: unknown;
  /** Existing gatekeeper action identifier while this call awaits approval. */
  pendingActionId?: number;
}

/** One durable observation or action emitted by a coding-session tool call. */
export interface CodingSessionActivity {
  /** Opaque activity identifier. */
  id: string;
  /** Coding session that produced this activity. */
  sessionId: string;
  /** Connected account vendor identifier. */
  vendorId: string;
  /** Human-facing connected resource title. */
  resourceTitle: string;
  /** Whether this record is a completed read or an approval-gated action. */
  type: "observation" | "action";
  /** Current action state; observations are always approved. */
  state: "pending" | "applying" | "approved" | "rejected" | "failed";
  /** Bounded description rendered by Workshop approval surfaces. */
  description: ObservationDescription | ActionDescription;
  /** Time the activity was submitted. */
  createdAt: Date;
  /** Failure text when an approved action could not be applied. */
  error?: string;
}

/** Narrow owner-bound capability used by the Sessions worker to serve Workshop MCP. */
export interface CodingSessionToolHost extends WorkerEntrypoint {
  /**
   * Revalidates startup authority for the current user and returns ephemeral OpenCode
   * customization for immediate materialization. This private control-plane call is made only by
   * the Sessions worker's startup alarm, never by public clients.
   */
  prepareSessionStartup(
    owner: CodingSessionOwner,
    sessionId: string,
    repositories: CodingSessionRepository[],
  ): Promise<OpenCodeUserCustomization>;

  /** Lists the current user's eligible connected MCP tools. */
  listTools(owner: CodingSessionOwner, sessionId: string, sandboxId: string): Promise<CodingSessionTool[]>;

  /** Lists namespaced MCP Apps resources referenced by the current tool catalog. */
  listResources(
    owner: CodingSessionOwner,
    sessionId: string,
    sandboxId: string,
  ): Promise<CodingSessionResource[]>;

  /** Reads one namespaced MCP Apps resource through its owning gatekeeper. */
  readResource(
    owner: CodingSessionOwner,
    sessionId: string,
    uri: string,
    sandboxId: string,
  ): Promise<CodingSessionReadResourceResult>;

  /** Calls one namespaced tool through its existing gatekeeper approval policy. */
  callTool(
    owner: CodingSessionOwner,
    sessionId: string,
    name: string,
    args: Record<string, unknown> | undefined,
    sandboxId: string,
  ): Promise<CodingSessionToolResult>;

  /** Collects the result of an approval-gated MCP action. */
  getActionResult(
    owner: CodingSessionOwner,
    sessionId: string,
    name: string,
    actionId: number,
    sandboxId: string,
  ): Promise<CodingSessionToolResult>;
}

/** Server-collected, sanitized evidence bundle for first-party product feedback automation. */
export interface ProductFeedbackEvidenceBundle {
  /** Stable evidence identifier minted by Workshop. */
  id: string;
  /** Feedback category selected by the user. */
  kind: "bug" | "feedback";
  /** Bounded title authored by the submitter. */
  title: string;
  /** Bounded details authored by the submitter. */
  description: string;
  /** Verified submitting user email. */
  submitterEmail: string;
  /** Authenticated owner used only to authorize the isolated model relay and repository policy. */
  owner: CodingSessionOwner;
  /** Normalized route pathname only. */
  pathname: string;
  /** Server-authorized optional workspace context. */
  workspace?: {
    /** Workspace durable object ID. */
    id: string;
    /** Workspace title. */
    title?: string;
    /** Current chat ID, when supplied and authorized. */
    chatId?: number;
    /** Bounded visible transcript summary or omission notice. */
    transcript?: string[];
    /** Bounded sanitized action or observation summaries. */
    activity?: string[];
    /** Omission reasons for policy-tainted or unavailable evidence. */
    omissions?: string[];
  };
  /** Bounded frontend diagnostics captured from the current browser tab. */
  diagnostics?: Array<{ timestamp: Date; level: "log" | "info" | "warn" | "error"; message: string }>;
  /** Bounded coding-session summaries and activity collected through owner-bound APIs. */
  codingSessions?: {
    /** Bounded public coding-session summaries. */
    sessions: CodingSessionSummary[];
    /** Bounded activity summaries. */
    activity: string[];
    /** Omission reasons for unavailable or policy-tainted evidence. */
    omissions?: string[];
  };
  /** Expiration time for private raw evidence. */
  expiresAt: Date;
}

/** Private control-plane RPC implemented by the Sessions service. */
export interface CodingSessionsService extends WorkerEntrypoint {
  /** Reports whether a separate-origin browser VS Code runtime is configured. */
  editorAvailable(): Promise<boolean>;

  /** Lists sessions owned by the authenticated Workshop user. */
  listSessions(owner: CodingSessionOwner): Promise<CodingSessionSummary[]>;

  /** Returns the display-safe development-stack catalog available to the authenticated owner. */
  getDevelopmentCatalog(owner: CodingSessionOwner): Promise<CodingSessionDevelopmentCatalog>;

  /** Checks one create request without reserving capacity or creating a sandbox generation. */
  preflightSession(
    owner: CodingSessionOwner,
    request: CreateCodingSessionRequest,
  ): Promise<CodingSessionDevelopmentPlan>;

  /** Returns persisted component and application lifecycle for one owned session. */
  getDevelopmentStatus(
    owner: CodingSessionOwner,
    sessionId: string,
  ): Promise<CodingSessionDevelopmentStatus>;

  /**
   * Retrieves one non-archived session owned by the authenticated Workshop user and reconciles its
   * live runtime metadata without exposing sandbox or terminal identifiers.
   */
  getSession(owner: CodingSessionOwner, sessionId: string): Promise<CodingSessionSummary | undefined>;

  /**
   * Retrieves persisted metadata for one non-archived owned session without contacting its sandbox.
   * This avoids re-entering a sandbox while authorizing an outbound tool call from that sandbox.
   */
  getSessionMetadata(owner: CodingSessionOwner, sessionId: string): Promise<CodingSessionSummary | undefined>;

  /**
   * Returns whether persisted registry metadata still maps the owned running session to the supplied
   * sandbox generation, without contacting that sandbox. This private control-plane check lets the
   * Workshop MCP host reject stale sandboxes during rolling deploys and restarts.
   */
  isCurrentSessionGeneration(owner: CodingSessionOwner, sessionId: string, sandboxId: string): Promise<boolean>;

  /** Creates a session after independently validating the repository allowlist. */
  createSession(
    owner: CodingSessionOwner,
    request: CreateCodingSessionRequest,
    customization?: OpenCodeUserCustomization,
  ): Promise<CodingSessionSummary>;

  /** Stops a session after verifying ownership. */
  stopSession(owner: CodingSessionOwner, sessionId: string): Promise<void>;

  /** Destroys and rebuilds a session after verifying ownership. */
  restartSession(
    owner: CodingSessionOwner,
    sessionId: string,
    customization?: OpenCodeUserCustomization,
  ): Promise<CodingSessionSummary>;

  /** Stops and archives a session after verifying ownership. */
  archiveSession(owner: CodingSessionOwner, sessionId: string): Promise<void>;

  /** Mints a short-lived, single-use terminal attachment capability. */
  mintAttachCapability(
    owner: CodingSessionOwner,
    sessionId: string,
    terminal?: CodingSessionTerminalKind,
  ): Promise<CodingSessionAttachCapability>;

  /** Mints a generation-bound browser VS Code capability after verifying ownership. */
  mintEditorCapability(owner: CodingSessionOwner, sessionId: string): Promise<CodingSessionEditorCapability>;

  /** Mints a generation-bound same-origin OpenCode server capability after verifying ownership. */
  mintOpenCodeCapability(owner: CodingSessionOwner, sessionId: string): Promise<CodingSessionOpenCodeCapability>;

  /** Attaches the trusted authenticated owner to an already-running Pi/Prime bridge. */
  connectPi(owner: CodingSessionOwner, sessionId: string): Promise<import("./pi-backbone.js").CodingSessionPiConnection>;
  /** Dispatches a bounded Pi/Prime command using an expiring generation-bound connection. */
  callPi(owner: CodingSessionOwner, sessionId: string, connectionId: string, command: import("./pi-backbone.js").CodingSessionPiCommand): Promise<import("./pi-backbone.js").CodingSessionPiResult>;

  /** Mints a generation-bound capability for one reviewed application after verifying ownership. */
  mintApplicationCapability(
    owner: CodingSessionOwner,
    sessionId: string,
    applicationId: string,
  ): Promise<CodingSessionApplicationCapability>;

  /** Writes one bounded file into an owned running session's private upload directory. */
  uploadFile(
    owner: CodingSessionOwner,
    request: CodingSessionFileUploadRequest,
  ): Promise<CodingSessionFileUploadResult>;

  /** Durably enqueue a first-party feedback automation job using private sanitized evidence. */
  submitProductFeedback(
    owner: CodingSessionOwner,
    evidence: ProductFeedbackEvidenceBundle,
  ): Promise<ProductFeedbackSubmissionResult>;

  /** List recent first-party feedback automation statuses owned by the supplied user. */
  listProductFeedbackStatuses(owner: CodingSessionOwner): Promise<ProductFeedbackStatus[]>;

  /** Read one first-party feedback automation status owned by the supplied user. */
  getProductFeedbackStatus(owner: CodingSessionOwner, id: string): Promise<ProductFeedbackStatus | undefined>;
}

/** Returns whether a value is a canonical GitHub repository name accepted by Coding Sessions. */
export function isCodingSessionRepository(value: unknown): value is CodingSessionRepository {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/.test(value);
}

/** Validates and canonically orders a bounded, non-empty coding-session repository set. */
export function validateCodingSessionRepositories(values: unknown): CodingSessionRepository[] {
  if (!Array.isArray(values) || values.length === 0) throw new Error("Select at least one repository.");
  if (values.length > MAX_CODING_SESSION_REPOSITORIES) {
    throw new Error(`Select at most ${MAX_CODING_SESSION_REPOSITORIES} repositories.`);
  }
  const repositorySet = new Set<CodingSessionRepository>();
  const repositories: CodingSessionRepository[] = [];
  for (const value of values) {
    if (!isCodingSessionRepository(value) || repositorySet.has(value)) {
      throw new Error("Coding session repository set is invalid.");
    }
    repositorySet.add(value);
    let index = 0;
    while (index < repositories.length && repositories[index]! < value) index++;
    repositories.splice(index, 0, value);
  }
  return repositories;
}

/** Validates and normalizes one coding-session file-upload request. */
export function validateCodingSessionFileUploadRequest(
  value: CodingSessionFileUploadRequest,
): CodingSessionFileUploadRequest & { filename: string } {
  if (typeof value !== "object" || value === null) throw new Error("Invalid coding session file upload.");
  const { sessionId, filename, content } = value as CodingSessionFileUploadRequest;
  if (typeof sessionId !== "string" || sessionId.length < 1) throw new Error("Coding session is required.");
  if (typeof filename !== "string" || filename.length < 1) throw new Error("Upload filename is required.");
  if (filename.length > MAX_CODING_SESSION_UPLOAD_FILENAME_LENGTH) {
    throw new Error(`Upload filename must be at most ${MAX_CODING_SESSION_UPLOAD_FILENAME_LENGTH} characters.`);
  }
  if (!(content instanceof Uint8Array)) throw new Error("Upload content must be bytes.");
  if (content.byteLength === 0) throw new Error("Upload content must not be empty.");
  if (content.byteLength > MAX_CODING_SESSION_UPLOAD_BYTES) {
    throw new Error(`Upload content must be at most ${MAX_CODING_SESSION_UPLOAD_BYTES} bytes.`);
  }
  return { sessionId, filename: safeCodingSessionUploadFilename(filename), content };
}

/** Returns a display-useful safe basename for a coding-session upload filename. */
export function safeCodingSessionUploadFilename(filename: string): string {
  const basename = filename.split(/[\\/]+/).filter(Boolean).at(-1) ?? "";
  const withoutControls = [...basename]
    .filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join("");
  const safe = withoutControls.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/[ .]+$/g, "").replace(/^\.+/g, "");
  const candidate = safe || "upload.bin";
  if (candidate.length <= MAX_CODING_SESSION_UPLOAD_FILENAME_LENGTH) return candidate;
  const dot = candidate.lastIndexOf(".");
  const extension = dot > 0 && candidate.length - dot <= 32 ? candidate.slice(dot) : "";
  return `${candidate.slice(0, MAX_CODING_SESSION_UPLOAD_FILENAME_LENGTH - extension.length)}${extension}`;
}

/** Validates and normalizes account-scoped OpenCode customization before persistence or use. */
export function validateOpenCodeCustomization(value: OpenCodeUserCustomization): OpenCodeUserCustomization {
  if (typeof value !== "object" || value === null || !Array.isArray(value.plugins) || !Array.isArray(value.skills)) {
    throw new Error("Invalid OpenCode customization.");
  }
  if (value.plugins.length > MAX_OPENCODE_PLUGINS) {
    throw new Error(`OpenCode customization may include at most ${MAX_OPENCODE_PLUGINS} plugins.`);
  }
  if (value.skills.length > MAX_OPENCODE_SKILLS) {
    throw new Error(`OpenCode customization may include at most ${MAX_OPENCODE_SKILLS} skills.`);
  }

  const plugins: string[] = [];
  const pluginSet = new Set<string>();
  for (const plugin of value.plugins) {
    if (typeof plugin !== "string" || plugin.trim() !== plugin || !NPM_PACKAGE_WITH_OPTIONAL_VERSION_REGEX.test(plugin)) {
      throw new Error("OpenCode plugins must be npm package names with optional semver suffixes.");
    }
    if (pluginSet.has(plugin)) throw new Error(`Duplicate OpenCode plugin: ${plugin}`);
    pluginSet.add(plugin);
    plugins.push(plugin);
  }

  const skills: OpenCodeUserCustomization["skills"] = [];
  const skillSet = new Set<string>();
  for (const skill of value.skills) {
    if (typeof skill !== "object" || skill === null) throw new Error("Invalid OpenCode skill.");
    const { name, description, instructions } = skill;
    if (typeof name !== "string" || name.length > MAX_OPENCODE_SKILL_NAME_LENGTH || !OPENCODE_SKILL_NAME_REGEX.test(name)) {
      throw new Error("OpenCode skill names must be lowercase kebab-case and at most 64 characters.");
    }
    if (skillSet.has(name)) throw new Error(`Duplicate OpenCode skill: ${name}`);
    if (typeof description !== "string" || description.length < 1 || description.length > MAX_OPENCODE_SKILL_DESCRIPTION_LENGTH) {
      throw new Error("OpenCode skill descriptions must be between 1 and 1024 characters.");
    }
    if (typeof instructions !== "string" || instructions.length < 1 || instructions.length > MAX_OPENCODE_SKILL_INSTRUCTIONS_LENGTH) {
      throw new Error("OpenCode skill instructions must be between 1 and 65536 characters.");
    }
    skillSet.add(name);
    skills.push({ name, description, instructions });
  }

  const result = { plugins, skills };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_OPENCODE_CUSTOMIZATION_BYTES) {
    throw new Error("OpenCode customization is too large.");
  }
  return result;
}
