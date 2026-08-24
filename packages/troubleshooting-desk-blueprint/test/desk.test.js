import test from "node:test";
import assert from "node:assert/strict";
import {
  applyObservation,
  buildSimulatedObservation,
  makeApprovalRequest,
  newCase,
  validateInput,
} from "../src/desk.js";

const input = {
  plantId: "nam-phat",
  timeRange: {
    from: "2026-08-23T00:00",
    to: "2026-08-24T00:00",
    timeZone: "Asia/Ho_Chi_Minh",
  },
  symptom: "Plant Overview daily grid value is reversed",
  affectedOutput: "chart",
};

test("requires an explicit plant-local scope", () => {
  assert.throws(() => validateInput({ ...input, timeRange: { ...input.timeRange, timeZone: "" } }), /time zone/);
  assert.throws(() => validateInput({ ...input, timeRange: { ...input.timeRange, from: "2026-08-23" } }), /explicit/);
});

test("builds the evidence ladder and identifies the first divergence", () => {
  const observation = buildSimulatedObservation(input, "observation-test", "2026-08-24T01:02:03.000Z");
  assert.deepEqual(observation.evidence.map((item) => item.boundary), [
    "raw telemetry",
    "configuration / mapping",
    "Dagster materialization",
    "durable grid/cache output",
    "served API",
    "chart / report",
  ]);
  assert.equal(observation.firstDivergentBoundary, "configuration / mapping");
  assert.equal(observation.integration, "simulated");
  assert.match(observation.evidence[1].snapshot.reference, /^snapshot:\/\//);
  assert.equal(observation.evidence[1].scope.timeZone, "Asia/Ho_Chi_Minh");
});

test("keeps blank and wrong-output cases scoped to their first failing boundary", () => {
  const blank = buildSimulatedObservation({ ...input, symptom: "daily grid is blank" }, "observation-blank", "2026-08-24T01:02:03.000Z");
  const wrong = buildSimulatedObservation({ ...input, symptom: "daily grid value is wrong" }, "observation-wrong", "2026-08-24T01:02:03.000Z");
  assert.equal(blank.firstDivergentBoundary, "durable grid/cache output");
  assert.equal(blank.evidence[3].verdict, "missing");
  assert.equal(wrong.firstDivergentBoundary, "durable grid/cache output");
  assert.equal(wrong.evidence[3].verdict, "mismatch");
});

test("appending a revisit retains the old observation", () => {
  const record = newCase(input, "case-test", "2026-08-24T01:00:00.000Z");
  const first = buildSimulatedObservation(input, "observation-one", "2026-08-24T01:02:03.000Z");
  const second = buildSimulatedObservation(input, "observation-two", "2026-08-24T02:02:03.000Z");
  const afterFirst = applyObservation(record, first);
  const afterSecond = applyObservation(afterFirst, second);
  assert.equal(afterSecond.observations.length, 2);
  assert.equal(afterSecond.observations[0].id, "observation-one");
  assert.equal(afterSecond.latestObservationId, "observation-two");
});

test("prepared actions are explicitly unexecuted", () => {
  const request = makeApprovalRequest("case-test", { type: "repair-cache" }, "approval-test", "2026-08-24T01:00:00.000Z");
  assert.equal(request.state, "pending-approval");
  assert.equal(request.executed, false);
  assert.match(request.note, /human approval/);
});
