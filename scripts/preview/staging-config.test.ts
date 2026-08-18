// The pure half of the PR-preview generator (scripts/preview/staging-config.ts): how a preview
// name is derived, and the shape of the configs built from the repo's REAL wrangler.jsonc files.
// Deploying them is not covered here — that needs an account.
//
// Same spirit as release/manifest-lib.test.ts: adding a deployable package, or changing how one is
// bound, has to be a conscious decision rather than something a preview silently drops.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BindingDecl } from "../release/manifest-lib.ts";
import {
  MAX_PREVIEW_NAME_LENGTH,
  R2_MAX_BUCKET_NAME_LENGTH,
  backendSecrets,
  buildPreviewConfigs,
  gatekeeperBindingName,
  gatekeeperShortName,
  isGatekeeper,
  previewPullRequestNumber,
  readPackages,
  resolveAccess,
  resolveAiGateway,
  resolvePreviewName,
  resolveTarget,
  routerPreviewUrl,
  slugifyPreviewName,
  type PreviewOverrides,
  type StagingConfig,
} from "./staging-config.ts";

const PREVIEW_NAME = "pr-123";
// The real account is deployment configuration, not something this repository holds, so the
// tests pick their own — which also keeps them from passing only against one account's values.
const ACCOUNT_ID = "0".repeat(32);
const WORKERS_DEV_HOST = "example.workers.dev";
const BASE_URL = routerPreviewUrl(PREVIEW_NAME, WORKERS_DEV_HOST);
const ADMIN = "someone@example.com";
const ACCESS = { aud: "a".repeat(64), iss: "https://previews-example.cloudflareaccess.com" };
const AI_GATEWAY = {
  gateway: "example-gateway",
  accountId: "1".repeat(32),
  apiToken: "example-run-and-read-token",
  providers: "cloudflare",
  useBinding: "false",
};
// Every input is passed explicitly: each resolver defaults to reading the environment, so a machine
// with any of these set would otherwise change what the tests assert.
const SECRETS = backendSecrets({
  admins: [ADMIN],
  access: ACCESS,
  aiGateway: resolveAiGateway(AI_GATEWAY),
});

/**
 * Every resource binding declared anywhere in the generated configs, as `[where, resource]`.
 *
 * A config declares resources in two independent halves — the baseline at the top level, and the
 * per-preview overrides under `previews` — across several keys, so flattening them into one
 * labelled sequence lets a caller assert per resource instead of nesting to reach one. The two
 * halves are listed out rather than indexed by one shared key list, because `d1_databases` is a
 * baseline-only key.
 */
function* declaredResources(
  configs: Map<string, StagingConfig>,
): Generator<[string, BindingDecl]> {
  for (const [name, config] of configs) {
    const previews = config.previews ?? {};
    // The binding lists whose entries Wrangler provisions when they carry nothing but a binding.
    const halves: [string, Record<string, BindingDecl[] | undefined>][] = [
      ["baseline", {
        kv_namespaces: config.kv_namespaces,
        r2_buckets: config.r2_buckets,
        d1_databases: config.d1_databases,
        worker_loaders: config.worker_loaders,
      }],
      ["preview", {
        kv_namespaces: previews.kv_namespaces,
        r2_buckets: previews.r2_buckets,
        worker_loaders: previews.worker_loaders,
      }],
    ];
    for (const [half, lists] of halves) {
      for (const [key, resources] of Object.entries(lists)) {
        for (const resource of resources ?? []) yield [`${name} ${half} ${key}`, resource];
      }
    }
  }
}

/** One generated config's per-preview overrides, asserted present. */
function previewsOf(configs: Map<string, StagingConfig>, name: string): PreviewOverrides {
  const config = configs.get(name);
  assert.ok(config, `${name}: no preview config`);
  assert.ok(config.previews, `${name}: no previews block`);
  return config.previews;
}

function buildAll() {
  const packages = readPackages();
  const configs = buildPreviewConfigs({
    previewName: PREVIEW_NAME,
    packages,
    accountId: ACCOUNT_ID,
    workersDevHost: WORKERS_DEV_HOST,
  });
  return { packages, configs };
}

