import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger as createBaseLogger } from "../src/logger.js";
import { createObservabilityContext } from "../src/observability-context.js";

type TestObservabilityFields = {
  accountId?: number;
  chatId?: number;
  collectionId?: string;
  gadgetId?: string;
  operation?: string;
  outcome?: string;
  vendorId?: string;
  providerRequestId?: string;
};

const obsContext = createObservabilityContext<TestObservabilityFields>();
const createLogger = obsContext.createLogger;

describe("worker logger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits the message and structured context as one indexed object", () => {
    let spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let logger = createLogger({ component: "workshop.user" });

    logger.warn("failed to load vendor", {
      event: "gatekeeper.vendor.load.failed",
      vendorId: "github",
    });

    expect(spy).toHaveBeenCalledWith({
      message: "failed to load vendor",
      event: "gatekeeper.vendor.load.failed",
      component: "workshop.user",
      vendorId: "github",
    });
  });

  it("derives immutable child loggers", () => {
    let spy = vi.spyOn(console, "info").mockImplementation(() => {});
    let logger = createLogger({ component: "workshop.user" });
    let accountLogger = logger.with({ accountId: 7 });

    accountLogger.info("account disconnected", {
      event: "account.disconnected",
      outcome: "ok",
    });
    logger.info("account listing finished", {
      event: "account.list.finished",
      outcome: "ok",
    });

    expect(spy.mock.calls[0]?.[0]).toMatchObject({ accountId: 7 });
    expect(spy.mock.calls[1]?.[0]).not.toHaveProperty("accountId");
  });

  it("chains child context with nearest values taking precedence", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = createLogger({
      component: "gatekeeper.context", vendorId: "context",
    });
    const collectionLogger = logger.with({
      operation: "collection.sync",
      collectionId: "collection-1",
      outcome: "started",
    });
    const retryLogger = collectionLogger.with({ collectionId: "collection-2" });

    retryLogger.info("collection sync finished", {
      event: "collection.sync.finished",
      outcome: "ok",
    });

    expect(spy).toHaveBeenCalledWith({
      message: "collection sync finished",
      component: "gatekeeper.context",
      vendorId: "context",
      operation: "collection.sync",
      collectionId: "collection-2",
      event: "collection.sync.finished",
      outcome: "ok",
    });
  });

  it("keeps explicit child context ahead of ambient context", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = createLogger({ component: "workshop.overseer" })
      .with({ operation: "agent.run" });

    obsContext.with({ operation: "ambient.operation" }, () => {
      logger.info("child wins", { event: "precedence.child" });
      logger.info("details win", { event: "precedence.details", operation: "log.call" });
    });

    expect(spy.mock.calls[0]?.[0]).toMatchObject({ operation: "agent.run" });
    expect(spy.mock.calls[1]?.[0]).toMatchObject({ operation: "log.call" });
  });

  it("pins component against ambient collisions", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = createLogger({ component: "workshop.overseer" });
    const runWithUnsafeContext = obsContext.with as unknown as (
      fields: Record<string, string>, callback: () => void,
    ) => void;

    runWithUnsafeContext({ component: "spoofed.component" }, () => {
      logger.info("component stays fixed", { event: "component.fixed" });
    });

    expect(spy.mock.calls[0]?.[0]).toMatchObject({ component: "workshop.overseer" });
  });

  it("adds package-local fields to child loggers", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logger = createLogger({ component: "workshop.agent" });
    const requestLogger = logger.with({ providerRequestId: "request-1" });

    requestLogger.debug("provider request started", { event: "provider.request.started" });

    expect(spy.mock.calls[0]?.[0]).toMatchObject({ providerRequestId: "request-1" });
  });

  it("inherits nested async context and restores its parent", async () => {
    let spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    let logger = createLogger({ component: "workshop.overseer" });

    await obsContext.with({ operation: "agent.run", gadgetId: "gadget-1" }, async () => {
      await obsContext.with({ chatId: 3 }, async () => {
        await Promise.resolve();
        logger.debug("nested", { event: "nested" });
      });
      logger.debug("parent", { event: "parent" });
    });

    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      operation: "agent.run",
      gadgetId: "gadget-1",
      chatId: 3,
    });
    expect(spy.mock.calls[1]?.[0]).not.toHaveProperty("chatId");
  });

  it("isolates concurrent async contexts", async () => {
    let spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    let logger = createLogger({ component: "workshop.overseer" });
    let ready = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });

    const runs = Promise.all([
      obsContext.with({ chatId: 1 }, async () => {
        ++ready;
        await gate;
        logger.debug("first", { event: "first" });
      }),
      obsContext.with({ chatId: 2 }, async () => {
        ++ready;
        await gate;
        logger.debug("second", { event: "second" });
      }),
    ]);
    expect(ready).toBe(2);
    release();
    await runs;
    logger.debug("outside", { event: "outside" });

    let logs = spy.mock.calls.map(([entry]) => entry);
    expect(logs).toContainEqual(expect.objectContaining({ event: "first", chatId: 1 }));
    expect(logs).toContainEqual(expect.objectContaining({ event: "second", chatId: 2 }));
    expect(logs.find(entry => entry.event === "outside")).not.toHaveProperty("chatId");
  });

  it("shares async context across independently created loggers", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const overseerLogger = createLogger({ component: "workshop.overseer" });
    const agentLogger = createLogger({ component: "workshop.agent" });

    await obsContext.with({ operation: "agent.run", gadgetId: "gadget-1", chatId: 3 }, async () => {
      overseerLogger.warn("overseer warning", { event: "overseer.warning" });
      await Promise.resolve();
      agentLogger.warn("agent warning", { event: "agent.warning" });
    });

    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      component: "workshop.overseer",
      operation: "agent.run",
      gadgetId: "gadget-1",
      chatId: 3,
    });
    expect(spy.mock.calls[1]?.[0]).toMatchObject({
      component: "workshop.agent",
      operation: "agent.run",
      gadgetId: "gadget-1",
      chatId: 3,
    });
  });

  it("does not impose ambient context on the base logger", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = createBaseLogger<{ operation?: string }>({ component: "gatekeeper.github" });

    obsContext.with({ operation: "agent.run" }, () => {
      logger.info("base logger event", { event: "base.logger.event" });
    });

    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty("operation");
  });

  it("preserves context after awaiting a custom thenable", async () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logger = createLogger({ component: "workshop.overseer" });
    const thenable: PromiseLike<void> = {
      // oxlint-disable-next-line unicorn/no-thenable -- Deliberately models an RPC promise.
      then(onfulfilled, onrejected) {
        return Promise.resolve().then(onfulfilled, onrejected);
      },
    };

    await obsContext.with({ operation: "agent.run" }, async () => {
      await thenable;
      logger.debug("after thenable", { event: "after.thenable" });
    });

    expect(spy.mock.calls[0]?.[0]).toMatchObject({ operation: "agent.run" });
  });

  it("normalizes errors and adds stacks at every level", () => {
    let errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let logger = createLogger({ component: "workshop.agent" });
    let error = new Error("boom");

    logger.error("agent failed", { event: "agent.failed", error });
    logger.warn("agent recovered", { event: "agent.recovered", error });

    expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
      error: "Error: boom",
      errorStack: expect.stringContaining("Error: boom"),
    });
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ error: "Error: boom" });
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({
      errorStack: expect.stringContaining("Error: boom"),
    });
  });

  it("omits undefined errors", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createLogger({ component: "workshop.agent" });

    logger.warn("undefined error", { event: "undefined.error", error: undefined });

    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty("error");
  });

  it("uses an own string message without serializing object contents", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createLogger({ component: "workshop.agent" });

    logger.warn("object error", {
      event: "object.error", error: { message: "safe summary", tokenValue: "do not log" },
    });

    expect(spy.mock.calls[0]?.[0]).toMatchObject({ error: "safe summary" });
    expect(JSON.stringify(spy.mock.calls[0]?.[0])).not.toContain("do not log");
  });

  it("does not traverse error causes or copy arbitrary properties", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createLogger({ component: "workshop.agent" });
    const cause = Object.assign(new Error("inner"), { tokenValue: "do not log" });
    const error = Object.assign(new Error("outer", { cause }), { responseBody: "do not log" });

    logger.warn("caused error", { event: "caused.error", error });

    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      error: "Error: outer",
      errorStack: expect.stringContaining("Error: outer"),
    });
    const serialized = JSON.stringify(spy.mock.calls[0]?.[0]);
    expect(serialized).not.toContain("Error: inner");
    expect(serialized).not.toContain("do not log");
  });
});

describe("observability context", () => {
  it("returns typed nested context and restores its parent", () => {
    obsContext.with({ operation: "agent.run" }, () => {
      expect(obsContext.get()).toEqual({ operation: "agent.run" });
      obsContext.with({ chatId: 3 }, () => {
        expect(obsContext.get()).toEqual({ operation: "agent.run", chatId: 3 });
      });
      expect(obsContext.get()).toEqual({ operation: "agent.run" });
    });
    expect(obsContext.get()).toEqual({});
  });
});
