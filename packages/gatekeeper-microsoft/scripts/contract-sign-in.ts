// Signs one contract test user in, for the optional live suite: opens Microsoft's sign-in in a
// browser (so MFA and Conditional Access apply as they would for anyone), and saves the user's
// refresh token under their label in the tokens file the suite reads.
//
//   node scripts/contract-sign-in.ts <phillip|sarah|bob>
//
// Needs the app credentials in the root `.dev.vars` (MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET,
// MICROSOFT_TENANT_ID) and `http://localhost:8765/callback` among the app registration's Web
// redirect URIs. Writes `MICROSOFT_CONTRACT_TOKENS` (default
// ~/.config/gadgets-microsoft-contract/tokens.json), readable only by you. Never prints a token.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const TOKENS_FILE = process.env.MICROSOFT_CONTRACT_TOKENS ?? join(homedir(), ".config", "gadgets-microsoft-contract", "tokens.json");
const LABELS = ["phillip", "sarah", "bob"];
const REDIRECT_URI = "http://localhost:8765/callback";
/** Everything the gatekeeper asks a user for, so the suite can exercise every resource. */
const SCOPES = "openid profile email offline_access User.Read " + [
  "Sites.ReadWrite.All", "Files.ReadWrite.All", "Mail.ReadWrite", "Mail.ReadWrite.Shared", "Mail.Send", "Mail.Send.Shared",
  "MailboxSettings.ReadWrite", "People.Read", "User.ReadBasic.All", "Calendars.ReadWrite", "Calendars.ReadWrite.Shared",
].map(scope => `https://graph.microsoft.com/${scope}`).join(" ");

const label = process.argv[2];
if (!label || !LABELS.includes(label)) {
  console.error(`usage: node scripts/contract-sign-in.ts <${LABELS.join("|")}>`);
  process.exit(2);
}

const vars = existsSync(join(ROOT, ".dev.vars")) ? Object.fromEntries(readFileSync(join(ROOT, ".dev.vars"), "utf8").split("\n")
  .map(line => /^([A-Z0-9_]+)=(.*)$/.exec(line)).filter(match => match !== null).map(match => [match[1]!, match[2]!.trim()])) : {};
const { MICROSOFT_CLIENT_ID: clientId, MICROSOFT_CLIENT_SECRET: clientSecret, MICROSOFT_TENANT_ID: tenant } = vars;
if (!clientId || !clientSecret || !tenant) {
  console.error("Set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET and MICROSOFT_TENANT_ID in the repository's root .dev.vars first.");
  process.exit(1);
}

const authority = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
const verifier = randomBytes(32).toString("base64url");
const state = randomBytes(16).toString("base64url");
const signIn = new URL(`${authority}/authorize`);
signIn.search = new URLSearchParams({
  client_id: clientId, response_type: "code", redirect_uri: REDIRECT_URI, scope: SCOPES, state, prompt: "select_account",
  code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
}).toString();

type Stored = { refresh_token: string; tid: string; oid: string; upn: string; name: string };

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", REDIRECT_URI);
  if (url.pathname !== "/callback") {
    response.writeHead(404).end();
    return;
  }
  try {
    if (url.searchParams.get("error")) throw new Error(`${url.searchParams.get("error")}: ${url.searchParams.get("error_description")}`);
    if (url.searchParams.get("state") !== state) throw new Error("The sign-in answered a different request.");
    const answer = await fetch(`${authority}/token`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code: url.searchParams.get("code") ?? "",
        redirect_uri: REDIRECT_URI, code_verifier: verifier, scope: SCOPES,
      }),
    });
    const body = await answer.json() as { refresh_token?: string; id_token?: string; error?: string; error_description?: string };
    if (!answer.ok || !body.refresh_token || !body.id_token) throw new Error(body.error_description ?? body.error ?? `HTTP ${answer.status}`);
    const claims = JSON.parse(Buffer.from(body.id_token.split(".")[1]!, "base64url").toString()) as Record<string, string>;
    const stored: Record<string, Stored> = existsSync(TOKENS_FILE) ? JSON.parse(readFileSync(TOKENS_FILE, "utf8")) : {};
    stored[label] = { refresh_token: body.refresh_token, tid: claims.tid!, oid: claims.oid!, upn: claims.preferred_username!, name: claims.name! };
    mkdirSync(dirname(TOKENS_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(TOKENS_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
    chmodSync(TOKENS_FILE, 0o600);
    response.writeHead(200, { "content-type": "text/plain" }).end(`Signed in ${label} as ${claims.preferred_username}. You can close this tab.`);
    console.log(`Saved ${label} (${claims.preferred_username}) to ${TOKENS_FILE}.`);
  } catch (error) {
    response.writeHead(400, { "content-type": "text/plain" }).end(String(error instanceof Error ? error.message : error));
    console.error(`Sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(8765, "localhost", () => {
  console.log(`Sign ${label} in at:\n${signIn.href}`);
  if (process.platform === "darwin") execFile("open", [signIn.href]);
  else if (process.platform === "linux") execFile("xdg-open", [signIn.href], () => {});
});
setTimeout(() => {
  console.error("No sign-in within five minutes.");
  process.exit(1);
}, 5 * 60_000).unref();
