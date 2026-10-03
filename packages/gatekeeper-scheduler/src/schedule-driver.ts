import { DurableObject } from "cloudflare:workers";
import type { RpcStub, RpcTarget } from "cloudflare:workers";
import { reportIssue } from "@gadgets/observability/error-reporting";
import type { ApprovalQueue, HookInitiator } from "@gadgets/workshop-shared/gatekeeper";
import {
  admitRun,
  beginDueRun,
  completeRun,
  createSchedule,
  failRun,
  rejectRun,
  type EnabledSchedule,
  type ScheduleRegistration,
} from "./driver-state.js";
import { obsContext } from "./observability.js";
import { toScheduleCadence } from "./schedule-types.js";
import type { ScheduleSummary, ScheduledFiring, ScheduledTaskHook } from "./types.js";
import {
  paginateManagementSchedules,
  type ManagementListOptions,
  type ManagementSchedulePage,
} from "./management.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.scheduler.driver",
  vendorId: "scheduler",
});

const ALARM_BATCH_SIZE = 20;
const DELIVERY_CONCURRENCY = 4;
const REVOCATION_CLEANUP_BATCH_SIZE = 100;
const RECOVERY_DELAY_MS = 5 * 60_000;
const MAX_ENABLED_SCHEDULES_PER_ACCOUNT = 500;
const MAX_ENABLED_SCHEDULES_PER_WORKSPACE = 100;

const METADATA_KEY = "metadata";
const SCHEDULE_PREFIX = "schedule:";
const CAPABILITIES_PREFIX = "caps:";

type ScheduleHookTarget = RpcTarget & ScheduledTaskHook;
type ScheduleInitiator = Fetcher<HookInitiator<ScheduleHookTarget>>;

type DriverMetadata = {
  schemaVersion: 1;
  revoked: boolean;
};

type StoredCapabilities = {
  initiator: ScheduleInitiator;
};

type HookResult = {
  callback: RpcStub<ScheduleHookTarget>;
  approvalQueue: RpcStub<ApprovalQueue>;
};

export type ScheduleActivation = ScheduleRegistration & {
  title: string;
  description: string;
  /** The gadget the hook delivers into, when the hook is pinned to one. */
  gadgetId?: number;
};

export type StoredSchedule = {
  version: 1;
  state: EnabledSchedule;
  title: string;
  description: string;
  gadgetId?: number;
};

type PreparedRun = {
  workspaceId: string;
  scheduleId: string;
  runId: string;
  scheduledTime: number;
};

type PendingState = Extract<EnabledSchedule, { status: "pending" }>;
type PendingStage = PendingState["stage"];

export class ScheduleDriver extends DurableObject {
  async enable(
    activation: ScheduleActivation,
    initiator: ScheduleInitiator,
    now = Date.now(),
  ): Promise<void> {
    await obsContext.with(
      {
        accountId: this.ctx.id.toString(),
        workspaceId: activation.workspaceId,
        scheduleId: activation.scheduleId,
        operation: "enable",
      },
      () => this.#enable(activation, initiator, now),
    );
  }

