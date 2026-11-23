import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub } from "capnweb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubserviceCallInput } from "@gadgets/observability/metrics";
import type { ConnectedAccountsSubscriber } from "@gadgets/workshop-shared/api";
import type {
  GatekeeperUser, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { TimeoutError } from "../src/do-retry";
import { askVendor, DISCOVERY_TIMEOUT_MS } from "../src/gatekeeper-discovery";
import { UserDurableObject } from "../src/user";
import { AdminSettings } from "../src/admin-settings";
import type { AdminConfig } from "../src/storage-schema/admin-settings-storage";
import type { FakeGatekeeperAccount } from "./test-worker";

const { recorded } = vi.hoisted(() => ({ recorded: [] as SubserviceCallInput[] }));
vi.mock(import("@gadgets/observability/metrics"), async original => ({
  ...await original(),
  recordSubserviceCall: (call: SubserviceCallInput) => { recorded.push(call); },
}));

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const POINT = {
  source: "workshop.gatekeeper.discovery", service: "gatekeeper.example", operation: "discovery",
  detail: "list",
};

const DESCRIPTION: VendorDescription = { displayName: "Example", url: "https://example.com" };
const RESOURCE: SupportedResource = {
  urlPattern: "https://example.com/doc/:id", title: "Document", description: "A document",
};
const never = () => new Promise<never>(() => {});

// What a test reaches into the user DO for.
type UserInternals = UserDurableObject & {
  storage: {
    connectedAccounts: { put(record: unknown): void };
    nextAccountId: { put(n: number): void };
  };
  ctx: DurableObjectState & {
    exports: {
      FakeGatekeeperAccount(options: { props: { name: string } }): Fetcher<FakeGatekeeperAccount>;
    };
  };
};

let counter = 0;

// A user DO and an AdminSettings DO whose bound gatekeepers are `vendors`, by vendor id, under
// the admin config `config`.
function deployment(vendors: Record<string, object>, config: Partial<AdminConfig> = {}) {
  const vars = {
    ...env,
    ...Object.fromEntries(Object.entries(vendors).map(([id, vendor]) =>
        [`GATEKEEPER_${id.toUpperCase()}`, vendor])),
    BLUEPRINTS: { get: async () => JSON.stringify(config), put: async () => {} },
  } as unknown as Cloudflare.Env;
  const stub = env.TEST_USER.getByName(`gatekeeper-discovery-${++counter}`);
  return {
    inUser: <T>(f: (user: UserInternals) => Promise<T>) => runInDurableObject(stub,
        (_host, state) => f(new UserDurableObject(state, vars) as UserInternals)),
    inAdmin: <T>(f: (admin: AdminSettings) => Promise<T>) => runInDurableObject(stub,
        (_host, state) => f(new AdminSettings(state, vars))),
  };
}

// Waits out the discovery bound under fake timers, then expects `work` to have settled.
async function withinBound<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  void work.finally(() => { settled = true; }).catch(() => {});
  await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS);
  expect(settled).toBe(true);
  return work;
}

