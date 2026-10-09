import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

/**
 * No `vars`: GITLAB_URL defaults to https://gitlab.com in code, and GITLAB_API_URL to GITLAB_URL,
 * so an unconfigured deployment talks to gitlab.com. Self-hosted instances set the vars (and,
 * behind Cloudflare Access, the CF_ACCESS_CLIENT_ID/SECRET secrets) per deployment.
 */
export default defineGadgetsWorker({
  name: "gatekeeper-gitlab",
  entrypoint: ".wrangler/validate/src/gitlab.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "GitLabGatekeeperImpl"] },
];
