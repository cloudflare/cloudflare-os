import {
  ActionApplyError, ActionJournal, ActionOutcomeUnknownError, APPLY_OUTCOME_UNKNOWN_MESSAGE,
} from "@gadgets/gatekeeper-kit/actions";
import { describe, expect, it } from "vitest";
import { MARKER_RETENTION_MS, SHEETS_ACTIONS, type MarkerEntry, type SheetsHost } from "../src/sheets-actions";
import { SheetsWriteRefused, type GoogleSheetsApi, type SheetArea } from "../src/sheets-api";
import type { EnteredValue } from "../src/sheets-model";
import { guardDigest } from "../src/sheets-plan";
import type { PlannedChange, SheetsAction } from "../src/sheets-simulation";
import { FakeKv } from "./fake-kv";
import { rect, sheet } from "./sheets-fixture";

type BatchRequest = Record<string, any>;

const T0 = Date.UTC(2026, 9, 10, 12);
const B2 = rect(1, 1);
const SHEETS = [sheet(0, "Sales")];

/**
 * One sheet's cells as entered, developer metadata, and an atomic `batchUpdate`, as far as apply
 * uses them. `onSend` runs as each batch arrives.
 */
class FakeSheets {
  cells = new Map<string, EnteredValue>();
  markers = new Map<number, string>();
  /** Every batch sent, committed or not. */
  batches: BatchRequest[][] = [];
  /** How many calls apply made of any kind. */
  calls = 0;
  /**
   * What the next sends do: `held` fails the send as a timeout while Google still holds the batch
   * until `release()`; `dropped` fails it, committing nothing.
   */
  failures: ("held" | "dropped")[] = [];
  onSend?: () => void;
  #held: BatchRequest[][] = [];

  api: Pick<GoogleSheetsApi, "getMetadata" | "readEntered" | "getDeveloperMetadata" | "batchUpdate"> = {
    getMetadata: async spreadsheetId => {
      this.calls++;
      return { id: spreadsheetId, title: "Budget", sheets: SHEETS, protectedRanges: [] };
    },
    readEntered: async (_spreadsheetId, areas: readonly SheetArea[]) => {
      this.calls++;
      return areas.map(({ rect: { startRow, endRow, startColumn, endColumn } }) =>
        Array.from({ length: endRow - startRow }, (_row, r) =>
          Array.from({ length: endColumn - startColumn }, (_cell, c) =>
            this.cells.get(`${startRow + r}:${startColumn + c}`) ?? null)));
    },
    getDeveloperMetadata: async (_spreadsheetId, metadataId) => {
      this.calls++;
      let metadataValue = this.markers.get(metadataId);
      return metadataValue === undefined ? undefined : { metadataValue };
    },
    batchUpdate: async (_spreadsheetId, requests) => {
      this.calls++;
      this.batches.push(requests as BatchRequest[]);
      this.onSend?.();
      let failure = this.failures.shift();
      if (failure === "held") {
        this.#held.push(requests as BatchRequest[]);
        throw new Error("The operation was aborted due to timeout");
      }
      if (failure === "dropped") throw new Error("Network connection lost.");
      if (!this.#commit(requests as BatchRequest[])) throw new SheetsWriteRefused(400);
    },
  };

  /** Lets Google process the oldest held batch, returning whether it committed. */
  release(): boolean {
    return this.#commit(this.#held.shift()!);
  }

  /** Applies every request or none, refusing a marker ID already taken, as Google does. */
  #commit(requests: BatchRequest[]): boolean {
    let cells = new Map(this.cells);
    let markers = new Map(this.markers);
    for (let request of requests) {
      if (request.createDeveloperMetadata) {
        let { metadataId, metadataValue } = request.createDeveloperMetadata.developerMetadata;
        if (markers.has(metadataId)) return false;
        markers.set(metadataId, metadataValue);
      } else if (request.deleteDeveloperMetadata) {
        markers.delete(request.deleteDeveloperMetadata.dataFilter.developerMetadataLookup.metadataId);
      } else {
        let { range, rows } = request.updateCells;
        for (let row = range.startRowIndex; row < range.endRowIndex; row++) {
          for (let column = range.startColumnIndex; column < range.endColumnIndex; column++) {
            let value = rows[row - range.startRowIndex].values[column - range.startColumnIndex]
              .userEnteredValue.numberValue;
            cells.set(`${row}:${column}`, value);
          }
        }
      }
    }
    this.cells = cells;
    this.markers = markers;
    return true;
  }
}

/** The markers a batch deletes, in order. */
function deletedBy(batch: BatchRequest[]): number[] {
  return batch.flatMap(request =>
    request.deleteDeveloperMetadata ? [request.deleteDeveloperMetadata.dataFilter.developerMetadataLookup.metadataId] : []);
}