  async #enable(
    activation: ScheduleActivation,
    initiator: ScheduleInitiator,
    now: number,
  ): Promise<void> {
    this.#requireLiveMetadata();
    await this.#armRecoveryAlarm(checkedAdd(now, RECOVERY_DELAY_MS));
    let replaced: StoredCapabilities | undefined;
    try {
      this.ctx.storage.transactionSync(() => {
        this.#requireLiveMetadata(true);
        const key = scheduleKey(activation.workspaceId, activation.scheduleId);
        const existing = this.#readSchedule(key);
        let state: EnabledSchedule;
        if (existing) {
          state = existing.state;
          this.ctx.storage.kv.put(key, {
            ...existing,
            title: activation.title,
            description: activation.description,
            gadgetId: activation.gadgetId,
          });
        } else {
          this.#assertScheduleQuota(activation.workspaceId);
          state = createSchedule(activation, now);
          this.ctx.storage.kv.put<StoredSchedule>(key, {
            version: 1,
            state,
            title: activation.title,
            description: activation.description,
            ...(activation.gadgetId !== undefined ? { gadgetId: activation.gadgetId } : {}),
          });
        }
        // A schedule already terminal here — a lapsed bound, or a repeated enable of a finished
        // row — can never fire, so it must not hold a delivery capability until disable.
        replaced = this.#takeCapabilities(state);
        if (!isTerminal(state)) {
          this.ctx.storage.kv.put<StoredCapabilities>(
            capabilitiesKey(activation.workspaceId, activation.scheduleId),
            { initiator },
          );
        }
      });
    } finally {
      disposeCapabilities(replaced);
    }
    await this.#planAlarmAfterMutation();
    logger.info("schedule enabled", { event: "schedule.enabled" });
  }

  async disable(workspaceId: string, scheduleId: string): Promise<void> {
    await obsContext.with(
      {
        accountId: this.ctx.id.toString(),
        workspaceId,
        scheduleId,
        operation: "disable",
      },
      () => this.#disable(workspaceId, scheduleId),
    );
  }

  async #disable(workspaceId: string, scheduleId: string): Promise<void> {
    let capabilities: StoredCapabilities | undefined;
    let revoked = false;
    try {
      this.ctx.storage.transactionSync(() => {
        if (this.#requireMetadata().revoked) {
          revoked = true;
          return;
        }
        const key = scheduleKey(workspaceId, scheduleId);
        this.#readSchedule(key);
        capabilities = this.ctx.storage.kv.get<StoredCapabilities>(
          capabilitiesKey(workspaceId, scheduleId),
        );
        this.ctx.storage.kv.delete(key);
        this.ctx.storage.kv.delete(capabilitiesKey(workspaceId, scheduleId));
      });
    } finally {
      disposeCapabilities(capabilities);
    }
    if (revoked) return;
    await this.#planAlarmAfterMutation();
    logger.info("schedule disabled", { event: "schedule.disabled" });
  }

  async getSchedule(workspaceId: string, scheduleId: string): Promise<StoredSchedule | undefined> {
    if (this.#requireMetadata().revoked) return undefined;
    return this.#readSchedule(scheduleKey(workspaceId, scheduleId));
  }

  async listWorkspace(workspaceId: string): Promise<ScheduleSummary[]> {
    if (this.#requireMetadata().revoked) return [];
    return this.#listSchedules(workspaceSchedulePrefix(workspaceId))
      .map(([, schedule]) => toScheduleSummary(schedule))
      .toSorted(compareScheduleSummaries);
  }

  async listAccount(options?: ManagementListOptions): Promise<ManagementSchedulePage> {
    if (this.#requireMetadata().revoked) return { schedules: [] };
    return paginateManagementSchedules(
      this.#listSchedules().map(([key, schedule]) => ({
        key,
        schedule: {
          ...toScheduleSummary(schedule),
          workspaceId: schedule.state.workspaceId,
          ...(schedule.gadgetId !== undefined ? { gadgetId: schedule.gadgetId } : {}),
        },
      })),
      options,
    );
  }

  async revoke(): Promise<void> {
    await obsContext.with({ accountId: this.ctx.id.toString(), operation: "revoke" }, async () => {
      try {
        await this.ctx.storage.setAlarm(Date.now());
        this.ctx.storage.transactionSync(() => {
          const metadata = this.#requireMetadata();
          if (metadata.revoked) return;
          this.ctx.storage.kv.put<DriverMetadata>(METADATA_KEY, {
            schemaVersion: 1,
            revoked: true,
          });
        });
        logger.info("scheduler account revoked", { event: "scheduler.account.revoked" });
      } catch (error) {
        logger.error("scheduler account revocation failed", {
          event: "scheduler.account.revoke.failed",
          error,
        });
        reportIssue("scheduler.revoke", error, { attributes: obsContext.get() });
        throw error;
      }
    });
  }

  async alarm(): Promise<void> {
    await obsContext.with({ accountId: this.ctx.id.toString(), operation: "alarm" }, async () => {
      const startedAt = Date.now();
      try {
        const { dueCount, batchSize, backlogCount, startHookRejectedCount } =
          await this.#runAlarm();
        logger.debug("scheduler alarm batch completed", {
          event: "scheduler.alarm.completed",
          durationMs: Date.now() - startedAt,
          dueCount,
          batchSize,
          backlogCount,
          startHookRejectedCount,
        });
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        logger.error("scheduler alarm failed", {
          event: "scheduler.alarm.failed",
          durationMs,
          error,
        });
        reportIssue("scheduler.alarm", error, {
          attributes: { ...obsContext.get(), durationMs },
        });
        throw error;
      }
    });
  }

  async #runAlarm(): Promise<{
    dueCount: number;
    batchSize: number;
    backlogCount: number;
    startHookRejectedCount: number;
  }> {
    const now = Date.now();
    await this.ctx.storage.setAlarm(checkedAdd(now, RECOVERY_DELAY_MS));
    if (this.#requireMetadata().revoked) {
      await this.#cleanupRevokedAccount();
      return { dueCount: 0, batchSize: 0, backlogCount: 0, startHookRejectedCount: 0 };
    }

    const due = this.#listSchedules()
      .filter(([, schedule]) => isDue(schedule, now))
      .toSorted(compareDueSchedules);
    const batch = due.slice(0, ALARM_BATCH_SIZE);

    // An alarm cannot overlap its own live handler, so an immediate write would not bypass a hung
    // callback. Rev1 relies on the recovery watchdog and replans after a successful batch.
    let startHookRejectedCount = 0;
    // A hung callback stalls this entire per-account batch. Stronger isolation is deferred beyond
    // rev1; ordinary work remains bounded to four concurrent deliveries.
    await runBounded(batch, DELIVERY_CONCURRENCY, async ([key, schedule]) => {
      if (await this.#deliverSafely(key, schedule)) startHookRejectedCount++;
    });
    await this.#planAlarm();
    return {
      dueCount: due.length,
      batchSize: batch.length,
      backlogCount: due.length - batch.length,
      startHookRejectedCount,
    };
  }

  async #planAlarmAfterMutation(): Promise<void> {
    try {
      await this.#planAlarm();
    } catch (error) {
      logger.error("scheduler alarm planning failed", {
        event: "scheduler.alarm.plan.failed",
        error,
      });
      reportIssue("scheduler.alarm.plan", error, { attributes: obsContext.get() });
    }
  }

  async #armRecoveryAlarm(deadline: number): Promise<void> {
    try {
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null || deadline < existing) await this.ctx.storage.setAlarm(deadline);
    } catch (error) {
      logger.error("scheduler recovery alarm failed", {
        event: "scheduler.alarm.arm.failed",
        error,
      });
      reportIssue("scheduler.alarm.arm", error, { attributes: obsContext.get() });
      throw error;
    }
  }

  #assertScheduleQuota(workspaceId: string): void {
    const accountCount = this.#listSchedules(
      SCHEDULE_PREFIX,
      MAX_ENABLED_SCHEDULES_PER_ACCOUNT,
    ).length;
    if (accountCount >= MAX_ENABLED_SCHEDULES_PER_ACCOUNT) {
      throw new RangeError("Enabled schedule account quota exceeded.");
    }

    const workspaceCount = this.#listSchedules(
      workspaceSchedulePrefix(workspaceId),
      MAX_ENABLED_SCHEDULES_PER_WORKSPACE,
    ).length;
    if (workspaceCount >= MAX_ENABLED_SCHEDULES_PER_WORKSPACE) {
      throw new RangeError("Enabled schedule workspace quota exceeded.");
    }
  }

  /**
   * Applies a transition to the fenced pending run, then persists it. Releases the delivery
   * capability once the schedule reaches a state it can never fire from, after the commit.
   */
  #settle(
    prepared: PreparedRun,
    stage: PendingStage | undefined,
    transition: (state: PendingState) => EnabledSchedule,
  ): void {
    let orphaned: StoredCapabilities | undefined;
    this.ctx.storage.transactionSync(() => {
      if (this.#requireMetadata().revoked) return;
      const key = scheduleKey(prepared.workspaceId, prepared.scheduleId);
      const stored = this.#readSchedule(key);
      if (!matchesPending(stored, prepared)) return;
      if (stage !== undefined && stored.state.stage !== stage) return;
      const state = transition(stored.state);
      this.ctx.storage.kv.put<StoredSchedule>(key, { ...stored, state });
      if (isTerminal(state)) orphaned = this.#takeCapabilities(state);
    });
    disposeCapabilities(orphaned);
  }

  /** Removes a schedule's stored capability row, handing the stub back to the caller to dispose. */
  #takeCapabilities(state: EnabledSchedule): StoredCapabilities | undefined {
    const key = capabilitiesKey(state.workspaceId, state.scheduleId);
    const stored = this.ctx.storage.kv.get<StoredCapabilities>(key);
    if (stored) this.ctx.storage.kv.delete(key);
    return stored;
  }

  async #deliver(key: string): Promise<boolean> {
    const prepared = this.#prepareRun(key, Date.now());
    if (!prepared) return false;
    return obsContext.with({ runId: prepared.runId }, async () => {
      try {
        return await this.#deliverPrepared(prepared);
      } catch (error) {
        this.#reportDeliveryFailure(error);
        return false;
      }
    });
  }

  async #deliverPrepared(prepared: PreparedRun): Promise<boolean> {
    const capabilities = this.ctx.storage.kv.get<StoredCapabilities>(
      capabilitiesKey(prepared.workspaceId, prepared.scheduleId),
    );
    if (!capabilities) {
      const error = new Error("Scheduler capability record is missing.");
      logger.error("scheduler capability record is missing", {
        event: "scheduler.capabilities.missing",
        error,
      });
      reportIssue("scheduler.capabilities.missing", error, {
        handled: true,
        attributes: obsContext.get(),
      });
      this.#rejectPending(prepared, Date.now());
      return false;
    }

    let hookResult: HookResult | undefined;
    try {
      // @ts-expect-error Worker RPC promises are disposable even though the mapped type omits it.
      using hookCall = capabilities.initiator.startHook();
      try {
        // Await admission rather than pipeline: its rejection must skip this occurrence before the
        // callback attempt is counted or either returned capability is used.
        // @ts-expect-error Worker RPC's mapped return type wraps the already-stubbed hook result.
        hookResult = await hookCall;
      } catch {
        this.#rejectPending(prepared, Date.now());
        return true;
      }

      const admitted = this.#markAdmitted(prepared, Date.now());
      if (!admitted || !hookResult) return false;

      const firing: ScheduledFiring = {
        scheduleId: prepared.scheduleId,
        runId: prepared.runId,
        scheduledTime: prepared.scheduledTime,
        actualTime: Date.now(),
        timeZone: timeZoneOf(admitted.state),
      };
      try {
        await hookResult.approvalQueue.authorizeObservation({
          title: `Run scheduled task: ${admitted.title}`,
          description: `Deliver scheduled task ${prepared.scheduleId} for its planned occurrence at ${prepared.scheduledTime}.`,
        });
      } catch {
        this.#failPending(prepared, "authorization_failed", Date.now());
        return false;
      }

      if (!this.#isPendingDelivery(prepared)) return false;
      try {
        await hookResult.callback.onSchedule(firing);
      } catch {
        this.#failPending(prepared, "callback_failed", Date.now());
        return false;
      }
      this.#completePending(prepared, Date.now());
      return false;
    } finally {
      disposeStub(capabilities.initiator);
    }
  }

  async #deliverSafely(key: string, schedule: StoredSchedule): Promise<boolean> {
    const { workspaceId, scheduleId } = schedule.state;
    return obsContext.with({ workspaceId, scheduleId }, async () => {
      try {
        return await this.#deliver(key);
      } catch (error) {
        this.#reportDeliveryFailure(error);
        return false;
      }
    });
  }

  #reportDeliveryFailure(error: unknown): void {
    logger.error("unexpected schedule delivery failure", {
      event: "schedule.delivery.unexpected",
      error,
    });
    reportIssue("scheduler.delivery", error, {
      handled: true,
      attributes: obsContext.get(),
    });
  }

  #prepareRun(key: string, now: number): PreparedRun | undefined {
    return this.ctx.storage.transactionSync(() => {
      this.#requireLiveMetadata();
      const stored = this.#readSchedule(key);
      if (!stored || !isDue(stored, now)) return undefined;

      let state = stored.state;
      if (state.status === "pending" && state.stage === "delivery") {
        state = failRun(state, state.runId, "callback_failed", now);
        this.ctx.storage.kv.put<StoredSchedule>(key, { ...stored, state });
        return undefined;
      }
      const leaseExpiresAt = checkedAdd(now, RECOVERY_DELAY_MS);
      if (state.status === "active" || state.status === "retrying") {
        state = beginDueRun(state, now, crypto.randomUUID(), leaseExpiresAt);
      } else if (state.status === "pending") {
        state = { ...state, leaseExpiresAt };
      }
      if (state.status !== "pending") return undefined;
      this.ctx.storage.kv.put<StoredSchedule>(key, { ...stored, state });
      return {
        workspaceId: state.workspaceId,
        scheduleId: state.scheduleId,
        runId: state.runId,
        scheduledTime: state.scheduledTime,
      };
    });
  }

  #markAdmitted(prepared: PreparedRun, now: number): StoredSchedule | undefined {
    return this.ctx.storage.transactionSync(() => {
      if (this.#requireMetadata().revoked) return undefined;
      const key = scheduleKey(prepared.workspaceId, prepared.scheduleId);
      const stored = this.#readSchedule(key);
      if (!matchesPending(stored, prepared)) return undefined;
      const leaseExpiresAt = checkedAdd(now, RECOVERY_DELAY_MS);
      const state =
        stored.state.stage === "admission"
          ? admitRun(stored.state, prepared.runId, now, leaseExpiresAt)
          : { ...stored.state, leaseExpiresAt };
      if (state.status !== "pending" || state.stage !== "delivery") return undefined;
      const admitted = { ...stored, state };
      this.ctx.storage.kv.put(key, admitted);
      return admitted;
    });
  }

  #rejectPending(prepared: PreparedRun, rejectedAt: number): void {
    this.#settle(prepared, undefined, (state) => rejectRun(state, prepared.runId, rejectedAt));
  }

  #failPending(
    prepared: PreparedRun,
    failureCode: "authorization_failed" | "callback_failed",
    failedAt: number,
  ): void {
    this.#settle(prepared, "delivery", (state) =>
      failRun(state, prepared.runId, failureCode, failedAt));
  }

  #completePending(prepared: PreparedRun, completedAt: number): void {
    this.#settle(prepared, "delivery", (state) =>
      completeRun(state, prepared.runId, completedAt));
  }

  #isPendingDelivery(prepared: PreparedRun): boolean {
    if (this.#requireMetadata().revoked) return false;
    const stored = this.#readSchedule(scheduleKey(prepared.workspaceId, prepared.scheduleId));
    return matchesPending(stored, prepared) && stored.state.stage === "delivery";
  }

  async #planAlarm(): Promise<void> {
    const metadata = this.#requireMetadata();
    if (metadata.revoked) {
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    let target: number | undefined;
    for (const [, schedule] of this.#listSchedules()) {
      const candidate = alarmTarget(schedule);
      if (candidate !== undefined && (target === undefined || candidate < target))
        target = candidate;
    }
    if (target === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(target);
  }

  async #cleanupRevokedAccount(): Promise<void> {
    const entries = [...this.ctx.storage.kv.list({ limit: REVOCATION_CLEANUP_BATCH_SIZE + 1 })];
    const cleanup = entries
      .filter(([key]) => key !== METADATA_KEY)
      .slice(0, REVOCATION_CLEANUP_BATCH_SIZE);
    for (const [key, value] of cleanup) {
      if (key.startsWith(CAPABILITIES_PREFIX)) disposeCapabilities(value as StoredCapabilities);
    }
    this.ctx.storage.transactionSync(() => {
      for (const [key] of cleanup) this.ctx.storage.kv.delete(key);
    });
    const remains = [...this.ctx.storage.kv.list({ limit: 2 })].some(
      ([key]) => key !== METADATA_KEY,
    );
    if (remains) await this.ctx.storage.setAlarm(Date.now());
    else await this.ctx.storage.deleteAlarm();
  }

  #readSchedule(key: string): StoredSchedule | undefined {
    const value = this.ctx.storage.kv.get<unknown>(key);
    return value === undefined ? undefined : decodeStoredSchedule(key, value, "reject");
  }

  #listSchedules(prefix = SCHEDULE_PREFIX, limit?: number): Array<[string, StoredSchedule]> {
    const schedules: Array<[string, StoredSchedule]> = [];
    for (const [key, value] of this.ctx.storage.kv.list<unknown>({ prefix, limit })) {
      const schedule = decodeStoredSchedule(key, value, "skip");
      if (schedule) schedules.push([key, schedule]);
    }
    return schedules;
  }

  #requireMetadata(): DriverMetadata {
    const metadata = this.ctx.storage.kv.get<DriverMetadata>(METADATA_KEY);
    if (metadata === undefined) return { schemaVersion: 1, revoked: false };
    if (metadata.schemaVersion !== 1 || typeof metadata.revoked !== "boolean") {
      throw new Error("Unsupported scheduler driver metadata.");
    }
    return metadata;
  }

  #requireLiveMetadata(initialize = false): DriverMetadata {
    const metadata = this.#requireMetadata();
    if (metadata.revoked) throw new Error("Scheduler account is permanently revoked.");
    if (initialize && this.ctx.storage.kv.get(METADATA_KEY) === undefined) {
      this.ctx.storage.kv.put<DriverMetadata>(METADATA_KEY, metadata);
    }
    return metadata;
  }
}

