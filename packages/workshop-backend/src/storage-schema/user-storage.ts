// The User Durable Object's storage schema: `makeUserStorage()` and the record types it stores.
//
// Everything a user's Durable Object persists is declared in this one file, so that a change to
// the stored shape of a user shows up as a change here. See overseer-storage.ts for the
// conventions.

import { createTypedStorage, collection } from "@gadgets/typed-storage";
import type {
  AiChatAuthorInfo, AiModelConfig, BlueprintMetadata, BlueprintOutput,
  WorkspaceMetadata, WorkpieceId, UserNotification, ChatTimelineHead, FavoriteItem, FavoriteItemRef,
} from "@gadgets/workshop-shared/api";
import { chatKey } from "./overseer-storage.js";
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

export type GadgetRecord = WorkspaceMetadata & {
  created: Date;
  lastActive?: Date;  // if missing, gadget is provisional
  // Set on a shared workspace the user was added to but hasn't opened yet; see
  // `WorkspaceMetadataWithTimestamps.invited`.
  invited?: true;
  // If we're not the gadget owner (it was shared with us), `owner` is set (inherited from
  // WorkspaceMetadata).
};

/**
 * The user's private read state for one chat, plus a record of which notifications for it have
 * already been delivered. The unread queries and subscriptions on `AuthenticatedApi` are answered
 * entirely from these rows. See docs/user-unread-state.md.
 *
 * Positions come in two kinds:
 * - A "sequence" is a timeline sequence number (`AiChatMessage.sequence`). It counts every record
 *   in the chat, including tool calls and other internal activity, and is what clients use.
 * - A "visible sequence" counts only visible messages (see the Overseer's `visibleThroughSequence`).
 *   Subtracting two visible sequences gives a number of unread messages.
 */
export type ChatReadCursor = {
  workspaceId: string;
  chatId: number;
  /** Sequence of the last record the user has read, inclusive; -1 if they haven't read anything. */
  readThroughSequence: number;
  /**
   * The same read position, as a visible sequence. Absent until the row is first set up from the
   * workspace (by a new message, the user first being given access, or a read/unread command).
   */
  readThroughVisibleSequence?: number;
  /**
   * Visible sequence of the latest message received from the workspace. It never goes down, so a
   * repeated or out-of-date update from the workspace can't inflate the count.
   */
  latestVisibleSequence?: number;
  /** Number of unread messages: `latestVisibleSequence - readThroughVisibleSequence`. */
  unreadCount: number;
  /**
   * Sequence of the latest completed notification (delivered, deliberately skipped, or expired).
   * Older notifications with failed devices remain in the outbox independently of this receipt.
   * If the workspace resends completed work after losing our acknowledgement, the receipt keeps
   * it from being queued twice.
   */
  notifiedThroughSequence: number;
  /**
   * IDs of the completed notifications at exactly `notifiedThroughSequence`, since several
   * can share one position. Absent means all notifications at that position count as handled; this
   * is the case when the position is a starting point set when tracking began, not a delivery.
   */
  notifiedEventIds?: string[];
  /**
   * The chat's title and latest-message preview, copied from the workspace so the inbox can show it
   * without asking the workspace. Always present, except on rows for deleted chats.
   */
  head?: ChatTimelineHead;
  /**
   * The chat's `lastActive` time in the workspace when `head` was produced. Decides which of two
   * heads with the same latest message (e.g. from before and after a rename) is newer.
   */
  headUpdatedAt?: Date;
  /**
   * Set when the chat has been deleted. The row is kept so a delayed update from before the
   * deletion can't bring the chat back. Chat IDs are never reused.
   */
  deleted?: true;
  /** Set while the user has the chat archived; see `AuthenticatedApi.setChatArchived()`. */
  archived?: true;
  /**
   * Set on a row created for a chat the user hasn't taken part in; cleared once they open it,
   * write in it or unarchive it (see `UnreadThread.unjoined`). Absent on rows from before this
   * was recorded, which count as joined.
   */
  unjoined?: true;
};

/**
 * A notification that the User DO has accepted from a workspace and still has to deliver, to an
 * open client if there is one or else by push. It is removed once it has been delivered,
 * deliberately skipped (e.g. because the workspace is muted), or has expired.
 */
export type QueuedChatNotification = UserNotification & {
  /** Sequence of the timeline record where the notification's event happened. */
  sequence: number;
  /**
   * When to give up delivering. Set when the notification is first accepted, and never extended by
   * retries, repeated sends from the workspace, or DO restarts.
   */
  expiresAt: Date;
  /** Only these subscriptions failed the previous attempt; absent until first delivery. */
  failedSubscriptions?: string[];
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

/** The storage key of a starred item: its kind and its identity within its workspace. */
export function favoriteKey(item: FavoriteItemRef): string {
  switch (item.kind) {
    case "app": return `${item.workspaceId}:app:${item.workpieceId}`;
    case "chat": return `${item.workspaceId}:chat:${item.chatId}`;
    case "file": return `${item.workspaceId}:file:${item.chatId}:${item.fileId}`;
  }
}

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
      // Notifications waiting to be delivered (see QueuedChatNotification). The key lists each
      // chat's queue in timeline order, and keeps separate notifications at the same position apart.
      notificationOutbox: collection<QueuedChatNotification>()({
        primaryKey: event => `${event.workspaceId}:${chatKey(event.chatId, event.sequence)}:${event.id}`,
      }),
      // The user's read state for each chat (see ChatReadCursor), indexed by workspace so a
      // workspace's rows can be removed together.
      chatReadCursors: collection<ChatReadCursor>()({
        primaryKey: record => `${record.workspaceId}:${record.chatId}`,
        nonUniqueIndexes: {
          byWorkspace(record: ChatReadCursor) { return record.workspaceId; },
        },
      }),
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
      // The apps and files the user has starred (AuthenticatedApi.setFavorite()), each with the
      // title and kind it had when starred so the Library can list them without opening workspaces.
      favorites: collection<FavoriteItem>()({
        primaryKey: favoriteKey,
        nonUniqueIndexes: {
          byWorkspace(record: FavoriteItem) { return record.workspaceId; },
        },
      }),
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

      // Central push subscriptions, keyed by the install-scoped device key the service returns, so a
      // device that registers again replaces its own subscription. Phones and browsers are kept
      // apart because the service caps each separately. Only this installation's signing key can
      // deliver to them.
      phoneNotificationSubscriptions: <Record<string, string>>{},
      browserNotificationSubscriptions: <Record<string, string>>{},
      // Latest-value push outbox. its version belongs only to the push replacement protocol.
      notificationBadge: <{version: number; count: number | null; retryAt?: number; expiresAt?: number}>
          {version: 0, count: null},

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
