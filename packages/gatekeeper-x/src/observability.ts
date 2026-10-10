import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the X gatekeeper. */
export type XObservabilityFields = {
  vendorId: string;
  /** The X API endpoint template a log line is about, e.g. `GET /2/users/:id/tweets`. */
  endpoint: string;
  /** An HTTP status X answered with. */
  status: number;
  /** X's problem `type` URI, which never carries request content. */
  problemType: string;
  /** How many rows of a response X could not hydrate. */
  dropped: number;
  /** An action id, for apply-time events. */
  action: number;
};

/** Ambient observability fields for one X gatekeeper operation. */
export const obsContext = createObservabilityContext<XObservabilityFields>();