test("preview names are slugified", () => {
  assert.equal(slugifyPreviewName("pr-123"), "pr-123");
  // Uppercase, a slash and an underscore, in a ref short enough to survive the cap intact.
  assert.equal(slugifyPreviewName("maximo/Add_Preview"), "maximo-add-preview");
  assert.equal(slugifyPreviewName("--trailing--"), "trailing");
  // A ref with nothing slug-legal in it still has to produce a usable name.
  assert.equal(slugifyPreviewName("///"), "preview");
});

test("over-long preview names truncate to a stable hashed form", () => {
  const long = "renovate/a-very-long-dependency-branch-name-that-keeps-going";
  const slug = slugifyPreviewName(long);

  // Wrangler derives the preview R2 bucket name from this, so the cap is load-bearing.
  assert.ok(slug.length <= MAX_PREVIEW_NAME_LENGTH, `${slug} is ${slug.length} chars`);
  assert.match(slug, /^renovate-a-very-lon-[0-9a-f]{8}$/);
  assert.equal(slug, slugifyPreviewName(long), "the hash must be stable across runs");
  assert.notEqual(slug, slugifyPreviewName(`${long}-2`), "distinct refs must not collide");
});

test("the preview name cap leaves every provisioned bucket inside R2's limit", () => {
  const { configs } = buildAll();
  const longest = "x".repeat(MAX_PREVIEW_NAME_LENGTH);

  for (const config of configs.values()) {
    for (const { binding } of config.previews?.r2_buckets ?? []) {
      // What Wrangler names the bucket it provisions for a preview.
      const name = `${config.name}-${longest}-${binding.toLowerCase().replaceAll("_", "-")}`;
      assert.ok(name.length <= R2_MAX_BUCKET_NAME_LENGTH,
          `${name} is ${name.length} characters; lower MAX_PREVIEW_NAME_LENGTH`);
    }
  }
});

test("PREVIEW_NAME is what CI passes, and it wins over the local git fallback", () => {
  assert.equal(resolvePreviewName({ name: "pr-42", prNumber: "" }), "pr-42");
  assert.equal(resolvePreviewName({ name: "PR/42", prNumber: "" }), "pr-42");
});

test("the preview name carries the pull request number, so look-alike branches cannot collide", () => {
  // All three slugify identically, which is the collision the number exists to prevent: without it
  // two open pull requests would deploy over each other, and either closing would delete both.
  for (const ref of ["feature/foo", "feature-foo", "Feature_Foo"]) {
    assert.equal(slugifyPreviewName(ref), "feature-foo");
  }
  assert.equal(resolvePreviewName({ name: "feature/foo", prNumber: "241" }), "pr241-feature-foo");
  assert.equal(resolvePreviewName({ name: "Feature_Foo", prNumber: "242" }), "pr242-feature-foo");

  // No number is a local run, which keeps the bare slug; neither is anything that is not one, since
  // the workflow interpolates the empty string on a scheduled run.
  assert.equal(resolvePreviewName({ name: "feature/foo", prNumber: "" }), "feature-foo");
  assert.equal(resolvePreviewName({ name: "feature/foo", prNumber: "not-a-number" }),
      "feature-foo");
});

test("the pull request number stays inside the name cap, and reads back out of it", () => {
  const long = "renovate/a-very-long-dependency-branch-name-that-keeps-going";
  const name = resolvePreviewName({ name: long, prNumber: "12345" });

  // The cap bounds the whole name, prefix included: Wrangler derives the preview's R2 bucket name
  // from it, so a prefix that ate into no budget would be a bucket over R2's limit.
  assert.ok(name.length <= MAX_PREVIEW_NAME_LENGTH, `${name} is ${name.length} chars`);
  assert.equal(previewPullRequestNumber(name), 12345);
  assert.equal(previewPullRequestNumber("pr241-feature-foo"), 241);
  // The sweep asks GitHub about whatever it reads back, so a preview deployed without a number has
  // to be distinguishable rather than matching some pull request by accident.
  assert.equal(previewPullRequestNumber("feature-foo"), undefined);
  assert.equal(previewPullRequestNumber("pr-123"), undefined);
  assert.equal(previewPullRequestNumber("prefix-123-branch"), undefined);
});