function decodeStoredSchedule(
  key: string,
  value: unknown,
  mode: "reject" | "skip",
): StoredSchedule | undefined {
  if (typeof value === "object" && value !== null && "version" in value && value.version === 1) {
    return value as StoredSchedule;
  }

  const error = new Error(`Unsupported scheduler schedule row: ${key}`);
  logger.error("unsupported scheduler schedule row", {
    event: "scheduler.schedule-row.unsupported",
    error,
  });
  reportIssue("scheduler.schedule-row.unsupported", error, {
    handled: true,
    attributes: obsContext.get(),
  });
  if (mode === "reject") throw error;
  return undefined;
}

function matchesPending(
  stored: StoredSchedule | undefined,
  prepared: PreparedRun,
): stored is StoredSchedule & { state: Extract<EnabledSchedule, { status: "pending" }> } {
  return stored?.state.status === "pending" && stored.state.runId === prepared.runId;
}

function isDue(schedule: StoredSchedule, now: number): boolean {
  const state = schedule.state;
  if (state.status === "active") return state.nextFire <= now;
  if (state.status === "retrying") return state.nextAttempt <= now;
  if (state.status === "pending") return state.leaseExpiresAt <= now;
  return false;
}

/** True once a schedule can never fire again, so its stored capability is dead weight. */
function isTerminal(state: EnabledSchedule): boolean {
  return state.status === "completed" || state.status === "expired" || state.status === "dead";
}

