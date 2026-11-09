import type { ScheduleStatus, ScheduleSummary } from "./types.js";

/** Account-management projection of one schedule. */
export type ManagementSchedule = ScheduleSummary & {
  /** The workspace this schedule delivers into. The host resolves its live title and route. */
  workspaceId: string;
  /** The gadget within that workspace, when the schedule is pinned to one. */
  gadgetId?: number;
};

/** Read-only filters accepted by the Scheduler management capability. */
export type ManagementListOptions = {
  /** Opaque continuation token. Pages are weakly consistent if schedules change between requests. */
  cursor?: string;
  query?: string;
  statuses?: ScheduleStatus[];
};

/** One bounded page returned to the Scheduler management app. */
export type ManagementSchedulePage = {
  schedules: ManagementSchedule[];
  cursor?: string;
};

/**
 * The read-only management capability the Scheduled Tasks app UI holds: the account's schedules,
 * across all of its workspaces, without the authority to change them. Hook enablement stays in the
 * Workshop's Connections UI.
 */
export interface ScheduleManagementApi {
  /**
   * Lists the account's scheduled tasks, across its workspaces, one page of at most 100 at a time,
   * filtered by `options`; pass a page's `cursor` back for the next.
   */
  list(options?: ManagementListOptions): Promise<ManagementSchedulePage>;
}