test("a reserved prefix shrinks the slug budget rather than overflowing it", () => {
  const long = "renovate/a-very-long-dependency-branch-name-that-keeps-going";
  for (const reserve of [0, 3, 9]) {
    const slug = slugifyPreviewName(long, { reserve });
    assert.ok(slug.length <= MAX_PREVIEW_NAME_LENGTH - reserve,
        `${slug} is ${slug.length} chars with ${reserve} reserved`);
  }
  // A ref short enough to survive intact is untouched: the budget only bites when it truncates.
  assert.equal(slugifyPreviewName("feature/foo", { reserve: 9 }), "feature-foo");
});

test("every deployable package gets a preview config, on the configured account", () => {
  const { packages, configs } = buildAll();

  assert.equal(configs.size, packages.length);
  assert.ok(configs.has("router") && configs.has("workshop-backend"),
      "the router and backend are the two non-gatekeeper deployables");
  for (const [name, config] of configs) {
    assert.equal(config.account_id, ACCOUNT_ID, name);
    assert.equal(config.routes, undefined, `${name}: a preview cannot be served from a zone`);
    assert.ok(config.previews, `${name}: no previews block`);
    // The worker is deployed under its package name; every URL and service binding is derived
    // from that, so a divergence here misconfigures the topology rather than merely renaming.
    assert.equal(config.name, name, `${name}: worker name diverges from its package`);
  }
});

test("the router is the only worker with a public hostname", () => {
  const { configs } = buildAll();

  for (const [name, config] of configs) {
    const exposed = name === "router";
    // Preview URLs are public, and everything but the router is reached over a service binding.
    // Giving one to the backend would publish /api with the router bypassed.
    assert.equal(config.workers_dev, exposed, `${name}: workers_dev`);
    assert.equal(config.preview_urls, exposed, `${name}: preview_urls`);
  }
});

test("the backend's per-preview resources carry no ids, so wrangler provisions them", () => {
  const { configs } = buildAll();
  const previews = previewsOf(configs, "workshop-backend");

  assert.deepEqual(previews.kv_namespaces, [{ binding: "BLUEPRINTS" }, { binding: "AVATARS" }]);
  assert.deepEqual(previews.r2_buckets, [{ binding: "BLUEPRINT_CONTENT" }]);
  assert.deepEqual(previews.worker_loaders, [{ binding: "LOADER" }]);
  assert.deepEqual(previews.ai, { binding: "WORKERS_AI" });
  assert.deepEqual(previews.browser, { binding: "BROWSER" });

  // An id or bucket name here would point the preview at the shared baseline resource, so every
  // preview would read and write one another's blueprints.
  for (const resource of [...(previews.kv_namespaces ?? []), ...(previews.r2_buckets ?? [])]) {
    assert.deepEqual(Object.keys(resource), ["binding"], JSON.stringify(resource));
  }
});

test("no config names a resource belonging to another deployment", () => {
  // The committed wrangler.jsonc files name resources for the deployment they were written for:
  // a real `bucket_name`, and KV entries whose only id is a local-dev Miniflare `preview_id`.
  // Passing either through would bind a baseline to that deployment's live bucket on the account
  // we share with it, or leave a KV binding with no id at all. Both halves of every config are
  // therefore binding-only, and Wrangler provisions.
  for (const [where, resource] of declaredResources(buildAll().configs)) {
    assert.deepEqual(Object.keys(resource), ["binding"], `${where}: ${JSON.stringify(resource)}`);
  }
});

test("the backend is told the router's origin, and nothing else", () => {
  const { configs } = buildAll();
  const vars = previewsOf(configs, "workshop-backend").vars;
  assert.ok(vars, "the backend preview declares no vars");

  // The origin is the only value the backend needs that is safe to write into a config Wrangler
  // will print; its admins and Access pair are uploaded as secrets instead (below).
  assert.deepEqual(Object.keys(vars), ["PUBLIC_BASE_URL"]);
  assert.equal(vars.PUBLIC_BASE_URL, BASE_URL);
  // Setting CF_ACCESS_AUD closes the password path on its own — login() and createAccount() both
  // throw once it is set — so this stays unset.
  assert.equal(vars.DISABLE_PASSWORD_AUTH, undefined);
});

