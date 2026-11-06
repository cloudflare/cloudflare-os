import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the PagerDuty gatekeeper. */
export type PagerDutyObservabilityFields = {
  vendorId: string;
  /** The REST endpoint template a log line is about, e.g. `GET /incidents/:id`. */
  endpoint: string;
  /** An HTTP status PagerDuty answered with. */
  status: number;
  /** PagerDuty's numeric error code, which never carries request content. */
  errorCode: number;
  /** An action id, for apply-time events. */
  action: number;
};

/** Ambient observability fields for one PagerDuty gatekeeper operation. */
export const obsContext = createObservabilityContext<PagerDutyObservabilityFields>();