function alarmTarget(schedule: StoredSchedule): number | undefined {
  const state = schedule.state;
  if (state.status === "active") return state.nextFire;
  if (state.status === "retrying") return state.nextAttempt;
  if (state.status === "pending") return state.leaseExpiresAt;
  return undefined;
}

function timeZoneOf(state: EnabledSchedule): string {
  return state.spec.kind === "interval" ? "UTC" : state.spec.timeZone;
}

function toScheduleSummary(schedule: StoredSchedule): ScheduleSummary {
  const common = {
    scheduleId: schedule.state.scheduleId,
    title: schedule.title,
    description: schedule.description,
    cadence: toScheduleCadence(schedule.state.spec),
    occurrences: schedule.state.occurrences,
    occurrenceCount: schedule.state.occurrences ? schedule.state.occurrenceCount ?? 0 : undefined,
  };
  const state = schedule.state;
  switch (state.status) {
    case "active":
      return { ...common, status: "active", nextFire: state.nextFire };
    case "pending":
      return { ...common, status: "active", nextFire: state.nextFire ?? state.scheduledTime };
    case "retrying":
      return { ...common, status: "active", nextFire: state.nextAttempt, retrying: true };
    case "dead":
      return {
        ...common,
        status: "dead",
        failedAt: state.failedAt,
        failureCode: state.failureCode,
      };
    case "completed":
      return { ...common, status: "completed", completedAt: state.completedAt };
    case "expired":
      return { ...common, status: "expired", expiredAt: state.expiredAt };
  }
}

