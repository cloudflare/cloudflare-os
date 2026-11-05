import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/**
 * The live contract suite: the gatekeeper against a real Microsoft 365 tenant, as real users. It is
 * opt-in and never part of `test`, since it needs an app registration, signed-in test users, and a
 * tenant set up to match: see the README's "Live suite".
 *
 * The app's `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` and `MICROSOFT_TENANT_ID` come from the
 * root `.dev.vars`; each user's refresh token from the 0600 file `MICROSOFT_CONTRACT_TOKENS` names
 * (default `~/.config/gadgets-microsoft-contract/tokens.json`), which `contract:sign-in` writes.
 * Tokens are redeemed here, in Node, and the rotated refresh tokens written back, so the suite never
 * needs a browser. With either missing, the suite skips.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const TOKENS_FILE = process.env.MICROSOFT_CONTRACT_TOKENS ?? join(homedir(), ".config", "gadgets-microsoft-contract", "tokens.json");
const SCOPES = "openid profile email offline_access User.Read " +
  "https://graph.microsoft.com/Sites.ReadWrite.All https://graph.microsoft.com/Files.ReadWrite.All " +
  ["Mail.ReadWrite", "Mail.Send", "Mail.ReadWrite.Shared", "Mail.Send.Shared", "MailboxSettings.ReadWrite", "People.Read", "Calendars.ReadWrite"]
    .map(scope => `https://graph.microsoft.com/${scope}`).join(" ");

type StoredUser = { refresh_token: string; tid: string; oid: string; upn: string; name: string };

/** What the suite gets per user. The refresh token lets the account refresh as it would in production. */
export type ContractAccount = {
  label: string; tenantId: string; objectId: string; name: string; username: string;
  accessToken: string; refreshToken: string; expiresAt: number; scopes: string[];
};

function devVars(): Record<string, string> {
  const path = join(ROOT, ".dev.vars");
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, "utf8").split("\n")
    .map(line => /^([A-Z0-9_]+)=(.*)$/.exec(line)).filter(match => match !== null).map(match => [match[1], match[2].trim()]));
}

async function contractAccounts(vars: Record<string, string>): Promise<ContractAccount[]> {
  const { MICROSOFT_CLIENT_ID: id, MICROSOFT_CLIENT_SECRET: secret, MICROSOFT_TENANT_ID: tenant } = vars;
  if (!id || !secret || !tenant || !existsSync(TOKENS_FILE)) return [];
  const stored = JSON.parse(readFileSync(TOKENS_FILE, "utf8")) as Record<string, StoredUser>;
  const accounts: ContractAccount[] = [];
  for (const [label, user] of Object.entries(stored)) {
    const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "refresh_token", refresh_token: user.refresh_token, scope: SCOPES }),
    });
    const body = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
    if (!response.ok || !body.access_token || !body.refresh_token) {
      throw new Error(`Couldn't redeem ${label}'s refresh token (${body.error ?? response.status}). Sign them in again.`);
    }
    user.refresh_token = body.refresh_token;
    accounts.push({
      label, tenantId: user.tid, objectId: user.oid, name: user.name, username: user.upn,
      accessToken: body.access_token, refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000, scopes: (body.scope ?? "").split(" "),
    });
  }
  writeFileSync(TOKENS_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
  chmodSync(TOKENS_FILE, 0o600);
  return accounts;
}

export default defineConfig(async () => {
  const vars = devVars();
  const accounts = await contractAccounts(vars);
  return {
    plugins: [
      capnwebValidate(),
      cloudflareTest({
        main: "./__tests__/workerd/worker.ts",
        miniflare: {
          compatibilityDate: "2026-09-04",
          compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
          modulesRules: [{ type: "Text", include: ["**/*.txt", "**/*.svg"] }],
          durableObjects: {
            USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
            SHAREPOINT_GATEKEEPER: { className: "SharePointGatekeeper", useSQLite: true },
            OUTLOOK_GATEKEEPER: { className: "OutlookGatekeeper", useSQLite: true },
            OUTLOOK_HOOK_DRIVER: { className: "OutlookHookDriver", useSQLite: true },
            CALENDAR_GATEKEEPER: { className: "CalendarGatekeeper", useSQLite: true },
            TEST_HOOKS: { className: "TestHooks", useSQLite: true },
          },
          bindings: {
            CLIENT_ID: vars.MICROSOFT_CLIENT_ID ?? "",
            CLIENT_SECRET: vars.MICROSOFT_CLIENT_SECRET ?? "",
            MICROSOFT_TENANT_ID: vars.MICROSOFT_TENANT_ID ?? "",
            // A public https URL here (a tunnel) lets the hooks test make real Graph subscriptions.
            BASE_URL: process.env.MICROSOFT_CONTRACT_BASE_URL ?? "http://localhost:8787/gatekeeper/microsoft",
            CONTRACT_ACCOUNTS: JSON.stringify(accounts),
          },
        },
      }),
    ],
    test: {
      include: ["__tests__/contract/*.test.ts"],
      setupFiles: ["../../scripts/assert-workerd.ts"],
      // Real Graph: a write's effect can take seconds to show in a listing.
      testTimeout: 60_000,
      // One tenant, one set of seeded objects: files run one after another.
      fileParallelism: false,
    },
  };
});
