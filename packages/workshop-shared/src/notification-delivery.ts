import type { WorkerEntrypoint } from "cloudflare:workers";

/** Structured task-completion event accepted by the install-local notification proxy. */
export type TaskCompletedDelivery = {
  /** Stable identifier used to deduplicate delivery attempts. */
  id: string;

  /** Workspace containing the task. */
  workspaceId: string;

  /** Chat containing the task. */
  chatId: number;

  /** Current human-readable workspace title. */
  workspaceTitle: string;

  /** Current human-readable chat title. */
  chatTitle: string;

  /** Time at which the deployment observed completion. */
  completedAt: Date;
};

/** A task paused on a durable connection or action-approval prompt. */
export type PermissionRequestedDelivery = Omit<TaskCompletedDelivery, "completedAt"> & {
  /** Time at which the deployment observed the task waiting for permission. */
  requestedAt: Date;
};

/** Platform-private service binding implemented by the install-local notification proxy. */
export interface NotificationDeliveryService extends WorkerEntrypoint {
  /** Consume a one-time central device registration for an install-local account. */
  registerDevice(accountId: string, deviceRegistrationId: string): Promise<void>;

  /** Ask the central service to deliver a typed task-completion notification. */
  deliverTaskCompleted(accountId: string, delivery: TaskCompletedDelivery): Promise<void>;

  /** Ask the central service to alert the user that a task needs their permission. */
  deliverPermissionRequested(
    accountId: string,
    delivery: PermissionRequestedDelivery,
  ): Promise<void>;
}
