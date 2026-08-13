// A real gatekeeper Worker whose verification outcomes the tests decide.
//
// WHY THIS EXISTS. The overseer tests need a gatekeeper that will refuse to admit an observer on
// command. Every shipping public gatekeeper can do that only at a cost that would dominate the test:
// the OAuth ones need a whole vendor's auth surface mocked before an account exists at all, and the
// Context Library only refuses once an observation has been *recorded*, which takes a gadget read
// session (so a Worker Loader), a slash-command invocation, or an AI-chat catalog snapshot. It is also
// a singleton, so it can never produce the two simultaneously-failing bindings one of these cases
// needs.
//
// So the overseer's own logic -- collect every failure, re-prompt once, then name what failed -- is
// tested against this fixture, where an outcome is one HTTP call away. Realism about a *particular*
// vendor is a different question, answered the way a per-vendor suite answers it: run the real
// gatekeeper unmodified and mock the vendor's external surfaces through a NetworkInterceptor handler
// module. This file deliberately does not try to be that.
//
// Note what the fixture does NOT model: a settled denial ("you may not read this") and an operational
// failure ("the credential expired") reach the overseer identically, as a thrown error, and the
// overseer cannot tell them apart -- by design, since it treats every failure as repairable. So there
// is one control knob here, `allow`, and the reason string is what carries the distinction to the
// user. Tests exercise both narratives by choosing reason text.

import { DurableObject, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import type {
  AccountDescription, ActionKind, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback,
  GatekeeperUser, GatekeeperUserVerifier, ResourceDescription, ResourceConfiguratorFrame,
  SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";

// Nothing but classes and the default handler may be exported from a Worker entry module: workerd
// treats every named export as an entrypoint and rejects anything that isn't one.
const VENDOR_HOST = "gadgets-test.example";

const SUPPORTED_RESOURCES: SupportedResource[] = [{
  urlPattern: `https://${VENDOR_HOST}/things/*`,
  title: "Test Thing",
  description: "A resource that exists only so tests can bind something.",
}];

const TYPES_CODE = `
/** A stand-in resource. It has no operations; nothing here is ever called. */
interface TestThing {}
`;

// A 1x1 transparent GIF, so nothing here reaches for a network asset.
const AVATAR = {
  url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
};

// ---------------------------------------------------------------------------
// Control state.
//
// Keyed by account label, which is the identity the verifier reports and the same string the Workshop
// shows the user -- so a test that read a label off `description.uniqueName` can aim an outcome at it
// without having to learn any internal id.

type VerifyOutcome = { allow: true } | { allow: false; reason: string };

export class TestControl extends DurableObject<Cloudflare.Env> {
  setVerifyOutcome(label: string, outcome: VerifyOutcome): void {
    this.ctx.storage.kv.put(`outcome:${label}`, outcome);
  }

  getVerifyOutcome(label: string): VerifyOutcome {
    // Default to admitting: a collaborator's first open has to be able to succeed.
    return this.ctx.storage.kv.get<VerifyOutcome>(`outcome:${label}`) ?? { allow: true };
  }

  recordAmbientVerification(label: string): void {
    const key = `ambient-verifications:${label}`;
    this.ctx.storage.kv.put(key, (this.ctx.storage.kv.get<number>(key) ?? 0) + 1);
  }

  getAmbientVerificationCount(label: string): number {
    return this.ctx.storage.kv.get<number>(`ambient-verifications:${label}`) ?? 0;
  }
}

// ctx.exports is typed via the Cloudflare.GlobalProps declaration in env.d.ts, so loopback bindings
// here carry their real prop and return types with no casts.
function control(exports: Cloudflare.Exports): DurableObjectStub<TestControl> {
  return exports.TestControl.getByName("control");
}

// ---------------------------------------------------------------------------
// Vendor

type AccountProps = { label: string };
type BindingProps = AccountProps & { resourceUrl: string; ambient?: true };

export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Test Gatekeeper",
      url: `https://${VENDOR_HOST}`,
      logo: AVATAR,
      tagline: "A gatekeeper that exists only for integration tests.",
      // Accounts are minted on request with no auth flow, which is what keeps these tests about the
      // overseer rather than about somebody's OAuth dance.
      autoProvisionsAccount: true,
    };
  }

  /**
   * Reached via provisionAmbientAccount(). Each call mints a distinct account, so two users -- or two
   * concurrent tests -- never share one.
   */
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    const label = `test-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}@${VENDOR_HOST}`;
    return this.ctx.exports.TestAccount({ props: { label } });
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /**
   * Required by the interface but unreachable: autoProvisionsAccount means the Workshop mints
   * accounts through createAccount() and never offers a connect flow.
   */
  async connectAccount(_callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    throw new Error("The test gatekeeper auto-provisions accounts; it has no connect flow.");
  }
}

