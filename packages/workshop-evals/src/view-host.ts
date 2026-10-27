import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import { z } from "zod";

// Runs a `<gadget-ui>` view as the Workshop does, so an eval can see what it does: in an
// opaque-origin srcdoc frame with `sandbox="allow-scripts"` (GadgetUiBlockCard.tsx), in headless
// Chromium. A view is model-written code, so it runs only there, never in this process. Every
// request it makes is blocked and recorded, as the Workshop's frame has no network.

/** The view's text, and whether it showed what a check waited for before the wait ran out. */
export type TextWait = { pass: boolean; text: string };

/** The browser failed, not the view: the run says nothing about the agent's work. */
export class ViewHostError extends Error {
  override name = "ViewHostError";
}

// The chat column the frame sits in, and a phone's.
const FRAME_WIDTH = 720;
const PHONE_WIDTH = 360;
const FRAME_HEIGHT = 1_000;
const VIEWPORT = { width: FRAME_WIDTH + 40, height: FRAME_HEIGHT + 40 };

// How long a view gets to load, to show what a check expects, and to react to one interaction. A
// frame call that takes longer means the view's code holds the page.
const SETTLE_MS = 15_000;
const WAIT_MS = 10_000;
const COMMIT_MS = 2_000;
const FRAME_CALL_MS = 15_000;
const POLL_MS = 100;

