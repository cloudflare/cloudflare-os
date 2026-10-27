// The Outlook configurator frame as the Workshop hosts it, in Chromium: the journeys a user takes
// through it, with the gatekeeper capability faked so each test decides what it answers and when.
// Needs the generated frame (`build:configurator`, which `test:run` runs first).

import { describe, expect, it, vi } from "vitest";
import type { OutlookConfiguratorStatus, OutlookFolderList } from "../src/configurator/outlook-configurator-types";
import { startFrame, useFrameHost, type Answer, type Hosted } from "./frame-host";

const READY: OutlookConfiguratorStatus = {
  state: "ready", me: { address: "phillip@contoso.com", name: "Phillip Jones" },
  levels: ["read", "draft", "send"], sharedLevels: ["read"], limitedByDeployment: false,
};
const FOLDERS: OutlookFolderList = {
  folders: [
    { id: "AAMkInbox", name: "Inbox", path: "Inbox", depth: 0, kind: "inbox", descendants: 1 },
    { id: "AAMkVendors", name: "Vendors", path: "Inbox/Vendors", depth: 1, kind: "folder", descendants: 0 },
    { id: "AAMkSent", name: "Sent Items", path: "Sent Items", depth: 0, kind: "sent", descendants: 0 },
  ],
};

useFrameHost();

const start = (answers: Record<string, Answer>, initialResource?: string) => startFrame("outlook", { answers, initialResource });

/** A radio or checkbox by the id the UI gives it. */
const control = (hosted: Hosted, id: string) => hosted.frame().locator(`#${id}`);
/** Chooses a card or segment as a user does, by its label; the radio itself is visually hidden. */
const choose = (hosted: Hosted, id: string) => hosted.frame().locator(`label[for="${id}"]`).click();
const ready = (hosted: Hosted) => async () => (await hosted.state()).ready;
const folderList = (hosted: Hosted) => hosted.frame().getByRole("radiogroup", { name: "Folders" });
/** The chosen people, as their chips name them. */
const chips = (hosted: Hosted) => hosted.frame().locator(".ol-chip-label").allInnerTexts();

/** What the frame binds, with the gatekeeper's answer given so the collection completes. */
async function bound(hosted: Hosted): Promise<unknown> {
  const draft = await hosted.collected();
  hosted.callsOf("resourceUrlFor").at(-1)!.resolve("https://outlook.office.com/mail/");
  return draft;
}