// ---------------------------------------------------------------------------
// Account

export class TestAccount
    extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: this.ctx.props.label.split("@")[0],
      // What the overseer names in a verification-failure message.
      uniqueName: this.ctx.props.label,
      avatar: AVATAR,
      singleton: { tsType: "TestThing" },
    };
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<TestSession>>> {
    return this.ctx.exports.TestGatekeeper({
      props: { label: this.ctx.props.label, resourceUrl: "test://ambient", ambient: true },
    });
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  /**
   * Bind a resource. The Workshop calls this when the owner pastes a URL; the returned class becomes
   * a Gatekeeper facet under that gadget's Overseer.
   */
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<TestSession>>;
    resource: SupportedResource;
  }> {
    const parsed = new URL(url);
    if (parsed.host !== VENDOR_HOST || !parsed.pathname.startsWith("/things/")) {
      throw new Error(`Not a test-gatekeeper resource URL: ${url}`);
    }
    return {
      class: this.ctx.exports.TestGatekeeper({
        props: { label: this.ctx.props.label, resourceUrl: url },
      }),
      resource: SUPPORTED_RESOURCES[0],
    };
  }

  /** The capability the overseer hands to addObserver() to say "this is the user asking". */
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.TestVerifier({ props: this.ctx.props });
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async revoke(): Promise<void> {}

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("The test gatekeeper has no resource configurator; bind a URL directly.");
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("The test gatekeeper has no credentials to reconnect.");
  }
}

/**
 * Reports which account is asking.
 *
 * `GatekeeperUserVerifier` has no methods of its own; the convention (see its declaration) is that a
 * gatekeeper adds a non-standard method and trusts the answer, because the overseer only ever hands a
 * verifier back to the vendor that minted it.
 */
export interface TestVerifierApi extends GatekeeperUserVerifier {
  identify(): Promise<string>;
}

