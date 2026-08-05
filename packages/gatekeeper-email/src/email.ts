import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorIface,
  Gatekeeper,
  HookController,
  HookInitiator,
  HookTargetMetadata,
  ResourceDescription,
  ApprovalQueue,
  VendorDescription,
  GatekeeperConnectCallback,
  AccountDescription,
  SupportedResource,
  ResourceConfiguratorFrame,
  stripTrailingSlashes,
} from '@gadgets/workshop-shared/gatekeeper';
import {
  EmailSession,
  EmailHook,
  IncomingEmail,
  EmailAddress as EmailAddressType,
  EmailAttachment,
} from "./types";
import PostalMime from "postal-mime";
import type { Email } from "postal-mime";
import TYPES_CODE from "./types.txt";
import EMAIL_CONFIGURATOR_HTML from "./generated/email-configurator-ui.txt";
import type { EmailMailboxConfiguratorRpc } from "./configurator/email-configurator-types";
import EMAIL_LOGO_SVG from "./email-logo.svg";
import { obsContext } from "./observability.js";

const VENDOR_ID = "email";

const logger = obsContext.createLogger({
  component: "gatekeeper.email", vendorId: VENDOR_ID,
});

const NONCE_BYTES = 32;
const NONCE_LIFETIME_MS = 10 * 60 * 1000;  // 10 minutes

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  let encoder = new TextEncoder();
  let bufA = encoder.encode(a);
  let bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

// Declare optional environment variables here since they may be omitted from wrangler.jsonc.
type Env = Cloudflare.Env & {
  // Base URL (protocol+host+optional path) at which the default fetch handler is served. Should
  // NOT include a trailing slash. Omit for localhost dev server.
  BASE_URL?: string,
}

function getBaseUrl(env: Env) {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/email");
}

