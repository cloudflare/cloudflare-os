// GitHub, as the real GitHub gatekeeper reaches it from the integration harness: its OAuth token
// endpoint, the REST API it reads and writes for one repository per account, and webhooks that
// deliver signed events back through the gatekeeper's own route. A handler module for the
// harness's NetworkInterceptor, so the suites here stay "the harness pointed at the package, plus
// this".

import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import type { GatekeeperSpec, Harness } from "../src/harness.js";
import type { Handler } from "../src/network-interceptor.js";
import { listConnectedAccounts, waitFor } from "../src/rpc-client.js";

/** The real gatekeeper's package, booted from the tree `build:integration-worker` validates. */
const GITHUB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../gatekeeper-github");
export const GITHUB_WORKER = "gatekeeper-github";
export const GITHUB_VENDOR_ID = "github";
export const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-secret";
/** Where browsers reach the gatekeeper, through the router, as `/gatekeeper/github`. */
export const GITHUB_BASE_URL = "https://workshop.test/gatekeeper/github";
export const WEBHOOK_ORIGIN = "https://workshop.test";

/**
 * The gatekeeper, prebuilt rather than built by each test file: those builds would race on its
 * `.wrangler/validate`. Without `hooks`, it has no `WEBHOOK_ORIGIN`, as a deployment that never
 * set one.
 */
export function githubGatekeeper({ hooks = true }: { hooks?: boolean } = {}): GatekeeperSpec {
  const entry = join(GITHUB_DIR, ".wrangler/validate/src/github.ts");
  if (!existsSync(entry)) {
    throw new Error(`No validated GitHub gatekeeper at ${entry}: run ` +
      "`vp run -F @gadgets/github-gatekeeper build:integration-worker` first.");
  }
  return {
    binding: "GITHUB",
    dir: GITHUB_DIR,
    patch: config => {
      delete config.build;
      config.vars = {
        ...config.vars, BASE_URL: GITHUB_BASE_URL, CLIENT_ID, CLIENT_SECRET,
        ...hooks ? { WEBHOOK_ORIGIN } : {},
      };
    },
  };
}

/**
 * Connect the GitHub account of `api`'s user through the gatekeeper's own OAuth flow and handoff
 * page, GitHub answering `code` with the token `token-<code>`.
 */
export async function connectGitHub(harness: Harness, api: RpcStub<AuthenticatedApi>, code: string) {
  const { url, nonce } = await api.connectAccount(GITHUB_VENDOR_ID);
  const begun = await harness.fetchWorker(GITHUB_WORKER, url, { redirect: "manual" });
  if (begun.status !== 302) throw new Error(`The connect link answered ${begun.status}`);
  const state = new URL(begun.headers.get("Location")!).searchParams.get("state")!;
  const page = await harness.fetchWorker(GITHUB_WORKER,
    `${GITHUB_BASE_URL}/oauth?code=${code}&state=${encodeURIComponent(state)}`);
  const ticket = /var ticket = (".*?");\n/.exec(await page.text());
  if (!ticket) throw new Error("The handoff page carried no ticket");
  await api.completeConnectHandoff(JSON.parse(ticket[1]!), nonce);
  return await waitFor("the connected GitHub account", async () =>
    (await listConnectedAccounts(api)).find(account => account.vendorId === GITHUB_VENDOR_ID) ?? null);
}

type Row = Record<string, unknown>;

/** A webhook on a repository, as the gatekeeper configured it. */
export type FakeWebhook = {
  id: number; repo: string; url: string; secret: string; events: string[]; active: boolean;
};

/** One repository, readable by every account that connects. */
type Repository = Row & { id: number; name: string };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });
const notFound = () => json({ message: "Not Found" }, 404);

export class FakeGitHub {
  /** The connected account, `ada`, whom every token belongs to. */
  readonly viewer = { id: 7, login: "ada", html_url: "https://github.com/ada", avatar_url: "https://avatars.example/ada" };
  readonly sender = { id: 8, login: "bob", html_url: "https://github.com/bob", avatar_url: "https://avatars.example/bob" };
  readonly webhooks = new Map<number, FakeWebhook>();
  /** Every webhook ever deleted, by id. */
  readonly deletedWebhooks: number[] = [];
  /** Each comment posted, as `<repo>#<number>: <body>`. */
  readonly comments: string[] = [];
  /** Each token revoked through `DELETE /applications/{client}/token`. */
  readonly revokedTokens: string[] = [];
  /** Each request made, as `METHOD /path`. */
  readonly requests: string[] = [];
  /** Whether accounts may still read the repositories. */
  readable = true;
  readonly #repositories = new Map<string, Repository>();
  #nextId = 100;

  /** A repository of `acme`'s, named uniquely so tests sharing this fake don't meet. */
  addRepository(name: string): Repository {
    const repository = {
      id: 5000 + this.#repositories.size, name, full_name: `acme/${name}`, private: true,
      html_url: `https://github.com/acme/${name}`, default_branch: "main", visibility: "private",
      owner: { id: 1, login: "acme", html_url: "https://github.com/acme" },
      permissions: { admin: true, push: true, pull: true },
    };
    this.#repositories.set(name, repository);
    return repository;
  }