export class TestVerifier
    extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements TestVerifierApi {
  async identify(): Promise<string> {
    return this.ctx.props.label;
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper (one per bound resource, running as a facet under the gadget's Overseer)

/** No operations: these tests never open a gadget's session, only verify observers. */
export type TestSession = Record<string, never>;

export class TestGatekeeper
    extends DurableObject<Cloudflare.Env, BindingProps> implements Gatekeeper<TestSession> {
  async describe(): Promise<ResourceDescription> {
    if (this.ctx.props.ambient) {
      return {
        url: this.ctx.props.resourceUrl,
        title: "Test Ambient",
        snippet: "An automatically-provided test capability.",
        suggestedBindingName: "TEST_AMBIENT",
        tsType: "TestThing",
      };
    }
    const name = decodeURIComponent(new URL(this.ctx.props.resourceUrl).pathname.split("/").pop()!);
    return {
      url: this.ctx.props.resourceUrl,
      // Distinct per binding, so a message covering two failing bindings names both.
      title: `Test Thing ${name}`,
      snippet: `The test resource ${name}.`,
      suggestedBindingName: "TEST_THING",
      tsType: "TestThing",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(_approvalQueue: RpcStub<ApprovalQueue>): Promise<TestSession> {
    return {};
  }

  /**
   * Admit an observer, or refuse on the test's instruction.
   *
   * Asks the verifier who it speaks for, then consults the control state for that account. Throwing
   * is how a gatekeeper reports "this user may not observe what the gadget has read", and it's the
   * behaviour the overseer's failure handling is built around.
   */
  async addObserver(id: string, user: Fetcher<TestVerifierApi>): Promise<void> {
    const label = await user.identify();
    if (this.ctx.props.ambient) {
      await control(this.ctx.exports).recordAmbientVerification(label);
      this.ctx.storage.kv.put(`observer:${id}`, label);
      return;
    }
    const outcome = await control(this.ctx.exports).getVerifyOutcome(label);
    if (!outcome.allow) throw new Error(outcome.reason);
    this.ctx.storage.kv.put(`observer:${id}`, label);
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(`observer:${id}`);
  }

  async applyAction(_action: number): Promise<void> {
    throw new Error("The test gatekeeper submits no actions.");
  }

  async rejectAction(_action: number): Promise<void> {}

  async revertAction(_action: number): Promise<void> {
    throw new Error("The test gatekeeper submits no actions.");
  }
}

// ---------------------------------------------------------------------------
// Control surface
//
// Plain HTTP on the worker's own fetch(), dispatched from tests with
// harness.fetchWorker("gatekeeper-test", ...). No env gating: this worker is never deployed.
//
// The bodies are checked rather than trusted. Not for safety -- the only callers are helpers in this
// package -- but for the failure mode: an unchecked misspelled field registers an outcome for the
// account named `undefined`, so the gatekeeper goes on admitting the account the test meant to fail
// and the test dies several steps later with an assertion that says nothing about the real cause.

/** A 400 whose body says which field was wrong, so a mistyped control call fails where it happens. */
function badRequest(problem: string): Response {
  return new Response(`Bad control request: ${problem}`, { status: 400 });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export default {
  async fetch(req: Request, _env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await req.json();
      } catch {
        return badRequest("the body is not JSON");
      }
      if (typeof body !== "object" || body === null) {
        return badRequest("the body is not a JSON object");
      }
    }

    // Set what addObserver() should do for one account.
    // Body: {"label": "...", "allow": false, "reason": "..."}
    if (url.pathname === "/control/verify-outcome" && req.method === "POST") {
      const { label, allow, reason } = body as Record<string, unknown>;
      if (!isNonEmptyString(label)) return badRequest("`label` must be a non-empty string");
      if (typeof allow !== "boolean") return badRequest("`allow` must be a boolean");
      if (reason !== undefined && typeof reason !== "string") {
        return badRequest("`reason` must be a string when present");
      }

      const outcome: VerifyOutcome = allow
        ? { allow: true }
        : { allow: false, reason: reason ?? "The test gatekeeper refused this account." };
      await control(ctx.exports).setVerifyOutcome(label, outcome);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/control/ambient-verification-count" && req.method === "POST") {
      const { label } = body as Record<string, unknown>;
      if (!isNonEmptyString(label)) return badRequest("`label` must be a non-empty string");
      return Response.json({ count: await control(ctx.exports).getAmbientVerificationCount(label) });
    }

    // Make this Worker issue a subrequest, so a test can prove that Worker-originated fetches really
    // do route through the interceptor rather than out to the internet.
    //
    // Reports the status rather than just succeeding or failing, because an intercepted-and-rejected
    // request does not reject here: the harness proxies outbound fetches and turns a proxy-side
    // failure into a synthetic 500.
    // Body: {"url": "..."} -> {"status": number} | {"error": string}
    if (url.pathname === "/control/fetch-probe" && req.method === "POST") {
      const { url: target } = body as Record<string, unknown>;
      if (!isNonEmptyString(target)) return badRequest("`url` must be a non-empty string");
      try {
        return Response.json({ status: (await fetch(target)).status });
      } catch (err) {
        return Response.json({ error: String(err) });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
