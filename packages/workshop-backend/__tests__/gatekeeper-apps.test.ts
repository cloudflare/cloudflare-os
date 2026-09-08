import { describe, expect, it } from "vitest";
import { gatekeeperAppInstanceId, listVisibleGatekeeperApps, resolveGatekeeperAppAccount } from "../src/server.js";
import { shouldRefreshWorkItemsSourceDescription, type ProvidedAccountInfo } from "../src/user.js";

function account(accountId: number, vendorId = "context",
    providesUi: NonNullable<ProvidedAccountInfo["description"]["providesUi"]> = { title: "Context" })
    : ProvidedAccountInfo {
  return {
    accountId,
    vendorId,
    description: {
      displayName: `Account ${accountId}`,
      uniqueName: `account-${accountId}@example.test`,
      avatar: { url: `https://example.test/${accountId}.png` },
      providesUi,
    },
  };
}

describe("gatekeeper management app identity", () => {
  it("gives two same-vendor UI accounts distinct stable account-addressed app ids", async () => {
    let first = account(17);
    let second = account(42);

    let apps = await listVisibleGatekeeperApps([first, second], false);

    expect(apps).toHaveLength(2);
    expect(apps[0].vendorId).toBe("context");
    expect(apps[0].id).toBe(await gatekeeperAppInstanceId(first));
    expect(apps[1].id).toBe(await gatekeeperAppInstanceId(second));
    expect(apps[0].id).not.toBe(apps[1].id);
    expect(apps[0].id).not.toContain(String(first.accountId));
    expect(apps.map((app) => app.accountUniqueName)).toEqual([
      "account-17@example.test",
      "account-42@example.test",
    ]);
  });

  it("resolves direct opens only for stable ids owned by the caller", async () => {
    let owned = account(17);
    let other = account(42);

    expect(await resolveGatekeeperAppAccount([owned], await gatekeeperAppInstanceId(owned), false))
        .toBe(owned);
    expect(await resolveGatekeeperAppAccount([owned], await gatekeeperAppInstanceId(other), false))
        .toBeNull();
  });

  it("hides admin-only apps from non-admins and rejects non-admin direct opens", async () => {
    let adminApp = account(17, "admin-app", { title: "Admin app", adminOnly: true });

    expect(await listVisibleGatekeeperApps([adminApp], false)).toEqual([]);
    expect(await resolveGatekeeperAppAccount([adminApp], await gatekeeperAppInstanceId(adminApp), false))
        .toBeNull();

    expect(await listVisibleGatekeeperApps([adminApp], true)).toHaveLength(1);
    expect(await resolveGatekeeperAppAccount([adminApp], await gatekeeperAppInstanceId(adminApp), true))
        .toBe(adminApp);
  });

  it("supports a legacy vendor id only when it resolves unambiguously", async () => {
    let first = account(17);
    let second = account(42);

    expect(await resolveGatekeeperAppAccount([first], "context", false)).toBe(first);
    expect(await resolveGatekeeperAppAccount([first, second], "context", false)).toBeNull();
  });

  it("allows legacy vendor id when only one same-vendor app is visible to the caller", async () => {
    let visible = account(17);
    let hidden = account(42, "context", { title: "Context Admin", adminOnly: true });

    expect(await resolveGatekeeperAppAccount([visible, hidden], "context", false)).toBe(visible);
    expect(await resolveGatekeeperAppAccount([visible, hidden], "context", true)).toBeNull();
  });

  it("preserves existing single-account list/open behavior with the new app id", async () => {
    let appAccount = account(17, "scheduler", { title: "Scheduled" });

    let [app] = await listVisibleGatekeeperApps([appAccount], false);

    expect(app).toMatchObject({
      id: await gatekeeperAppInstanceId(appAccount),
      vendorId: "scheduler",
      title: "Scheduled",
      accountDisplayName: "Account 17",
      accountUniqueName: "account-17@example.test",
    });
    expect(await resolveGatekeeperAppAccount([appAccount], app.id, false)).toBe(appAccount);
  });

  it("exposes composite source metadata while preserving the existing admin gate", async () => {
    let source = account(17, "jira", {
      title: "Jira Work Items",
      adminOnly: true,
      composition: {kind: "work-items", role: "jira", embeddedOnly: true},
    });

    expect(await listVisibleGatekeeperApps([source], false)).toEqual([]);
    expect(await listVisibleGatekeeperApps([source], true)).toEqual([expect.objectContaining({
      id: await gatekeeperAppInstanceId(source),
      vendorId: "jira",
      composition: {kind: "work-items", role: "jira", embeddedOnly: true},
    })]);
    expect(await resolveGatekeeperAppAccount(
        [source], await gatekeeperAppInstanceId(source), true)).toBe(source);
  });

  it("refreshes migrated Jira and Zendesk accounts that predate Work Items source metadata", () => {
    expect(shouldRefreshWorkItemsSourceDescription(account(7, "jira", { title: "Jira" })))
      .toBe(true);
    expect(shouldRefreshWorkItemsSourceDescription(account(8, "zendesk", {
      title: "Zendesk",
      composition: {kind: "work-items", role: "zendesk", embeddedOnly: true},
    }))).toBe(false);
    expect(shouldRefreshWorkItemsSourceDescription(account(9, "confluence", { title: "Confluence" })))
      .toBe(false);
  });
});
