const RUNBOOK_ID = "daily-grid";
const MAX_CASES = 100;
const VALID_OUTPUTS = new Set(["chart", "csv", "report", "cache", "api"]);
const VALID_ACTIONS = new Set(["review-mapping", "request-backfill", "repair-cache", "verify-deployment"]);

export const EVIDENCE_BOUNDARIES = [
  "raw telemetry",
  "configuration / mapping",
  "Dagster materialization",
  "durable grid/cache output",
  "served API",
  "chart / report",
];

const boundarySlugs = {
  "raw telemetry": "raw-telemetry",
  "configuration / mapping": "mapping",
  "Dagster materialization": "dagster",
  "durable grid/cache output": "grid-cache",
  "served API": "api",
  "chart / report": "presentation",
};

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isIsoLocalDateTime(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value);
}

function isTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function validateInput(input) {
  if (!input || typeof input !== "object") throw new Error("An investigation scope is required.");
  const plantId = text(input.plantId);
  const from = text(input.timeRange?.from);
  const to = text(input.timeRange?.to);
  const timeZone = text(input.timeRange?.timeZone);
  const symptom = text(input.symptom);
  if (!plantId) throw new Error("Plant is required.");
  if (!from || !isIsoLocalDateTime(from) || !to || !isIsoLocalDateTime(to)) {
    throw new Error("From and to must be explicit plant-local date and time values.");
  }
  if (from >= to) throw new Error("The end of the time range must be after the start.");
  if (!timeZone || !isTimeZone(timeZone)) throw new Error("A valid plant-local time zone is required.");
  if (!symptom) throw new Error("Describe the symptom.");
  const affectedOutput = input.affectedOutput === undefined ? undefined : text(input.affectedOutput);
  if (affectedOutput && !VALID_OUTPUTS.has(affectedOutput)) throw new Error("Affected output is not supported.");
  return {
    plantId,
    timeRange: { from, to, timeZone },
    symptom,
    ...(affectedOutput ? { affectedOutput } : {}),
  };
}

export function validateAction(action) {
  if (!action || typeof action !== "object" || !VALID_ACTIONS.has(action.type)) {
    throw new Error("Choose a supported prepared action.");
  }
  return { type: action.type, ...(text(action.reason) ? { reason: text(action.reason).slice(0, 500) } : {}) };
}