// Runs in the view's frame before any of its code: `agent` shaped as the Workshop's bootstrap
// makes it (uiBlockFrame.ts), the records the checks read, and `__evalView`, the host's helpers.
// The view can reach all of it, so the host trusts nothing it returns.
const FRAME_SCRIPT = String.raw`(() => {
  if (location.href !== "about:srcdoc") return;
  // The Workshop's default Trusted Types policy (uiBlockFrame.ts), which TRUSTED_TYPES_CSP makes
  // the only one: a view may clear an element with "" but parse no other string as HTML.
  globalThis.trustedTypes?.createPolicy("default", { createHTML: html => html === "" ? html : null });
  const bridge = (...args) => window.__evalViewBridge(...args);
  const report = (kind, detail) => { bridge("record", kind, String(detail).slice(0, 500)).catch(() => {}); };
  const state = { pending: 0, started: 0 };

  addEventListener("error", event => report("error", event.error?.message ?? event.message));
  addEventListener("unhandledrejection", event => report("error", event.reason?.message ?? event.reason));

  // HTML parsed from a string. Clearing with "" is fine.
  const markup = (name, html) => {
    if (String(html ?? "").trim() !== "") report("markup", name + ": " + String(html).slice(0, 200));
  };
  for (const [proto, name] of [[Element.prototype, "innerHTML"], [Element.prototype, "outerHTML"], [ShadowRoot.prototype, "innerHTML"]]) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, { ...descriptor, set(html) { markup(name, html); descriptor.set.call(this, html); } });
  }
  for (const [proto, name, index] of [[Element.prototype, "insertAdjacentHTML", 1], [Element.prototype, "setHTMLUnsafe", 0],
      [ShadowRoot.prototype, "setHTMLUnsafe", 0], [Range.prototype, "createContextualFragment", 0],
      [Document.prototype, "write"], [Document.prototype, "writeln"]]) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    proto[name] = function (...args) { markup(name, index === undefined ? args.join("") : args[index]); return original.apply(this, args); };
  }

  // Elements with a handler for a click or an edit, which a click may have to reach.
  const INTERACTIVE = ["click", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "change", "input"];
  const listening = new Set();
  const addEventListener_ = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, ...rest) {
    if (this instanceof Element && INTERACTIVE.includes(type)) listening.add(this);
    return addEventListener_.call(this, type, ...rest);
  };
  for (const proto of [HTMLElement.prototype, SVGElement.prototype]) {
    for (const type of INTERACTIVE) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, "on" + type);
      if (!descriptor?.set) continue;
      Object.defineProperty(proto, "on" + type, { ...descriptor, set(handler) { if (handler) listening.add(this); descriptor.set.call(this, handler); } });
    }
  }
  const listens = el => listening.has(el) || INTERACTIVE.some(type => el.hasAttribute("on" + type));

  const track = promise => {
    state.started++;
    state.pending++;
    const done = () => { state.pending--; };
    promise.then(done, done);
    return promise;
  };
  globalThis.agent = Object.freeze({ send: message => track(bridge("send", message)) });

  const norm = text => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const visible = el => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
  const label = el => [el instanceof HTMLElement ? el.innerText : el.textContent, el.getAttribute("aria-label"),
    el.getAttribute("title"), [...el.children].find(child => child.tagName === "title")?.textContent].filter(Boolean).join(" ");
  const named = (el, text) => norm(label(el)).includes(norm(text));
  const describe = el => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + ' "' + norm(label(el)).slice(0, 40) + '"';
  const registry = [];
  const register = (el, stage) => ({ id: registry.push(el) - 1, description: describe(el), stage });
  const CONTROLS = "input:not([type=hidden]), button, select, textarea, a[href], [role=button], [role=checkbox], [role=switch], [role=radio], [role=option], [tabindex]";
  const center = box => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });

  // The element that names the item, then what a user would reach for beside it: the controls
  // and handlers in its row (the largest box around it that names no other item), then, for a
  // chart, the nearest element with a handler in line with it.
  const targets = (text, others) => {
    const elements = [...document.body.querySelectorAll("*")].filter(el =>
      !["SCRIPT", "STYLE", "TITLE"].includes(el.tagName) && visible(el) && named(el, text));
    const deepest = elements.filter(el => !elements.some(other => other !== el && el.contains(other)));
    const found = [];
    const add = (el, stage) => { if (found.length < 8 && !found.some(entry => registry[entry.id] === el)) found.push(register(el, stage)); };
    for (const el of deepest.slice(0, 2)) add(el, "label");
    const first = deepest[0];
    if (first === undefined) return found;
    const namesOther = el => others.some(other => named(el, other));
    let row = first;
    for (let up = first.parentElement; up && up !== document.body && !namesOther(up); up = up.parentElement) row = up;
    const inRow = [...row.querySelectorAll("*")].filter(el => visible(el) && !el.disabled && (el.matches(CONTROLS) || listens(el)));
    for (let up = first; up && up !== row.parentElement; up = up.parentElement) if (listens(up)) inRow.push(up);
    inRow.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    for (const el of inRow) add(el, "row");
    const at = center(first.getBoundingClientRect());
    const near = [...listening].filter(el => el.isConnected && visible(el) && !el.contains(first) && !namesOther(el))
      .map(el => ({ el, box: el.getBoundingClientRect() }))
      .filter(({ box }) => (box.left <= at.x && at.x <= box.right) || (box.top <= at.y && at.y <= box.bottom))
      .sort((a, b) => Math.hypot(center(a.box).x - at.x, center(a.box).y - at.y) - Math.hypot(center(b.box).x - at.x, center(b.box).y - at.y));
    for (const { el } of near.slice(0, 2)) add(el, "near");
    return found;
  };

  const sameValue = (value, wanted) => norm(value) === norm(wanted) || (norm(value) !== "" && Number(value) === Number(wanted));

  const ops = {
    state: () => ({ pending: state.pending, started: state.started, loaded: document.readyState === "complete" }),
    frames: count => new Promise(resolve => {
      const step = left => left === 0 ? resolve(ops.state()) : requestAnimationFrame(() => step(left - 1));
      step(count);
    }),
    text: () => {
      const labels = [...document.body.querySelectorAll("svg title")].map(el => el.textContent);
      for (const el of document.body.querySelectorAll("[aria-label], [title]")) labels.push(el.getAttribute("aria-label"), el.getAttribute("title"));
      return [document.body.innerText, ...labels].filter(Boolean).join("\n");
    },
    visible: () => document.body.innerText.trim() !== "" || [...document.body.querySelectorAll("svg, canvas, img")].some(visible),
    targets,
    aim: id => {
      const el = registry[id];
      el.scrollIntoView({ block: "center", inline: "center" });
      const { x, y } = center(el.getBoundingClientRect());
      const hit = document.elementFromPoint(x, y);
      return { x, y, hits: hit !== null && (hit === el || el.contains(hit)) };
    },
    dispatch: id => {
      const el = registry[id];
      if (el instanceof HTMLElement) el.click();
      else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    },
    // Sets the first control holding "from" to "to", as a user's edit would, and returns it.
    setValue: (from, to) => {
      const control = [...document.body.querySelectorAll("input, select, textarea")].find(el =>
        !["checkbox", "radio", "hidden", "button", "submit", "reset", "file"].includes(el.type) &&
        !el.disabled && sameValue(el.value, from));
      if (control === undefined) return null;
      if (control instanceof HTMLSelectElement) {
        const option = [...control.options].find(option => sameValue(option.value, to) || sameValue(option.text, to));
        if (option === undefined) return null;
        control.value = option.value;
      } else {
        control.value = to;
      }
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      return register(control, "control").id;
    },
    // The button beside an element showing "from" alone that moves it toward "to".
    stepper: (from, to) => {
      const raise = Number(to) > Number(from);
      const sign = raise ? /^[+＋▲↑]$/ : /^[-−–▼↓]$/;
      const word = raise ? /increase|increment|more|plus|add|up/i : /decrease|decrement|less|minus|remove|down/i;
      const shows = [...document.body.querySelectorAll("*")].filter(el => el.children.length === 0 && visible(el) && sameValue(el.textContent, from));
      for (const el of shows) {
        for (let up = el.parentElement, depth = 0; up && depth < 3; up = up.parentElement, depth++) {
          const button = [...up.querySelectorAll("button, [role=button]")].find(candidate => visible(candidate) &&
            (sign.test(candidate.textContent.trim()) || word.test(candidate.getAttribute("aria-label") ?? candidate.getAttribute("title") ?? "")));
          if (button) return register(button, "control").id;
        }
      }
      return null;
    },
    submitButtons: () => [...document.body.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")]
      .filter(el => visible(el) && /calc|split|update|apply|compute|total|\bgo\b|=/i.test(label(el) || el.value || ""))
      .slice(0, 3).map(el => register(el, "control")),
    overflow: () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    viewportHeights: () => {
      const found = [];
      const check = (where, style) => {
        for (const name of style) {
          const value = style.getPropertyValue(name);
          if (/\d[sdl]?vh\b/i.test(value)) found.push(where + " { " + name + ": " + value + " }");
        }
      };
      const visit = rules => {
        for (const rule of rules) {
          if (rule.cssRules) visit(rule.cssRules);
          if (rule.style) check(rule.selectorText ?? "@" + rule.constructor.name, rule.style);
        }
      };
      for (const sheet of document.styleSheets) visit(sheet.cssRules);
      for (const el of document.body.querySelectorAll("[style]")) check(describe(el), el.style);
      return found;
    },
  };
  Object.defineProperty(window, "__evalView", { value: (op, ...args) => ops[op](...args) });
})();`;

