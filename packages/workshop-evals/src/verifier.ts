import type { RpcCompatible, RpcStub } from "capnweb";
import type { AgentSession } from "@gadgets/integration-tests/agent-session";
import type { WorkpieceId, WorkpieceSummary } from "@gadgets/workshop-shared/api";
import { toJsonValue } from "vitest-evals";
import type { EvalCheck, EvalCheckOutcome } from "./task.js";

const EVIDENCE_LIMIT = 2_000;

/** Recorded when a check's `id` was never reached because the verifier body itself threw. */
const VERIFIER_THREW = "verifier.threw";

// `toJsonValue` answers undefined for anything it cannot represent, which would otherwise be
// indistinguishable from an author who supplied no evidence at all.
const UNSERIALIZABLE_EVIDENCE = "<evidence was not JSON-serializable>";

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > EVIDENCE_LIMIT ? `${message.slice(0, EVIDENCE_LIMIT)}...` : message;
}

/** The session capabilities a verifier needs, which is far less than a whole agent session. */
export type VerifierSession = Pick<AgentSession, "connectToGadget" | "restartGadgets">;

// Declared signature plus an untyped implementation, matching `connectTyped` in agent-session.ts:
// capnweb's recursive `RpcStub` generic does not survive being forwarded through another generic.
function connectTyped<Session extends RpcCompatible<Session>>(
    session: VerifierSession, id: WorkpieceId): Promise<RpcStub<Session>>;
function connectTyped(session: VerifierSession, id: WorkpieceId) {
  return session.connectToGadget(id);
}

/**
 * Resolves the one Gadget carrying this exact title.
 *
 * Tasks name the Gadget in their prompt, so an unresolvable title usually means the agent named it
 * something else. The error lists what was actually built, which is the first thing an author asks.
 */
export function resolveGadget(
    workpieces: readonly WorkpieceSummary[], title: string): WorkpieceId {
  const matches = workpieces.filter(
      workpiece => workpiece.type === "gadget" && workpiece.title === title);
  const match = matches.at(0);
  if (matches.length !== 1 || match === undefined) {
    const built = workpieces.map(workpiece => JSON.stringify(workpiece.title)).join(", ");
    throw new Error(`Expected exactly one Gadget titled ${JSON.stringify(title)}, ` +
      `found ${matches.length} among [${built}]`);
  }
  return match.id;
}

/**
 * What a task uses to observe what the agent built, and where its observations are collected.
 *
 * Every read targets the chat's *provisional* branch, so a task sees the agent's proposed changes
 * exactly as a user would before accepting them. Checks are held in registration order and each is
 * isolated, so a report reads top-to-bottom and one failing expectation neither hides nor reorders
 * the others.
 */
export class EvalVerifier {
  /** Chat whose provisional branch is under verification. */
  readonly chatId: number;
  /** Workpieces visible after the turn settled. */
  readonly workpieces: readonly WorkpieceSummary[];
  readonly #session: VerifierSession;
  readonly #checks: EvalCheck[] = [];
  readonly #pending: Promise<void>[] = [];

  constructor(session: VerifierSession, chatId: number, workpieces: readonly WorkpieceSummary[]) {
    this.#session = session;
    this.chatId = chatId;
    this.workpieces = workpieces;
  }

  /**
   * Records one named observation.
   *
   * A throw inside `body` — a failed RPC, a schema mismatch, a Gadget that was never created — is
   * recorded as a failed check rather than aborting the run, so one broken expectation does not
   * discard everything else the trial would have told you.
   */
  async check(id: string, body: () => Promise<EvalCheckOutcome>): Promise<void> {
    if (this.#checks.some(check => check.id === id)) {
      throw new Error(`Duplicate eval check ID ${JSON.stringify(id)} within one turn`);
    }
    const index = this.#checks.length;
    this.#checks.push({ id, pass: false, evidence: "check did not complete" });
    const settled = this.#run(index, id, body);
    this.#pending.push(settled);
    await settled;
  }

  async #run(index: number, id: string, body: () => Promise<EvalCheckOutcome>): Promise<void> {
    try {
      const outcome = await body();
      if (typeof outcome === "boolean") {
        this.#checks[index] = { id, pass: outcome };
        return;
      }
      const evidence = outcome.evidence === undefined
        ? undefined
        : toJsonValue(outcome.evidence) ?? UNSERIALIZABLE_EVIDENCE;
      this.#checks[index] = {
        id,
        pass: outcome.pass,
        ...(evidence === undefined ? {} : { evidence }),
      };
    } catch (error) {
      this.#checks[index] = { id, pass: false, evidence: describeError(error) };
    }
  }

  /**
   * Connects a typed stub to the provisional server of the Gadget with this exact title. The caller
   * owns the stub, so bind it with `using`. Throws when no Gadget matches, or when several do.
   */
  connect<Session extends RpcCompatible<Session>>(gadgetTitle: string): Promise<RpcStub<Session>> {
    return connectTyped<Session>(this.#session, resolveGadget(this.workpieces, gadgetTitle));
  }

  /**
   * Abruptly restarts every Gadget server in the workspace, exactly as the platform does when code
   * changes: storage is kept, memory is discarded.
   *
   * Any stub obtained before this call is invalidated and will throw, so take a fresh one with
   * `connect` afterwards. Use it to check that state a Gadget reported really was persisted rather
   * than held in a field — including derived indexes, which is where an in-memory `Set` of seen ids
   * silently stops rejecting duplicates.
   *
   * Only call this from a task's final turn: it advances the workspace code version, which an agent
   * replaying its history in a later turn would reject.
   */
  async restart(): Promise<void> {
    await this.#session.restartGadgets();
  }

  /**
   * Runs the task's verifier and returns its observations in registration order.
   *
   * A throw that escapes the verifier body — a duplicate check ID, an unguarded helper, a task bug —
   * becomes one more failed check. Letting it propagate instead would discard every observation the
   * trial had already paid for.
   */
  async collect(verify: (verifier: EvalVerifier) => Promise<void>): Promise<EvalCheck[]> {
    try {
      await verify(this);
    } catch (error) {
      this.#checks.push({ id: VERIFIER_THREW, pass: false, evidence: describeError(error) });
    }
    await Promise.all(this.#pending);
    return this.#checks;
  }
}
