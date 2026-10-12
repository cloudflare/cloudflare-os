// GitLab, as the real GitLab gatekeeper reaches it from the integration harness: its OAuth token
// and revoke endpoints, the instance's version, projects and their issues, the comments an
// approved write posts, and webhooks that sign what they deliver back through the gatekeeper's
// own route, as GitLab 19.0 and later sign it. A handler module for the harness's
// NetworkInterceptor, as github-fake.ts is for GitHub; the REST shapes are the gatekeeper's own
// fixtures, taken from GitLab's documentation.

import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import * as fx from "../../gatekeeper-gitlab/__tests__/fixtures/gitlab-docs.js";
import type { GatekeeperSpec, Harness } from "../src/harness.js";
import type { Handler } from "../src/network-interceptor.js";
import { listConnectedAccounts, waitFor } from "../src/rpc-client.js";

/** The real gatekeeper's package, booted from the tree `build:integration-worker` validates. */
const GITLAB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../gatekeeper-gitlab");
export const GITLAB_WORKER = "gatekeeper-gitlab";
export const GITLAB_VENDOR_ID = "gitlab";
const CLIENT_ID = "test-client";
/** The instance, which users visit and the Worker reaches alike. */
export const GITLAB = "https://gitlab.example.com";
/** Where browsers reach the gatekeeper, through the router, as `/gatekeeper/gitlab`. */
export const GITLAB_BASE_URL = "https://workshop.test/gatekeeper/gitlab";
const WEBHOOK_ORIGIN = "https://workshop.test";

/**
 * The gatekeeper, prebuilt rather than built by each test file: those builds would race on its
 * `.wrangler/validate`. Without `hooks`, it has no `WEBHOOK_ORIGIN`, as a deployment that never
 * set one.
 */
export function gitlabGatekeeper({ hooks = true }: { hooks?: boolean } = {}): GatekeeperSpec {
  const entry = join(GITLAB_DIR, ".wrangler/validate/src/gitlab.ts");
  if (!existsSync(entry)) {
    throw new Error(`No validated GitLab gatekeeper at ${entry}: run ` +
      "`vp run -F @gadgets/gitlab-gatekeeper build:integration-worker` first.");
  }
  return {
    binding: "GITLAB",
    dir: GITLAB_DIR,
    patch: config => {
      delete config.build;
      config.vars = {
        ...config.vars, BASE_URL: GITLAB_BASE_URL, CLIENT_ID, CLIENT_SECRET: "test-secret", GITLAB_URL: GITLAB,
        ...hooks ? { WEBHOOK_ORIGIN } : {},
      };
    },
  };
}

/**
 * Connect the GitLab account of `api`'s user through the gatekeeper's own OAuth flow and handoff
 * page, GitLab answering `code` with the token `token-<code>`.
 */
export async function connectGitLab(harness: Harness, api: RpcStub<AuthenticatedApi>, code: string) {
  const { url, nonce } = await api.connectAccount(GITLAB_VENDOR_ID);
  const begun = await harness.fetchWorker(GITLAB_WORKER, url, { redirect: "manual" });
  if (begun.status !== 302) throw new Error(`The connect link answered ${begun.status}`);
  const state = new URL(begun.headers.get("Location")!).searchParams.get("state")!;
  const page = await harness.fetchWorker(GITLAB_WORKER,
    `${GITLAB_BASE_URL}/oauth?code=${code}&state=${encodeURIComponent(state)}`);
  const ticket = /var ticket = (".*?");\n/.exec(await page.text());
  if (!ticket) throw new Error("The handoff page carried no ticket");
  await api.completeConnectHandoff(JSON.parse(ticket[1]!), nonce);
  return await waitFor("the connected GitLab account", async () =>
    (await listConnectedAccounts(api)).find(account => account.vendorId === GITLAB_VENDOR_ID) ?? null);
}

type Row = Record<string, unknown>;

/** A project webhook, as the gatekeeper configured it. */
export type FakeWebhook = { id: number; projectId: number; url: string; signingToken?: string; triggers: string[] };

/** One project of `acme`'s, which every account that connects maintains. */
type Project = { id: number; path: string };

const json = (body: unknown, status = 200) => Response.json(body, { status });
const notFound = () => json({ message: "404 Not found" }, 404);

