// The Workshop's side of the admin gatekeeper, faked: the queue a session is given, the Admin API
// it lends, the views that API opens, and the Admin API lent for one action.

import { RpcTarget, env } from "cloudflare:workers";
import type { ApiShape } from "@gadgets/api-schema/schema";
import type {
  ActionDescription, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ADMIN_SCHEMA, SERVICES } from "../../src/surface.js";

export const ROOT = "AdminApi";
export const VIEW = "AdminWorkspaceView";

/** A session's stub, as an agent's code sees it: methods its type can't name. */
export type Session = Disposable & Record<string, (...args: unknown[]) => Promise<any>>;

/** What the fakes saw, in order: "getAdminApi", "observe <title>", "submit <tag>" and
 * "<service>.<method>". */
export type Log = string[];

/** What a fake method answers with: a value, or an error to throw after the call is recorded. */
export type Answer = (name: string, args: unknown[]) => unknown;

/**
 * What `call` rejects with. Settled through then() alone: `expect(...).rejects` reads other
 * properties of the RPC promise, each a pipelined promise of its own that rejects unhandled.
 */
export function rejection(call: Promise<unknown>): Promise<Error> {
  return call.then(() => new Error("did not reject"), (error: Error) => error);
}

/** A value that fits `shape`, for a required argument. */
function sample(shape: ApiShape): unknown {
  switch (shape.kind) {
    case "string": return "x";
    case "number": return 1;
    case "boolean": return true;
    case "literal": return shape.value;
    case "ref": return sample(ADMIN_SCHEMA.shapes[shape.name]!);
    case "union": return sample(shape.branches.find((branch) => branch.kind !== "undefined")!);
    case "array": return [];
    case "object":
      return Object.fromEntries(Object.entries(shape.properties)
          .filter(([, property]) => !(property.kind === "union" &&
              property.branches.some((branch) => branch.kind === "undefined")))
          .map(([key, property]) => [key, sample(property)]));
    default: throw new Error(`no sample for a ${shape.kind}`);
  }
}

/** Arguments that fit `service.name`: one for each required parameter. */
export function sampleArguments(service: string, name: string): unknown[] {
  const method = ADMIN_SCHEMA.services[service]!.methods.find((candidate) => candidate.name === name)!;
  return method.params.filter((param) => !param.optional).map((param) => sample(param.type));
}

/** A target with one method per name, each recording its call and answering with `answer`. */
export function recordingTarget(service: string, names: readonly string[], log: Log, answer: Answer) {
  class Recording extends RpcTarget {
    readonly calls: { name: string; args: unknown[] }[] = [];
    disposed = 0;

    [Symbol.dispose](): void {
      this.disposed++;
    }
  }
  for (const name of names) {
    Object.defineProperty(Recording.prototype, name, {
      value: async function (this: Recording, ...args: unknown[]) {
        log.push(`${service}.${name}`);
        this.calls.push({ name, args });
        return answer(name, args);
      },
    });
  }
  return new Recording();
}

export type Recording = ReturnType<typeof recordingTarget>;

/** The report the fakes answer getIssueReport() with, as admins read it. */
export const REPORT_ID = "report-1";

/**
 * An issue report as the Admin API returns it: with links, an update time, an admins-only entry,
 * an agent's origin, and one field the gatekeeper has never heard of on the report and on an
 * entry. The reporter is an admin who also answered their own report as one.
 */
export function issueReport(overrides: Record<string, unknown> = {}) {
  return {
    id: REPORT_ID,
    filedAt: new Date("2026-03-04T05:06:07.000Z"),
    reporter: { id: "ada", name: "Ada" },
    text: "The sheet is empty.",
    priority: "high",
    context: { workspaceId: "workspace-1", chatId: 4 },
    status: "investigating",
    images: [{ id: "image-1", type: "image/png", byteLength: 4, secretNote: "x" }],
    grant: { id: "grant-1", scope: "workspace", expiresAt: new Date("2026-03-05T00:00:00.000Z") },
    links: ["https://tickets.example/1"],
    updatedAt: new Date("2026-03-04T06:00:00.000Z"),
    secretNote: "only admins",
    entries: [
      { id: "e1", at: new Date("2026-03-04T05:10:00.000Z"), author: { id: "ada", name: "Ada" },
        visibility: "public", text: "It still happens." },
      { id: "e2", at: new Date("2026-03-04T05:20:00.000Z"), author: { id: "grace", name: "Grace" },
        visibility: "admins", via: "api", text: "Cache key looks stale." },
      { id: "e3", at: new Date("2026-03-04T05:30:00.000Z"), author: { id: "grace", name: "Grace" },
        visibility: "public", via: "gatekeeper", agent: { workspaceId: "triage", chatId: 2 },
        text: "We are looking.", internal: true },
      { id: "e4", at: new Date("2026-03-04T05:40:00.000Z"), author: { id: "ada", name: "Ada" },
        visibility: "public", via: "cli", text: "", status: "investigating" },
    ],
    ...overrides,
  };
}

/** An Admin API with every method the gatekeeper serves, answering with `answer`. */
export const adminApi = (log: Log, answer: Answer = (name) => ({ answered: name })) =>
  recordingTarget(ROOT, SERVICES.get(ROOT)!, log, answer);

/**
 * The Workshop's side of one session: its queue, which records each observation and each
 * submitted action and lends `admin`, the Admin API built with `answer`.
 */
export function workshop(answer?: Answer) {
  const log: Log = [];
  const admin = adminApi(log, answer);

  class Queue extends RpcTarget {
    readonly observations: ObservationDescription[] = [];
    readonly submitted: { action: number; description: ActionDescription }[] = [];
    refuseObservations = false;
    disposed = 0;

    async getAdminApi() {
      log.push("getAdminApi");
      return admin;
    }

    async authorizeObservation(description: ObservationDescription): Promise<void> {
      log.push(`observe ${description.title}`);
      this.observations.push(description);
      if (this.refuseObservations) throw new Error("The approval queue refused this observation.");
    }

    async submitAction(action: number, description: ActionDescription): Promise<void> {
      log.push(`submit ${description.actionKind?.tag}`);
      this.submitted.push({ action, description });
    }

    [Symbol.dispose](): void {
      this.disposed++;
    }
  }
  return { log, admin, queue: new Queue() };
}

/** A facet of its own. */
export const facet = () => env.ADMIN_GATEKEEPER.getByName(crypto.randomUUID());

/** A facet with a session of the whole binding over `queue`. */
export async function openBinding(queue: RpcTarget) {
  const gatekeeper = facet();
  const session = await gatekeeper.startSession(queue as never) as unknown as Session;
  return { gatekeeper, session };
}