test("the backend's secrets are the admin list, the Access pair and the AI gateway", () => {
  // A secret is always text, so the admin list travels as JSON — the form `#isAdmin()` already
  // parses. Everything here is uploaded by preview.ts, never written to a config.
  assert.deepEqual(SECRETS, {
    ADMINS: `["${ADMIN}"]`,
    CF_ACCESS_AUD: ACCESS.aud,
    CF_ACCESS_ISS: ACCESS.iss,
    CF_AI_GATEWAY: AI_GATEWAY.gateway,
    CF_AI_GATEWAY_ACCOUNT_ID: AI_GATEWAY.accountId,
    CF_AI_GATEWAY_API_TOKEN: AI_GATEWAY.apiToken,
    CF_AI_GATEWAY_PROVIDERS: AI_GATEWAY.providers,
    CF_AI_GATEWAY_USE_BINDING: AI_GATEWAY.useBinding,
  });
});

test("the AI gateway is optional as a group, but not half-configured", () => {
  // No gateway is a BYOK preview, which is a working deployment rather than a broken one.
  assert.deepEqual(resolveAiGateway({}), {});
  assert.deepEqual(resolveAiGateway({ accountId: AI_GATEWAY.accountId }), {}, "orphans are ignored");

  // With one, the account is what AiGatewayConfig demands: without it the backend throws on the
  // first chat, so the deploy has to be the thing that fails instead.
  assert.throws(() => resolveAiGateway({ gateway: "g" }),
      /CF_AI_GATEWAY_ACCOUNT_ID must be set when CF_AI_GATEWAY is/);

  // The gateway name and its account are the whole requirement: a preview binds Workers AI, and
  // the binding transport is pre-authenticated in-account, so a tokenless gateway is a complete
  // configuration. Everything below them is independently optional.
  assert.deepEqual(resolveAiGateway({ gateway: "g", accountId: "a" }),
      { CF_AI_GATEWAY: "g", CF_AI_GATEWAY_ACCOUNT_ID: "a" });
  assert.deepEqual(resolveAiGateway({ gateway: "g", accountId: "a", apiToken: "t" }),
      { CF_AI_GATEWAY: "g", CF_AI_GATEWAY_ACCOUNT_ID: "a", CF_AI_GATEWAY_API_TOKEN: "t" });
});

test("a preview that cannot use the binding transport needs the gateway token", () => {
  // Both mirror an AiGatewayConfig throw: opting out of the binding leaves only HTTPS, and the
  // google SDK cannot take the binding's fetch. Each is a deploy failure rather than a chat one.
  assert.throws(
      () => resolveAiGateway({ gateway: "g", accountId: "a", useBinding: "false" }),
      /CF_AI_GATEWAY_API_TOKEN must be set when CF_AI_GATEWAY_USE_BINDING is false/);
  assert.throws(
      () => resolveAiGateway({ gateway: "g", accountId: "a", providers: "cloudflare,google" }),
      /CF_AI_GATEWAY_API_TOKEN must be set when the google provider is enabled/);

  // With the token, both are configurations rather than errors.
  assert.deepEqual(
      resolveAiGateway({ gateway: "g", accountId: "a", apiToken: "t", useBinding: "false" }),
      { CF_AI_GATEWAY: "g", CF_AI_GATEWAY_ACCOUNT_ID: "a", CF_AI_GATEWAY_API_TOKEN: "t",
        CF_AI_GATEWAY_USE_BINDING: "false" });
  // Requiring the binding is the other half of the same knob, and needs no token at all.
  assert.deepEqual(resolveAiGateway({ gateway: "g", accountId: "a", useBinding: "true" }),
      { CF_AI_GATEWAY: "g", CF_AI_GATEWAY_ACCOUNT_ID: "a", CF_AI_GATEWAY_USE_BINDING: "true" });

  // Case and padding are normalized before the check, and the canonical form is what is emitted,
  // so the backend never receives a value it would have to normalize itself.
  assert.deepEqual(
      resolveAiGateway({ gateway: "g", accountId: "a", apiToken: "t", useBinding: " FALSE " }),
      { CF_AI_GATEWAY: "g", CF_AI_GATEWAY_ACCOUNT_ID: "a", CF_AI_GATEWAY_API_TOKEN: "t",
        CF_AI_GATEWAY_USE_BINDING: "false" });
  // A normalized " FALSE " is still the opt-out, so it needs the token like any other.
  assert.throws(
      () => resolveAiGateway({ gateway: "g", accountId: "a", useBinding: " FALSE " }),
      /CF_AI_GATEWAY_API_TOKEN must be set when CF_AI_GATEWAY_USE_BINDING is false/);

  // The backend compares against the two strings and reads anything else as unset, so a value it
  // would silently ignore fails here instead
  assert.throws(() => resolveAiGateway({ gateway: "g", accountId: "a", useBinding: "yes please" }),
      /CF_AI_GATEWAY_USE_BINDING must be "true" or "false", not "yes please"/);
});