/** What a webhook names each kind of event's trigger. */
const TRIGGERS: Record<string, string> = {
  "Issue Hook": "issues_events", "Merge Request Hook": "merge_requests_events", "Note Hook": "note_events",
  "Push Hook": "push_events", "Tag Push Hook": "tag_push_events",
};

/** A Standard Webhooks signature, as GitLab signs a delivery with a webhook's signing token. */
function sign(signingToken: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(signingToken.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export class FakeGitLab {
  /** The connected account, `ada`, whom every token belongs to. */
  readonly viewer = { id: 7, username: "ada", name: "Ada", avatar_url: "https://avatars.example/ada", web_url: `${GITLAB}/ada` };
  readonly sender = { id: 8, username: "bob", name: "Bob", avatar_url: "https://avatars.example/bob", web_url: `${GITLAB}/bob` };
  readonly webhooks = new Map<number, FakeWebhook>();
  /** Every webhook ever deleted, by id. */
  readonly deletedWebhooks: number[] = [];
  /** Each comment posted, as `<project path>#<iid>: <body>`. */
  readonly comments: string[] = [];
  /** Each token revoked through `POST /oauth/revoke`. */
  readonly revokedTokens: string[] = [];
  /** Each REST request made, as `METHOD /path`. */
  readonly requests: string[] = [];
  readonly #projects = new Map<string, Project>();
  #nextId = 100;

  /** A project of `acme`'s, named uniquely so tests sharing this fake don't meet. */
  addProject(name: string): Project {
    const project = { id: 5000 + this.#projects.size, path: `acme/${name}` };
    this.#projects.set(project.path, project);
    return project;
  }

  readonly handler: Handler = async (url, method, _headers, request) => {
    if (url.origin !== GITLAB) return null;
    if (url.pathname === "/oauth/token" && method === "POST") {
      const form = new URLSearchParams(await request.text());
      const code = form.get("grant_type") === "authorization_code"
        ? form.get("code") : form.get("refresh_token")?.replace(/^refresh-/, "");
      return json({ ...fx.oauthTokenResponse.data, access_token: `token-${code}`, refresh_token: `refresh-${code}` });
    }
    if (url.pathname === "/oauth/revoke" && method === "POST") {
      this.revokedTokens.push(new URLSearchParams(await request.text()).get("token") ?? "");
      return json({});
    }
    if (!url.pathname.startsWith("/api/v4/")) return null;
    const path = url.pathname.slice("/api/v4".length);
    this.requests.push(`${method} ${path}`);
    if (path === "/user") return json({ ...fx.currentUserResponse.data, ...this.viewer, email: "ada@example.com" });
    if (path === "/metadata") return json({ version: "19.4.0-ee" });
    const [, ref = "", rest = ""] = /^\/projects\/([^/]+)(\/.*)?$/.exec(path) ?? [];
    const project = this.#project(decodeURIComponent(ref));
    if (!project) return null;
    if (rest === "") return json(this.#projectRest(project));
    const issue = /^\/issues\/(\d+)$/.exec(rest);
    if (issue && method === "GET") return json(this.#issueRest(project, Number(issue[1])));
    const notes = /^\/issues\/(\d+)\/notes$/.exec(rest);
    if (notes && method === "POST") {
      const { body } = await request.json() as { body: string };
      this.comments.push(`${project.path}#${notes[1]}: ${body}`);
      return json({
        ...fx.issueNotesResponse.data[0], id: 900 + this.comments.length, body, author: this.viewer, system: false,
        noteable_iid: Number(notes[1]), project_id: project.id, created_at: new Date().toISOString(),
      }, 201);
    }
    return await this.#hooks(project, method, rest, request);
  };

  /** Issue `iid` of `project`, opened just now by `sender`, as a webhook reports it. */
  issueEvent(project: Project, action: string, iid: number): Row {
    const now = new Date().toISOString();
    return {
      object_kind: "issue", event_type: "issue", user: this.sender,
      project: { id: project.id, name: project.path.split("/")[1], path_with_namespace: project.path, web_url: `${GITLAB}/${project.path}` },
      object_attributes: {
        id: 300 + iid, iid, title: "Crash on start", description: "It crashes.", action,
        state: action === "close" ? "closed" : "opened", url: `${GITLAB}/${project.path}/-/issues/${iid}`,
        created_at: now, updated_at: now, confidential: false,
      },
      labels: [], assignees: [], changes: {},
    };
  }

  /**
   * Deliver `event` as GitLab would: to each webhook on the payload's project with its trigger on,
   * signed with its signing token, through the gatekeeper's own route. Returns each status.
   */
  async deliver(harness: Harness, event: string, payload: Row, { to }: { to?: FakeWebhook[] } = {})
      : Promise<number[]> {
    const projectId = (payload.project as { id: number }).id;
    const body = JSON.stringify(payload);
    const id = randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const targets = to ?? [...this.webhooks.values()]
      .filter(webhook => webhook.projectId === projectId && webhook.triggers.includes(TRIGGERS[event]!));
    return await Promise.all(targets.map(async webhook => (await harness.fetchWorker(GITLAB_WORKER, webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "X-Gitlab-Event": event, "webhook-id": id, "webhook-timestamp": timestamp,
        ...webhook.signingToken === undefined ? {} : { "webhook-signature": sign(webhook.signingToken, id, timestamp, body) },
      },
      body,
    })).status));
  }

  #project(ref: string): Project | undefined {
    return /^\d+$/.test(ref)
      ? [...this.#projects.values()].find(project => project.id === Number(ref))
      : this.#projects.get(ref);
  }

  #projectRest({ id, path }: Project): Row {
    return {
      ...fx.projectResponse.data, id, path: path.split("/")[1], path_with_namespace: path, name: path.split("/")[1],
      web_url: `${GITLAB}/${path}`, http_url_to_repo: `${GITLAB}/${path}.git`,
      namespace: { ...fx.projectResponse.data.namespace, path: "acme", full_path: "acme", name: "Acme" },
      // A Maintainer, who may manage the project's webhooks.
      permissions: { project_access: { access_level: 40, notification_level: 3 }, group_access: null },
    };
  }

  #issueRest(project: Project, iid: number): Row {
    return {
      ...fx.issueResponse.data, iid, project_id: project.id, title: "Crash on start", state: "opened", closed_at: null,
      author: this.sender, web_url: `${GITLAB}/${project.path}/-/issues/${iid}`, labels: ["bug"],
    };
  }

  async #hooks(project: Project, method: string, rest: string, request: Request): Promise<Response | null> {
    const own = [...this.webhooks.values()].filter(webhook => webhook.projectId === project.id);
    if (rest === "/hooks" && method === "GET") return json(own.map(webhook => this.#reported(webhook)));
    if (rest === "/hooks" && method === "POST") {
      const webhook = this.#configured(this.#nextId++, project.id, await request.json() as Row);
      this.webhooks.set(webhook.id, webhook);
      return json(this.#reported(webhook), 201);
    }
    const hook = /^\/hooks\/(\d+)(\/events)?$/.exec(rest);
    if (!hook) return null;
    const webhook = own.find(found => found.id === Number(hook[1]));
    if (!webhook) return notFound();
    if (hook[2] !== undefined) return method === "GET" ? json([]) : null;
    if (method === "GET") return json(this.#reported(webhook));
    if (method === "PUT") {
      const updated = this.#configured(webhook.id, project.id, await request.json() as Row, webhook);
      this.webhooks.set(webhook.id, updated);
      return json(this.#reported(updated));
    }
    if (method === "DELETE") {
      this.webhooks.delete(webhook.id);
      this.deletedWebhooks.push(webhook.id);
      return new Response(null, { status: 204 });
    }
    return null;
  }

  /** `existing` as GitLab keeps it once `config` is applied, which changes only what it names. */
  #configured(id: number, projectId: number, config: Row, existing?: FakeWebhook): FakeWebhook {
    const triggers = new Set(existing?.triggers);
    for (const [key, on] of Object.entries(config)) {
      if (!key.endsWith("_events")) continue;
      if (on === true) triggers.add(key);
      else triggers.delete(key);
    }
    const signingToken = typeof config.signing_token === "string" ? config.signing_token : existing?.signingToken;
    return {
      id, projectId, url: String(config.url ?? existing?.url), triggers: [...triggers].toSorted(),
      ...signingToken === undefined ? {} : { signingToken },
    };
  }

  #reported({ id, url, signingToken, triggers }: FakeWebhook): Row {
    return {
      id, url, alert_status: "executable", enable_ssl_verification: true, custom_webhook_template: "",
      push_events_branch_filter: null, branch_filter_strategy: "all_branches",
      ...Object.fromEntries(triggers.map(trigger => [trigger, true])), signing_token_present: signingToken !== undefined,
    };
  }
}
