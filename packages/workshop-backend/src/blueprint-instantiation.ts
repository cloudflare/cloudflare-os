// Creating a workspace from a blueprint for a user: the steps AuthenticatedApi
// .newWorkspaceFromBlueprint() takes, as a function of what any caller acting for a user holds.

import type { RpcStub as NativeRpcStub } from "cloudflare:workers";
import type {
  AgentSpawnerConfig, AuthenticatedApi, BlueprintBindingAssignment, CollaboratorRole, Overseer,
  WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { deploymentOutputForBlueprint, readAdminConfig } from "./admin-config.js";
import { recordAnalytics } from "./analytics.js";
import { sanitizeBlueprintOutput } from "./blueprint-archive.js";
import { bundledPublication } from "./bundled-blueprints.js";
import { checkTeamSpaceKey } from "./spaces.js";
import { readBlueprintKvRecord } from "./storage-schema/blueprints-kv.js";
import type { UserDurableObject } from "./user.js";

/** What a workspace created from a blueprint is called, where it goes and how it is published. */
export type BlueprintInstantiationOptions = {
  /**
   * The new workspace's Overseer id, which the caller allocated with `newUniqueId()` to record it
   * before the workspace exists; omitted, a fresh one.
   */
  id?: string;
  /** The workspace's title; omitted, the blueprint's. */
  title?: string;
  /**
   * The team space the workspace belongs to, which must satisfy `checkTeamSpaceKey()`; omitted,
   * the user's personal space.
   */
  spaceKey?: string;
  /**
   * The entry of its space's listing to place it under (see `UserDurableObject.newWorkspace()`).
   */
  parentId?: string;
  /**
   * The role the workspace is published with from the start. Omitted, the blueprint's default
   * (see `bundledPublication()`); null, none.
   */
  publicAccess?: CollaboratorRole | null;
};

/**
 * The options of `AuthenticatedApi.newWorkspaceFromBlueprint()` as this module's
 * `newWorkspaceFromBlueprint()` takes them: a string is a `spaceKey`, and `publish: false` opts out
 * of the blueprint's default publication. Only the members that method declares are read, since
 * capnweb-validate forwards any others unvalidated.
 */
export function fromApiOptions(
    options: Parameters<AuthenticatedApi["newWorkspaceFromBlueprint"]>[2],
): BlueprintInstantiationOptions {
  let { spaceKey, parentId, publish } =
      typeof options === "string" ? { spaceKey: options } : options ?? {};
  return { spaceKey, parentId, ...(publish === false && { publicAccess: null }) };
}

/**
 * Creates a workspace of the user whose User DO is `user` from blueprint `blueprintId`, binding
 * the gatekeepers `bindings` assign into its gadget, and returns the Overseer that `open`, which
 * opens a workspace for that user, gives them on it. The caller disposes what this returns.
 */
export async function newWorkspaceFromBlueprint(
    ctx: ExecutionContext | DurableObjectState,
    env: Cloudflare.Env,
    user: DurableObjectStub<UserDurableObject>,
    open: (id: string) => Promise<NativeRpcStub<Overseer>>,
    blueprintId: string,
    bindings: Record<string, BlueprintBindingAssignment>,
    { id: givenId, title, spaceKey, parentId, publicAccess }: BlueprintInstantiationOptions = {},
): Promise<NativeRpcStub<Overseer>> {
  if (spaceKey !== undefined) checkTeamSpaceKey(spaceKey);
  let overseers = ctx.exports.OverseerDurableObject;

  // 1. Read blueprint from KV.
  let kvRecord = await readBlueprintKvRecord(env, blueprintId);
  if (!kvRecord) throw new Error("Blueprint not found.");
  title ??= kvRecord.metadata.title;

  // 2. Create new Overseer DO (same as newWorkspace()).
  let id = givenId ?? overseers.newUniqueId().toString();
  await user.newWorkspace(id, title, spaceKey, parentId);
  // Released if a later step throws; on return it passes to the caller.
  using owned = new DisposableStack();
  let overseerResult = owned.use(await open(id));

  // 3. Initialize from the blueprint's code. The Overseer reads it for itself, as the version
  //    this metadata describes, so that it is the code the bindings assigned below belong to.
  let overseerDo = overseers.get(overseers.idFromString(id));
  await overseerDo.initializeFromBlueprint(blueprintId, {...kvRecord.metadata, title},
      deploymentOutputForBlueprint(await readAdminConfig(env), blueprintId,
          sanitizeBlueprintOutput(kvRecord.metadata.output)),
      publicAccess === undefined ? bundledPublication(blueprintId, kvRecord)
          : publicAccess ?? undefined);

  // 4. Create gatekeepers from assignments and bind them into the workspace's (only) gadget.
  let metadata = await overseerResult.getMetadata();
  using gadget = await overseerResult.getGadget(metadata.defaultGadgetId!);

  // Defensively put blueprint bindings into a map (not a raw object) until we've had a chance to
  // validate the names.
  let blueprintBindings = new Map(Object.entries(kvRecord.metadata.bindings));
  let gadgetId = metadata.defaultGadgetId!;

  // Create gatekeepers in two phases: first every non-spawner binding (binding the
  // non-spawnerOnly ones into the gadget, and recording each created gatekeeper's id by
  // binding name), then the agent spawners, whose configs reference the phase-one results
  // symbolically (see SpawnerEnvTarget).
  let createdIds = new Map<string, WorkpieceId>();
  let gkPromises: Promise<void>[] = [];

  for (let [bindingName, assignment] of Object.entries(bindings)) {
    let blueprintBinding = blueprintBindings.get(bindingName);
    if (!blueprintBinding) {
      throw new Error(`Unknown binding name: ${bindingName}`);
    }

    gkPromises.push((async () => {
      let gk;
      if (assignment.type === "gatekeeper") {
        gk = await overseerResult.newGatekeeper(assignment.accountId, assignment.resourceUrl);
        if (!gk) {
          throw new Error(`Failed to create gatekeeper for binding "${bindingName}".`);
        }
      } else if (assignment.type === "aiModel") {
        gk = await overseerResult.newAiModelGatekeeper(assignment.modelId);
      } else {
        return;  // agent spawners are created in phase two
      }
      try {
        let id = await gk.getId();
        createdIds.set(bindingName, id);
        // A spawnerOnly binding exists purely to feed some spawner's env; it is not bound
        // into the gadget itself.
        if (!blueprintBinding.spawnerOnly) {
          await gadget.bind(bindingName, id);
        }
      } finally {
        gk[Symbol.dispose]();
      }
    })());
  }

  await Promise.all(gkPromises);

  // Phase two: agent spawners, with the full AgentSpawnerConfig reconstructed -- displayName
  // from the binding's title, modelId from the assignment, and env resolved against the
  // phase-one gatekeepers and the new gadget.
  for (let [bindingName, assignment] of Object.entries(bindings)) {
    if (assignment.type !== "agentSpawner") continue;
    let blueprintBinding = blueprintBindings.get(bindingName);
    if (blueprintBinding?.type !== "agentSpawner") {
      throw new Error(`Binding "${bindingName}" type mismatch.`);
    }

    let spawnerEnv: Record<string, WorkpieceId> = {};
    for (let [envName, target] of Object.entries(blueprintBinding.env)) {
      if (target.type === "gadget") {
        spawnerEnv[envName] = gadgetId;
      } else {
        let id = createdIds.get(target.name);
        if (id === undefined) {
          throw new Error(`Agent spawner binding "${bindingName}" references binding ` +
              `"${target.name}", which was not assigned.`);
        }
        spawnerEnv[envName] = id;
      }
    }

    let config: AgentSpawnerConfig = {
      displayName: blueprintBinding.title,
      modelId: assignment.modelId,
      env: spawnerEnv,
    };
    using gk = await overseerResult.newAgentSpawnerGatekeeper(config);
    await gadget.bind(bindingName, await gk.getId());
  }

  recordAnalytics(ctx, env, {
    event_name: "gadget_created",
    user_id: user.id.toString(),
    gadget_id: id,
    blueprint_id: blueprintId,
    source: "blueprint",
  });

  owned.move();
  return overseerResult;
}
