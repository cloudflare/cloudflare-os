// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { entry, makeTestRoot } from "../../../action-test-harness";
import { RESTRICTED_APPROVAL_COPY } from "../../../components/RestrictedApprovalNotice";
import { PendingApprovalCard } from "./PendingApprovalCard";

const testRoot = makeTestRoot();
afterEach(() => { testRoot.cleanup(); vi.restoreAllMocks(); });

// Long enough that any clamp on the description or the field body would cut it.
const BODY = Array.from({length: 40}, (_, i) => `Line ${i} of the message being authorised.`)
  .join("\n");

const pending = (over: Record<string, unknown> = {}) => entry(1, {
  resourceTitle: "Outbox",
  description: {
    title: "Send an email to dana@example.com",
    description: `Replies to the renewal thread.\n${BODY}`,
    implementsRevert: false,
    autoApprovable: false,
    descriptionIsComplete: true,
    fields: [{kind: "text", label: "Body", value: BODY}],
  },
  ...over,
});

async function render(record: ReturnType<typeof pending>, restricted = false) {
  const onResolve = vi.fn<(decision: "approve" | "deny") => void>();
  await testRoot.render(
    <PendingApprovalCard
      record={record} restricted={restricted} busy={false} onResolve={onResolve}
    />,
  );
  return {onResolve};
}

const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find(b => b.textContent?.trim() === label);

it("shows the whole request, with nothing clamped away", async () => {
  await render(pending());

  const text = document.body.textContent ?? "";
  // Both the prose and the field body are present in full, first line to last.
  expect(text).toContain("Replies to the renewal thread.");
  expect(text).toContain("Line 0 of the message being authorised.");
  expect(text).toContain("Line 39 of the message being authorised.");
  // The field renders uncapped: the card scrolls, rather than each field clamping inside it.
  expect(document.body.querySelector("pre")?.className).not.toContain("max-h-56");
  expect([...document.body.querySelectorAll("div")]
    .some(d => d.className.includes("overflow-y-auto"))).toBe(true);
});

it("warns above the description when the gatekeeper did not finish describing the action",
    async () => {
  await render(pending({description: {...pending().description, descriptionIsComplete: false}}));

  const notice = document.body.querySelector('[role="note"]');
  expect(notice).not.toBeNull();
  const prose = [...document.body.querySelectorAll("p")]
    .find(p => p.textContent?.startsWith("Replies to the renewal thread."));
  expect(prose).toBeDefined();
  // The approver meets the warning before the prose it qualifies.
  expect(notice!.compareDocumentPosition(prose!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Both buttons point at it, so the warning is announced with the decision either way.
  for (const label of ["Approve", "Deny"]) {
    expect(button(label)!.getAttribute("aria-describedby")).toContain(notice!.id);
  }
});

it("leaves the notice off a description the gatekeeper marked complete", async () => {
  await render(pending());

  expect(document.body.querySelector('[role="note"]')).toBeNull();
});

it("tells a restricted workspace's approver that the check is theirs", async () => {
  await render(pending(), true);

  // The kernel does not inspect the action for the sensitive data this workspace has read, so
  // every approve surface has to say so -- including one reached without opening the run.
  const notice = [...document.body.querySelectorAll('[role="note"]')]
    .find(n => n.textContent?.includes(RESTRICTED_APPROVAL_COPY));
  expect(notice).toBeDefined();
  for (const label of ["Approve", "Deny"]) {
    expect(button(label)!.getAttribute("aria-describedby")).toContain(notice!.id);
  }
});

it("reports each decision to the surface holding the card", async () => {
  const {onResolve} = await render(pending());

  await act(async () => { button("Approve")!.click(); });
  expect(onResolve).toHaveBeenCalledWith("approve");

  await act(async () => { button("Deny")!.click(); });
  expect(onResolve).toHaveBeenLastCalledWith("deny");
});

it("refuses a second decision while one is in flight", async () => {
  const onResolve = vi.fn<(decision: "approve" | "deny") => void>();
  await testRoot.render(
    <PendingApprovalCard record={pending()} restricted={false} busy onResolve={onResolve} />,
  );

  expect(button("Approve")!.disabled).toBe(true);
  expect(button("Deny")!.disabled).toBe(true);
});
