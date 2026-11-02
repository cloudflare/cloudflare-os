// The User Durable Object's storage schema: `makeUserStorage()` and the record types it stores.
//
// Everything a user's Durable Object persists is declared in this one file, so that a change to
// the stored shape of a user shows up as a change here. See overseer-storage.ts for the
// conventions.

import { createTypedStorage, collection } from "@gadgets/typed-storage";
import type {
  AiChatAuthorInfo, AiModelConfig, BlueprintMetadata, BlueprintOutput, WorkspaceMetadata,
  WorkpieceId, SpaceInfo, SpaceSyncJobInfo, CollaboratorRole,
} from "@gadgets/workshop-shared/api";
import type { AccountDescription, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import type { DeviceSessionHandoff } from "../auth/device-session-handoff.js";

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

/**
 * A user selected on behalf of a gatekeeper app that is currently awaiting
 * redemption by that account. Keyed by the SHA-256 of the single-use ticket and
 * swept by the User DO alarm after `expiresAt`.
 */
type PendingGatekeeperUserSelection = {
  ticketHash: string;
  appAccountId: number;
  vendorId: string;
  selectedUserId: string;
  expiresAt: Date;
};

export type UserAiModelRecord = {
  profile: AiChatAuthorInfo;
  config: AiModelConfig;
}

export type LoginSessionRecord = {
  tokenId: string,  // sha256 hash of token, hex-formatted
  created: Date,
  /** Device sessions expire server-side; legacy browser sessions have no expiry. */
  expiresAt?: Date,
  /** A staged device session cannot authenticate until its handoff is consumed. */
  pendingUntil?: Date,
}

/**
 * A device-session transfer staged by an authenticated browser. Keyed by a hash of the native
 * app's opaque state, idempotent for that state, single-use, and swept after `expiresAt`.
 */
export type PendingDeviceHandoffRecord = {
  stateHash: string;
  ticketHash: string;
  publicKey: string;
  handoff: DeviceSessionHandoff;
  expiresAt: Date;
  /** Password/gatekeeper mode only: activated on consumption, deleted on abandoned expiry. */
  sessionTokenId?: string;
};

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

/**
 * The two one-way flags of a workspace (`WorkspaceMetadata.containsRestrictedData` and
 * `ownerInvitesOnly`) as its Overseer states them, each one present, and with them the role the
 * workspace is published with (`WorkspaceMetadata.publicAccess`), absent when it is not published,
 * and how many times that role has changed (`publicAccessRevision`, absent for none). The
 * Overseer sends them to its owner's User DO with every call that can lead to a space listing
 * the workspace.
 */
export type WorkspaceRestrictions =
    Required<Pick<WorkspaceMetadata, "containsRestrictedData" | "ownerInvitesOnly">>
    & Pick<WorkspaceMetadata, "publicAccess"> & { publicAccessRevision?: number };

export type GadgetRecord = WorkspaceMetadata & {
  created: Date;
  lastActive?: Date;  // if missing, gadget is provisional
  // If we're not the gadget owner (it was shared with us), `owner` is set (inherited from
  // WorkspaceMetadata).

  // On the user's own workspaces, `containsRestrictedData` and `ownerInvitesOnly` (inherited from
  // WorkspaceMetadata) are what the workspace's Overseer last reported (see WorkspaceRestrictions),
  // and absent means it has never reported. A space lists a workspace only while both are false:
  // one that is set, or was never reported, keeps it out of every listing (see
  // UserDurableObject.#reconcileSpace()). A record of a workspace shared with the user has neither.
  // `publicAccess` is stated with them and recorded likewise, except that it is not one-way: the
  // record says what the statement made after the most changes of it said, and nothing while
  // either flag is set.

  /**
   * How many changes of `publicAccess` the statement the record took it from came after (see
   * WorkspaceRestrictions), absent for none. Set on the user's own workspaces only, and never
   * sent to a client.
   */
  publicAccessRevision?: number;

  /**
   * What a space last acknowledged for this workspace: the key of the space listing it, personal
   * or team, the title listed there and the role the entry says the workspace is published
   * with, absent when it says none. It is the marker UserDurableObject.#reconcileSpace()
   * works from. For a workspace a space may list, the marker being absent, or different from
   * what the record now says, means the listing has yet to catch up; for one no space may list,
   * the marker being there at all does. Without `title`, the space has acknowledged nothing: it
   * was asked to list the workspace, or to drop it (see UserDurableObject.deleteWorkspace()), and
   * may or may not have. A marker is written before any space is asked to list the workspace,
   * so with no marker no space lists it, and with one the spaces that may are the one it names
   * and the one the record points at. Set on the user's own workspaces only, and never sent to
   * a client.
   */
  registered?: { spaceKey: string; title?: string; published?: CollaboratorRole };

  /**
   * Where the workspace asks to sit in its space's tree: at the end of the entries under
   * `parentId` of that space's listing (see AuthenticatedApi.newWorkspace), or at the top of the
   * tree, which only a space listing it for the first time heeds. Set when the workspace is
   * created, and for the top of the tree whenever the record is pointed at a space, as a move
   * does; sent with every registration until a space acknowledges one, and dropped then, so that
   * it never places the workspace a second time. A record without one, as one written before
   * records had one, registers without it, and is listed with no position, among the entries
   * its space never positioned (see SpaceWorkspaceInfo.position). Set on the user's own
   * workspaces only, and never sent to a client.
   */
  placement?: { parentId?: string };

  /**
   * Set on the user's own workspaces that a space sync created (see
   * UserDurableObject.ensureSyncedWorkspace()): the connected account that synced it, the
   * bundled blueprint it was created from, whose import methods alone a sync may call on it, and
   * the address of the source item it was synced from, which a re-sync syncs it from again
   * (UserDurableObject.resyncWorkspace()). A client is shown the account alone
   * (WorkspaceMetadata.syncedFrom).
   */
  syncedFrom?: { accountId: number; blueprintId: string; sourceUrl: string };
};

/**
 * The workspace a space sync keeps for one source item (see
 * UserDurableObject.ensureSyncedWorkspace()), keyed by a digest of the space, the account, the
 * blueprint and the item's source URL, since that URL may be longer than a storage key. It counts only while the
 * user's own record of `workspaceId` exists and belongs to that space.
 */
export type SyncedWorkspaceRecord = { key: string; workspaceId: string };

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
      pendingDeviceHandoffs: collection<PendingDeviceHandoffRecord>()({
        primaryKey: "stateHash",
      }),
      pendingUserSelections: collection<PendingGatekeeperUserSelection>()({
        primaryKey: "ticketHash",
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
      // The spaces this user is a member of, mirrored here by each space so listing them is one
      // read of the user's own DO, like the record of a workspace shared with them. Presentation
      // only: a space's own member list is the authority, and nothing is authorized from this.
      spaces: collection<SpaceInfo>()({
        primaryKey: "key",
      }),
      // The user's space-sync jobs (see UserDurableObject.startSpaceSync()), each the authority on
      // what the account running it may still do for it: the loopback that account holds acts
      // only while the job here is "running". Every running job is kept, and the most recently
      // ended of those that have ended.
      spaceSyncJobs: collection<SpaceSyncJobInfo>()({
        primaryKey: "jobId",
      }),
      // For each source item a space sync of the user's brought into a space, the workspace it
      // was synced into. Written before that workspace is created, so that no creation leaves a
      // workspace no record leads back to.
      syncedWorkspaces: collection<SyncedWorkspaceRecord>()({
        primaryKey: "key",
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

      // Central push subscriptions, keyed by the install-scoped device key the service returns, so a
      // device that registers again replaces its own subscription. Only this installation's signing
      // key can deliver to them.
      notificationSubscriptions: <Record<string, string>>{},

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

      // The key of this user's personal space, once one has been claimed for them (see
      // #ensurePersonalSpace()). It says which of `spaces` to list first, and which space the
      // user's own workspaces with no `spaceKey` register with. Like that mirror it authorizes
      // nothing, since the space itself records its owner.
      personalSpaceKey: <string | null>null,
    }
  });
}

export type UserStorage = ReturnType<typeof makeUserStorage>;