function getBasePath(env: Env) {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function getEmailMailboxResource(env: Env): SupportedResource {
  return {
    urlPattern: `${getBaseUrl(env)}/mailbox/:user`,
    title: "Email Mailbox",
    description: "Send and receive emails.",
  };
}

function getSupportedResourcesList(env: Env): SupportedResource[] {
  return [getEmailMailboxResource(env)];
}

const EMAIL_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(EMAIL_LOGO_SVG)}`;

function getEmailHost(env: Env) {
  // TODO: This is actually a lie, as email routing can be configured on an entirely different
  //   domain and forwarded to this worker. We only really care about the name before the `@` for
  //   routing purposes. At present the returned host isn't really used anywhere important so
  //   maybe we can get rid of this entirely, or maybe we should bring back the env var that
  //   specifies the default host.
  return new URL(getBaseUrl(env)).hostname;
}

function validateEmailName(value: string | undefined): { ok: true, emailName: string } | { ok: false, message: string } {
  let emailName = value?.trim().toLowerCase();
  if (!emailName) return { ok: false, message: "Choose an email address." };
  if (!/^[a-z0-9._+-]{1,64}$/.test(emailName)) {
    return { ok: false, message: "Use letters, numbers, dots, underscores, plus signs, or hyphens." };
  }
  if (emailName.startsWith(".") || emailName.endsWith(".") || emailName.includes("..")) {
    return { ok: false, message: "Email names cannot start or end with a dot or contain consecutive dots." };
  }
  return { ok: true, emailName };
}

const emailConfiguratorEnvs = new WeakMap<object, Env>();

// RPC interface exposed by Gatekeeper to the resource selection/configuration iframe.
@validateRpc()
class EmailMailboxConfiguratorUI extends RpcTarget implements EmailMailboxConfiguratorRpc {
  constructor(env: Env) {
    super();
    emailConfiguratorEnvs.set(this, env);
  }

  // Email mailbox resource URLs depend on Gatekeeper's configured BASE_URL,
  // so the iframe asks Gatekeeper to construct the URL.
  async resourceUrl(emailName: string | null | undefined): Promise<string> {
    let validated = validateEmailName(emailName ?? undefined);
    if (!validated.ok) throw new Error(validated.message);
    let env = emailConfiguratorEnvs.get(this);
    if (!env) throw new Error("Email configurator is not initialized.");
    return `${getBaseUrl(env)}/mailbox/${encodeURIComponent(validated.emailName)}`;
  }
}

// =======================================================================================

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to Cloudflare OS.
  </body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authorization Link Expired</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6; margin: 0 0 1.5rem 0;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #d97706; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;

// =======================================================================================
// Default export: fetch handler (for connectAccount flow) and email handler (for inbound).

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);
    let basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    let relPath = url.pathname.slice(basePath.length);
    let path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      // This is a connectAccount completion URL. Route to the UserAccount DO.
      let userObjectId = ctx.exports.UserAccount.idFromString(path[0]);
      let stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(userObjectId);
      if (!await stub.complete(path[1])) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      return new Response(SELF_CLOSING_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8"
        }
      });
    } else {
      return new Response("Not Found", { status: 404 });
    }
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    // Parse the recipient address to extract the local part (username).
    let toAddress = message.to;
    let atIndex = toAddress.indexOf("@");
    if (atIndex < 0) {
      message.setReject("Invalid recipient address");
      return;
    }
    let name = toAddress.slice(0, atIndex);

    // Route to the EmailAddress DO for this username.
    let stub: DurableObjectStub<EmailAddress> =
        ctx.exports.EmailAddress.getByName(name);

    // Parse the email using postal-mime.
    let parsed: Email = await PostalMime.parse(message.raw);

    // Build the structured IncomingEmail.
    let from: EmailAddressType = parsed.from
        ? { name: parsed.from.name || "", address: parsed.from.address || "" }
        : { name: "", address: message.from };

    let to: EmailAddressType[] = (parsed.to || []).map(addr => ({
      name: addr.name || "",
      address: addr.address || "",
    }));

    let cc: EmailAddressType[] = (parsed.cc || []).map(addr => ({
      name: addr.name || "",
      address: addr.address || "",
    }));

    let attachments: EmailAttachment[] = (parsed.attachments || []).map(att => ({
      filename: att.filename || null,
      mimeType: att.mimeType,
      disposition: att.disposition || null,
      content: att.content as ArrayBuffer,
    }));

    let incomingEmail: IncomingEmail = {
      from,
      to,
      cc,
      subject: parsed.subject || "",
      date: parsed.date || new Date().toISOString(),
      text: parsed.text || null,
      html: parsed.html || null,
      attachments,
    };

    try {
      await stub.receiveEmail(incomingEmail);
    } catch (err) {
      logger.error("email delivery failed", {
        event: "email.delivery.failed", error: err,
      });
      // If no hook is configured or delivery fails, reject the email.
      message.setReject("Delivery failed: " + err);
    }
  }
};

// =======================================================================================
// Top-level API exposed to the Workshop.

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  status() {
    return "Email Gatekeeper";
  }

  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Email",
      url: getBaseUrl(this.env),
      logo: { url: EMAIL_LOGO_URL },
      color: "#fff5df",
      tagline: "Trigger gadgets from incoming email",
      description:
          "Give Cloudflare OS an email address it can receive messages from. Useful for triage " +
          "agents, ticket-from-email workflows, or anything driven by mail.",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{url: string}> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let nonce = generateNonce();

    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, nonce);

    return {
      url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${nonce}`
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return getSupportedResourcesList(this.env);
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// =======================================================================================
// UserAccount DO: handles the connectAccount flow and tracks claimed email addresses.
//
// Since email doesn't require OAuth, the connect flow just stores the callback and completes
// immediately when the user visits the connection URL. After completion, the DO persists to
// track which email addresses have been claimed by this user account.

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string) {
    // Self-delete after 1 hour if never completed.
    this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);

    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put("nonce", { value: nonce, expiresAt: Date.now() + NONCE_LIFETIME_MS });
  }

  // Returns false if the nonce is invalid or expired.
  async complete(nonce: string): Promise<boolean> {
    let stored = this.ctx.storage.kv.get<{value: string, expiresAt: number}>("nonce");
    if (!stored || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, nonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      return false;
    }

    let props: GatekeeperUserImplProps = {
      userAccountId: this.ctx.id.toString(),
    };
    await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));

    // Clean up the callback, but keep the DO alive to track claimed email addresses.
    this.ctx.storage.deleteAlarm();
    this.ctx.storage.kv.delete("callback");

    return true;
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    // Timed out without completion -- clean up.
    this.ctx.storage.deleteAll();
  }

  async addEmail(emailName: string): Promise<void> {
    this.ctx.storage.kv.put(`email:${emailName}`, true);
  }

  async getEmails(): Promise<string[]> {
    let entries = this.ctx.storage.kv.list({ prefix: "email:" });
    return [...entries].map(([key]) => key.slice("email:".length));
  }
}