beforeEach(() => {
  recorded.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("askVendor", () => {
  it("answers as the gatekeeper does and records a success with its duration", async () => {
    let asking = askVendor("list", "example", async () => {
      await new Promise(resolve => setTimeout(resolve, 250));
      return "answer";
    });
    await vi.advanceTimersByTimeAsync(250);
    await expect(asking).resolves.toBe("answer");
    expect(recorded).toEqual([{ ...POINT, outcome: "success", durationMs: 250 }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rethrows what the gatekeeper threw and records the reason threw", async () => {
    let error = new Error("directory throttled");
    await expect(askVendor("list", "example", async () => { throw error; })).rejects.toBe(error);
    expect(recorded).toEqual([{ ...POINT, outcome: "error", reason: "threw", durationMs: 0 }]);
  });

  it("counts a synchronous throw as threw, not as an unbounded wait", async () => {
    let error = new Error("no such method");
    await expect(askVendor("filter", "example", () => { throw error; })).rejects.toBe(error);
    expect(recorded).toEqual(
        [{ ...POINT, detail: "filter", outcome: "error", reason: "threw", durationMs: 0 }]);
  });

  it("gives up on a gatekeeper that never answers once the bound passes, recording timeout", async () => {
    let outcome: unknown;
    let asking = askVendor("ambient", "example", never).catch(err => { outcome = err; });
    await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined();
    expect(recorded).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await asking;
    expect(outcome).toBeInstanceOf(TimeoutError);
    expect(recorded).toEqual([{
      ...POINT, detail: "ambient", outcome: "error", reason: "timeout",
      durationMs: DISCOVERY_TIMEOUT_MS,
    }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Each fan-out over the bound gatekeepers, with one that never answers: it returns within the
// discovery bound, with the others as they would be, and the stalled one as its failure shape.
describe("discovery fan-outs with a gatekeeper that never answers", () => {
  const timedOut = (detail: string, service = "gatekeeper.stalled") =>
      ({ ...POINT, service, detail, outcome: "error", reason: "timeout" });

  it("lists it as unavailable in listGatekeeperVendors", async () => {
    const { inUser } = deployment({
      example: { describe: async () => DESCRIPTION, getSupportedResources: async () => [RESOURCE] },
      stalled: { describe: async () => DESCRIPTION, getSupportedResources: never },
    });
    const vendors = await inUser(user => withinBound(user.listGatekeeperVendors()));
    expect(vendors).toMatchObject([
      { id: "example", supportedResources: [RESOURCE] },
      { id: "stalled", unavailable: true },
    ]);
    expect(recorded).toContainEqual(expect.objectContaining(timedOut("list")));
  });

  it("filters it out of a vendor list filtered by resource URL", async () => {
    const { inUser } = deployment({
      example: { describe: async () => DESCRIPTION, getSupportedResources: async () => [RESOURCE] },
      stalled: { describe: async () => DESCRIPTION, getSupportedResources: never },
    });
    const vendors = await inUser(user => withinBound(
        user.listGatekeeperVendors({ resourceUrl: "https://example.com/doc/1" })));
    expect(vendors).toMatchObject([{ id: "example" }]);
    expect(recorded).toContainEqual(expect.objectContaining(timedOut("filter")));
  });

  it("leaves it out of the ambient gatekeepers the user can add", async () => {
    const ambient = { ...DESCRIPTION, autoProvisionsAccount: true };
    const { inUser } = deployment({
      example: { describe: async () => ambient, getSupportedResources: async () => [] },
      stalled: { describe: never, getSupportedResources: async () => [] },
    });
    const addable = await inUser(user => withinBound(user.listAddableGatekeepers()));
    expect(addable).toEqual([{ id: "example", description: ambient, supportedResources: [] }]);
    expect(recorded).toContainEqual(expect.objectContaining(timedOut("ambient")));
  });

  it("skips its accounts in a connected-accounts subscription", async () => {
    const { inUser } = deployment({
      example: { describe: async () => DESCRIPTION, getSupportedResources: async () => [] },
      stalled: { describe: never, getSupportedResources: async () => [] },
    });
    const added: string[] = [];
    const subscriber = new RpcStub<ConnectedAccountsSubscriber>({
      add: async (_id, _description, _vendor, _resources, _valid, vendorId) => {
        added.push(vendorId);
      },
      remove: async () => {},
      ready: async () => {},
    });
    await inUser(async user => {
      let id = 0;
      for (const vendorId of ["example", "stalled"]) {
        user.storage.connectedAccounts.put({
          id: id++, vendorId, description: { displayName: vendorId },
          account: user.ctx.exports.FakeGatekeeperAccount({ props: { name: `discovery-${vendorId}` } }) as
              unknown as Fetcher<GatekeeperUser>,
        });
      }
      user.storage.nextAccountId.put(id);
      using _subscription = await withinBound(user.subscribeConnectedAccounts(subscriber));
    });
    expect(added).toEqual(["example"]);
    expect(recorded).toContainEqual(expect.objectContaining(timedOut("connections")));
  });

  it("lists its resource config as unreadable in the admin settings", async () => {
    const { inAdmin } = deployment({
      example: { describe: async () => DESCRIPTION, getSupportedResources: async () => [RESOURCE] },
      stalled: { describe: async () => DESCRIPTION, getSupportedResources: never },
    });
    const settings = await inAdmin(admin => withinBound(admin.getSettings("admin")));
    expect(settings.resourceVendors.map(vendor => vendor.vendorId)).toEqual(["example"]);
    expect(recorded).toContainEqual(expect.objectContaining(timedOut("admin")));
  });
});