function compareScheduleSummaries(left: ScheduleSummary, right: ScheduleSummary): number {
  const leftTime =
    left.status === "active" ? (left.nextFire ?? Number.MAX_SAFE_INTEGER) : terminalTime(left);
  const rightTime =
    right.status === "active" ? (right.nextFire ?? Number.MAX_SAFE_INTEGER) : terminalTime(right);
  return leftTime - rightTime || left.scheduleId.localeCompare(right.scheduleId);
}

function terminalTime(summary: Exclude<ScheduleSummary, { status: "active" }>): number {
  if (summary.status === "dead") return summary.failedAt;
  if (summary.status === "completed") return summary.completedAt;
  return summary.expiredAt;
}

function compareDueSchedules(
  [leftKey, left]: [string, StoredSchedule],
  [rightKey, right]: [string, StoredSchedule],
): number {
  return alarmTarget(left)! - alarmTarget(right)! || leftKey.localeCompare(rightKey);
}

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const current = index++;
        if (current >= values.length) return;
        await run(values[current]!);
      }
    }),
  );
}

function disposeCapabilities(capabilities: StoredCapabilities | undefined): void {
  disposeStub(capabilities?.initiator);
}

function disposeStub(value: unknown): void {
  const disposable = value as { [Symbol.dispose]?: () => void } | undefined;
  disposable?.[Symbol.dispose]?.();
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result))
    throw new RangeError("Alarm deadline exceeds supported range.");
  return result;
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function scheduleKey(workspaceId: string, scheduleId: string): string {
  return `${SCHEDULE_PREFIX}${encodeKeyPart(workspaceId)}:${encodeKeyPart(scheduleId)}`;
}

function workspaceSchedulePrefix(workspaceId: string): string {
  return `${SCHEDULE_PREFIX}${encodeKeyPart(workspaceId)}:`;
}

function capabilitiesKey(workspaceId: string, scheduleId: string): string {
  return `${CAPABILITIES_PREFIX}${encodeKeyPart(workspaceId)}:${encodeKeyPart(scheduleId)}`;
}
