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
          // The fake GitLab (fake-gitlab.ts) answers at this origin.
          GITLAB_URL: "https://gitlab.example.com",
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
