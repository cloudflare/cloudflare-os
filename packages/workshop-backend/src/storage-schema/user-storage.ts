// The User Durable Object's storage schema: `makeUserStorage()` and the record types it stores.
//
// Everything a user's Durable Object persists is declared in this one file, so that a change to
// the stored shape of a user shows up as a change here. See overseer-storage.ts for the
// conventions.

import { createTypedStorage, collection } from "@gadgets/typed-storage";
import type {
  AiChatAuthorInfo, AiModelConfig, BlueprintMetadata, BlueprintOutput, GadgetMetadata, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import type { AccountDescription, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";

export type ConnectedAccountRecord = {
  id: number;
  account: Fetcher<GatekeeperUser>;
  description: AccountDescription;
  vendorId: string;   // Derived from the GATEKEEPER_ binding name (e.g. "google", "email").
  credentialExpiresAt?: Date;    // When credentials are expected to expire, if known.
  credentialsExpired?: boolean;  // Set true by async notification from gatekeeper.
  // True if the Workshop created this account automatically via GatekeeperVendor.createAccount()
  // (no OAuth flow), rather than the user connecting it. Such accounts are protected from manual
  // disconnect, since deleting one permanently destroys the user's data in that gatekeeper.
  autoProvisioned?: boolean;
};

/**
 * A connect ("connect") or reconnect/ensureResources ("restore") flow that a gatekeeper has finished
 * but the user's browser has not yet confirmed (see connect-handoff.ts). Keyed by the SHA-256 of the
 * ticket; single-use, and swept by alarm() once `expiresAt` passes.
 */
export type PendingHandoffRecord = {
  ticketHash: string;
  kind: "connect" | "restore";
  accountId: number;
  expiresAt: Date;
  credentialExpiresAt?: Date;
  /** The staged account, present for `kind: "connect"` only; becomes the ConnectedAccountRecord. */
  connect?: Pick<ConnectedAccountRecord, "account" | "description" | "vendorId">;
  /**
   * The gatekeeper's id for the staged credentials, present for `kind: "restore"` only; passed back
   * in commitReconnect() so this ticket can activate no other stage's credentials.
   */
  stageId?: string;
};

/**
 * A started connect / reconnect / ensure-resources flow, keyed by the hash of the nonce the Workshop
 * tab gave the popup (see ConnectFlowStart); completeConnectHandoff requires the ticket's record and
 * the nonce's flow to name the same account. Single-use, and swept by alarm() once `expiresAt` passes.
 */
export type PendingConnectFlow = {
  nonceHash: string;
  accountId: number;
  expiresAt: Date;
};

export type UserAiModelRecord = {
  profile: AiChatAuthorInfo;
  config: AiModelConfig;
}

type LoginSessionRecord = {
  tokenId: string,  // sha256 hash of token, hex-formatted
  created: Date,
}

/** Blueprint record stored in the user's `blueprints` collection. */
export type BlueprintUserRecord = {
  id: string;
  metadata: BlueprintMetadata;
  gadgetId?: string;
  /** Source of truth for whether the blueprint is featured deployment-wide. */
  featured?: boolean;
};

type LibraryBlueprintRecord = {
  id: string;
  metadata: BlueprintMetadata;
  addedAt: Date;
  uploaded: boolean;
};

export type GadgetRecord = GadgetMetadata & {
  created: Date;
  lastActive?: Date;  // if missing, gadget is provisional
  // If we're not the gadget owner (it was shared with us), `owner` is set (inherited from
  // GadgetMetadata).
};

/**
 * One output of a workspace, as pushed into a user's output index by the Overseer that owns it
 * (see `syncWorkspaceOutputs()`). Carries only what the workspace itself knows: its title,
 * activity time and ownership are joined in from the `gadgets` collection on read, so they can't
 * go stale here.
 */
export type WorkspaceOutputEntry = {
  workpieceId: WorkpieceId;
  title: string;
  created: Date;

  /** The format the gadget was built as, if it was instantiated from a blueprint declaring one. */
  output?: BlueprintOutput;
};

type OutputRecord = WorkspaceOutputEntry & {
  // The workspace containing this output (an Overseer DO id).
  workspaceId: string;
};

/**
 * AI Gateway billing state for the optional top-up flow: which Cloudflare account to bill and a
 * cached credit balance. The OAuth tokens themselves live in the connected Cloudflare *gatekeeper*
 * account (vendorId "cloudflare"); billing reads a usable token from there via getUsableAccessToken.
 */
export type CloudflareBilling = {
  /** Selected account, once chosen (auto-selected when the grant sees exactly one). */
  accountId?: string;
  accountName?: string;
  /** Cached credit balance (USD) and when it was last fetched (unix ms). */
  creditsRemaining?: number | null;
  creditsUpdatedAt?: number;
};

export function makeUserStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      aiModels: collection<UserAiModelRecord>()({
        primaryKey: record => record.profile.id,
      }),
      gadgets: collection<GadgetRecord>()({
        primaryKey: "id"
      }),
      connectedAccounts: collection<ConnectedAccountRecord>()({
        primaryKey: "id"
      }),
      sessions: collection<LoginSessionRecord>()({
        primaryKey: "tokenId",
      }),
      pendingHandoffs: collection<PendingHandoffRecord>()({
        primaryKey: "ticketHash",
      }),
      pendingConnectFlows: collection<PendingConnectFlow>()({
        primaryKey: "nonceHash",
      }),
      blueprints: collection<BlueprintUserRecord>()({
        primaryKey: "id",
      }),
      libraryBlueprints: collection<LibraryBlueprintRecord>()({
        primaryKey: "id",
      }),
      // Outputs of every workspace in `gadgets`, mirrored here by each workspace's Overseer so the
      // Outputs page is one cheap read of the user's own DO. Entries are meaningful only while the
      // corresponding `gadgets` record exists; `syncWorkspaceOutputs()` and the `gadgets` deletion
      // paths keep the two in step.
      outputs: collection<OutputRecord>()({
        primaryKey: record => `${record.workspaceId}:${record.workpieceId}`,
        nonUniqueIndexes: {
          byWorkspace(record: OutputRecord) { return record.workspaceId; },
        },
      }),
    },
    singletons: {
      // AI Gateway billing state (selected account + cached balance) for the optional top-up flow;
      // null until a Cloudflare account is connected and resolved.
      cloudflareBilling: <CloudflareBilling | null>null,

      created: false,
      profile: <AiChatAuthorInfo>{
        type: "user",
        name: "User",
        id: "user@example.com",
      },
      quickModel: <string | null>null,
      preferredModel: <string | null>null,
      onboardingCompleted: false,

      // Set once the user's pre-existing workspaces have been asked to populate the outputs index
      // (see #backfillOutputs()). Workspaces created since push on their own.
      outputsBackfilled: false,

      // How far that catch-up has got: the last workspace id examined. The sweep runs a page at a
      // time and resumes here on the next visit.
      outputsBackfillCursor: "",

      nextAccountId: 0,
      pinnedBlueprints: <string[]>[],

      // Per-user free-tier daily LLM-call counter (only used when ENABLE_CLOUDFLARE_LIMITS is on).
      // Stores the current UTC day and the calls made that day; a stale `day` implicitly resets the
      // count. Folds the former standalone RateLimitDO into the user object.
      dailyLlmCount: <{ day: string; count: number } | null>null,

      // `passwordHash` value as passed to `login()`, but with an extra round of SHA-256 applied.
      //
      // null = password disabled (e.g. because some other auth mechanism is used)
      passwordHashHash: <Uint8Array | null>null,
      // Current profile revision, bumped every time the user updates their
      // public-facing profile. Currently this is only bumped when the user
      // changes their display name.
      profileRev: 0,
      // Profile revision the deployment-wide user directory last acknowledged
      // (-1 = never, which also lazily backfills users created before the
      // directory existed). See #syncDirectory().
      directoryRev: -1,
    }
  });
}

export type UserStorage = ReturnType<typeof makeUserStorage>;
