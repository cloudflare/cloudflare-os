// Salesforce JWT bearer auth. In-memory access token only; the private key is never logged.
// The `aud` claim must be the login host itself (login.salesforce.com / test.salesforce.com), not
// the token endpoint. This follows the pattern proven by the touchless outbound-console worker.

export interface SalesforceAuthConfig {
  clientId: string;
  username: string;
  privateKeyPem: string;
  loginUrl?: string;
}

export interface SalesforceAccessToken {
  accessToken: string;
  instanceUrl: string;
  apiVersion: string;
  issuedAt: number;
  expiresAt: number;
}

const DEFAULT_API_VERSION = "v60.0";
const TOKEN_LIFETIME_MS = 10 * 60 * 1000; // SF JWT tokens are valid for up to 10 min

const ALLOWED_SF_HOST_SUFFIXES = [
  ".salesforce.com",
  ".force.com",
  ".salesforce-setup.com",
];

function isAllowedSalesforceHost(loginUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(loginUrl);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return ALLOWED_SF_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
  );
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  // Requires a PKCS #8 PEM. PKCS #1 "BEGIN RSA PRIVATE KEY" keys should be converted by the
  // operator before deployment.
  return crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64urlEncode(input: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let str = "";
  for (let i = 0; i < input.length; i += 3) {
    const a = input[i];
    const b = input[i + 1] ?? 0;
    const c = input[i + 2] ?? 0;
    str += chars[a >> 2];
    str += chars[((a & 3) << 4) | (b >> 4)];
    str += i + 1 < input.length ? chars[((b & 15) << 2) | (c >> 6)] : "=";
    str += i + 2 < input.length ? chars[c & 63] : "=";
  }
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64url(input: string | Uint8Array): string {
  if (typeof input === "string") {
    return base64urlEncode(new TextEncoder().encode(input));
  }
  return base64urlEncode(input);
}

function makeJwtHeader(): string {
  return base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
}

function makeJwtClaims(
  issuer: string,
  subject: string,
  audience: string,
  expirySeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  return base64url(
    JSON.stringify({
      iss: issuer,
      sub: subject,
      aud: audience,
      exp: now + expirySeconds,
      iat: now,
    }),
  );
}

async function signJwt(
  header: string,
  claims: string,
  privateKey: CryptoKey,
): Promise<string> {
  const signingInput = `${header}.${claims}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${base64url(signature)}`;
}

export class SfAuthError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SfAuthError";
  }
}

export async function authenticateWithJwt(
  config: SalesforceAuthConfig,
  now: () => number = Date.now,
): Promise<SalesforceAccessToken> {
  const loginUrl = (config.loginUrl ?? "https://login.salesforce.com").replace(/\/+$/, "");
  if (!isAllowedSalesforceHost(loginUrl)) {
    throw new SfAuthError(`Salesforce host not in allowlist: ${new URL(loginUrl).hostname}`);
  }
  const tokenEndpoint = `${loginUrl}/services/oauth2/token`;

  const privateKey = await importRsaPrivateKey(config.privateKeyPem);

  const header = makeJwtHeader();
  const claims = makeJwtClaims(config.clientId, config.username, loginUrl, 120);
  const jwtAssertion = await signJwt(header, claims, privateKey);

  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwtAssertion,
  });

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    let message = `Salesforce JWT auth failed: ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string; error_description?: string };
      if (body.error_description) message = `Salesforce JWT auth failed: ${body.error_description}`;
      else if (body.error) message = `Salesforce JWT auth failed: ${body.error}`;
    } catch {
      // Ignore malformed JSON error bodies.
    }
    throw new SfAuthError(message, response.status);
  }

  const tokenData = (await response.json()) as {
    access_token?: string;
    instance_url?: string;
    issued_at?: string;
  };
  if (!tokenData.access_token || !tokenData.instance_url) {
    throw new SfAuthError("Salesforce JWT auth response missing access_token or instance_url");
  }

  const issuedAt = tokenData.issued_at
    ? Number.parseInt(tokenData.issued_at, 10)
    : now();

  return {
    accessToken: tokenData.access_token,
    instanceUrl: tokenData.instance_url,
    apiVersion: DEFAULT_API_VERSION,
    issuedAt,
    expiresAt: issuedAt + TOKEN_LIFETIME_MS,
  };
}