test("no generated config declares a secret's variable", () => {
  for (const [name, config] of buildAll().configs) {
    const halves: [string, Record<string, unknown> | undefined][] = [
      ["baseline", config.vars],
      ["preview", config.previews?.vars],
    ];
    for (const [half, vars] of halves) {
      for (const key of Object.keys(SECRETS)) {
        assert.ok(!Object.hasOwn(vars ?? {}, key),
            `${name} ${half} vars declare ${key}; upload it as a secret from preview.ts instead`);
      }
    }
  }
});

test("no generated config carries a secret's value anywhere", () => {
  // This is the guard that keeps the values out of a public log. Wrangler prints the value of every
  // plain-text var in its deploy summary (truncated to about forty characters) and every
  // `unsafe.bindings` entry verbatim in its configuration warning, and GitHub's secret masking does
  // not save either: it replaces exact occurrences of a registered secret, and a reformatted or
  // truncated slice is not one. So no generated config may carry one at all — not in `vars`, not
  // anywhere else, and not in any of the eighteen, since only the backend reads them.
  // Every value that identifies this deployment — the two whose values are ordinary words are left
  // to the name check above. The bare email as well as its JSON form, so that seeding the admins as
  // anything other than the secret's exact encoding — a comma-joined var, say — is caught too.
  const generic = new Set(["CF_AI_GATEWAY_PROVIDERS", "CF_AI_GATEWAY_USE_BINDING"]);
  const sensitive = [
    ...Object.entries(SECRETS).filter(([key]) => !generic.has(key)),
    ["an admin's email", ADMIN],
  ];
  for (const [name, config] of buildAll().configs) {
    const serialized = JSON.stringify(config);
    for (const [key, value] of sensitive) {
      assert.ok(!serialized.includes(value),
          `${name}'s config carries ${key}; upload it as a secret from preview.ts instead`);
    }
  }
});

test("every gatekeeper is bound to the backend by RPC and to the router by HTTP", () => {
  const { packages, configs } = buildAll();
  const gatekeepers = packages.map((pkg) => pkg.name).filter(isGatekeeper).toSorted();
  assert.ok(gatekeepers.length >= 16, `only found ${gatekeepers.length} gatekeepers`);

  // A service binding names a worker, which is the package name; the binding name — what the
  // router and the backend actually scan for — is the uppercased form.
  const backend = previewsOf(configs, "workshop-backend").services;
  assert.ok(backend, "the backend preview declares no service bindings");
  assert.deepEqual(backend.map((service) => service.service),
      gatekeepers);
  for (const [index, service] of backend.entries()) {
    assert.equal(service.binding, gatekeeperBindingName(gatekeepers[index]));
    assert.equal(service.entrypoint, "GatekeeperVendor", service.service);
  }

  const router = previewsOf(configs, "router").services;
  assert.ok(router, "the router preview declares no service bindings");
  assert.deepEqual(router.map((service) => service.service),
      ["workshop-backend", ...gatekeepers],
      "the router fronts the backend and every gatekeeper");
  for (const [index, service] of router.slice(1).entries()) {
    assert.equal(service.binding, gatekeeperBindingName(gatekeepers[index]));
    // The router forwards whole HTTP requests, so it binds the default entrypoint.
    assert.equal(service.entrypoint, undefined, service.service);
  }
});