  readonly handler: Handler = async (url, method, headers, request) => {
    if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token" && method === "POST") {
      const code = new URLSearchParams(await request.text()).get("code");
      return json({ access_token: `token-${code}`, token_type: "bearer", scope: "repo,read:user,admin:repo_hook" });
    }
    if (url.origin !== "https://api.github.com") return null;
    this.requests.push(`${method} ${url.pathname}`);
    if (url.pathname === "/user") return json({ ...this.viewer, name: "Ada" });
    if (url.pathname === `/applications/${CLIENT_ID}/token` && method === "DELETE") {
      this.revokedTokens.push(String((await request.json() as Row).access_token));
      return new Response(null, { status: 204 });
    }
    const byId = /^\/repositories\/(\d+)$/.exec(url.pathname);
    if (byId) {
      const repository = [...this.#repositories.values()].find(({ id }) => id === Number(byId[1]));
      return repository ? this.#repository(repository, headers) : notFound();
    }
    const [, name = "", rest = ""] = /^\/repos\/acme\/([^/]+)(\/.*)?$/.exec(url.pathname) ?? [];
    const repository = this.#repositories.get(name);
    if (!repository) return null;
    if (rest === "") return this.#repository(repository, headers);
    if (!this.readable) return notFound();
    const own = [...this.webhooks.values()].filter(webhook => webhook.repo === name);
    if (rest === "/hooks" && method === "GET") return json(own.map(webhook => this.#reported(webhook)));
    if (rest === "/hooks" && method === "POST") {
      const webhook = this.#configured(this.#nextId++, name, await request.json() as Row);
      this.webhooks.set(webhook.id, webhook);
      return json(this.#reported(webhook), 201);
    }
    const hook = /^\/hooks\/(\d+)$/.exec(rest);
    if (hook) {
      const id = Number(hook[1]);
      const webhook = own.find(found => found.id === id);
      if (!webhook) return notFound();
      if (method === "DELETE") {
        this.webhooks.delete(id);
        this.deletedWebhooks.push(id);
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") {
        const updated = this.#configured(id, name, await request.json() as Row);
        this.webhooks.set(id, updated);
        return json(this.#reported(updated));
      }
      return json(this.#reported(webhook));
    }
    const issue = /^\/issues\/(\d+)$/.exec(rest);
    if (issue && method === "GET") return json(this.issue(name, Number(issue[1])));
    const comments = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (comments && method === "POST") {
      const { body } = await request.json() as { body: string };
      this.comments.push(`${name}#${comments[1]}: ${body}`);
      return json({
        id: 900 + this.comments.length, body, user: this.viewer,
        html_url: `https://github.com/acme/${name}/issues/${comments[1]}#issuecomment-${900 + this.comments.length}`,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }, 201);
    }
    return null;
  };

  /** Issue `number` of repository `name`, opened just now by `sender`. */
  issue(name: string, number: number): Row {
    const now = new Date().toISOString();
    return {
      number, html_url: `https://github.com/acme/${name}/issues/${number}`, title: "Crash on start",
      state: "open", body: "It crashes.", user: this.sender, labels: [{ name: "bug" }], assignees: [],
      created_at: now, updated_at: now, closed_at: null, comments: 0,
    };
  }

  /**
   * Deliver `event` as GitHub would: to each of the repository's active webhooks that subscribes
   * to it, signed with its secret, through the gatekeeper's own route. Returns each status.
   */
  async deliver(harness: Harness, event: string, payload: Row, { to }: { to?: FakeWebhook[] } = {})
      : Promise<number[]> {
    const name = (payload.repository as { name: string }).name;
    const body = JSON.stringify(payload);
    const targets = to ?? [...this.webhooks.values()]
      .filter(webhook => webhook.repo === name && webhook.active && webhook.events.includes(event));
    return await Promise.all(targets.map(async webhook => (await harness.fetchWorker(GITHUB_WORKER, webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": randomUUID(),
        "X-Hub-Signature-256": `sha256=${createHmac("sha256", webhook.secret).update(body).digest("hex")}`,
      },
      body,
    })).status));
  }

  /** An `issues` event for issue `number` of repository `name`. */
  issueEvent(action: string, name: string, number: number): Row {
    return { action, repository: this.#repositories.get(name), sender: this.sender, issue: this.issue(name, number) };
  }

  #repository(repository: Repository, headers: Headers): Response {
    if (!this.readable) return notFound();
    const etag = `"repo-${repository.id}"`;
    if (headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
    return json(repository, 200, { ETag: etag });
  }

  #configured(id: number, repo: string, { events, config, active }: Row): FakeWebhook {
    const { url, secret } = config as { url: string; secret: string };
    return { id, repo, url, secret, events: events as string[], active: active !== false };
  }

  #reported({ id, url, events, active }: FakeWebhook): Row {
    return { id, active, events, config: { url, content_type: "json", insecure_ssl: "0", secret: "********" } };
  }
}
