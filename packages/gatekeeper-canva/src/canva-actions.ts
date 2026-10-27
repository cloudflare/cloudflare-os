// Every side effect this gatekeeper has, as the kit's action set: what each action stores, how the
// approver sees it, and how it is applied. Nothing here runs before approval; the session stages
// actions, and the facet applies them when the user approves.
//
// Each action is simulated: it returns the design or asset it will make under a temporary id the
// session allocated ("~1", "~2", ...), and apply binds that id to the one Canva assigns, so reads
// made against the temporary id keep working across the approval (see canva-simulation.ts). Two of
// the actions spend the user's AI credits, so none is auto-approvable, and every one takes a
// durable claim before its provider call so a crash mid-dispatch cannot replay a credit-spending
// request. The Connect API cannot delete a design or an asset, so none implements revert.

import {
  ActionApplyError,
  ActionOutcomeUnknownError,
  APPLY_OUTCOME_UNKNOWN_MESSAGE,
  defineActions,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import { isCredentialsChanged, isCredentialsExpired, type CredentialRead } from "@gadgets/gatekeeper-kit/credentials";
import type { ProvisionalIds } from "@gadgets/gatekeeper-kit/simulation";
import {
  CanvaApi,
  CanvaApiError,
  type CanvaGenerationJobResponse,
  type CanvaImageTransformationJobResponse,
} from "./canva-api";
import { VENDOR_ID } from "./canva-credentials";
import { describeDesignType, designTypeToWire, normalizeDesign, normalizeImageAsset } from "./canva-normalize";
import type {
  CanvaDesign,
  CanvaDesignType,
  CanvaGenerationDesignType,
  CanvaGenerationSection,
  CanvaImageAsset,
} from "./types";

/** What every action stores: the temporary id it answers to, and when the agent asked. */
type Staged = {
  /** The temporary id the session returned for what this action makes; apply binds it. */
  ref: string;
  /** When the action was staged: the created and modified time its pending row shows. */
  submittedAt: number;
};

/** What each kind of action stores. Every value was rebuilt from known members when staged. */
export type CanvaActions = {
  createDesign: Staged & {
    designType: CanvaDesignType;
    title?: string;
    /** An image to place on the first page: a Canva asset id, or the temporary id of a pending removal. */
    assetId?: string;
  };
  generateDesign: Staged & {
    brief: string;
    designType: CanvaGenerationDesignType;
    outline?: { sections: CanvaGenerationSection[] };
  };
  removeBackground: Staged & {
    assetId: string;
    /** The source asset's name as read at staging, so the approver sees which image it is. */
    sourceName: string;
    /** The source asset's size as read at staging, from which the result's is predicted. */
    sourceDimensions: { width: number; height: number } | null;
    name?: string;
  };
};

/** A journal entry of this action set. */
export type CanvaAction = TaggedAction<CanvaActions>;

type JobStatus = "in_progress" | "success" | "failed";
type JobError = { code: string; message: string };

/**
 * What applying an action recorded, read back by the `list*` observations, by reads of a temporary
 * id whose job is still running, and by revert. Kept outside the journal because the kit retires
 * applied records and this gatekeeper has nothing to revert; a job's later states (polled by the
 * reads) are written over the same record.
 */
export type CanvaJobRecord =
  | { kind: "createDesign"; actionId: number; at: number; ref: string; design: CanvaDesign }
  | {
    kind: "generateDesign"; actionId: number; at: number; ref: string;
    brief: string; designType: CanvaGenerationDesignType;
    /** Null when Canva refused to start the job. */
    jobId: string | null; status: JobStatus; design?: CanvaDesign; error?: JobError;
  }
  | {
    kind: "removeBackground"; actionId: number; at: number; ref: string;
    sourceAssetId: string;
    /** The source as read at staging and the name asked for, from which the pending row is built. */
    sourceName: string; sourceDimensions: { width: number; height: number } | null; name?: string;
    /** Null when the job finished inside the creation call, or Canva refused to start it. */
    jobId: string | null; status: JobStatus; asset?: CanvaImageAsset; error?: JobError;
  };

/** What apply handlers may do. Deliberately not the Durable Object, whose stub others hold. */
export type CanvaActionHost = {
  /** The temporary ids this gatekeeper allocated and what Canva assigned them. */
  readonly refs: ProvisionalIds<string>;
  /** Runs a provider write as the connection. Never replayed: a second attempt could spend again. */
  write<T>(op: (api: CanvaApi, read: CredentialRead) => Promise<T>): Promise<T>;
  /** Runs a provider read the action needs for itself, such as polling the job it started. */
  read<T>(op: (api: CanvaApi) => Promise<T>): Promise<T>;
  /** Records what an apply did, for the reads and revert to read back. */
  recordJob(record: CanvaJobRecord): void;
  /** What an earlier attempt at this action recorded, so a retry resumes rather than repeats. */
  recordedJob(actionId: number): CanvaJobRecord | undefined;
};

const CREDITS_WARNING = "**This spends your Canva AI credits.** They are not refunded if the result is unwanted.";

// How long apply waits for a background removal. Canva says the job usually takes seconds. The
// action stays pending until the job ends, so the temporary id it provides stays live for the
// actions that depend on it: a wait that runs out asks the user to approve again, and the retry
// resumes the same job rather than starting another.
const TRANSFORMATION_WAIT_MS = 20_000;
const TRANSFORMATION_POLL_MS = 2_000;

const isProvisional = (id: string): boolean => id.startsWith("~");

/** The job state a Canva generation response describes, for the record. */
export function generationStateFromJob(job: CanvaGenerationJobResponse):
    Pick<Extract<CanvaJobRecord, { kind: "generateDesign" }>, "jobId" | "status" | "design" | "error"> {
  return {
    jobId: job.id,
    status: job.status,
    ...(job.status === "success" && job.result ? { design: normalizeDesign(job.result.design) } : {}),
    ...(job.status === "failed" && job.error ? { error: { code: job.error.code, message: job.error.message } } : {}),
  };
}

/** The job state a Canva transformation response describes, for the record. */
export function transformationStateFromJob(job: CanvaImageTransformationJobResponse):
    Pick<Extract<CanvaJobRecord, { kind: "removeBackground" }>, "jobId" | "status" | "asset" | "error"> {
  return {
    jobId: job.id ?? null,
    status: job.status,
    ...(job.status === "success" && job.result ? { asset: normalizeImageAsset(job.result.asset) } : {}),
    ...(job.status === "failed" && job.error ? { error: { code: job.error.code, message: job.error.message } } : {}),
  };
}

/**
 * Whether a failed provider call is one Canva refused outright: the request was understood and
 * turned down, so nothing was created and nothing spent. Everything else is either retryable
 * (rate limit, dead credentials) or of unknown outcome (the request may have reached Canva).
 */
function isRefusal(error: unknown): error is CanvaApiError {
  return error instanceof CanvaApiError && error.status >= 400 && error.status < 500
    && error.status !== 429 && !error.isAuthError;
}

/**
 * Classifies an apply failure for the kit: a refusal is terminal and known absent; a rate limit or
 * dead credentials are retryable, since nothing was spent and a later attempt may succeed; anything
 * else may already have taken effect on Canva, so it is terminal with an unknown outcome.
 */
function applyFailure(error: unknown, what: string): never {
  if (isRefusal(error)) {
    const hint = error.status === 403
      ? " If this Canva account was connected before the gatekeeper requested every scope it now " +
        "uses, disconnect and reconnect it; otherwise the user's plan may not include this feature."
      : "";
    throw new ActionApplyError(`Canva refused to ${what}: ${error.message}.${hint}`);
  }
  if (error instanceof CanvaApiError && error.status === 429) {
    throw new Error(`Canva is rate limiting this account or its AI credits are used up, so it could not ${what} ` +
      `(${error.message}). Nothing was spent; try again later.`);
  }
  // A dead grant, or one the account replaced while the request was being prepared: in both
  // cases the request was never sent, so a retry is right.
  if (isCredentialsExpired(error) || isCredentialsChanged(error)) throw error;
  const detail = error instanceof Error ? error.message : String(error);
  throw new ActionOutcomeUnknownError(`The request to ${what} failed after it may have reached Canva ` +
    `(${detail}). ${APPLY_OUTCOME_UNKNOWN_MESSAGE}`);
}

/**
 * Follows a transformation job for a bounded time, so the usual case binds its asset inside apply.
 * A poll that fails leaves the job as last seen: it was started, and the next attempt resumes it.
 */
async function awaitTransformation(host: CanvaActionHost, job: CanvaImageTransformationJobResponse):
    Promise<CanvaImageTransformationJobResponse> {
  const deadline = Date.now() + TRANSFORMATION_WAIT_MS;
  let current = job;
  while (current.status === "in_progress" && current.id !== undefined && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, TRANSFORMATION_POLL_MS));
    const jobId = current.id;
    try {
      current = await host.read(api => api.getImageTransformation(jobId));
    } catch {
      break;
    }
  }
  return current;
}

