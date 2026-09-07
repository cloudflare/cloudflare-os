import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPACITY_LIMITS } from "../src/capacity.js";

interface WranglerConfig {
  vars?: Record<string, string>;
  containers: Array<{
    class_name: string;
    image: string;
    instance_type: string;
    max_instances: number;
  }>;
  durable_objects: {
    bindings: Array<{ name: string; class_name: string }>;
  };
  migrations: Array<{
    tag: string;
    new_sqlite_classes?: string[];
  }>;
}

function readConfig(name: string): WranglerConfig {
  return JSON.parse(
    readFileSync(new URL(`../${name}`, import.meta.url), "utf8")
  ) as WranglerConfig;
}

const expectedClasses = [
  ["CodingSessionSandbox", "standard-1", 20],
  ["CodingSessionSandboxStandard2", "standard-2", CAPACITY_LIMITS["standard-2"].global],
  ["CodingSessionSandboxStandard3", "standard-3", CAPACITY_LIMITS["standard-3"].global],
  ["CodingSessionSandboxStandard4", "standard-4", CAPACITY_LIMITS["standard-4"].global],
  ["ProductFeedbackSandbox", "standard-1", 4],
] as const;

const expectedBindings = [
  ["SESSION_SANDBOX", "CodingSessionSandbox"],
  ["SESSION_SANDBOX_STANDARD_2", "CodingSessionSandboxStandard2"],
  ["SESSION_SANDBOX_STANDARD_3", "CodingSessionSandboxStandard3"],
  ["SESSION_SANDBOX_STANDARD_4", "CodingSessionSandboxStandard4"],
  ["PRODUCT_FEEDBACK_SANDBOX", "ProductFeedbackSandbox"],
  ["SESSION_CAPACITY", "CodingSessionCapacity"],
  ["SESSION_POLICIES", "CodingSessionPolicy"],
  ["SESSION_APPLICATION_PREVIEWS", "CodingSessionApplicationPreview"],
  ["SESSION_REGISTRIES", "CodingSessionRegistry"],
] as const;

describe.each([
  [
    "release",
    "wrangler.jsonc",
    "docker.io/cloudflare/sandbox@sha256:6c8e082085d0861ad3b359041abd4cdc750f5b0e29e7aa82bb87a9b557dbdc60",
  ],
  [
    "Odie production",
    "wrangler.odie-os-production.jsonc",
    "registry.cloudflare.com/286469790a4362a2e194b32045c5eca7/odie-os-coding-session@sha256:2d2edbdb0eb6e2ba382b878425dd928ad5b957862e5ad7450b062a9c75f1f01b",
  ],
])("%s capacity config", (_label, file, image) => {
  const config = readConfig(file);

  it("keeps every sandbox size on the pinned image with its pool limit", () => {
    expect(config.containers).toEqual(expectedClasses.map(
      ([class_name, instance_type, max_instances]) => ({
        class_name,
        image,
        instance_type,
        max_instances,
      })
    ));
  });

  it("binds the preview relay and its direct generation-check registry", () => {
    expect(config.durable_objects.bindings).toEqual(expectedBindings.map(
      ([name, class_name]) => ({ name, class_name })
    ));
  });

  it("keeps cookie-isolation verification absent from checked deployment configuration", () => {
    expect(config.vars?.APPLICATION_PREVIEW_COOKIE_ISOLATION_VERIFIED).toBeUndefined();
  });

  it("keeps the capacity and preview migrations before the feedback sandbox migration", () => {
    expect(config.migrations.at(-3)).toEqual({
      tag: "v3",
      new_sqlite_classes: [
        "CodingSessionSandboxStandard2",
        "CodingSessionSandboxStandard3",
        "CodingSessionSandboxStandard4",
        "CodingSessionCapacity",
      ],
    });
    expect(config.migrations.at(-2)).toEqual({
      tag: "v4",
      new_sqlite_classes: ["CodingSessionApplicationPreview"],
    });
    expect(config.migrations.at(-1)).toEqual({
      tag: "v5",
      new_sqlite_classes: ["ProductFeedbackSandbox"],
    });
  });
});

describe("durable lifecycle rollout config", () => {
  it("enables writers only for Odie production", () => {
    expect(readConfig("wrangler.odie-os-production.jsonc").vars?.CODING_SESSION_DURABLE_LIFECYCLE_ENABLED)
      .toBe("true");
    expect(readConfig("wrangler.jsonc").vars?.CODING_SESSION_DURABLE_LIFECYCLE_ENABLED)
      .toBeUndefined();
  });
});
