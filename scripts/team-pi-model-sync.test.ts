import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/deploy-production.yml", import.meta.url), "utf8");
const step = workflow.split("- name: Sync Team PI Codex models\n")[1]?.split("- name:")[0];
assert.ok(step);
const script = step.match(/node -e '([^']+)'/)?.[1];
assert.ok(script);

test("model synchronization runs only after the backend metadata is deployed", () => {
  assert.ok(workflow.indexOf("- name: Sync Team PI Codex models") >
    workflow.indexOf("wrangler deploy --no-bundle --config workshop-backend/wrangler.json"));
});

test("production model sync puts Astra first without removing configured profiles", () => {
  const result = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, TEAM_PI_CODEX_MODELS: " gpt-5.6-sol,custom-model,gpt-6-astra,gpt-5.6-sol, " },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "gpt-6-astra,gpt-5.6-sol,custom-model");
  assert.match(step, /wrangler secret put TEAM_PI_CODEX_MODELS --name odie-os-backend/);
  assert.match(step, /TEAM_PI_CODEX_MODELS: \$\{\{ secrets\.TEAM_PI_CODEX_MODELS \}\}/);
});

test("production model sync rejects an empty configuration", () => {
  const result = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, TEAM_PI_CODEX_MODELS: " , " },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("invalid model configuration never invokes the Worker secret writer", () => {
  const shell = step.split("run: |\n")[1];
  assert.ok(shell);
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", `wrangler() { printf WRITER_CALLED; }\n${shell}`], {
    env: { ...process.env, TEAM_PI_CODEX_MODELS: " , " },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});
