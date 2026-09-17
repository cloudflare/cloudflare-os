import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagementSchedule } from "../src/management-types";
import SchedulerPage, {
  CREATE_SCHEDULE_PROMPT,
  type ScheduleManagementClient,
} from "./SchedulerPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BRIEF_WORKSPACE = "a".repeat(64);
const ROUNDUP_WORKSPACE = "b".repeat(64);
const DELETED_WORKSPACE = "c".repeat(64);

// The host resolves live workspace titles; anything it doesn't know renders as unavailable.
const TITLES = new Map([
  [BRIEF_WORKSPACE, "Daily Brief"],
  [ROUNDUP_WORKSPACE, "Team Roundup"],
]);

function hostProps() {
  return {
    openWorkspace: vi.fn<(workspaceId: string, gadgetId?: number) => void>(),
    openPrompt: vi.fn<(prompt: string) => void>(),
    resolveWorkspaceTitles: vi.fn<(ids: string[]) => Promise<(string | null)[]>>(async (ids) =>
      ids.map((id) => TITLES.get(id) ?? null),
    ),
  };
}

const active: ManagementSchedule = {
  scheduleId: "active",
  title: "Morning brief",
  description: "Prepare the daily calendar and inbox brief.",
  cadence: {
    kind: "calendar",
    timeZone: "America/Chicago",
    rule: {
      freq: "weekly",
      interval: 1,
      byDay: ["MO", "TU", "WE", "TH", "FR"],
      hour: 8,
      minute: 0,
      anchorMs: 0,
    },
  },
  status: "active",
  nextFire: Date.UTC(2026, 6, 31, 13),
  workspaceId: BRIEF_WORKSPACE,
};

const dead: ManagementSchedule = {
  scheduleId: "dead",
  title: "Weekly roundup",
  description: "Prepare the weekly roundup.",
  cadence: { kind: "interval", everyMs: 604_800_000, anchorMs: 0 },
  status: "dead",
  failedAt: Date.UTC(2026, 6, 30, 13),
  failureCode: "callback_failed",
  workspaceId: ROUNDUP_WORKSPACE,
  gadgetId: 2,
};

const completed: ManagementSchedule = {
  scheduleId: "completed",
  title: "Quarterly export",
  description: "Export the quarterly report once.",
  cadence: { kind: "once", fireAt: Date.UTC(2026, 6, 29, 13), timeZone: "UTC" },
  status: "completed",
  completedAt: Date.UTC(2026, 6, 29, 13, 1),
  workspaceId: BRIEF_WORKSPACE,
};

const expired: ManagementSchedule = {
  scheduleId: "expired",
  title: "Missed reminder",
  description: "Send a one-time reminder.",
  cadence: { kind: "once", fireAt: Date.UTC(2026, 6, 28, 13), timeZone: "UTC" },
  status: "expired",
  expiredAt: Date.UTC(2026, 6, 28, 13),
  workspaceId: DELETED_WORKSPACE,
};