// =======================================================================================

type GatekeeperUserImplProps = {
  userAccountId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Email Receiver",
      avatar: { url: "" },  // TODO: email icon
    };
  }

  // This gatekeeper does not provide sign-in.
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return getSupportedResourcesList(this.env);
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    let resource = getEmailMailboxResource(this.env);
    if (resourceUrlPattern !== resource.urlPattern) {
      throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: EMAIL_CONFIGURATOR_HTML,
      ui: new RpcStub(new EmailMailboxConfiguratorUI(this.env)),
    };
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    // Parse the URL to extract the email name.
    // URL format: <BASE_URL>/mailbox/<name>
    // Strip the base path prefix before checking for /mailbox/.
    let parsed = new URL(url);
    let baseUrl = new URL(getBaseUrl(this.env));
    if (parsed.origin !== baseUrl.origin) {
      throw new Error(`URL origin ${parsed.origin} does not match email gatekeeper origin ${baseUrl.origin}`);
    }
    let basePath = getBasePath(this.env);
    if (!parsed.pathname.startsWith(basePath + "/") && parsed.pathname !== basePath) {
      throw new Error(`URL path ${parsed.pathname} does not match BASE_URL path ${basePath}`);
    }
    let relPath = parsed.pathname.slice(basePath.length);
    let emailNameSegment = relPath.slice("/mailbox/".length);
    if (!relPath.startsWith("/mailbox/") || !emailNameSegment) {
      throw new Error(`Invalid email URL: ${url}`);
    }

    let decodedEmailName: string;
    try {
      decodedEmailName = decodeURIComponent(emailNameSegment);
    } catch {
      throw new Error(`Invalid email URL encoding: ${url}`);
    }

    let validated = validateEmailName(decodedEmailName);
    if (!validated.ok) throw new Error(validated.message);
    if (emailNameSegment !== encodeURIComponent(validated.emailName)) {
      throw new Error(`Email URL is not canonical: ${url}`);
    }
    let emailName = validated.emailName;

    let userAccountId = this.ctx.props.userAccountId;
    let userAccountDOId = this.ctx.exports.UserAccount.idFromString(userAccountId);
    let userAccount = this.ctx.exports.UserAccount.get(userAccountDOId);
    let emailAddress = this.ctx.exports.EmailAddress.getByName(emailName);

    // Claim the email address. EmailAddress is the source of truth for ownership, so we
    // check/claim there first, then record the association in UserAccount.
    let newlyClaimed = await emailAddress.claim(userAccountId);
    try {
      await userAccount.addEmail(emailName);
    } catch (error) {
      if (newlyClaimed) await emailAddress.releaseClaimAndHook(userAccountId);
      throw error;
    }

    let props: EmailGatekeeperImplProps = { emailName, userAccountId };
    return {class: this.ctx.exports.EmailGatekeeperImpl({ props }), resource: getEmailMailboxResource(this.env)};
  }

  async revoke(): Promise<void> {
    // Disconnect all hooks, but do NOT release address claims -- they are permanent.
    let userAccountId = this.ctx.props.userAccountId;
    let userAccountDOId = this.ctx.exports.UserAccount.idFromString(userAccountId);
    let emails = await this.ctx.exports.UserAccount.get(userAccountDOId).getEmails();
    await Promise.all(emails.map(emailName =>
      this.ctx.exports.EmailAddress.getByName(emailName).setHook(null, userAccountId)
    ));
  }

  async reconnect(): Promise<{url: string}> {
    // Email connections do not use OAuth and never expire.
    throw new Error("Email connections do not require re-authentication.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }

  // Mint a verifier representing this account. The email gatekeeper uses the "low-stakes" observer
  // strategy (see EmailGatekeeperImpl.addObserver): a mailbox here is a fresh address minted on the
  // deployment's own domain specifically for the Gadget, so the Gadget's collaborators are the
  // intended audience. The verifier carries no identity and is never consulted — but the overseer
  // mints one on every open, so it must exist and not throw.
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.EmailVerifier({});
  }
}

