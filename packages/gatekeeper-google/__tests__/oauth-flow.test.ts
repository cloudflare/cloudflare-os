import { describe, expect, it } from "vitest";
import {
  beginStoredOAuthFlow, claimStoredOAuthFlow, mergeGrantedResources, prepareOAuthFlow,
  shouldDeleteCredentialsOnAlarm, type OAuthFlowMode,
} from "../src/oauth-flow";
import {
  BIGQUERY_RESOURCE, GOOGLE_DOC_RESOURCE, IDENTITY_SCOPES,
} from "../src/resources";
import { FakeKv } from "./fake-kv";

const TEN_MINUTES = 10 * 60 * 1000;
const OAUTH_REDIRECT_URI = "https://gatekeeper-google.example.workers.dev/oauth";

describe("stored OAuth flow", () => {
  it("keeps a claimed attempt immutable while a later consent flow starts", () => {
    let kv = new FakeKv();
    prepareOAuthFlow(kv, "init-docs", [GOOGLE_DOC_RESOURCE.urlPattern], "reconnect", 1_000);

    expect(beginStoredOAuthFlow(kv, "init-docs", "oauth-docs", OAUTH_REDIRECT_URI, 2_000)).toEqual({
      oauthNonce: "oauth-docs",
      scopes: [
        ...IDENTITY_SCOPES,
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/drive.metadata.readonly",
      ],
    });
    let claimedDocs = claimStoredOAuthFlow(kv, "oauth-docs", 3_000);

    prepareOAuthFlow(kv, "init-bigquery", [BIGQUERY_RESOURCE.urlPattern], "reconnect", 4_000);
    expect(claimedDocs).toEqual({
      mode: "reconnect",
      requestedResources: [GOOGLE_DOC_RESOURCE.urlPattern],
      oauthRedirectUri: OAUTH_REDIRECT_URI,
    });
    expect(beginStoredOAuthFlow(kv, "init-bigquery", "oauth-bigquery", OAUTH_REDIRECT_URI, 5_000)?.scopes)
      .toContain("https://www.googleapis.com/auth/bigquery");
    expect(claimStoredOAuthFlow(kv, "oauth-bigquery", 6_000)).toEqual({
      mode: "reconnect",
      requestedResources: [BIGQUERY_RESOURCE.urlPattern],
      oauthRedirectUri: OAUTH_REDIRECT_URI,
    });
  });

  it("merges resources granted by overlapping OAuth completions", () => {
    let kv = new FakeKv();

    mergeGrantedResources(kv, [GOOGLE_DOC_RESOURCE.urlPattern]);
    mergeGrantedResources(kv, [BIGQUERY_RESOURCE.urlPattern]);

    expect(kv.get<string[]>("grantedResources")).toEqual([
      GOOGLE_DOC_RESOURCE.urlPattern,
      BIGQUERY_RESOURCE.urlPattern,
    ]);
  });

  it("binds the OAuth redirect URI to the claimed attempt", () => {
    let kv = new FakeKv();
    let oauthRedirectUri = "https://preview-gatekeeper-google.example.workers.dev/oauth";
    prepareOAuthFlow(kv, "init", [], "connect", 0);

    expect(beginStoredOAuthFlow(kv, "init", "oauth", oauthRedirectUri, 1)).not.toBeNull();
    expect(claimStoredOAuthFlow(kv, "oauth", 2)).toEqual({
      mode: "connect",
      requestedResources: [],
      oauthRedirectUri,
    });
  });

  it("rejects wrong-stage, wrong-nonce, and replay attempts without consuming the flow", () => {
    let kv = new FakeKv();
    prepareOAuthFlow(kv, "init", [], "connect", 0);

    expect(claimStoredOAuthFlow(kv, "init", 1)).toBeNull();
    expect(beginStoredOAuthFlow(kv, "wrong", "oauth", OAUTH_REDIRECT_URI, 1)).toBeNull();
    expect(beginStoredOAuthFlow(kv, "init", "oauth", OAUTH_REDIRECT_URI, 1)).not.toBeNull();
    expect(beginStoredOAuthFlow(kv, "init", "other", OAUTH_REDIRECT_URI, 2)).toBeNull();
    expect(claimStoredOAuthFlow(kv, "wrong", 2)).toBeNull();
    expect(claimStoredOAuthFlow(kv, "oauth", 2)).toEqual({
      mode: "connect", requestedResources: [], oauthRedirectUri: OAUTH_REDIRECT_URI,
    });
    expect(claimStoredOAuthFlow(kv, "oauth", 2)).toBeNull();
  });

  it("gives the initiation and OAuth stages independent ten-minute expiries", () => {
    let kv = new FakeKv();
    prepareOAuthFlow(kv, "init", [], "connect", 0);
    expect(beginStoredOAuthFlow(kv, "init", "oauth", OAUTH_REDIRECT_URI, TEN_MINUTES)).toBeNull();

    prepareOAuthFlow(kv, "init", [], "connect", 0);
    expect(beginStoredOAuthFlow(kv, "init", "oauth", OAUTH_REDIRECT_URI, TEN_MINUTES - 1)).not.toBeNull();
    expect(claimStoredOAuthFlow(kv, "oauth", 2 * TEN_MINUTES - 1)).toBeNull();

    prepareOAuthFlow(kv, "init", [], "connect", 0);
    expect(beginStoredOAuthFlow(kv, "init", "oauth", OAUTH_REDIRECT_URI, TEN_MINUTES - 1)).not.toBeNull();
    expect(claimStoredOAuthFlow(kv, "oauth", 2 * TEN_MINUTES - 2)).not.toBeNull();
  });

  it("does not accept legacy nonce-only state", () => {
    let kv = new FakeKv();
    kv.put("nonce", { value: "legacy", expiresAt: TEN_MINUTES, stage: "initiation" });

    expect(beginStoredOAuthFlow(kv, "legacy", "oauth", OAUTH_REDIRECT_URI, 0)).toBeNull();
    expect(claimStoredOAuthFlow(kv, "legacy", 0)).toBeNull();
  });

  it.each<OAuthFlowMode>(["connect", "auth", "reconnect"])(
    "preserves %s mode independently of an empty resource list", mode => {
      let kv = new FakeKv();
      prepareOAuthFlow(kv, "init", [], mode, 0);

      expect(beginStoredOAuthFlow(kv, "init", "oauth", OAUTH_REDIRECT_URI, 1)).toEqual({
        oauthNonce: "oauth", scopes: IDENTITY_SCOPES,
      });
      expect(claimStoredOAuthFlow(kv, "oauth", 2)).toEqual({
        mode, requestedResources: [], oauthRedirectUri: OAUTH_REDIRECT_URI,
      });
    },
  );

  it("clears obsolete pending-flow keys when preparing a new flow", () => {
    let kv = new FakeKv();
    for (let key of ["nonce", "requestedScopes", "requestedResources", "reconnecting", "ephemeral"]) {
      kv.put(key, "legacy");
    }

    prepareOAuthFlow(kv, "init", [], "auth", 0);

    for (let key of ["nonce", "requestedScopes", "requestedResources", "reconnecting", "ephemeral"]) {
      expect(kv.entries.has(key)).toBe(false);
    }
  });

  it("deletes a legacy ephemeral sign-in when its alarm survives a deploy", () => {
    let kv = new FakeKv();
    kv.put("refreshToken", "token");
    kv.put("ephemeral", true);

    expect(shouldDeleteCredentialsOnAlarm(kv)).toBe(true);
  });

  it("keeps a persistent account when no cleanup marker is set", () => {
    let kv = new FakeKv();
    kv.put("refreshToken", "token");

    expect(shouldDeleteCredentialsOnAlarm(kv)).toBe(false);
  });

  it("deletes a current transient sign-in when its cleanup marker is set", () => {
    let kv = new FakeKv();
    kv.put("refreshToken", "token");
    kv.put("deleteCredentialsOnAlarm", true);

    expect(shouldDeleteCredentialsOnAlarm(kv)).toBe(true);
  });
});
