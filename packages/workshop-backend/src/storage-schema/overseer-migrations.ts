// The Overseer Durable Object's storage migrations: one function per step of the `version`
// singleton (see makeOverseerStorage), each bringing a workspace up from the schema version
// before it.
//
// The Overseer's constructor runs them, in version order, before anything else can touch storage
// (see OverseerImpl's constructor for how they are sequenced around its own initialization). The
// synchronous ones check the stored version themselves and return immediately at any other, so
// they are called unconditionally; the git-storage migration is asynchronous, so the constructor
// checks the version itself in order to run it under blockConcurrencyWhile.
//
// A change to what a workspace has stored needs a new version, a migration here, and a matching
// bump of OVERSEER_STORAGE_VERSION.

import type {
  AgentSpawnerConfig, CommitIdentity, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import type {
  AgentSpawnerBindingProps, BindingRecord, GadgetRecord, LegacyAgentSpawnerConfig,
  OverseerStorage,
} from "./overseer-storage";
import { migrateCodeLogToGit } from "./overseer-git-migration";
import { retryOnDoReset } from "../do-retry";
import { GitStore, commitIdentityForAuthor } from "../git-store";
import type { createWorkshopLogger } from "../observability";
import type { UserDurableObject } from "../user";

/**
 * The current storage schema version: the one the last migration below stamps, and the one a
 * new workspace is born at (so it has nothing to migrate). The migrations themselves name
 * their versions literally, since each one's source and target are fixed for good.
 */
export const OVERSEER_STORAGE_VERSION = 4;

/**
 * What the migrations need from the Overseer. OverseerImpl satisfies this structurally and
 * passes itself; the interface exists so this module names exactly what it depends on, without
 * importing OverseerImpl.
 */
export interface OverseerMigrationHost {
  /** The Durable Object's state: storage transactions, its own id, and its loopback exports. */
  ctx: DurableObjectState;

  /** The workspace's storage. */
  storage: OverseerStorage;

  /** The workspace's git object store, which receives the commits the git migration writes. */
  gitStore: GitStore;

  /** The Overseer's logger, so migration logs carry the workspace's id like all its others. */
  logger: ReturnType<typeof createWorkshopLogger>;

  /** The workspace owner's user DO id. Absent if the workspace was never initialized. */
  ownerId?: string;

  /** The workspace's default gadget, as cached by the Overseer. */
  defaultGadgetId?: WorkpieceId;

  /** A fresh stub to the owner's user DO. Throws if the workspace was never initialized. */
  ownerUserDo(): DurableObjectStub<UserDurableObject>;

  /** Allocates a workpiece id from the shared counter. */
  allocateWorkpieceId(): WorkpieceId;

  /**
   * Creates the workspace's default gadget, unless it already has one, and returns its id. The
   * Overseer owns this because it also updates the cached `defaultGadgetId`.
   */
  ensureDefaultGadget(commitId: string | undefined): WorkpieceId;

  /**
   * A unique, monotonic chat-message timestamp. The Overseer owns this because uniqueness spans
   * every message it writes, before and after the migrations.
   */
  getChatTimestamp(): Date;
}

/**
 * Version 0 -> 1: the workspace predates multi-gadget support. Fully synchronous, so nothing
 * can observe pre-migration state.
 */
export function migrateToMultiGadget(host: OverseerMigrationHost): void {
  if (host.storage.version.get() !== 0) return;
  if (host.ownerId === undefined) {
    // Brand-new (or never-initialized) DO: there is nothing to migrate. We deliberately avoid
    // writing anything here, so that probing a nonexistent DO leaves no storage behind; the
    // version singleton is set when the workspace is first initialized (see
    // OverseerDurableObject.open() / receiveExternalMessage()).
    return;
  }

  // Run the whole migration in one transaction so that a mid-migration error can't leave the
  // workspace half-migrated.
  let startedAt = Date.now();
  host.ctx.storage.transactionSync(() => {
    // If the workspace has any gadget content (code beyond the initial empty snapshot, or named
    // bindings), register that content as the workspace's single gadget and record it as the
    // default gadget; binding names and blueprint annotations move from the gatekeeper records
    // onto the gadget's binding edges. (The stale originals are left on the gatekeeper records;
    // see GatekeeperRecord.) A workspace with no gadget content migrates to zero gadgets.
    let hasCode = [...host.storage.code.list({limit: 1, start: 2})].length > 0;
    let allGatekeepers = [...host.storage.gatekeepers.list()];
    let namedGatekeepers = allGatekeepers.filter(gk => gk.bindingName !== undefined);

    // The legacy flat env's named entries: each named gatekeeper, plus `GADGET -> the legacy
    // gadget` when one is created below. Used to resolve spawner allowlists further down.
    // (The workspace default binding list itself needs no migration step: it is derived on
    // demand from the gadget record created below, whose bindingName and binding edges yield
    // exactly this map -- so chats in old workspaces keep seeing `env.GADGET` and the same
    // named bindings they always did.)
    let legacyEnv: Record<string, WorkpieceId> = {};
    for (let gk of namedGatekeepers) {
      legacyEnv[gk.bindingName!] = gk.id;
    }

    if (hasCode || namedGatekeepers.length > 0) {
      let id = host.allocateWorkpieceId();
      // Set defaultGadgetId before putting the record, so that workpiece subscribers never see
      // the gadget without its legacy names (see the `defaultGadgetId` singleton).
      host.storage.defaultGadgetId.put(id);
      let bindings: Record<string, BindingRecord> = {};
      for (let gk of namedGatekeepers) {
        bindings[gk.bindingName!] = {
          target: gk.id,
          ...(gk.blueprintAnnotation ? {blueprintAnnotation: gk.blueprintAnnotation} : {}),
        };
      }
      host.storage.gadgets.put({
        type: "gadget",
        id,
        title: host.storage.title.get(),
        created: new Date(),
        bindingName: "GADGET",
        bindings,
      });
      legacyEnv["GADGET"] = id;
    }

    // Rewrite each agent-spawner gatekeeper's config from the old `env?: string[]` binding-name
    // allowlist to the new `env: Record<name, WorkpieceId>` form (see AgentSpawnerConfig). The
    // config lives in two places and both must be updated: the record's `creationSpec`, and the
    // props baked into the record's `class` stub. Props can't be edited in place, so the stub
    // is recreated the same way newAgentSpawnerGatekeeper() creates it -- except that
    // `creatorUserId` isn't recoverable from the record, so it is omitted, relying on the
    // documented legacy fallback to the workspace owner.
    for (let gk of allGatekeepers) {
      if (gk.creationSpec?.type !== "agentSpawner") continue;
      // The stored (pre-migration) shape differs from the real type only in `env`; the
      // conflicting `env` types force the cast through `unknown`.
      let {env: legacyAllowlist, ...restConfig} =
          gk.creationSpec.config as unknown as LegacyAgentSpawnerConfig;
      let env: Record<string, WorkpieceId>;
      if (legacyAllowlist !== undefined) {
        // Resolve each allowlisted name against the gatekeepers' binding names, dropping any
        // that no longer resolve.
        env = {};
        for (let name of legacyAllowlist) {
          if (Object.hasOwn(legacyEnv, name)) env[name] = legacyEnv[name];
        }
      } else {
        // An absent allowlist historically meant "unrestricted": the spawned agent saw every
        // named binding plus GADGET -- exactly the legacy env map built above.
        env = {...legacyEnv};
      }
      let config: AgentSpawnerConfig = {...restConfig, env};
      gk.creationSpec = {...gk.creationSpec, config};
      let props: AgentSpawnerBindingProps = {overseerId: host.ctx.id.toString(), config};
      gk.class = host.ctx.exports.AgentSpawnerGatekeeper({props});
      host.storage.gatekeepers.put(gk);
    }

    host.storage.version.put(1);
  });

  host.logger.info("migrated workspace storage", {
    event: "storage.migration.completed", durationMs: Date.now() - startedAt,
  });
}

/**
 * Version 1 -> 2: runs the git-storage migration (see overseer-git-migration.ts) and stamps
 * schema version 2. The version stamp is written last: storage writes persist in order, so a
 * crash mid-migration leaves the version at 1 and the next construction redoes the whole
 * (re-runnable) migration.
 *
 * Unlike the others this awaits and does not check the stored version: the caller does, since
 * it must run this under blockConcurrencyWhile.
 */
export async function migrateToGitStorage(host: OverseerMigrationHost): Promise<void> {
  let startedAt = Date.now();
  let { commits } = await migrateCodeLogToGit({
    storage: host.storage,
    gitStore: host.gitStore,
    ownerIdentity: await ownerCommitIdentity(host),
    defaultGadgetId: host.defaultGadgetId,
    createDefaultGadget: () => host.ensureDefaultGadget(undefined),
    getChatTimestamp: () => host.getChatTimestamp(),
  });
  host.storage.version.put(2);
  host.logger.info("migrated workspace code to git storage", {
    event: "storage.migration.git.completed",
    durationMs: Date.now() - startedAt, commitCount: commits,
  });
}

// The workspace owner's commit identity, for commits synthesized by the git-storage migration.
// A transient user-DO reset is retried once (pure read on a fresh-stub helper); anything past
// that degrades to a placeholder rather than failing: identity on synthesized history is
// cosmetic, and blocking the migration on the owner's User DO would leave the workspace
// unusable for as long as that DO is unreachable (or its account gone).
async function ownerCommitIdentity(host: OverseerMigrationHost): Promise<CommitIdentity> {
  try {
    if (host.ownerId !== undefined) {
      let profile = await retryOnDoReset(
          () => host.ownerUserDo().whoamiIfExists(), host.logger);
      if (profile) return commitIdentityForAuthor(profile);
    }
  } catch (err) {
    host.logger.warn("failed to resolve owner identity for history import", {
      event: "storage.migration.git.owner-identity.failed", error: err,
    });
  }
  return { name: "Workspace owner", email: "owner@localhost" };
}

/**
 * Version 2 -> 3: backfill the actions indexes. Indexes are only maintained at write time, so
 * over records that predate their declaration they start empty -- and updating a pre-existing
 * action would then throw on the index update. Synchronous (and chained after the git-storage
 * migration when that one is still pending), so nothing can observe pre-migration state;
 * transactionSync makes rebuilds-plus-stamp atomic, so a crash mid-rebuild retries whole. The
 * `!== 2` guard keeps never-initialized DOs write-free (they stamp the current version at first
 * initialization).
 */
export function migrateToActionIndexes(host: OverseerMigrationHost): void {
  if (host.storage.version.get() !== 2) return;
  host.ctx.storage.transactionSync(() => {
    host.storage.actions.pendingByGatekeeper.rebuild();
    host.storage.actions.byHistoryFilter.rebuild();
    host.storage.actions.byLastChanged.rebuild();
    host.storage.version.put(3);
  });
  host.logger.info("backfilled the action-log indexes", {
    event: "storage.migration.action-indexes.completed",
  });
}

/**
 * Version 3 -> 4: stamp every pre-existing `gadgets` row with the WorkpieceRecord `type`
 * discriminant (all such rows are gadgets; worktrees postdate this version). Required rather
 * than an absent-means-gadget default, so consumers dispatch on `type` without carrying
 * undefined-handling forever. Synchronous, and chained after migrateToActionIndexes on both of
 * the constructor's paths so a v1 workspace runs 1→2, 2→3, 3→4 in one wake; transactionSync
 * makes rewrite-plus-stamp atomic, so a crash mid-rewrite retries whole; and the `!== 3` guard
 * keeps never-initialized DOs write-free. No byBindingName rebuild is needed: every
 * pre-existing row carries a bindingName, so the keys the index already holds are exactly what
 * its `?? null` function computes for them.
 */
export function migrateToWorkpieceTypes(host: OverseerMigrationHost): void {
  if (host.storage.version.get() !== 3) return;
  host.ctx.storage.transactionSync(() => {
    for (let record of Array.from(host.storage.gadgets.list())) {
      // Pre-v4 rows lack the discriminant at runtime (whatever the type says), and all of
      // them are gadgets.
      host.storage.gadgets.put({...(record as GadgetRecord), type: "gadget"});
    }
    host.storage.version.put(4);
  });
  host.logger.info("stamped workpiece record types", {
    event: "storage.migration.workpiece-types.completed",
  });
}