// A trivial verifier since the email gatekeeper's observer strategy is low-stakes.
@validateRpc()
export class EmailVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// =======================================================================================

@validateRpc()
class EmailSessionImpl extends RpcTarget implements EmailSession {
  #emailName: string;
  #emailHost: string;
  #ctx: DurableObjectState<EmailGatekeeperImplProps>;
  #approvalQueue: RpcStub<ApprovalQueue>;

  constructor(emailName: string, emailHost: string,
      ctx: DurableObjectState<EmailGatekeeperImplProps>,
      approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#emailName = emailName;
    this.#emailHost = emailHost;
    this.#ctx = ctx;
    this.#approvalQueue = approvalQueue;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  async getAddress(): Promise<string> {
    return `${this.#emailName}@${this.#emailHost}`;
  }

  async subscribe(callback: RpcStub<EmailHookTarget>): Promise<void> {
    // Construct the HookController at bind time, so its props carry the specifics of this
    // registration (here, just the gatekeeper props). The controller needs no other state.
    let hookController: Fetcher<HookController<EmailHookTarget>> =
        this.#ctx.exports.EmailHookControllerImpl({props: this.#ctx.props});

    // @ts-ignore TS insists hookController is the wrong type... why? It looks identical to me.
    await this.#approvalQueue.bindHook(hookController, callback, {
      title: `Receive email`,
      description: `Receive emails sent to ${this.#emailName}@${this.#emailHost}`,
    });
  }
}

// =======================================================================================

type EmailGatekeeperImplProps = {
  emailName: string;
  userAccountId: string;
};

// Intersection type: EmailHook for the hook-specific methods, RpcTarget to satisfy the
// HookController/HookInitiator generic constraint (Hook extends RpcTarget).
type EmailHookTarget = RpcTarget & EmailHook;

@validateRpc()
export class EmailGatekeeperImpl extends DurableObject<Env, EmailGatekeeperImplProps>
    implements Gatekeeper<EmailSession> {

  async describe(): Promise<ResourceDescription> {
    let emailName = this.ctx.props.emailName;
    let host = getEmailHost(this.env);
    return {
      url: `${getBaseUrl(this.env)}/mailbox/${encodeURIComponent(emailName)}`,
      title: `${emailName}@${host}`,
      snippet: `Receive emails sent to ${emailName}@${host}`,
      suggestedBindingName: "EMAIL",
      tsType: "EmailSession",
      hookTsType: "EmailHook",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<EmailSession> {
    let emailName = this.ctx.props.emailName;
    let host = getEmailHost(this.env);
    return new EmailSessionImpl(emailName, host, this.ctx, approvalQueue.dup());
  }

  // ---------------------------------------------------------------------------

  async applyAction(action: number): Promise<void> {
    throw new Error("Email gatekeeper has no actions");
  }

  async rejectAction(action: number): Promise<void> {
    // No actions to reject.
  }

  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("Email gatekeeper has no actions to revert");
  }

  // Observer tracking: the email gatekeeper uses the "low-stakes" strategy. Each mailbox is a fresh
  // address minted on the deployment's own domain for this Gadget; there is no external ACL and no
  // other party who "independently has access" to that inbox, so the Gadget's own collaborators are
  // the natural audience. Any collaborator may observe: addObserver/removeObserver are no-ops and we
  // never set excludeObservers on observations.
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
}

@validateRpc()
export class EmailHookControllerImpl extends WorkerEntrypoint<Env, EmailGatekeeperImplProps>
    implements HookController<EmailHookTarget> {
  // `_target` is unused -- email doesn't display its hooks -- but must be declared, since RPC
  // argument validation is generated from this signature and would reject the extra argument.
  async enable(initiator: Fetcher<HookInitiator<EmailHookTarget>>,
               _target: HookTargetMetadata): Promise<void> {
    return this.#setHook(initiator);
  }

  disable(): Promise<void> {
    return this.#setHook(null);
  }

  async #setHook(initiator: Fetcher<HookInitiator<EmailHookTarget>> | null) {
    // Forward the hook initiator to the EmailAddress DO for this email name.
    let emailName = this.ctx.props.emailName;
    let userAccountId = this.ctx.props.userAccountId;
    let stub: DurableObjectStub<EmailAddress> =
        this.ctx.exports.EmailAddress.getByName(emailName);
    await stub.setHook(initiator, userAccountId);
  }
}

