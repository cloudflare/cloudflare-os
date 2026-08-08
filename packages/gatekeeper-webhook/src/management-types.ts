import type { DeliverySummary, EndpointStatus, EndpointSummary } from "./types.js";

/** Account-management projection of one endpoint. */
export type ManagementEndpoint = EndpointSummary & {
  /** The workspace this endpoint delivers into. The host resolves its live title and route. */
  workspaceId: string;
  /** The gadget within that workspace, when the hook is pinned to one. */
  gadgetId?: number;
};

/** Read-only filters accepted by the Webhooks management capability. */
export type ManagementListOptions = {
  /** Opaque continuation token. Pages are weakly consistent if endpoints change between requests. */
  cursor?: string;
  query?: string;
  statuses?: EndpointStatus[];
};

/** One bounded page returned to the Webhooks management app. */
export type ManagementEndpointPage = {
  endpoints: ManagementEndpoint[];
  cursor?: string;
};

/** Recent deliveries for one endpoint, newest first. */
export type ManagementDeliveryPage = {
  deliveries: DeliverySummary[];
};