describe("SchedulerPage", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  it("opens the workspace from the row and delegates prompt actions", async () => {
    const list = vi.fn<ScheduleManagementClient["list"]>(async () => ({
      schedules: [active, dead],
    }));
    const host = hostProps();
    await render(<SchedulerPage api={{ list }} {...host} />);

    expect(container!.textContent).toContain("Morning brief");
    expect(container!.textContent).toContain("Needs attention");
    expect(container!.querySelector('[role="switch"]')).toBeNull();
    // Rows carry cadence, target and timing only — never the schedule's description.
    expect(container!.textContent).not.toContain(active.description);

    await click('[data-action="open-schedule"]', "Morning brief");
    expect(host.openWorkspace).toHaveBeenCalledWith(BRIEF_WORKSPACE, undefined);
    await click('[data-action="open-schedule"]', "Weekly roundup");
    expect(host.openWorkspace).toHaveBeenLastCalledWith(ROUNDUP_WORKSPACE, 2);
    await click('[data-action="create-schedule"]');
    expect(host.openPrompt).toHaveBeenCalledWith(CREATE_SCHEDULE_PROMPT);
  });

  it("expands the failure reason on needs-attention rows only", async () => {
    const list = vi.fn<ScheduleManagementClient["list"]>(async () => ({
      schedules: [active, dead],
    }));
    await render(<SchedulerPage api={{ list }} {...hostProps()} />);

    // Only the failed schedule gets a caret; healthy rows have nothing to expand.
    expect(container!.querySelectorAll('[data-action="toggle-diagnostic"]')).toHaveLength(1);
    expect(container!.textContent).not.toContain("Task callback failed after retries.");

    await click('[data-action="toggle-diagnostic"]');
    expect(container!.textContent).toContain("Task callback failed after retries.");
    expect(container!.textContent).not.toContain(dead.description);
  });

  it("maps status tabs to server filters and appends cursor pages", async () => {
    const list = vi.fn<ScheduleManagementClient["list"]>(async (options) =>
      options?.cursor
        ? { schedules: [dead] }
        : options?.statuses?.includes("dead")
          ? { schedules: [dead] }
          : { schedules: [active], cursor: "next" },
    );
    await render(<SchedulerPage api={{ list }} {...hostProps()} />);

    await click('[data-filter="dead"]');
    expect(list).toHaveBeenLastCalledWith({ query: undefined, statuses: ["dead"] });
    expect(container!.textContent).toContain("Weekly roundup");

    await click('[data-filter="all"]');
    await click('[data-action="load-more"]');
    expect(list).toHaveBeenLastCalledWith({
      cursor: "next",
      query: undefined,
      statuses: undefined,
    });
    expect(container!.textContent).toContain("Morning brief");
    expect(container!.textContent).toContain("Weekly roundup");
  });

  it("keeps title lookups within the host limit during rapid pagination", async () => {
    const schedules = Array.from({ length: 101 }, (_, index) => ({
      ...active,
      scheduleId: `schedule-${index}`,
      title: `Task ${index}`,
      workspaceId: index.toString(16).padStart(64, "0"),
    }));
    const list = vi.fn<ScheduleManagementClient["list"]>(async (options) =>
      options?.cursor
        ? { schedules: schedules.slice(100) }
        : { schedules: schedules.slice(0, 100), cursor: "next" },
    );
    const firstLookup = deferred<(string | null)[]>();
    const resolveWorkspaceTitles = vi
      .fn<(ids: string[]) => Promise<(string | null)[]>>()
      .mockImplementationOnce(() => firstLookup.promise)
      .mockImplementation(async (ids) => {
        if (ids.length > 100) throw new TypeError("Invalid workspace title lookup.");
        return ids.map((id) => `Workspace ${Number.parseInt(id, 16)}`);
      });

    await render(
      <SchedulerPage
        api={{ list }}
        {...hostProps()}
        resolveWorkspaceTitles={resolveWorkspaceTitles}
      />,
    );
    await click('[data-action="load-more"]');
    await act(async () =>
      firstLookup.resolve(schedules.slice(0, 100).map((_, index) => `Old ${index}`)),
    );

    expect(resolveWorkspaceTitles.mock.calls.every(([ids]) => ids.length <= 100)).toBe(true);
    expect(container!.textContent).toContain("Workspace 100");
  });

  it("drops the search and tabs when the account has no schedules at all", async () => {
    const result = deferred<{ schedules: ManagementSchedule[] }>();
    const list = vi.fn<ScheduleManagementClient["list"]>(() => result.promise);
    await render(<SchedulerPage api={{ list }} {...hostProps()} />);

    expect(container!.textContent).toContain("Loading scheduled tasks");
    await act(async () => result.resolve({ schedules: [] }));

    expect(container!.querySelector('input[type="search"]')).toBeNull();
    expect(container!.querySelector('[data-filter="all"]')).toBeNull();
    expect(container!.querySelector('[data-action="create-schedule"]')).not.toBeNull();
    expect(container!.textContent).toContain("Get started");
  });

  it("shows a bounded error and retries the first page", async () => {
    const list = vi
      .fn<ScheduleManagementClient["list"]>()
      .mockRejectedValueOnce(new Error("private backend detail"))
      .mockResolvedValueOnce({ schedules: [active] });
    await render(<SchedulerPage api={{ list }} {...hostProps()} />);

    expect(container!.textContent).toContain("Couldn’t load scheduled tasks");
    expect(container!.textContent).not.toContain("private backend detail");
    await click("button", "Try again");
    expect(container!.textContent).toContain("Morning brief");
  });

  it("debounces search and keeps the filter chrome on an empty result", async () => {
    const list = vi.fn<ScheduleManagementClient["list"]>(async (options) => ({
      schedules: options?.query ? [] : [active],
    }));
    await render(<SchedulerPage api={{ list }} {...hostProps()} />);

    await change('input[type="search"]', "weekly roundup");
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
    expect(list).toHaveBeenLastCalledWith({ query: "weekly roundup", statuses: undefined });
    expect(container!.textContent).toContain("No scheduled tasks match these filters");
    // The search and tabs must survive an empty result, or the filter can't be cleared.
    expect(container!.querySelector('input[type="search"]')).not.toBeNull();
    expect(container!.querySelector('[data-filter="all"]')).not.toBeNull();
  });

  it("maps finished schedules to completed and expired states", async () => {
    const list = vi.fn<ScheduleManagementClient["list"]>(async (options) => ({
      schedules: options?.statuses?.includes("completed") ? [completed, expired] : [active],
    }));
    await render(<SchedulerPage api={{ list }} {...hostProps()} />);

    await click('[data-filter="finished"]');
    expect(list).toHaveBeenLastCalledWith({
      query: undefined,
      statuses: ["completed", "expired"],
    });
    expect(container!.textContent).toContain("Quarterly export");
    expect(container!.textContent).toContain("Missed reminder");
    // The expired task points at a workspace the host can no longer resolve, so it can't be opened.
    const rows = [
      ...container!.querySelectorAll<HTMLButtonElement>('[data-action="open-schedule"]'),
    ];
    expect(container!.textContent).toContain("Unavailable workspace");
    expect(rows.find((row) => row.textContent?.includes("Missed reminder"))?.disabled).toBe(true);
    expect(rows.find((row) => row.textContent?.includes("Quarterly export"))?.disabled).toBe(false);
  });

  async function render(element: React.ReactNode): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(element);
    });
  }

  async function click(selector: string, text?: string): Promise<void> {
    const elements = [...container!.querySelectorAll<HTMLElement>(selector)];
    const element = text
      ? elements.find((candidate) => candidate.textContent?.includes(text))
      : elements[0];
    if (!element) throw new Error(`Missing ${selector}`);
    await act(async () => element.click());
  }

  async function change(selector: string, value: string): Promise<void> {
    const element = container!.querySelector<HTMLInputElement>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
