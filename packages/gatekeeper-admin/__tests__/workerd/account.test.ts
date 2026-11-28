// The vendor, the connect link and the account: who may connect, what a connection stores, and
// what removing the account does.

import { runDurableObjectAlarm } from "cloudflare:test";
import { DurableObject, env } from "cloudflare:workers";
import { INVALID_LINK_HTML } from "@gadgets/gatekeeper-kit/connect-pages";
import {
  matchesResourceUrlPattern, type GatekeeperConnectCallback,
} from "@gadgets/workshop-shared/gatekeeper";
import { ADMIN_ACCESS_ERROR_CODES, createAdminAccessError } from "@gadgets/workshop-shared/api";
import { beforeEach, describe, expect, it } from "vitest";
import * as WORKER from "../../src/admin.js";
import { GatekeeperVendor } from "../../src/admin.js";
import WRANGLER_CONFIG from "../../wrangler.jsonc?raw";
import {
  Queue, accountOf, connectAccount, exported, openSession, rejection, startConnection, visit,
  withFacet,
} from "./harness.js";
import { workshop } from "./worker.js";

/** The account's one resource, as the Workshop and a workspace's owner name it. */
const DEPLOYMENT_URL = "admin://deployment";
const NOT_CONNECTED = "This deployment admin account is no longer connected.";
/** What a call is refused with once the account's user is no deployment admin. */
const NOT_ADMIN = createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.notAdmin).message;

const vendor = () => exported().GatekeeperVendor({});

/** What a read through a connection of the account `userObjectId` answers, or its refusal. */
const read = (userObjectId: string) => withFacet(userObjectId, async (facet) => {
  using session = await openSession(facet, new Queue());
  return await session.listUsers!().catch((error: Error) => error.message);
});

beforeEach(() => workshop.reset());

