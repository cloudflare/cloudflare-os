import { DurableObject } from "cloudflare:workers";
import {
  applyObservation,
  buildSimulatedObservation,
  makeApprovalRequest,
  newCase,
  summarizeCases,
  validateInput,
  validateAction,
} from "./desk.js";

const STATE_KEY = "troubleshooting-desk-state";

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Durable state and read-only runbook orchestration for the Troubleshooting Desk.
 *
 * The optional AVA_EVIDENCE binding is intentionally a narrow future seam. The bundled
 * blueprint does not declare or assume that binding, so this first slice always identifies its
 * evidence as simulated instead of implying that it reached AVA production.
 */
export class Gadget extends DurableObject {
  async #read() {
    return (await this.ctx.storage.get(STATE_KEY)) ?? { cases: {} };
  }

  async #update(mutator) {
    return this.ctx.storage.transaction(async (transaction) => {
      const state = (await transaction.get(STATE_KEY)) ?? { cases: {} };
      const result = await mutator(state);
      await transaction.put(STATE_KEY, state);
      return result;
    });
  }

  async #case(id) {
    const state = await this.#read();
    const record = state.cases[id];
    if (!record) throw new Error("No troubleshooting case exists with that id.");
    return { state, record };
  }

  /** Open a durable case with an explicit plant-local scope. */
  async open(input) {
    const normalized = validateInput(input);
    const now = new Date().toISOString();
    const record = newCase(normalized, makeId("case"), now);
    await this.#update((state) => {
      state.cases[record.id] = record;
    });
    return copy(record);
  }

  /**
   * Run the named daily-grid inspection in read-only mode. Every run appends one observation;
   * existing observations are not replaced or merged.
   */
  async inspect(caseId, request = {}) {
    if (request.runbook !== undefined && request.runbook !== "daily-grid") {
      throw new Error("Only the daily-grid runbook is available in this slice.");
    }
    if (request.mode !== undefined && request.mode !== "read-only") {
      throw new Error("The daily-grid runbook only accepts read-only mode.");
    }
    const observedAt = new Date().toISOString();
    const observationId = makeId("observation");
    const updated = await this.#update((state) => {
      const record = state.cases[caseId];
      if (!record) throw new Error("No troubleshooting case exists with that id.");
      const observation = buildSimulatedObservation(record.input, observationId, observedAt);
      const next = applyObservation(record, observation);
      state.cases[caseId] = next;
      return next;
    });
    return copy(updated);
  }

  /** Recheck a case and append a fresh observation while retaining its history. */
  async revisit(caseId) {
    return this.inspect(caseId, { runbook: "daily-grid", mode: "read-only" });
  }

  /**
   * Prepare a change for separate human approval. This method never performs a backfill,
   * mapping update, cache repair, or deployment operation.
   */
  async proposeAction(caseId, action) {
    const request = makeApprovalRequest(caseId, validateAction(action), makeId("approval"));
    await this.#update((state) => {
      const record = state.cases[caseId];
      if (!record) throw new Error("No troubleshooting case exists with that id.");
      state.cases[caseId] = {
        ...record,
        proposals: [...record.proposals, request],
        updatedAt: request.createdAt,
      };
    });
    return copy(request);
  }

  /** Return compact case rows for the reopen flow. */
  async listCases() {
    return copy(summarizeCases(await this.#read()));
  }

  /** Return one complete case, including append-only historical observations. */
  async getCase(caseId) {
    return copy((await this.#case(caseId)).record);
  }
}
