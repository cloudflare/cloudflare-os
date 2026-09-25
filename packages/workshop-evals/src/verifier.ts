import { setTimeout as delay } from "node:timers/promises";
import type { RpcCompatible, RpcStub } from "capnweb";
import type { WorkshopAgentSession } from "@gadgets/integration-tests/agent-session";
import type {
  AiChatMessage, GadgetClient, WorkpieceId, WorkpieceSummary,
} from "@gadgets/workshop-shared/api";
import type { EvalCheck, EvalCheckOutcome } from "./task.js";

const EVIDENCE_LIMIT = 2_000;
const VERIFIER_THREW = "verifier.threw";

export type VerifierSession = Pick<WorkshopAgentSession, "openGadget" | "connectionDrops">;

function truncate(value: string): string {
  return value.length > EVIDENCE_LIMIT ? `${value.slice(0, EVIDENCE_LIMIT)}...` : value;
}

function connectTyped<Session extends RpcCompatible<Session>>(
    client: RpcStub<GadgetClient>, chatId: number): Promise<RpcStub<Session>>;
function connectTyped(client: RpcStub<GadgetClient>, chatId: number) {
  return client.connectToGadget(chatId);
}

/** Find the single Gadget with the exact title required by a task. */
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

/** The agent's chat messages after `sinceSequence`, in order. */
export function agentReplies(
    history: readonly AiChatMessage[], sinceSequence: number): string[] {
  return history.flatMap(message =>
    message.sequence > sinceSequence && message.type === "message" &&
    message.author.type === "agent" ? [message.message] : []);
}

/** Runs independent functional checks against the agent's provisional Gadget branch. */
export class EvalVerifier {
  readonly workpieces: readonly WorkpieceSummary[];
  /** What the agent said in chat during this turn, oldest first. Empty when it only acted. */
  readonly replies: readonly string[];
  readonly #session: VerifierSession;
  readonly #checks: EvalCheck[] = [];
  readonly #pending: Promise<void>[] = [];

  constructor(
      session: VerifierSession, workpieces: readonly WorkpieceSummary[],
      replies: readonly string[] = []) {
    this.#session = session;
    this.workpieces = workpieces;
    this.replies = replies;
  }

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

  async connect<Session extends RpcCompatible<Session>>(
      gadgetTitle: string): Promise<RpcStub<Session>> {
    const opened = await this.#session.openGadget(
        resolveGadget(this.workpieces, gadgetTitle));
    try {
      return connectTyped<Session>(opened.client, opened.chatId);
    } finally {
      opened.client[Symbol.dispose]();
    }
  }

  /**
   * Runs `verify` and returns its checks. Throws instead when a check failed while the Workshop
   * connection dropped, since that failure says nothing about the agent's work.
   */
  async collect(verify: (verifier: EvalVerifier) => Promise<void>): Promise<EvalCheck[]> {
    const drops = this.#session.connectionDrops;
    try {
      await verify(this);
    } catch (error) {
      this.#checks.push({ id: VERIFIER_THREW, pass: false, evidence: truncate(String(error)) });
    }
    await Promise.all(this.#pending);
    if (this.#checks.some(check => !check.pass)) {
      // A check can see its RPC fail before the session counts the drop behind it.
      await delay(0);
      if (this.#session.connectionDrops !== drops) {
        throw new Error("The Workshop connection dropped during verification");
      }
    }
    return this.#checks;
  }

  results(): EvalCheck[] {
    return this.#checks.map(check => ({ ...check }));
  }

  async #run(index: number, id: string, body: () => Promise<EvalCheckOutcome>): Promise<void> {
    try {
      this.#checks[index] = { id, ...await body() };
    } catch (error) {
      this.#checks[index] = { id, pass: false, evidence: truncate(String(error)) };
    }
  }
}
