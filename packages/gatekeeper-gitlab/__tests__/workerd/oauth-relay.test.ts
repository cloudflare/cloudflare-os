// The OAuth callback on a Worker Preview: a preview's hostname cannot be registered with the
// GitLab application, so the authorize request names the *stable* Worker's callback and carries a
// signed state; the stable Worker relays GitLab's answer to the preview, which exchanges the code
// with the same redirect_uri it authorized under. The relay itself is the kit's
// (`gatekeeper-kit/preview-oauth`); these tests pin how this Worker wires it and what it stores.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/gitlab.js";
import { FakeGitLab, json } from "./fake-gitlab.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const STABLE = "https://gatekeeper-gitlab.gadgets-staging.workers.dev";
const PREVIEW = "https://pr1-gatekeeper-gitlab.gadgets-staging.workers.dev";
const SECRET = "s".repeat(64);
type Env = Parameters<typeof worker.fetch>[1];

/** The env a Worker runs with; previews add the kit's redirect and signing variables. */
function envFor(baseUrl: string, preview: { relayTo: string } | undefined): Env {
  return {
    ...env,
    BASE_URL: baseUrl,
    OAUTH_STATE_SIGNING_SECRET: SECRET,
    ...(preview
      ? { OAUTH_ALLOW_PREVIEW_REDIRECTS: "true", OAUTH_REDIRECT_URI: `${preview.relayTo}/oauth` }
      : {}),
  } as Env;
}

/** The stable staging Worker may relay to its previews. */
const stableEnv = { ...envFor(STABLE, undefined), OAUTH_ALLOW_PREVIEW_REDIRECTS: "true" } as Env;

async function seedInitiation(): Promise<{ doId: string; nonce: string }> {
  const id = env.USER_ACCOUNT.newUniqueId();
  const nonce = "b".repeat(64);
  await runInDurableObject(env.USER_ACCOUNT.get(id), async (_i, state) => {
    state.storage.kv.put("nonce", { value: nonce, expiresAt: Date.now() + 60_000, stage: "initiation" });
    state.storage.kv.put("requestedScopes", ["api", "write_repository"]);
    state.storage.kv.put("callback", "placeholder");
  });
  return { doId: id.toString(), nonce };
}

function ctxFor() {
  return { exports: { UserAccount: env.USER_ACCOUNT } } as unknown as Parameters<typeof worker.fetch>[2];
}

describe("OAuth on a Worker Preview", () => {
  it("authorizes against the stable callback with a signed state, and the stable Worker relays the answer", async () => {
    const { doId, nonce } = await seedInitiation();
    const previewEnv = envFor(PREVIEW, { relayTo: STABLE });

    // 1. The preview starts the flow: GitLab is told to come back to the *stable* Worker.
    const start = await worker.fetch(new Request(`${PREVIEW}/${doId}/${nonce}`), previewEnv, ctxFor());
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe("https://gitlab.example.com/oauth/authorize");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${STABLE}/oauth`);
    const state = authorize.searchParams.get("state")!;
    expect(state.split(".")).toHaveLength(3);  // a signed JWT, not the direct doId:nonce form

    // 2. GitLab answers at the stable Worker, which relays code and state to the preview verbatim.
    const relay = await worker.fetch(new Request(`${STABLE}/oauth?code=the-code&state=${state}`), stableEnv, ctxFor());
    expect(relay.status).toBe(302);
    const relayed = new URL(relay.headers.get("location")!);
    expect(relayed.origin + relayed.pathname).toBe(`${PREVIEW}/oauth`);
    expect(relayed.searchParams.get("code")).toBe("the-code");
    expect(relayed.searchParams.get("state")).toBe(state);

    // 3. The preview exchanges the code, repeating the redirect_uri it authorized under -- the
    //    stable one -- as RFC 6749 requires, then hands off to the Workshop.
    const gitlab = new FakeGitLab();
    let exchanged: URLSearchParams | undefined;
    gitlab.on("POST", /^\/oauth\/token/, request => {
      exchanged = new URLSearchParams(request.body);
      // The exchange request is the step under test; GitLab's refusal ends the flow here, before
      // the account would call the (placeholder) Workshop callback.
      return json({ error: "invalid_grant" }, { status: 400 });
    });
    gitlab.install();
    await expect(worker.fetch(new Request(relayed.toString()), previewEnv, ctxFor())).rejects.toThrow();
    expect(exchanged?.get("code")).toBe("the-code");
    expect(exchanged?.get("redirect_uri")).toBe(`${STABLE}/oauth`);
  });

  it("relays GitLab's refusal too, so the preview shows the failure rather than the stable Worker", async () => {
    const { doId, nonce } = await seedInitiation();
    const previewEnv = envFor(PREVIEW, { relayTo: STABLE });
    const start = await worker.fetch(new Request(`${PREVIEW}/${doId}/${nonce}`), previewEnv, ctxFor());
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const relay = await worker.fetch(new Request(`${STABLE}/oauth?error=access_denied&state=${state}`), stableEnv, ctxFor());
    expect(relay.status).toBe(302);
    const relayed = new URL(relay.headers.get("location")!);
    expect(relayed.origin).toBe(PREVIEW);
    expect(relayed.searchParams.get("error")).toBe("access_denied");
    const shown = await worker.fetch(new Request(relayed.toString()), previewEnv, ctxFor());
    expect(shown.status).toBe(400);
    expect(await shown.text()).toMatch(/GitLab authorization failed/);
  });

  it("runs direct when the preview variables are unset, as in production: its own callback, the plain state", async () => {
    const { doId, nonce } = await seedInitiation();
    const production = { ...env, BASE_URL: "https://gadgets.example.com/gatekeeper/gitlab" } as Env;
    const start = await worker.fetch(new Request(`https://gadgets.example.com/gatekeeper/gitlab/${doId}/${nonce}`), production, ctxFor());
    const authorize = new URL(start.headers.get("location")!);
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://gadgets.example.com/gatekeeper/gitlab/oauth");
    expect(authorize.searchParams.get("state")).toMatch(/^[0-9a-f]{64}:[0-9a-f]{64}$/);
  });

  it("refuses to start a flow whose preview configuration is half set, rather than sending GitLab a redirect it will reject", async () => {
    const { doId, nonce } = await seedInitiation();
    const broken = { ...envFor(PREVIEW, { relayTo: STABLE }), OAUTH_ALLOW_PREVIEW_REDIRECTS: undefined } as Env;
    const start = await worker.fetch(new Request(`${PREVIEW}/${doId}/${nonce}`), broken, ctxFor());
    expect(start.status).toBe(503);
    expect(await start.text()).toMatch(/OAUTH_ALLOW_PREVIEW_REDIRECTS/);
  });
});