test("every gatekeeper is mounted under the router's origin", () => {
  const { packages, configs } = buildAll();

  for (const { name } of packages.filter((pkg) => isGatekeeper(pkg.name))) {
    assert.equal(previewsOf(configs, name).vars?.BASE_URL,
        `${BASE_URL}/gatekeeper/${gatekeeperShortName(name)}`);
  }
  // The router discovers gatekeepers by lowercasing its GATEKEEPER_* bindings, so the path each
  // gatekeeper is told to serve has to be the one the router will route to it.
  assert.equal(gatekeeperBindingName("gatekeeper-mcp-portal"), "GATEKEEPER_MCP_PORTAL");
  assert.equal(gatekeeperShortName("gatekeeper-mcp-portal"), "mcp-portal");
});

test("each preview's context collections are namespaced to that preview", () => {
  const { configs } = buildAll();
  const context = previewsOf(configs, "workshop-backend").services
      ?.find((service) => service.service === "gatekeeper-context");
  assert.ok(context, "the backend has no gatekeeper-context binding");

  // Previews share one baseline gatekeeper-context worker; the sharingDomain is the only thing
  // keeping one PR's collections out of another's.
  assert.deepEqual(context.props, { sharingDomain: BASE_URL });
});

test("a worker whose name diverges from its package directory is rejected", () => {
  assert.throws(() => buildPreviewConfigs({
    previewName: PREVIEW_NAME,
    accountId: ACCOUNT_ID,
    workersDevHost: WORKERS_DEV_HOST,
    packages: [{ name: "gatekeeper-github", config: { name: "github" } }],
  }), /requires them to match/);
});

test("an unrecognized deployable package is rejected rather than half-configured", () => {
  assert.throws(() => buildPreviewConfigs({
    previewName: PREVIEW_NAME,
    accountId: ACCOUNT_ID,
    workersDevHost: WORKERS_DEV_HOST,
    packages: [{ name: "workshop-frontend", config: { name: "workshop-frontend" } }],
  }), /cannot build a preview config/);
});

test("the target account has no default, in either direction", () => {
  // Defaulting would mean a missing variable deploys somewhere plausible-but-wrong rather than
  // failing, and the two have to move together: BASE_URL comes from the host, the workers from
  // the account.
  assert.deepEqual(
      resolveTarget({ accountId: "abc", workersDevHost: "x.workers.dev" }),
      { accountId: "abc", workersDevHost: "x.workers.dev" });
  assert.throws(() => resolveTarget({ accountId: "", workersDevHost: "" }),
      /CLOUDFLARE_ACCOUNT_ID and PREVIEW_WORKERS_DEV_HOST/);
  assert.throws(() => resolveTarget({ accountId: "abc", workersDevHost: "" }),
      /PREVIEW_WORKERS_DEV_HOST must be set/);
  assert.throws(() => resolveTarget({ accountId: "", workersDevHost: "x.workers.dev" }),
      /CLOUDFLARE_ACCOUNT_ID must be set/);

  assert.throws(() => buildPreviewConfigs({
    previewName: PREVIEW_NAME,
    accountId: ACCOUNT_ID,
    // The signature requires it; the runtime guard is what this asserts, for the caller who
    // resolved only half its target.
    workersDevHost: undefined as unknown as string,
    packages: [],
  }), /needs both accountId and workersDevHost/);
});

test("the Access application has no default, in either direction", () => {
  // A preview is a public workers.dev URL holding real gatekeeper capabilities. With neither value
  // set the backend falls back to password signup *silently*, so this has to fail closed — and the
  // pair moves together, since an audience without an issuer cannot be verified and an issuer
  // without an audience verifies nothing in particular.
  assert.deepEqual(resolveAccess(ACCESS), ACCESS);
  assert.throws(() => resolveAccess({ aud: "", iss: "" }),
      /CF_ACCESS_AUD and CF_ACCESS_ISS/);
  assert.throws(() => resolveAccess({ aud: ACCESS.aud, iss: "" }), /CF_ACCESS_ISS must be set/);
  assert.throws(() => resolveAccess({ aud: "", iss: ACCESS.iss }), /CF_ACCESS_AUD must be set/);
});
