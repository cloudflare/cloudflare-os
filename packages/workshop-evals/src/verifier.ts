import type { RpcCompatible, RpcStub } from "capnweb";
import type { WorkshopAgentSession } from "@gadgets/integration-tests/agent-session";
import type { GadgetClient, WorkpieceId, WorkpieceSummary } from "@gadgets/workshop-shared/api";
import type { EvalCheck, EvalCheckOutcome } from "./task.js";

const EVIDENCE_LIMIT = 2_000;
const VERIFIER_THREW = "verifier.threw";

export type VerifierSession = Pick<WorkshopAgentSession, "openGadget">;

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

/** Runs independent functional checks against the agent's provisional Gadget branch. */
export class EvalVerifier {
  readonly workpieces: readonly WorkpieceSummary[];
  readonly #session: VerifierSession;
  readonly #checks: EvalCheck[] = [];
  readonly #pending: Promise<void>[] = [];

  constructor(session: VerifierSession, workpieces: readonly WorkpieceSummary[]) {
    this.#session = session;
    this.workpieces = workpieces;
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

  async collect(verify: (verifier: EvalVerifier) => Promise<void>): Promise<EvalCheck[]> {
    try {
      await verify(this);
    } catch (error) {
      this.#checks.push({ id: VERIFIER_THREW, pass: false, evidence: truncate(String(error)) });
    }
    await Promise.all(this.#pending);
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
