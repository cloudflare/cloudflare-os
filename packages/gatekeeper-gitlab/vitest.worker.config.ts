import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/**
 * The workerd project: sessions (RpcTarget), the account Durable Object's refresh-under-lock
 * behaviour, and the gatekeeper Durable Object reached through a `TestHooks` facet. The
 * `@validateRpc()` decorators are applied in-memory by the capnweb-validate plugin, since
 * `.wrangler/validate` is not built for tests.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        // Kept in step with wrangler.jsonc; a drift here tests a runtime we do not deploy.
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        modulesRules: [
          { type: "Text", include: ["**/*.txt", "**/*.svg"] },
        ],
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          GITLAB_GATEKEEPER: { className: "GitLabGatekeeperImpl", useSQLite: true },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
        },
        bindings: {
          CLIENT_ID: "test-client-id",
          CLIENT_SECRET: "test-client-secret",
          BASE_URL: "http://localhost:8787/gatekeeper/gitlab",
          // The README's Access-protected layout, which the fake GitLab (fake-gitlab.ts) plays:
          // users visit one origin, the Worker talks to another, and Access in front of that one
          // admits only the service token.
          GITLAB_URL: "https://gitlab.example.com",
          GITLAB_API_URL: "https://gitlab-api.example.com",
          CF_ACCESS_CLIENT_ID: "test-access-id",
          CF_ACCESS_CLIENT_SECRET: "test-access-secret",
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
