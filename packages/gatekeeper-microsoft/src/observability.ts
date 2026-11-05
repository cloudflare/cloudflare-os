import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Microsoft 365 gatekeeper. */
export type MicrosoftObservabilityFields = {
  vendorId: string;
  /** An HTTP status Graph answered with. */
  status: number;
  /** Graph's error `code`, which never carries request content. */
  graphCode: string;
  /** Why Microsoft refused an authorization: an AADSTS code, or OAuth's `error`. */
  oauthError: string;
  /** Graph's `request-id` response header, which Microsoft support asks for. */
  requestId: string;
  /** An action id, for apply-time events. */
  action: number;
  /** The binding's scope kind (`all`, `site`, `folder`, ...). */
  scopeKind: string;
  /** How many items an event concerns. */
  count: number;
};

/** Ambient observability fields for one Microsoft 365 gatekeeper operation. */
export const obsContext = createObservabilityContext<MicrosoftObservabilityFields>();
