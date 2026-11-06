import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

export default defineConfig({
  plugins: [capnwebValidate(), cloudflareTest({
    main: "./__tests__/workerd/worker.ts",
    miniflare: {
      compatibilityDate: deployed.worker.compatibilityDate,
      compatibilityFlags: deployed.worker.compatibilityFlags,
      modulesRules: [{ type: "Text", include: ["**/*.txt", "**/*.svg"] }],
      bindings: { CLIENT_ID: "client", CLIENT_SECRET: "secret", GITHUB_URL: "https://git.example.com",
        GITHUB_API_URL: "https://api.example.com" },
      durableObjects: {
        USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
        GITHUB_GATEKEEPER: { className: "GitHubGatekeeperImpl", useSQLite: true },
        GITHUB_HOOK_DRIVER: { className: "GitHubHookDriver", useSQLite: true },
        SEEDED_GITHUB_GATEKEEPER: { className: "SeededGitHubGatekeeper", useSQLite: true },
        TEST_HOOKS: { className: "TestHooks", useSQLite: true },
      },
    },
  })],
  test: { include: ["__tests__/enterprise/*.test.ts"], setupFiles: ["../../scripts/assert-workerd.ts"] },
});
