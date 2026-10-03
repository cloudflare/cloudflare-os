import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_MODEL } from "./config.js";
import setup from "./global-setup.js";

const environment = process.env;

afterEach(() => {
  process.env = environment;
  vi.restoreAllMocks();
});

it("warns once that an overridden model is not comparable to published baselines", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  process.env = { ...environment, WORKSHOP_EVAL_MODELS: `${DEFAULT_MODEL}, @cf/zai-org/glm-5.2` };
  setup();
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.[0]).toContain("@cf/zai-org/glm-5.2");
  expect(warn.mock.calls[0]?.[0]).not.toContain(`selects ${DEFAULT_MODEL}`);

  warn.mockClear();
  process.env = { ...environment, WORKSHOP_EVAL_MODELS: "" };
  setup();
  expect(warn).not.toHaveBeenCalled();
});