// =======================================================================================
// EmailAddress DO: per-address durable object.
//
// Named by the local part of the email address (the part before @).
// Stores the hook Fetcher and dispatches inbound emails to it.

export class EmailAddress extends DurableObject<Env> {
  // Claim this email address for a user account. The first caller to claim an address becomes
  // its permanent owner. Subsequent calls from the same owner are idempotent. Calls from a
  // different owner are rejected.
  async claim(userAccountId: string): Promise<boolean> {
    let owner = this.ctx.storage.kv.get<string>("owner");
    if (owner && owner !== userAccountId) {
      throw new Error("This email address is claimed by another user");
    }
    if (!owner) {
      this.ctx.storage.kv.put("owner", userAccountId);
      return true;
    }
    return false;
  }

  async releaseClaimAndHook(userAccountId: string): Promise<void> {
    let owner = this.ctx.storage.kv.get<string>("owner");
    if (owner === userAccountId) {
      this.ctx.storage.kv.delete("owner");
      this.ctx.storage.kv.delete("hook");
    }
  }

  async setHook(
      hook: Fetcher<HookInitiator<EmailHookTarget>> | null,
      userAccountId: string): Promise<void> {
    let owner = this.ctx.storage.kv.get<string>("owner");
    if (owner !== userAccountId) {
      throw new Error("This email address is not owned by this user account");
    }

    if (hook) {
      this.ctx.storage.kv.put("hook", hook);
    } else {
      this.ctx.storage.kv.delete("hook");
    }
  }

  async receiveEmail(email: IncomingEmail): Promise<void> {
    let hookInitiator =
        this.ctx.storage.kv.get<Fetcher<HookInitiator<EmailHookTarget>>>("hook");
    if (!hookInitiator) {
      throw new Error("No hook configured for this email address");
    }

    // The stored Fetcher is a HookInitiator. Call startHook() to get the actual hook entrypoint
    // and an ApprovalQueue for logging observations. Use `using` to dispose the result (and its
    // contained stubs, including approvalQueue) at end of scope.
    // @ts-ignore TODO: TS doesn't understand that the returned promise is disposable?
    using startHookResult = hookInitiator.startHook();

    // Pipeline: access approvalQueue on the not-yet-resolved promise and call through it.
    let sender = email.from.name
        ? `${email.from.name} <${email.from.address}>`
        : email.from.address;
    await startHookResult.approvalQueue.authorizeObservation({
      title: `Email from ${email.from.address}: ${email.subject}`,
      description: `Received email from ${sender}\n\n`
          + `**Subject:** ${email.subject}\n`
          + `**Date:** ${email.date}\n`
          + (email.to.length > 0
              ? `**To:** ${email.to.map(a => a.address).join(", ")}\n`
              : "")
          + (email.cc.length > 0
              ? `**CC:** ${email.cc.map(a => a.address).join(", ")}\n`
              : ""),
    });

    // Deliver the email to the gadget's hook entrypoint.
    await startHookResult.callback.receiveEmail(email);
  }
}
