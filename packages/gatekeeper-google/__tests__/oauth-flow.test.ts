import { describe, expect, it } from "vitest";
import {
  beginStoredOAuthFlow, claimStoredOAuthFlow, mergeGrantedResources, prepareOAuthFlow,
  shouldDeleteCredentialsOnAlarm, type OAuthFlowMode,
} from "../src/oauth-flow";
import {
  BIGQUERY_RESOURCE, DRIVE_WRITES_GRANT, GOOGLE_DOC_RESOURCE, GOOGLE_DRIVE_FOLDER_RESOURCE,
  IDENTITY_SCOPES, recordedResourceUrlPatterns,
} from "../src/resources";
import { FakeKv } from "./fake-kv";

const TEN_MINUTES = 10 * 60 * 1000;
const OAUTH_REDIRECT_URI = "https://gatekeeper-google.example.workers.dev/oauth";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

/**
 * A reconnect begun for `requested`: the scopes its consent asks Google for, with the grants of
 * `withheld` left out, and the storage it is kept in.
 */
function begun(requested: string[], withheld?: string[]) {
  let kv = new FakeKv();
  prepareOAuthFlow(kv, "init", requested, "reconnect", 0);
  let scopes = beginStoredOAuthFlow(kv, "init", "oauth", OAUTH_REDIRECT_URI, 1, withheld)?.scopes;
  return { kv, scopes };
}

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

  // Regression: the shared-drive resource's urlPattern was retired, and a reconnect feeds the
  // recorded grant straight back in, so an unknown pattern made the repair path throw.
  it("reconnects an account whose recorded grant names a retired resource", () => {
    let kv = new FakeKv();
    let requestable = recordedResourceUrlPatterns({
      resourceUrlPatterns: [
        "https://drive.google.com/drive/folders/:driveId",
        GOOGLE_DRIVE_FOLDER_RESOURCE.urlPattern,
      ],
    });

    prepareOAuthFlow(kv, "init", requestable, "reconnect", 0);

    expect(beginStoredOAuthFlow(kv, "init", "oauth", OAUTH_REDIRECT_URI, 1)?.scopes).toEqual([
      ...IDENTITY_SCOPES,
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/presentations.readonly",
      DRIVE_SCOPE,
    ]);
  });

  it("asks for the Drive writes grant with any Google Drive resource, once", () => {
    const FOLDER = GOOGLE_DRIVE_FOLDER_RESOURCE.urlPattern;
    for (let requested of [[FOLDER], [FOLDER, DRIVE_WRITES_GRANT], [DRIVE_WRITES_GRANT, FOLDER]]) {
      let { kv, scopes } = begun(requested);
      expect(scopes, String(requested)).toContain(DRIVE_SCOPE);
      let recorded = claimStoredOAuthFlow(kv, "oauth", 2)?.requestedResources;
      expect(recorded?.filter(pattern => pattern === DRIVE_WRITES_GRANT), String(requested)).toHaveLength(1);
      expect(recorded, String(requested)).toContain(FOLDER);
    }

    // A Doc on its own, BigQuery, and a sign-in that asks for no resource: no Drive writes.
    for (let requested of [[GOOGLE_DOC_RESOURCE.urlPattern], [BIGQUERY_RESOURCE.urlPattern], []]) {
      let { kv, scopes } = begun(requested);
      expect(scopes, String(requested)).not.toContain(DRIVE_SCOPE);
      expect(claimStoredOAuthFlow(kv, "oauth", 2)?.requestedResources, String(requested)).toEqual(requested);
    }
  });

  it("leaves a withheld grant's scopes out of what a consent asks for, and keeps the grant in the attempt", () => {
    const FOLDER = GOOGLE_DRIVE_FOLDER_RESOURCE.urlPattern;
    let { kv, scopes } = begun([FOLDER], [DRIVE_WRITES_GRANT]);
    expect(scopes).toEqual([
      ...IDENTITY_SCOPES,
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/presentations.readonly",
    ]);
    expect(scopes).not.toContain(DRIVE_SCOPE);
    // The grant is still what completing the consent records.
    expect(claimStoredOAuthFlow(kv, "oauth", 2)?.requestedResources)
      .toEqual([FOLDER, DRIVE_WRITES_GRANT]);
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