describe("the Outlook configurator frame", () => {
  it("opens on the whole mailbox, read only", async () => {
    const frame = await start({ getStatus: () => READY });
    await control(frame, "ol-access-read").waitFor();
    for (const id of ["ol-mailbox-mine", "ol-target-all", "ol-access-read"]) {
      expect(await control(frame, id).isChecked(), id).toBe(true);
    }
    expect(await frame.text()).toContain("Mail can be read and searched. Nothing is changed.");
    await expect.poll(ready(frame)).toBe(true);
    expect(await bound(frame)).toEqual({ access: "read" });
    // Nothing is read to show the user beyond what they choose from.
    expect(frame.calls.map(call => call.method)).toEqual(["getStatus", "resourceUrlFor"]);
    // A script the policy refused, or a missing global, would show here.
    expect(frame.consoleErrors).toEqual([]);
  });

  it("offers every level the mailbox allows, each saying what it permits", async () => {
    const frame = await start({ getStatus: () => READY });
    const levels = frame.frame().getByRole("radiogroup", { name: "Permission" }).getByRole("radio");
    await expect.poll(() => levels.evaluateAll(nodes => nodes.map(node => node.id))).toEqual(["ol-access-read", "ol-access-draft", "ol-access-send"]);
    await choose(frame, "ol-access-send");
    await expect.poll(() => frame.text()).toContain("Mail can also be sent. Each message waits for your approval.");
    expect(await bound(frame)).toEqual({ access: "send" });
  });

  it("chooses a folder from a filtered list, with or without its subfolders", async () => {
    const frame = await start({ getStatus: () => READY, listFolders: () => FOLDERS });
    await choose(frame, "ol-target-folder");
    await expect.poll(ready(frame)).toBe(false);
    expect(frame.callsOf("listFolders").map(call => call.args)).toEqual([[null]]);
    const search = frame.frame().getByRole("searchbox", { name: "Find a folder" });
    const rows = () => folderList(frame).locator("label").evaluateAll(nodes => nodes.map(node => node.innerText.replace(/\s+/g, " ").trim()));
    await search.pressSequentially("vend");
    // A match shows its path under its name.
    await expect.poll(rows).toEqual(["Vendors Inbox/Vendors"]);
    // Focus stays in the search box while the list re-renders under it.
    expect(await search.evaluate(node => node.matches(":focus"))).toBe(true);
    await search.fill("nothing");
    await frame.frame().getByText('No folders match "nothing".').waitFor();
    await search.press("Escape");
    await expect.poll(() => folderList(frame).getByRole("radio").count()).toBe(3);
    await folderList(frame).getByRole("radio", { name: "Inbox", exact: true }).check();
    await expect.poll(ready(frame)).toBe(true);
    await frame.frame().getByRole("checkbox", { name: "Include its 1 subfolder" }).uncheck();
    expect(await bound(frame)).toEqual({ access: "read", folder: { id: "AAMkInbox", subfolders: false } });
  });

  it("keeps the folder list scrolled where it was as choosing a folder re-renders it", async () => {
    // Enough folders that the list scrolls.
    const many: OutlookFolderList = {
      folders: Array.from({ length: 20 }, (_, index) => ({ id: `AAMk${index}`, name: `Folder ${index}`, path: `Folder ${index}`, depth: 0, kind: "folder", descendants: 0 })),
    };
    const frame = await start({ getStatus: () => READY, listFolders: () => many });
    await choose(frame, "ol-target-folder");
    const list = control(frame, "ol-folders");
    await list.waitFor();
    await list.evaluate(node => { node.scrollTop = 120; });
    expect(await list.evaluate(node => node.scrollTop)).toBe(120);
    // A row already in view, so choosing it needs no scrolling of its own.
    await folderList(frame).getByRole("radio", { name: "Folder 6" }).check();
    expect(await list.evaluate(node => node.scrollTop)).toBe(120);
    // Focus stays on the chosen radio across the re-render.
    expect(await control(frame, "ol-folder-AAMk6").evaluate(node => node.matches(":focus"))).toBe(true);
  });

  it("adds people from suggestions, typed addresses, domains and pastes, and refuses what isn't one", async () => {
    const frame = await start({
      getStatus: () => READY,
      searchPeople: () => [{ address: "sarah@contoso.com", name: "Sarah James" }],
    });
    await choose(frame, "ol-target-people");
    await expect.poll(ready(frame)).toBe(false);
    const input = frame.frame().getByRole("combobox", { name: "People and domains" });
    const error = frame.frame().locator("#ol-people-error");
    await input.pressSequentially("sar");
    // One lookup once typing pauses, not one per keystroke.
    await expect.poll(() => frame.callsOf("searchPeople").map(call => call.args)).toEqual([["sar"]]);
    await expect.poll(() => input.getAttribute("aria-activedescendant")).toBe("ol-person-0");
    expect(await input.getAttribute("aria-expanded")).toBe("true");
    await input.press("Enter");
    await expect.poll(() => chips(frame)).toEqual(["Sarah James"]);
    expect(await input.evaluate(node => node.matches(":focus"))).toBe(true);

    await input.fill("bob@contoso.com, fabrikam.com; ");
    await expect.poll(() => chips(frame)).toEqual(["Sarah James", "bob@contoso.com", "Anyone at fabrikam.com"]);

    await input.fill("bob@");
    await input.press("Enter");
    await expect.poll(() => error.textContent()).toBe(`"bob@" isn't an email address or a domain like @contoso.com.`);
    expect(await input.getAttribute("aria-invalid")).toBe("true");
    // A paste that is partly good adds what is, keeps the rest in the box, and still says what was wrong.
    await input.fill("ada@contoso.com, nope");
    await input.press("Enter");
    await expect.poll(() => chips(frame)).toContain("ada@contoso.com");
    expect(await input.inputValue()).toBe("nope");
    expect(await error.textContent()).toBe(`"nope" isn't an email address or a domain like @contoso.com.`);
    await frame.frame().getByRole("button", { name: "Remove ada@contoso.com" }).click();
    await input.fill("");
    await input.press("Backspace");
    await expect.poll(() => chips(frame)).toEqual(["Sarah James", "bob@contoso.com"]);
    await frame.frame().getByRole("button", { name: "Remove bob@contoso.com" }).click();
    await expect.poll(() => chips(frame)).toEqual(["Sarah James"]);
    expect(await bound(frame)).toEqual({ access: "read", senders: ["sarah@contoso.com"] });
  });

  it("opens a shared mailbox only once the gatekeeper has opened it, and says why it couldn't", async () => {
    const frame = await start({ getStatus: () => READY, listFolders: () => FOLDERS });
    await choose(frame, "ol-mailbox-shared");
    await expect.poll(ready(frame)).toBe(false);
    // Nothing of the user's own mailbox shows under a shared one that isn't open yet.
    expect(await control(frame, "ol-target-all").count()).toBe(0);
    const address = frame.frame().getByRole("textbox", { name: "Shared mailbox address" });
    const open = frame.frame().getByRole("button", { name: "Open" });
    const error = frame.frame().locator("#ol-shared-error");
    await address.fill("support");
    await open.click();
    await expect.poll(() => error.textContent()).toBe(`"support" isn't an email address. Enter one like support@contoso.com.`);
    expect(frame.callsOf("openSharedMailbox")).toHaveLength(0);

    await address.fill("Support@Contoso.com");
    await address.press("Enter");
    await frame.frame().getByRole("button", { name: "Opening…" }).waitFor();
    await vi.waitFor(() => expect(frame.waiting("openSharedMailbox")).toHaveLength(1));
    frame.waiting("openSharedMailbox")[0]!.reject("You haven't been given access to support@contoso.com.");
    await expect.poll(() => error.textContent()).toBe("You haven't been given access to support@contoso.com.");

    await open.click();
    await vi.waitFor(() => expect(frame.waiting("openSharedMailbox")).toHaveLength(1));
    frame.waiting("openSharedMailbox")[0]!.resolve({ address: "support@contoso.com", name: "Contoso Support" });
    await frame.frame().getByText("You have access").waitFor();
    expect(await frame.text()).toContain("Contoso Support support@contoso.com You have access");
    // The shared mailbox allows only reading, so the higher levels aren't offered.
    const levels = frame.frame().getByRole("radiogroup", { name: "Permission" }).getByRole("radio");
    expect(await levels.evaluateAll(nodes => nodes.map(node => node.id))).toEqual(["ol-access-read"]);
    expect(await frame.text()).toContain('For shared mailboxes, this connection allows up to "Read only".');
    await choose(frame, "ol-target-folder");
    await expect.poll(() => frame.callsOf("listFolders").map(call => call.args)).toEqual([["support@contoso.com"]]);
  });

  it("offers no shared mailbox when the grant can't open one, and says what would", async () => {
    const frame = await start({ getStatus: () => ({ ...READY, sharedLevels: [] }) });
    await control(frame, "ol-target-all").waitFor();
    expect(await control(frame, "ol-mailbox-mine").count()).toBe(0);
    expect(await control(frame, "ol-mailbox-shared").count()).toBe(0);
    expect(await control(frame, "ol-target-all").isChecked()).toBe(true);
    await expect.poll(ready(frame)).toBe(true);
    expect(await frame.text()).toContain("Shared mailboxes open through your own account, once an admin approves more Microsoft 365 permissions and you reconnect.");
  });

  it("asks for Outlook access from the click, then reads the status again", async () => {
    let status: OutlookConfiguratorStatus = { state: "needsAccess" };
    const frame = await start({ getStatus: () => status });
    await expect.poll(() => frame.text()).toContain("hasn't been allowed to open Outlook yet");
    await expect.poll(ready(frame)).toBe(false);
    status = READY;
    await frame.frame().getByRole("button", { name: "Allow access" }).click();
    await frame.frame().getByRole("radiogroup", { name: "What to connect" }).waitFor();
    expect((await frame.state()).ensured).toEqual([["https://outlook.office.com/*"]]);
  });

  it("collects the resource URL the gatekeeper writes", async () => {
    const frame = await start({ getStatus: () => READY });
    await choose(frame, "ol-access-draft");
    const url = frame.collect();
    await vi.waitFor(() => expect(frame.waiting("resourceUrlFor")).toHaveLength(1));
    const [resolving] = frame.waiting("resourceUrlFor");
    expect(resolving!.args).toEqual([{ access: "draft" }]);
    resolving!.resolve("https://outlook.office.com/mail/?access=draft");
    await expect(url).resolves.toEqual({ url: "https://outlook.office.com/mail/?access=draft" });
  });

  it("opens a binding being edited where it was, narrowed as it was", async () => {
    const frame = await start({
      getStatus: () => READY, listFolders: () => FOLDERS,
      locate: () => ({ access: "draft", folder: { id: "AAMkVendors", path: "Inbox/Vendors", subfolders: false } }),
    }, "https://outlook.office.com/mail/folder/AAMkVendors/?subfolders=0&access=draft");
    await control(frame, "ol-folder-AAMkVendors").waitFor();
    for (const id of ["ol-target-folder", "ol-folder-AAMkVendors", "ol-access-draft"]) {
      expect(await control(frame, id).isChecked(), id).toBe(true);
    }
    expect(await control(frame, "ol-subfolders").isChecked()).toBe(false);
    expect(await bound(frame)).toEqual({ access: "draft", folder: { id: "AAMkVendors", subfolders: false } });
  });

  it("says what failed and retries just that", async () => {
    let fail = true;
    const frame = await start({
      getStatus: () => READY,
      listFolders: () => {
        if (fail) throw new Error("Outlook didn't answer. Try again in a moment.");
        return FOLDERS;
      },
    });
    await choose(frame, "ol-target-folder");
    await expect.poll(() => frame.frame().getByRole("alert").textContent()).toBe("Outlook didn't answer. Try again in a moment.");
    fail = false;
    await frame.frame().getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => folderList(frame).getByRole("radio").count()).toBe(3);
    expect(frame.callsOf("listFolders")).toHaveLength(2);
  });
});