/** The Sheets action set over a fake spreadsheet, a journal, a stored marker list and a clock. */
function setup() {
  let fake = new FakeSheets();
  let clock = { now: T0 };
  let journal = new ActionJournal<SheetsAction>(new FakeKv(), { namespace: "sheets" });
  let stored: MarkerEntry[] = [];
  let host: SheetsHost = {
    api: fake.api as GoogleSheetsApi,
    spreadsheetId: "sheet-1",
    applied: id => journal.get(id)?.state === "applied" || journal.wasApplied(id),
    markers: { read: () => structuredClone(stored), write: entries => { stored = structuredClone(entries); } },
    now: () => clock.now,
  };
  let actions = SHEETS_ACTIONS.bind(journal, host);
  let nextMarker = 1000;
  return {
    fake,
    clock,
    journal,
    actions,
    markers: () => stored,
    /**
     * Queues a write of `value` to Sales!B2, guarded by the cell as it is, as
     * `updateSpreadsheet()` would.
     */
    queue: async (value: number) => {
      let changes: PlannedChange[] = [{ op: "writeCells", sheetId: 0, rect: B2, values: [[value]] }];
      let entered = [[[fake.cells.get("1:1") ?? null]]];
      let marker = { id: ++nextMarker, token: crypto.randomUUID() };
      let sha256 = await guardDigest(SHEETS, { sheetIds: [0], cells: [{ sheetId: 0, rect: B2 }] }, entered);
      let id = await actions.submit({ submitAction: async () => {} }, "editSheetValues", {
        changes, sheets: { 0: "Sales" }, marker, guard: { sha256, after: [] },
      });
      return { id, marker: marker.id };
    },
  };
}

describe("applying a Google Sheets change", () => {
  it("keeps a marker a send given up on could still commit, so that send cannot land over a later batch", async () => {
    let { fake, clock, journal, actions, queue } = setup();
    let a = await queue(6);
    fake.failures = ["held"];

    // A's first send times out while Google still holds it; its resend lands.
    await actions.apply(a.id);
    expect(journal.wasApplied(a.id)).toBe(true);
    expect(fake.batches).toHaveLength(2);
    expect(fake.batches[1]).toEqual(fake.batches[0]);
    expect(fake.cells.get("1:1")).toBe(6);

    clock.now += 60_000;
    let b = await queue(7);
    await actions.apply(b.id);
    expect(deletedBy(fake.batches[2])).toEqual([]);
    expect(fake.cells.get("1:1")).toBe(7);

    // Google gets round to A's first send: its marker is still there, so the batch is refused.
    expect(fake.release()).toBe(false);
    expect(fake.cells.get("1:1")).toBe(7);
    expect([...fake.markers.keys()]).toEqual([a.marker, b.marker]);
  });

  it("deletes a marker in the first batch sent once its window has passed", async () => {
    let { fake, clock, actions, markers, queue } = setup();
    let a = await queue(6);
    await actions.apply(a.id);

    clock.now = T0 + MARKER_RETENTION_MS - 1;
    let b = await queue(7);
    await actions.apply(b.id);
    clock.now = T0 + MARKER_RETENTION_MS;
    let c = await queue(8);
    await actions.apply(c.id);

    expect(fake.batches.map(deletedBy)).toEqual([[], [], [a.marker]]);
    expect([...fake.markers.keys()]).toEqual([b.marker, c.marker]);
    expect(markers()).toEqual([
      { id: b.marker, sentAt: T0 + MARKER_RETENTION_MS - 1 },
      { id: c.marker, sentAt: T0 + MARKER_RETENTION_MS },
    ]);
  });

  it("holds a later change pending, sending nothing, while one with an unknown outcome could still land", async () => {
    let { fake, clock, journal, actions, markers, queue } = setup();
    let a = await queue(6);
    fake.failures = ["dropped", "dropped", "dropped"];
    fake.onSend = () => { clock.now += 30_000; };

    let unknown = await actions.apply(a.id).catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(ActionOutcomeUnknownError);
    expect((unknown as Error).message).toBe(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    let lastSend = T0 + 60_000;
    expect(markers()).toEqual([{ id: a.marker, sentAt: lastSend, unknown: true }]);
    fake.onSend = undefined;

    let b = await queue(7);
    clock.now = lastSend + MARKER_RETENTION_MS - 1;
    let calls = fake.calls;
    let fenced = await actions.apply(b.id).catch((error: unknown) => error);
    expect(fenced).toBeInstanceOf(Error);
    expect(fenced).not.toBeInstanceOf(ActionApplyError);
    expect(fenced).not.toBeInstanceOf(ActionOutcomeUnknownError);
    expect((fenced as Error).message).toBe(
      "An earlier change's outcome is still unknown, and it could still land until " +
      `${new Date(lastSend + MARKER_RETENTION_MS).toISOString()}. Apply this one after that.`);
    expect(journal.get(b.id)?.state).toBe("pending");
    expect(fake.calls).toBe(calls);

    clock.now = lastSend + MARKER_RETENTION_MS;
    await actions.apply(b.id);
    expect(journal.wasApplied(b.id)).toBe(true);
    expect(deletedBy(fake.batches.at(-1)!)).toEqual([a.marker]);
    expect(fake.cells.get("1:1")).toBe(7);
  });

  it("records the batch's entry, its outcome unknown, just before each send, and settles it once it lands", async () => {
    let { fake, clock, actions, markers, queue } = setup();
    let a = await queue(6);
    fake.failures = ["dropped"];
    let atSend: MarkerEntry[][] = [];
    fake.onSend = () => {
      atSend.push(structuredClone(markers()));
      clock.now += 30_000;
    };

    await actions.apply(a.id);

    expect(atSend).toEqual([
      [{ id: a.marker, sentAt: T0, unknown: true }],
      [{ id: a.marker, sentAt: T0 + 30_000, unknown: true }],
    ]);
    expect(fake.batches[1]).toEqual(fake.batches[0]);
    expect(markers()).toEqual([{ id: a.marker, sentAt: T0 + 30_000 }]);
  });
});
