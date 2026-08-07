// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    // Salesforce JWT credentials. SF_CLIENT_ID is the External Client App consumer key,
    // SF_USERNAME the integration user, SF_PRIVATE_KEY the RSA PKCS#8 private key (PEM),
    // SF_LOGIN_URL defaults to https://login.salesforce.com.
    SF_CLIENT_ID?: string;
    SF_USERNAME?: string;
    SF_PRIVATE_KEY?: string;
    SF_LOGIN_URL?: string;
    // Backend URL for the aggregate-sync handler (unused today; reserved).
    SF_BACKEND_URL?: string;
  }

  interface GlobalProps {
    // Populates Cloudflare.Exports, the type of ctx.exports.
    mainModule: typeof import("./index.js");
    // Storage classes exposed as DO namespaces on ctx.exports.
    durableNamespaces:
      | "SalesforceGatekeeper";
  }
}