function stableId(prefix, seed) {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function snapshotFingerprint(value) {
  const serialized = JSON.stringify(value);
  return stableId("fixture", serialized).slice(8).padStart(8, "0") + "-local-fixture";
}

function sourceRecord(system, locator, extra = {}) {
  return {
    system,
    locator,
    query: null,
    run: null,
    key: null,
    endpoint: null,
    ...extra,
  };
}

function scenarioFor(symptom) {
  const lower = symptom.toLowerCase();
  if (/blank|empty|missing|no value/.test(lower)) return "missing-output";
  if (/reverse|reversed|direction|import.?export|swapped/.test(lower)) return "reversed-mapping";
  return "wrong-output";
}

function sourceFor(boundary, input, observationId) {
  const { plantId, timeRange } = input;
  const scope = `${plantId}/${timeRange.from}/${timeRange.to}`;
  const encoded = encodeURIComponent(scope);
  const base = `simulated://ava/${boundarySlugs[boundary]}/${encoded}`;
  switch (boundary) {
    case "raw telemetry":
      return sourceRecord("ThingsBoard telemetry (deferred)", `${base}/daily-meter-values`, { query: "daily_meter_values exact plant/date/device/metric" });
    case "configuration / mapping":
      return sourceRecord("AVA configuration (deferred)", `${base}/daily-meter-tm-mapping`, { query: "daily_meter_tm_mapping effective mapping at observation time" });
    case "Dagster materialization":
      return sourceRecord("Dagster (deferred)", `${base}/agg-daily-meter-values`, { query: "agg_daily_meter_values exact plant-local partition", run: `${observationId}:simulated-run` });
    case "durable grid/cache output":
      return sourceRecord("Durable cache (deferred)", `${base}/operation-overview-cache`, { key: `operation_overview_cache:${plantId}:${timeRange.from.slice(0, 10)}:grid_values` });
    case "served API":
      return sourceRecord("Monitoring API (deferred)", `${base}/plant-overview`, { endpoint: `/api/plant/${encodeURIComponent(plantId)}/overview?from=${encodeURIComponent(timeRange.from)}&to=${encodeURIComponent(timeRange.to)}&timeZone=${encodeURIComponent(timeRange.timeZone)}` });
    default:
      return sourceRecord("Plant Overview presentation (deferred)", `${base}/daily-grid`, { endpoint: `ui://plant-overview/daily-grid?plant=${encodeURIComponent(plantId)}&from=${encodeURIComponent(timeRange.from)}` });
  }
}

function fixtureValue(boundary, scenario) {
  if (scenario === "missing-output" && boundary === "durable grid/cache output") return null;
  if (scenario === "reversed-mapping" && boundary === "configuration / mapping") return { import: "grid-export", export: "grid-import", direction: "reversed" };
  if (scenario === "wrong-output" && boundary === "durable grid/cache output") return { expected: 42.1, actual: 41.2, unit: "kWh" };
  if (boundary === "raw telemetry") return { value: 42.1, unit: "kWh", deviceId: "simulated-grid-meter" };
  if (boundary === "configuration / mapping") return { import: "grid-import", export: "grid-export", direction: "normal" };
  if (boundary === "Dagster materialization") return { partition: "plant-local-day", status: "success", materialized: true };
  if (boundary === "durable grid/cache output") return { value: 42.1, unit: "kWh" };
  if (boundary === "served API") return { dailyGridValue: scenario === "missing-output" ? null : 42.1, unit: "kWh" };
  return { displayedValue: scenario === "missing-output" ? "—" : 42.1, unit: "kWh" };
}

function verdictFor(boundary, scenario) {
  if (scenario === "reversed-mapping") {
    if (boundary === "configuration / mapping") return "mismatch";
    if (boundary === "raw telemetry") return "matches";
    return "inconclusive";
  }
  if (scenario === "missing-output") {
    if (boundary === "durable grid/cache output") return "missing";
    if (boundary === "raw telemetry" || boundary === "configuration / mapping") return "matches";
    return "inconclusive";
  }
  if (boundary === "durable grid/cache output") return "mismatch";
  if (boundary === "raw telemetry" || boundary === "configuration / mapping" || boundary === "Dagster materialization") return "matches";
  return "inconclusive";
}

function observationText(boundary, verdict, value) {
  if (verdict === "matches") return `${boundary} agrees with the simulated expected value (${JSON.stringify(value)}).`;
  if (verdict === "mismatch") return `${boundary} differs from the simulated expected value. Review this boundary first.`;
  if (verdict === "missing") return `${boundary} has no value in the simulated snapshot.`;
  return `${boundary} is not proven by the simulated adapter; a live read-only capability is required.`;
}

export function buildSimulatedObservation(input, observationId, observedAt) {
  const scenario = scenarioFor(input.symptom);
  const deviceIds = [`${input.plantId}:grid-meter`];
  const evidence = EVIDENCE_BOUNDARIES.map((boundary, index) => {
    const value = fixtureValue(boundary, scenario);
    const verdict = verdictFor(boundary, scenario);
    const source = sourceFor(boundary, input, observationId);
    const reference = `snapshot://${observationId}/${boundarySlugs[boundary]}`;
    return {
      id: `${observationId}:${boundarySlugs[boundary]}`,
      boundary,
      source,
      observedAt,
      scope: {
        plantId: input.plantId,
        from: input.timeRange.from,
        to: input.timeRange.to,
        timeZone: input.timeRange.timeZone,
        deviceIds,
        metrics: ["daily grid value"],
      },
      snapshot: { reference, value, fingerprint: snapshotFingerprint(value) },
      freshness: {
        state: "simulated / live freshness unavailable",
        observedAt,
        policy: "Never use this fixture as production evidence; refresh after a read-only adapter is connected.",
      },
      integration: "simulated",
      verdict,
      observation: observationText(boundary, verdict, value),
      sequence: index + 1,
    };
  });
  const first = evidence.find((item) => item.verdict === "mismatch" || item.verdict === "missing");
  const firstDivergentBoundary = first?.boundary;
  const confirmedFacts = [
    `Plant ${input.plantId} is scoped to ${input.timeRange.from}–${input.timeRange.to} in ${input.timeRange.timeZone}.`,
    "The daily-grid runbook is read-only and records an append-only observation.",
    "The evidence ladder keeps source telemetry ahead of cache, API, and presentation output.",
  ];
  const unresolvedFacts = [
    "Live AVA telemetry, configuration, Dagster, cache, API, and UI capabilities are not connected in this blueprint.",
    "The simulated snapshots do not prove current production values or freshness.",
  ];
  const safeNextAction = firstDivergentBoundary
    ? `Connect a read-only AVA adapter and recheck ${firstDivergentBoundary} before preparing any change.`
    : "Connect a read-only AVA adapter, then revisit this case before drawing a conclusion.";
  return {
    id: observationId,
    inspectedAt: observedAt,
    integration: "simulated",
    evidence,
    firstDivergentBoundary,
    confirmedFacts,
    unresolvedFacts,
    safeNextAction,
  };
}

export function newCase(input, id, now = new Date().toISOString()) {
  return {
    id,
    input: validateInput(input),
    runbook: RUNBOOK_ID,
    status: "open",
    integration: "simulated",
    observations: [],
    proposals: [],
    createdAt: now,
    updatedAt: now,
    safeNextAction: "Run the named daily-grid read-only inspection.",
    confirmedFacts: [],
    unresolvedFacts: ["No evidence has been collected yet."],
  };
}

export function applyObservation(record, observation) {
  return {
    ...record,
    status: "inspected",
    integration: observation.integration,
    observations: [...record.observations, observation],
    latestObservationId: observation.id,
    firstDivergentBoundary: observation.firstDivergentBoundary,
    confirmedFacts: observation.confirmedFacts,
    unresolvedFacts: observation.unresolvedFacts,
    safeNextAction: observation.safeNextAction,
    updatedAt: observation.inspectedAt,
  };
}

export function makeApprovalRequest(caseId, action, id, now = new Date().toISOString()) {
  const cleanAction = validateAction(action);
  return {
    id,
    caseId,
    action: cleanAction,
    state: "pending-approval",
    executed: false,
    createdAt: now,
    note: "Prepared only. A separate human approval and post-action durable-output check are required.",
  };
}

export function summarizeCases(state) {
  return Object.values(state.cases ?? {})
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_CASES)
    .map((record) => ({
      id: record.id,
      plantId: record.input.plantId,
      symptom: record.input.symptom,
      timeRange: record.input.timeRange,
      status: record.status,
      integration: record.integration,
      updatedAt: record.updatedAt,
      firstDivergentBoundary: record.firstDivergentBoundary,
      observationCount: record.observations.length,
    }));
}

export { MAX_CASES, RUNBOOK_ID };
