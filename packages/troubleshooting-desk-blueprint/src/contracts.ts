/** A plant-local investigation scope. */
export interface InvestigationInput {
  plantId: string;
  timeRange: { from: string; to: string; timeZone: string };
  symptom: string;
  affectedOutput?: "chart" | "csv" | "report" | "cache" | "api";
}

/** The four states an evidence item can have at a boundary. */
export type EvidenceVerdict = "matches" | "mismatch" | "missing" | "inconclusive";

/** A prepared operation. It is never executed by the initial runbook. */
export interface ProposedAction {
  type: "review-mapping" | "request-backfill" | "repair-cache" | "verify-deployment";
  reason?: string;
}

/** The narrow Gadget-server contract shared by the client and Code Mode. */
export interface TroubleshootingDesk {
  open(input: InvestigationInput): Promise<Investigation>;
  inspect(id: string, request?: { runbook?: "daily-grid"; mode?: "read-only" }): Promise<Investigation>;
  revisit(id: string): Promise<Investigation>;
  proposeAction(id: string, action: ProposedAction): Promise<ApprovalRequest>;
}

/** Durable case state returned by the runbook. */
export interface Investigation {
  id: string;
  input: InvestigationInput;
  runbook: "daily-grid";
  status: "open" | "inspected";
  integration: "simulated" | "live";
  observations: EvidenceObservation[];
  latestObservationId?: string;
  firstDivergentBoundary?: string;
  confirmedFacts: string[];
  unresolvedFacts: string[];
  safeNextAction: string;
  proposals: ApprovalRequest[];
  createdAt: string;
  updatedAt: string;
}

/** One append-only evidence snapshot from a named boundary. */
export interface EvidenceObservation {
  id: string;
  inspectedAt: string;
  integration: "simulated" | "live";
  evidence: EvidenceItem[];
  firstDivergentBoundary?: string;
  confirmedFacts: string[];
  unresolvedFacts: string[];
  safeNextAction: string;
}

/** Evidence is scoped, locatable, immutable, and explicit about freshness. */
export interface EvidenceItem {
  id: string;
  boundary: string;
  source: {
    system: string;
    locator: string;
    query: string | null;
    run: string | null;
    key: string | null;
    endpoint: string | null;
  };
  observedAt: string;
  scope: {
    plantId: string;
    from: string;
    to: string;
    timeZone: string;
    deviceIds: string[];
    metrics: string[];
  };
  snapshot: { reference: string; value: unknown; fingerprint: string };
  freshness: { state: string; observedAt: string; policy: string };
  verdict: EvidenceVerdict;
  observation: string;
}

/** A human approval request. `executed` is always false in this slice. */
export interface ApprovalRequest {
  id: string;
  caseId: string;
  action: ProposedAction;
  state: "pending-approval";
  executed: false;
  createdAt: string;
  note: string;
}
