import assert from "node:assert/strict";
import test from "node:test";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { Writable } from "node:stream";
import { callbackStub, callbackTarget, drainingWriter, encodeArgs, functionStub, ndjsonEvents, type AnswerCall } from "./callbacks.ts";
import { table } from "../generated/commands.ts";
import type { Remote } from "./session.ts";

/**
 * A server whose `drive` calls each named method of the callback it is given, once, in order, and
 * whose `ask` asks a configuration callback for its choices, as `openGadget` does.
 */
class Driver extends RpcTarget {
  async drive(callback: Remote, methods: string[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const method of methods) results.push(await callback[method](method, new Date(0), 1n));
    return results;
  }
  async fire(callback: Remote, value: unknown): Promise<unknown> {
    return callback(value);
  }
  async ask(callback: Remote, needs: unknown): Promise<unknown> {
    return callback.configure(needs);
  }
}

/** An answer function for callbacks that must not be asked anything. */
const noAnswers: AnswerCall = (key) => assert.fail(`asked ${key}`);

function session(t: { after: (fn: () => void) => void }): Remote {
  const { port1, port2 } = new MessageChannel();
  newMessagePortRpcSession(port2, new Driver());
  const main = newMessagePortRpcSession(port1);
  t.after(() => {
    main[Symbol.dispose]();
    port1.close();
    port2.close();
  });
  return main;
}

test("a callback target answers every method its table entry lists, as prototype methods", async (t) => {
  // AiChatSubscriber is the API's widest: a subscriber missing `changeApplied` dies the
  // first time a change lands.
  const entry = table.callbacks.AiChatSubscriber;
  const names = entry.methods.map((method) => method.name);
  assert.ok(names.includes("changeApplied"));
  const events: [string, Record<string, unknown>][] = [];
  const target = callbackTarget("AiChatSubscriber", entry, (event, args) => void events.push([event, args]), noAnswers);
  assert.deepEqual(Object.getOwnPropertyNames(target), []);
  for (const name of names) assert.equal(typeof Object.getPrototypeOf(target)[name], "function");

  const main = session(t);
  const stub = callbackStub("AiChatSubscriber", entry, (event, args) => void events.push([event, args]), noAnswers);
  assert.deepEqual(await main.drive(stub, names), names.map(() => undefined));
  stub[Symbol.dispose]();
  assert.deepEqual(events.map(([event]) => event), names);
  // Keyed by the parameter names the table gives.
  const [first] = entry.methods;
  assert.deepEqual(events[0][1], { [first.params[0]]: first.name, [first.params[1]]: new Date(0), [first.params[2]]: 1n });
});

test("every callback interface in the table gets its own complete target", async (t) => {
  const main = session(t);
  const asked: string[] = [];
  for (const [name, entry] of Object.entries(table.callbacks)) {
    const seen: string[] = [];
    const answer: AnswerCall = (key) => {
      asked.push(key);
      return `answer to ${key}`;
    };
    const stub = callbackStub(name, entry, (event) => void seen.push(event), answer);
    const results = await main.drive(stub, entry.methods.map((method) => method.name));
    stub[Symbol.dispose]();
    // Methods returning nothing are events; those returning a value are answered, and the server
    // gets the answer.
    const events = entry.methods.filter((method) => !method.answer);
    assert.deepEqual(seen, events.map((method) => method.name), name);
    assert.deepEqual(results, entry.methods.map((method) => method.answer ? `answer to ${name}.${method.name}` : undefined), name);
  }
  assert.ok(asked.includes("ObserverConfigCallback.configure"), asked.join(", "));
});

test("an answer method returns the answer to the server, asked with its arguments keyed by parameter name", async (t) => {
  const main = session(t);
  const calls: [string, Record<string, unknown>][] = [];
  const choices = [{ accountId: 7, gatekeeperId: 3 }];
  const entry = table.callbacks.ObserverConfigCallback;
  const stub = callbackStub("ObserverConfigCallback", entry, () => assert.fail("emitted an event"), (key, args) => {
    calls.push([key, args]);
    return choices;
  });
  const needs = [{ gatekeeperId: 3, resourceTitle: "Mail", vendorId: "google" }];
  assert.deepEqual(await main.ask(stub, needs), choices);
  stub[Symbol.dispose]();
  assert.deepEqual(calls, [["ObserverConfigCallback.configure", { needs }]]);
});

test("an answer function that throws refuses the call: the server's call rejects with its message", async (t) => {
  const main = session(t);
  const stub = callbackStub("ObserverConfigCallback", table.callbacks.ObserverConfigCallback, () => undefined, () => {
    throw new Error("no --answer for ObserverConfigCallback.configure");
  });
  await assert.rejects(Promise.resolve(main.ask(stub, [])), /no --answer for ObserverConfigCallback\.configure/);
  stub[Symbol.dispose]();
});

test("a bare-function callback emits events named after its parameter, keyed by the function's", async (t) => {
  const main = session(t);
  const events: [string, Record<string, unknown>][] = [];
  const stub = functionStub("callback", ["metadata"], (event, args) => void events.push([event, args]));
  assert.equal(await main.fire(stub, { title: "x" }), undefined);
  stub[Symbol.dispose]();
  assert.deepEqual(events, [["callback", { metadata: { title: "x" } }]]);
});

test("a callback's arguments encode as results do", () => {
  assert.deepEqual(encodeArgs({ size: 3n, when: new Date(0), body: new Uint8Array([1]), gone: undefined }),
    { size: "3", when: "1970-01-01T00:00:00.000Z", body: { base64: "AQ==" }, gone: null });
});

test("events are NDJSON lines, their arguments encoded as results are", () => {
  const lines: string[] = [];
  ndjsonEvents((line) => void lines.push(line))("added", { note: { when: new Date(0), size: 3n, body: new Uint8Array([1]) }, extra: undefined });
  assert.deepEqual(lines, ['{"event":"added","args":{"note":{"when":"1970-01-01T00:00:00.000Z","size":"3","body":{"base64":"AQ=="}},"extra":null}}\n']);
});

test("while stdout is full, an event's call returns only once it drains: the server is held back", async (t) => {
  const main = session(t);
  // A reader that takes nothing until released.
  const taken: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => release = resolve);
  const stdout = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, done) {
      void released.then(() => {
        taken.push(chunk.toString());
        done();
      });
    },
  });
  const stub = functionStub("callback", ["value"], ndjsonEvents(drainingWriter(stdout)));
  let delivered = false;
  const fired = Promise.resolve(main.fire(stub, 1)).then((result) => {
    delivered = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(delivered, false);
  release();
  assert.equal(await fired, undefined);
  stub[Symbol.dispose]();
  assert.deepEqual(taken, ['{"event":"callback","args":{"value":1}}\n']);

  // With room to spare, nothing waits.
  assert.equal(drainingWriter(new Writable({ write: (_chunk, _encoding, done) => done() }))("x"), undefined);
});