const StateSchema = z.object({ pending: z.number(), started: z.number(), loaded: z.boolean() });
const AimSchema = z.object({ x: z.number(), y: z.number(), hits: z.boolean() });
const TargetSchema = z.object({
  id: z.number(),
  description: z.string(),
  stage: z.enum(["label", "row", "near", "control"]),
});
const TargetsSchema = z.array(TargetSchema);
const ControlSchema = z.number().nullable();

const TIMED_OUT = Symbol("timed out");

async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  const controller = new AbortController();
  try {
    return await Promise.race([work, delay(ms, TIMED_OUT, { signal: controller.signal })]);
  } finally {
    controller.abort();
  }
}

// The view's document, with the Workshop's Trusted Types CSP (uiBlockFrame.ts). It leaves out the
// rest of the Workshop's CSP, which would stop the view's requests before they are recorded.
const TRUSTED_TYPES_CSP = `<meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'; trusted-types gadget-ui default">`;

function viewDocument(html: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1">${TRUSTED_TYPES_CSP}</head>
<body>
${html}
</body>
</html>`;
}

const SHELL = `<!DOCTYPE html><body style="margin:0"><iframe sandbox="allow-scripts"
  style="border:0;width:${FRAME_WIDTH}px;height:${FRAME_HEIGHT}px"></iframe></body>`;

let browser: Promise<Browser> | undefined;

function launchBrowser(): Promise<Browser> {
  browser ??= chromium.launch().then(launched => {
    launched.on("disconnected", () => { browser = undefined; });
    return launched;
  }, (error: unknown) => {
    browser = undefined;
    throw new ViewHostError("Chromium did not start", { cause: error });
  });
  return browser;
}

/** Closes the browser this process runs views in, if one started. */
export async function closeViewBrowser(): Promise<void> {
  const running = browser;
  browser = undefined;
  await (await running?.catch(() => undefined))?.close();
}

/** A view running in its own browser context. Dispose it to close the page. */
export class RenderedView implements AsyncDisposable {
  /** Uncaught errors and rejections in the view's code, as the Workshop would show them. */
  readonly errors: string[] = [];
  /** What the view tried to fetch or connect to. All of it was blocked. */
  readonly requests: string[] = [];
  /** HTML the view parsed from strings, through innerHTML and the like. */
  readonly markup: string[] = [];
  /** What the view asked the user to send, through agent.send. */
  readonly messages: unknown[] = [];
  /** Why the view never settled, if it did not. */
  unsettled: string | undefined;

  readonly #context: BrowserContext;
  #page: Page | undefined;
  #frame: Frame | undefined;
  #crash: string | undefined;
  #stuck: string | undefined;
  #closed = false;

  private constructor(context: BrowserContext) {
    this.#context = context;
  }

  /**
   * Runs `html`, the HTML of a `<gadget-ui>` block, and waits until it settles: loaded, with no
   * `agent.send` pending. A view that never settles still opens, with `unsettled` set.
   */
  static async open(html: string): Promise<RenderedView> {
    const launched = await launchBrowser();
    let view: RenderedView | undefined;
    try {
      view = new RenderedView(await launched.newContext({ viewport: VIEWPORT }));
      await view.#start();
    } catch (error) {
      await view?.[Symbol.asyncDispose]();
      throw error instanceof ViewHostError ? error
        : new ViewHostError("Chromium could not open the view's page", { cause: error });
    }
    try {
      await view.#load(html);
      return view;
    } catch (error) {
      await view[Symbol.asyncDispose]();
      throw view.#hostError(error);
    }
  }

  async #start(): Promise<void> {
    const context = this.#context;
    await context.exposeBinding("__evalViewBridge", (_source, ...args: unknown[]) => this.#bridge(args));
    await context.addInitScript({ content: FRAME_SCRIPT });
    await context.route("**/*", route => {
      this.requests.push(route.request().url());
      return route.abort();
    });
    await context.routeWebSocket(/.*/, socket => {
      this.requests.push(socket.url());
      return socket.close();
    });
    const page = await context.newPage();
    page.on("crash", () => { this.#crash = "The view's page crashed"; });
    await page.setContent(SHELL);
    this.#page = page;
  }

  async #load(html: string): Promise<void> {
    const page = this.#requirePage();
    const loaded = await within(page.evaluate(`new Promise(resolve => {
      const frame = document.querySelector("iframe");
      frame.addEventListener("load", resolve, { once: true });
      frame.srcdoc = ${JSON.stringify(viewDocument(html))};
    })`), SETTLE_MS);
    if (loaded === TIMED_OUT) {
      this.#stuck = "The view did not finish loading: its code may be holding the page";
      this.unsettled = this.#stuck;
      return;
    }
    this.#frame = page.mainFrame().childFrames().at(0);
    await this.#settle();
  }

  /** The view's text as it reads on screen, with its SVG titles and its labels. */
  text(): Promise<string> {
    return this.#guard(() => this.#text());
  }

  /** Whether the view shows anything: text, or a drawing with a size. */
  visible(): Promise<boolean> {
    return this.#guard(async () => z.boolean().parse(await this.#frameCall("visible")));
  }

  /** Waits until the view's text passes `test`, or the wait runs out. */
  waitForText(test: (text: string) => boolean): Promise<TextWait> {
    return this.#guard(() => this.#waitForText(test, WAIT_MS));
  }

  /**
   * Clicks the item `label` names, as a user would: the element that names it first, then the
   * controls beside it, until a click makes the view call `agent.send`. `others` names the other
   * items, so "beside it" stops short of them. Returns what it tried.
   */
  click(label: string, others: readonly string[]): Promise<string[]> {
    return this.#guard(async () => {
      const tried: string[] = [];
      for (const target of TargetsSchema.parse(await this.#frameCall("targets", label, [...others]))) {
        const before = await this.#state();
        const aim = AimSchema.parse(await this.#frameCall("aim", target.id));
        if (target.stage === "label" || aim.hits) {
          await this.#mouseClick(aim.x, aim.y);
          tried.push(`clicked ${target.description}`);
        } else {
          await this.#frameCall("dispatch", target.id);
          tried.push(`dispatched a click on ${target.description}`);
        }
        const after = StateSchema.parse(await this.#frameCall("frames", 2));
        if (after.started > before.started) {
          await this.#settle();
          return tried;
        }
      }
      return tried;
    });
  }

  /**
   * Changes the value the view shows as `from` to `to`, as a user would, and waits until the
   * view's text passes `until`: an edit of the control holding it, then Enter, then a button
   * such as "Calculate"; or the stepper beside it.
   */
  setValue(from: string, to: string, until: (text: string) => boolean):
      Promise<TextWait & { how: string }> {
    return this.#guard(async () => {
      const control = ControlSchema.parse(await this.#frameCall("setValue", from, to));
      if (control !== null) {
        let wait = await this.#waitForText(until, COMMIT_MS);
        if (wait.pass) return { ...wait, how: `changed the control holding ${from}` };
        await this.#clickTarget(control);
        await this.#requirePage().keyboard.press("Enter");
        wait = await this.#waitForText(until, COMMIT_MS);
        if (wait.pass) return { ...wait, how: "changed the control and pressed Enter" };
        for (const button of TargetsSchema.parse(await this.#frameCall("submitButtons"))) {
          await this.#clickTarget(button.id);
          wait = await this.#waitForText(until, COMMIT_MS);
          if (wait.pass) return { ...wait, how: `changed the control and clicked ${button.description}` };
        }
        return { ...await this.#waitForText(until, WAIT_MS), how: "changed the control" };
      }
      const steps = Math.abs(Number(to) - Number(from));
      const stepper = ControlSchema.parse(await this.#frameCall("stepper", from, to));
      if (stepper === null || !Number.isInteger(steps) || steps > 5) {
        return { pass: false, text: await this.#text(), how: `found no control holding ${from}` };
      }
      for (let step = 0; step < steps; step++) await this.#clickTarget(stepper);
      return { ...await this.#waitForText(until, WAIT_MS), how: `clicked its stepper ${steps} times` };
    });
  }

  /** How many CSS pixels wider than a phone the view is, at a phone's width. */
  overflowAtPhoneWidth(): Promise<number> {
    return this.#guard(async () => {
      await this.#requirePage().evaluate(
          `document.querySelector("iframe").style.width = "${PHONE_WIDTH}px"`);
      await this.#frameCall("frames", 2);
      return z.number().parse(await this.#frameCall("overflow"));
    });
  }

  /** The view's CSS declarations that use viewport height units. */
  viewportHeights(): Promise<string[]> {
    return this.#guard(async () => z.array(z.string()).parse(await this.#frameCall("viewportHeights")));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#context.close().catch(() => {});
  }

  async #bridge([op, ...args]: unknown[]): Promise<unknown> {
    switch (op) {
      case "record": {
        const [kind, detail] = args;
        if (kind === "error") this.errors.push(String(detail));
        else if (kind === "markup") this.markup.push(String(detail));
        return undefined;
      }
      case "send":
        this.messages.push(args[0]);
        return undefined;
      default:
        throw new TypeError("The view called the eval host incorrectly");
    }
  }

  #requirePage(): Page {
    if (this.#page === undefined) throw new Error("The view's page is not open");
    return this.#page;
  }

  async #frameCall(op: string, ...args: (string | number | string[])[]): Promise<unknown> {
    if (this.#stuck !== undefined) throw new Error(this.#stuck);
    if (this.#frame === undefined) throw new Error("The view never loaded");
    const result = await within(
        this.#frame.evaluate(`__evalView(...${JSON.stringify([op, ...args])})`), FRAME_CALL_MS);
    if (result === TIMED_OUT) {
      this.#stuck = "The view stopped responding: its code may be holding the page";
      throw new Error(this.#stuck);
    }
    return result;
  }

  async #state(): Promise<z.infer<typeof StateSchema>> {
    return StateSchema.parse(await this.#frameCall("state"));
  }

  async #text(): Promise<string> {
    return z.string().parse(await this.#frameCall("text"));
  }

  async #waitForText(test: (text: string) => boolean, ms: number): Promise<TextWait> {
    const deadline = Date.now() + ms;
    for (;;) {
      const text = await this.#text();
      if (test(text)) return { pass: true, text };
      if (Date.now() >= deadline) return { pass: false, text };
      await delay(POLL_MS);
    }
  }

  // Loaded, then two animation frames in a row with no `agent.send` pending.
  async #settle(): Promise<void> {
    if (this.unsettled !== undefined) return;
    const deadline = Date.now() + SETTLE_MS;
    let quiet = 0;
    while (quiet < 2) {
      const state = StateSchema.parse(await this.#frameCall("frames", 1));
      quiet = state.loaded && state.pending === 0 ? quiet + 1 : 0;
      if (quiet < 2 && Date.now() >= deadline) {
        this.unsettled = `After ${SETTLE_MS / 1_000} s the view had not finished loading`;
        return;
      }
    }
  }

  async #mouseClick(x: number, y: number): Promise<void> {
    const page = this.#requirePage();
    const frame = await page.$("iframe");
    const box = await frame?.boundingBox();
    if (box === null || box === undefined) throw new Error("The view's frame has no box");
    await page.mouse.click(box.x + x, box.y + y);
  }

  async #clickTarget(id: number): Promise<void> {
    const aim = AimSchema.parse(await this.#frameCall("aim", id));
    await this.#mouseClick(aim.x, aim.y);
  }

  #hostError(error: unknown): unknown {
    return this.#crash !== undefined || this.#context.browser()?.isConnected() === false
      ? new ViewHostError(this.#crash ?? "Chromium closed", { cause: error })
      : error;
  }

  async #guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw this.#hostError(error);
    }
  }
}