export const canvaActions = defineActions<CanvaActionHost, CanvaActions>({
  createDesign: {
    kind: { tag: "create-design", label: "Create a design" },
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: payload => {
      const builder = buildDescription(
        `Create a new, empty ${describeDesignType(payload.designType)} in the connected Canva account.`)
        .inline("Design type", typeof payload.designType === "string"
          ? payload.designType : `${payload.designType.width}×${payload.designType.height}px`);
      if (payload.title !== undefined) builder.inline("Title", payload.title);
      if (payload.assetId !== undefined) {
        builder.inline("Asset placed on the first page", isProvisional(payload.assetId)
          ? `${payload.assetId} (the image a pending background removal produces)`
          : payload.assetId);
      }
      return {
        title: `Create a Canva ${typeof payload.designType === "string" ? payload.designType : "design"}`,
        ...builder.finish(),
        implementsRevert: false,
      };
    },
    provides: payload => [payload.ref],
    dependsOn: payload => payload.assetId !== undefined && isProvisional(payload.assetId) ? [payload.assetId] : [],
    apply: async (payload, host, ctx) => {
      const at = Date.now();
      const assetId = payload.assetId === undefined
        ? undefined
        : host.refs.requireResolved(payload.assetId, { expectedKind: "asset" });
      let created;
      try {
        created = await host.write(api => api.createDesign({
          design_type: designTypeToWire(payload.designType),
          ...(payload.title !== undefined ? { title: payload.title } : {}),
          ...(assetId !== undefined ? { asset_id: assetId } : {}),
        }));
      } catch (error) {
        applyFailure(error, "create the design");
      }
      host.refs.bind(payload.ref, created.id);
      host.recordJob({ kind: "createDesign", actionId: ctx.id, at, ref: payload.ref, design: normalizeDesign(created) });
    },
  },

  generateDesign: {
    kind: { tag: "generate-design", label: "Generate a design with AI" },
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: payload => {
      const builder = buildDescription(
        `Ask Canva's AI to generate a ${payload.designType} from the brief below. The design is saved to ` +
        `your Canva account once generation finishes, which takes from seconds to a few minutes.`)
        .prose(CREDITS_WARNING)
        .inline("Design type", payload.designType)
        .verbatim("Brief", payload.brief);
      if (payload.outline !== undefined) {
        builder.json(`Outline (${payload.outline.sections.length} slides)`, payload.outline);
      }
      return {
        title: `Generate a Canva ${payload.designType} with AI`,
        ...builder.finish(),
        implementsRevert: false,
      };
    },
    provides: payload => [payload.ref],
    apply: async (payload, host, ctx) => {
      const at = Date.now();
      const base = {
        kind: "generateDesign" as const, actionId: ctx.id, at, ref: payload.ref,
        brief: payload.brief, designType: payload.designType,
      };
      let job: CanvaGenerationJobResponse;
      try {
        job = await host.write(api => api.createDesignGeneration({
          brief: payload.brief,
          design_type: { type: "preset", name: payload.designType },
          ...(payload.outline !== undefined ? { outline: payload.outline } : {}),
        }));
      } catch (error) {
        // A refusal is a decided outcome worth listing: an approved request that went nowhere.
        if (isRefusal(error)) {
          host.recordJob({ ...base, jobId: null, status: "failed", error: { code: "refused", message: error.message } });
        }
        applyFailure(error, "start the design generation");
      }
      // Generation takes minutes, so the temporary id stays unbound until a read finds the job done.
      const state = generationStateFromJob(job);
      if (state.design) host.refs.bind(payload.ref, state.design.id);
      host.recordJob({ ...base, ...state });
    },
  },

  removeBackground: {
    kind: { tag: "remove-background", label: "Remove an image's background with AI" },
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: payload => {
      const builder = buildDescription(
        "Remove the background from the Canva image asset below with Canva's AI, saving the result as a " +
        "new asset in your Canva Uploads. The original is not changed.")
        .prose(CREDITS_WARNING)
        .inline("Source asset", payload.sourceName)
        .inline("Source asset ID", isProvisional(payload.assetId)
          ? `${payload.assetId} (the image a pending background removal produces)`
          : payload.assetId);
      if (payload.name !== undefined) builder.inline("New asset name", payload.name);
      return {
        title: "Remove a Canva image's background with AI",
        ...builder.finish(),
        implementsRevert: false,
      };
    },
    provides: payload => [payload.ref],
    dependsOn: payload => isProvisional(payload.assetId) ? [payload.assetId] : [],
    apply: async (payload, host, ctx) => {
      const sourceAssetId = host.refs.requireResolved(payload.assetId, { expectedKind: "asset" });
      // An earlier attempt that ran out of time left the job running: resume it, never start another.
      const earlier = host.recordedJob(ctx.id);
      const resumed = earlier?.kind === "removeBackground" && earlier.jobId !== null ? earlier : undefined;
      const base = resumed ?? {
        kind: "removeBackground" as const, actionId: ctx.id, at: Date.now(), ref: payload.ref, sourceAssetId,
        sourceName: payload.sourceName, sourceDimensions: payload.sourceDimensions,
        ...(payload.name !== undefined ? { name: payload.name } : {}),
      };
      let state: ReturnType<typeof transformationStateFromJob>;
      if (resumed && resumed.status !== "in_progress") {
        // A read settled the job meanwhile (or found it expired): its outcome stands.
        state = {
          jobId: resumed.jobId, status: resumed.status,
          ...(resumed.asset ? { asset: resumed.asset } : {}), ...(resumed.error ? { error: resumed.error } : {}),
        };
      } else {
        let job: CanvaImageTransformationJobResponse;
        if (resumed) {
          job = { id: resumed.jobId!, status: "in_progress" };
        } else {
          try {
            job = await host.write(api => api.createImageTransformation({
              asset_id: sourceAssetId,
              transformations: [{ type: "background_removal" }],
              ...(payload.name !== undefined ? { name: payload.name } : {}),
            }));
          } catch (error) {
            if (isRefusal(error)) {
              host.recordJob({ ...base, jobId: null, status: "failed", error: { code: "refused", message: error.message } });
            }
            applyFailure(error, "start the background removal");
          }
          // Recorded before the wait, so a read during it sees the job running, and a retry finds it.
          host.recordJob({ ...base, ...transformationStateFromJob(job) });
        }
        state = transformationStateFromJob(await awaitTransformation(host, job));
        host.recordJob({ ...base, ...state });
      }
      if (state.status === "failed") {
        const reason = state.error ? `${state.error.message} (${state.error.code})` : "the job failed";
        throw new ActionApplyError(`Canva could not remove the background: ${reason}. The credits it spent are not refunded.`);
      }
      if (!state.asset) {
        throw new Error("Canva is still removing the background. Approve this action again in a moment; " +
          "the same job is resumed, so the request is not sent twice and no further credits are spent.");
      }
      host.refs.bind(payload.ref, state.asset.id);
    },
    reject: async (_payload, host, ctx) => {
      // The job is on Canva whether or not this action stays: rejecting it would strand the actions
      // that wait for the asset while the asset arrives anyway. Approving again finishes it.
      const earlier = host.recordedJob(ctx.id);
      if (earlier?.kind === "removeBackground" && earlier.jobId !== null && earlier.status === "in_progress") {
        throw new Error("Canva has already started this background removal and the credits are spent, so it " +
          "can't be rejected. Approve it again to finish it.");
      }
    },
  },
}, {
  // Fenced on the Canva user the connection is pinned to, not the connection generation: a
  // reconnect as the same user must not strand what is waiting, and the account refuses a
  // reconnect as anyone else (see UserAccount.acceptAuthCode).
  fence: "authority",
  isResolvedReference: (host, ref) => host.refs.isResolved(ref),
  vendorId: VENDOR_ID,
});