describe("the vendor", () => {
  it("is an ordinary connect-flow gatekeeper, for deployment admins", async () => {
    const description = await vendor().describe();
    expect(description.displayName).toBe("Deployment admin");
    expect(description).not.toHaveProperty("autoProvisionsAccount");
    expect(description).not.toHaveProperty("providesAuth");
    expect(description.description).toMatch(/^For deployment admins only\./);
    expect("createAccount" in GatekeeperVendor.prototype).toBe(false);
    expect("createResource" in GatekeeperVendor.prototype).toBe(false);
  });

  it("offers its one resource to a deployment admin, and nothing to anyone else", async () => {
    const offered = await vendor().getSupportedResources({ userId: "ada", isAdmin: true });
    expect(offered.map((resource) => [resource.id, resource.urlPattern]))
        .toEqual([["deployment", DEPLOYMENT_URL]]);
    expect(offered[0]).not.toHaveProperty("creatable");
    for (const options of [undefined, {}, { userId: "bob" }, { userId: "bob", isAdmin: false }]) {
      expect(await vendor().getSupportedResources(options)).toEqual([]);
    }
  });

  it("serves the binding's declarations", async () => {
    const types = await vendor().getTypeScriptTypes();
    expect(types).toMatch(/^export interface AdminApi \{$/m);
    expect(types).toContain("export interface AdminBinding extends AdminApi");
  });
});

describe("connecting", () => {
  it("is refused without the Admin API the Workshop hands a deployment admin", async () => {
    const callback = exported().TestConnectCallback({ props: { label: "bob" } }) as unknown as
        Fetcher<GatekeeperConnectCallback>;
    for (const options of [undefined, {}, { resourceTypeIds: ["deployment"] }]) {
      expect((await rejection(vendor().connectAccount(callback, options))).message)
          .toBe("Only a deployment admin can connect the admin gatekeeper.");
    }
    expect(workshop.completed).toEqual([]);
  });

  it("completes when its link is visited, once, and hands the popup back to the Workshop", async () => {
    workshop.admins.add("ada");
    const { url, userObjectId } = await startConnection("ada");
    expect(url).toMatch(/^http:\/\/localhost:8787\/gatekeeper\/admin\/[0-9a-f]{64}\/[0-9a-f]{64}$/);
    // Nothing is connected until the link is visited.
    expect(workshop.completed).toEqual([]);
    expect(await read(userObjectId)).toBe(NOT_CONNECTED);

    const page = await visit(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('"ticket-ada"');
    expect(html).toContain("https://workshop.example");
    expect(workshop.completed).toEqual(["ada"]);
    expect(await read(userObjectId)).toEqual({ answered: "listUsers" });

    // The link is spent: the Workshop is told once.
    expect(await (await visit(url)).text()).toBe(INVALID_LINK_HTML);
    expect(workshop.completed).toEqual(["ada"]);
  });

  it("answers a link that names no connection as an invalid one", async () => {
    workshop.admins.add("ada");
    const { url, userObjectId } = await startConnection("ada");
    const base = url.slice(0, url.lastIndexOf("/") - 64);
    const other = env.USER_ACCOUNT.newUniqueId().toString();
    for (const link of [
      `${base}${userObjectId}/${"0".repeat(64)}`,
      `${base}${other}/${url.slice(-64)}`,
      `${base}${"z".repeat(64)}/${url.slice(-64)}`,
    ]) {
      expect(await (await visit(link)).text(), link).toBe(INVALID_LINK_HTML);
    }
    expect((await visit(`${base}${userObjectId}`)).status).toBe(404);
    // A link under another prefix is answered, not thrown: its path holds the nonce.
    expect((await visit(url.replace("/gatekeeper/admin/", "/elsewhere/"))).status).toBe(404);
    expect((await visit(new Request(url, { method: "POST" }) as never)).status).toBe(404);
    expect(workshop.completed).toEqual([]);
    // A wrong nonce spends nothing.
    expect(await (await visit(url)).text()).toContain('"ticket-ada"');
  });

  it("clears a connection whose link was never visited", async () => {
    workshop.admins.add("ada");
    const { url, userObjectId } = await startConnection("ada");
    const account = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
    expect(await runDurableObjectAlarm(account)).toBe(true);
    expect(await (await visit(url)).text()).toBe(INVALID_LINK_HTML);
    expect(workshop.completed).toEqual([]);
  });

  it("keeps a connected account past the alarm of its connect flow", async () => {
    const userObjectId = await connectAccount("ada");
    const account = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
    await runDurableObjectAlarm(account);
    expect(await read(userObjectId)).toEqual({ answered: "listUsers" });
  });
});

describe("the account", () => {
  it("declares no singleton and no UI, so it is injected into no workspace", async () => {
    const description = await accountOf(await connectAccount("ada")).describe();
    expect(description.displayName).toBe("Deployment admin");
    // One identity per user, the deployment's host, so a second connect is not a second account.
    expect(description.uniqueName).toBe("localhost:8787");
    expect(description).not.toHaveProperty("singleton");
    expect(description).not.toHaveProperty("providesUi");
  });

  it("offers the one resource, and gives its class for that URL alone", async () => {
    const account = accountOf(await connectAccount("ada"));
    const resources = await account.getSupportedResources();
    expect(resources.map((resource) => [resource.id, resource.urlPattern]))
        .toEqual([["deployment", DEPLOYMENT_URL]]);
    expect(matchesResourceUrlPattern(resources[0]!.urlPattern, DEPLOYMENT_URL)).toBe(true);

    const found = await account.getGatekeeperClassFor(DEPLOYMENT_URL);
    expect(found.resource.urlPattern).toBe(DEPLOYMENT_URL);
    for (const url of ["admin://deployment/", "admin://other", "https://example.com/"]) {
      expect((await rejection(account.getGatekeeperClassFor(url))).message, url)
          .toBe("The admin gatekeeper has one resource, admin://deployment.");
    }
  });

  it("adds the resource through a frame with nothing to choose", async () => {
    const account = accountOf(await connectAccount("ada"));
    const frame = await account.startResourceConfigurator("deployment");
    expect(frame.iframeHtml).toContain("only a deployment admin can connect");
    const ui = frame.ui as unknown as { resourceUrl(): Promise<string> };
    expect(await ui.resourceUrl()).toBe(DEPLOYMENT_URL);
    // An older Workshop names the type by its exact pattern.
    const legacy = await account.startResourceConfigurator(DEPLOYMENT_URL);
    expect(legacy.iframeHtml).toBe(frame.iframeHtml);
    for (const type of ["https://*", "other"]) {
      expect((await rejection(account.startResourceConfigurator(type))).message, type)
          .toBe("The admin gatekeeper has one resource, admin://deployment.");
    }
  });

  it("has no scopes to grant and nothing to renew", async () => {
    const account = accountOf(await connectAccount("ada"));
    await expect(account.ensureResources(["deployment"])).resolves.toEqual({});
    await expect(account.getAuthenticatedEmail()).resolves.toBeNull();
    expect((await rejection(account.reconnect())).message).toMatch(/no credentials to renew/);
    expect((await rejection(account.commitReconnect("stage"))).message).toMatch(/no credentials to renew/);
  });

  it("answers as its own user stands with the deployment, each time it is asked", async () => {
    const userObjectId = await connectAccount("ada");
    expect(await read(userObjectId)).toEqual({ answered: "listUsers" });

    workshop.admins.delete("ada");
    expect(await read(userObjectId)).toBe(NOT_ADMIN);

    workshop.admins.add("ada");
    expect(await read(userObjectId)).toEqual({ answered: "listUsers" });
  });

  it("offers and binds nothing while its user is no deployment admin, and stays to be used again", async () => {
    const account = accountOf(await connectAccount("ada"));
    workshop.admins.delete("ada");
    expect(await account.getSupportedResources()).toEqual([]);
    expect((await rejection(account.getGatekeeperClassFor(DEPLOYMENT_URL))).message).toBe(NOT_ADMIN);
    // The account itself is still there, to be removed or used once they are an admin again.
    expect((await account.describe()).displayName).toBe("Deployment admin");

    workshop.admins.add("ada");
    expect(await account.getSupportedResources()).toHaveLength(1);
    expect((await account.getGatekeeperClassFor(DEPLOYMENT_URL)).resource.urlPattern)
        .toBe(DEPLOYMENT_URL);
  });

  it("refuses once it is removed while the Workshop is asked whether its user is an admin", async () => {
    const userObjectId = await connectAccount("ada");
    const account = () => env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
    // Removed from another request, while the account waits on the Workshop's answer.
    workshop.whileAsked = async () => {
      workshop.whileAsked = undefined;
      await account().revoke();
    };
    expect((await rejection(account().isAdmin())).message).toBe(NOT_CONNECTED);
  });

  it("ends every connection made with it when it is removed, and leaves the others", async () => {
    const [ada, grace] = [await connectAccount("ada"), await connectAccount("grace")];
    await accountOf(ada).revoke();

    expect(await read(ada)).toBe(NOT_CONNECTED);
    expect(await read(grace)).toEqual({ answered: "listUsers" });
    // The grant is gone: nothing was asked of the Workshop for the removed account.
    expect(workshop.log.filter((entry) => entry.startsWith("open "))).toEqual(["open grace"]);
  });
});

describe("the Worker", () => {
  // The runtime does not start a Worker whose entry module exports a value that is no handler,
  // such as a string constant. This pool loads the module without that check.
  it("exports classes and its handler, and nothing else", () => {
    const exportedValues = Object.entries(WORKER);
    expect(exportedValues.map(([name]) => name)).toContain("default");
    for (const [name, value] of exportedValues) {
      expect(typeof value, name).toBe(name === "default" ? "object" : "function");
    }
    expect(Object.keys(WORKER.default)).toEqual(["fetch"]);
  });

  // Wrangler makes a Durable Object of every class a migration names, bound or not, and the
  // runtime does not start a Worker that exports no such class.
  it("exports every Durable Object class its migrations name", () => {
    const config: { migrations: { new_sqlite_classes?: string[]; new_classes?: string[] }[] } =
        JSON.parse(WRANGLER_CONFIG.replace(/^\s*\/\/.*$/gm, ""));
    const migrated = config.migrations.flatMap(
        (migration) => [...(migration.new_sqlite_classes ?? []), ...(migration.new_classes ?? [])]);
    expect(migrated).toEqual(["AdminGatekeeperImpl", "UserAccount"]);
    const classes: Record<string, unknown> = WORKER;
    for (const name of migrated) {
      const exportedClass = classes[name] as { prototype?: unknown } | undefined;
      expect(exportedClass?.prototype, name).toBeInstanceOf(DurableObject);
    }
  });
});
