import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import type { RpcPromise } from "capnweb";
import { z } from "zod";
import type { ViewBinding } from "@gadgets/workshop-shared/api";

// Runs an `<inline-html>` view as the Workshop does, so an eval can see what it does: in an
// opaque-origin srcdoc frame with `sandbox="allow-scripts"` (UiBlockCard.tsx) and, but for the
// network, the Workshop's CSP, in headless Chromium. A view is model-written code, so it runs only
// there, never in this process. Every request it makes is blocked and recorded, as the Workshop's
// frame has no network.

/** The view's text, and whether it showed what a check waited for before the wait ran out. */
export type TextWait = { pass: boolean; text: string };

/** The browser failed, not the view: the run says nothing about the agent's work. */
export class ViewHostError extends Error {
  override name = "ViewHostError";
}

/** Opens a name of the chat's scope for a view, as the Workshop's frame host asks the kernel. */
export type ViewBinder = (name: string) => Promise<Awaited<RpcPromise<ViewBinding>>>;

const noBindings: ViewBinder = async name => {
  throw new Error(`No binding named ${name}`);
};

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
// How long a click gets to make the view call `agent.send`, as after an animation or a debounce.
const CLICK_SEND_MS = 2_000;

// Runs in the view's frame before any of its code: `agent` and `env` shaped as the Workshop's
// bootstrap makes them (uiBlockFrame.ts), the records the checks read, and `__evalView`, the host's
// helpers. The view can reach all of it, so the host trusts nothing it returns.
const frameScript = (env: boolean) => String.raw`(() => {
  if (location.href !== "about:srcdoc") return;
${env ? String.raw`  // The Workshop's default Trusted Types policy (uiBlockFrame.ts), which a view with env gets.
  globalThis.trustedTypes?.createPolicy("default", { createHTML: html => html === "" ? html : null });
` : ""}
  const bridge = (...args) => window.__evalViewBridge(...args);
  const report = (kind, detail) => { bridge("record", kind, String(detail).slice(0, 500)).catch(() => {}); };
  const state = { pending: 0, started: 0 };

  addEventListener("error", event => report("error", event.error?.message ?? event.message));
  addEventListener("unhandledrejection", event => report("error", event.reason?.message ?? event.reason));

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

${env ? String.raw`
  // env, as the Workshop's bootstrap makes it: each name a promise the view awaits for saved data,
  // or calls as env.NAME.rpc.method() or env.NAME.method() before it settles. The host opens names
  // through the chat's kernel session, and refuses any the tag does not list.
  const pipelined = result => new Proxy({}, {
    get(_, key) {
      if (key === "then" || key === "catch" || key === "finally") return result[key].bind(result);
      if (typeof key !== "string") return undefined;
      return (...args) => pipelined(result.then(value => value[key](...args)));
    },
  });
  const methods = (name, member) => new Proxy({}, {
    get: (_, method) => typeof method !== "string" || method === "then" ? undefined
      : (...args) => pipelined(track(bridge("call", name, member, method, args))),
  });
  const binding = name => {
    let value;
    const opened = () => value ??= track(bridge("open", name)).then(({ type, json }) =>
      type === "data" ? JSON.parse(json) : type === "gadget" ? { rpc: methods(name, "rpc") } : methods(name, null));
    return new Proxy({}, {
      get(_, key) {
        if (key === "then" || key === "catch" || key === "finally") {
          const promise = opened();
          return promise[key].bind(promise);
        }
        if (typeof key !== "string") return undefined;
        return key === "rpc" ? methods(name, "rpc") : methods(name, null)[key];
      },
    });
  };
  const bindings = new Map();
  globalThis.env = new Proxy({}, {
    get(_, name) {
      if (typeof name !== "string" || name === "then") return undefined;
      if (!bindings.has(name)) bindings.set(name, binding(name));
      return bindings.get(name);
    },
  });
` : ""}

  const norm = text => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const center = box => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });

  // What a person can see. A box shows when it is at least 2px each way and on the page; an
  // element when its style draws it (not hidden, not transparent) and no ancestor clips it to a
  // box that does not show, as visually hidden text is; text when its element shows it.
  const DRAWN = { opacityProperty: true, visibilityProperty: true };
  const onPage = box => box.width >= 2 && box.height >= 2 && box.right + scrollX > 0 && box.bottom + scrollY > 0 &&
    box.left + scrollX < document.documentElement.scrollWidth && box.top + scrollY < document.documentElement.scrollHeight;
  const clipped = el => {
    for (let up = el; up && up !== document.documentElement; up = up.parentElement) {
      const style = getComputedStyle(up);
      if ((style.overflowX !== "visible" || style.overflowY !== "visible") && !onPage(up.getBoundingClientRect())) return true;
    }
    return false;
  };
  // An element with display: contents has no box of its own, so its parent's style decides.
  const drawn = el => {
    while (el && getComputedStyle(el).display === "contents") el = el.parentElement;
    return el !== null && el.checkVisibility(DRAWN) && !clipped(el);
  };
  const shown = el => drawn(el) && onPage(el.getBoundingClientRect());
  const textBox = node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect(); };
  const textShown = node => node.data.trim() !== "" && node.parentElement !== null && onPage(textBox(node)) && drawn(node.parentElement);
  // The value a form control shows as text, read-only and disabled ones too, when a person sees the
  // control: not a password's dots, a box's tick, a slider's thumb, or a placeholder.
  const UNREAD = ["hidden", "password", "checkbox", "radio", "file", "image", "range", "color"];
  const controlText = el => (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !UNREAD.includes(el.type))) &&
    el.value.trim() !== "" && shown(el) ? el.value : null;

  // The text a person sees in root, without the text they cannot see, in runs that read as one: a
  // box of its own (a block, a table cell, an inline-block such as a button, a control, an SVG text)
  // or a line break ends a run, and an inline element does not, so "$<b>15</b>.99" reads "$15.99".
  // Each run has the gap before it (none, a space as between a row's cells, or a new line), its
  // text, and the text nodes and controls that show it, with where each one's text starts and ends.
  const SKIPPED = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "title", "desc", "script", "style", "defs", "metadata"]);
  const runsOf = root => {
    const runs = [];
    let run = { gap: "", text: "", parts: [] };
    const read = (text, node) => {
      if (node !== undefined) run.parts.push({ node, start: run.text.length, end: run.text.length + text.length });
      run.text += text;
    };
    const end = gap => {
      runs.push(run);
      run = { gap, text: "", parts: [] };
    };
    const control = (node, value) => {
      end("");
      read(" ");
      if (value !== null) read(value, node);
      read(" ");
      end("");
    };
    const visit = node => {
      if (node.nodeType === Node.TEXT_NODE) {
        // Blank text, as between two inline elements, is the space between them.
        if (node.data.trim() === "") read(" ");
        else if (textShown(node)) read(node.data, node);
        return;
      }
      if (!(node instanceof Element) || SKIPPED.has(node.tagName)) return;
      if (node instanceof HTMLBRElement) return void end("\n");
      if (node instanceof HTMLSelectElement) {
        if (shown(node)) control(node, node.selectedOptions[0]?.text ?? "");
        return;
      }
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) return void control(node, controlText(node));
      const display = getComputedStyle(node).display;
      if (display === "none") return;
      const gap = node instanceof SVGElement ? (["text", "foreignObject"].includes(node.tagName) ? "\n" : node.tagName === "tspan" ? " " : null)
        : ["inline", "contents", "ruby"].includes(display) ? null : display.startsWith("inline") ? "" : display === "table-cell" ? " " : "\n";
      if (gap !== null) end(gap);
      for (const child of node.childNodes) visit(child);
      if (gap !== null) end(gap);
    };
    visit(root);
    runs.push(run);
    return runs;
  };
  // The text a person sees in root, read as innerText reads it.
  const textOf = root => runsOf(root).map(run => run.gap + run.text).join("").split("\n")
    .map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  // The elements that show text in runs, but for those that show part of a word, as the 15 of
  // "$<b>15</b>.99" is: an element's text must start and end at a space or an end of its run.
  const wholeIn = runs => {
    const edges = new Map();
    for (const run of runs) {
      for (const { node, start, end } of run.parts) {
        for (let el = node instanceof Element ? node : node.parentElement; el && el !== document.body; el = el.parentElement) {
          edges.set(el, { first: edges.get(el)?.first ?? { text: run.text, at: start }, last: { text: run.text, at: end } });
        }
      }
    }
    const parted = ({ text, at }) => /\s/.test(text[at - 1] ?? " ") || /\s/.test(text[at] ?? " ");
    return new Set([...edges].flatMap(([el, { first, last }]) => parted(first) && parted(last) ? [el] : []));
  };
  // An element's aria-label, title, and, for an SVG shape, its <title> tooltip.
  const ownLabels = el => [el.getAttribute("aria-label"), el.getAttribute("title"),
    el instanceof SVGElement ? [...el.children].find(child => child.tagName === "title")?.textContent : null].filter(Boolean);
  const labelsIn = root => [root, ...root.querySelectorAll("*")].flatMap(el => {
    const own = ownLabels(el);
    return own.length > 0 && shown(el) ? own : [];
  });
  const label = el => [textOf(el), ...ownLabels(el)].filter(Boolean).join(" ");
  const named = (el, text) => norm(label(el)).includes(norm(text));
  const describe = el => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + ' "' + norm(label(el)).slice(0, 40) + '"';
  const registry = [];
  const register = (el, stage) => ({ id: registry.push(el) - 1, description: describe(el), stage });
  const CONTROLS = "input:not([type=hidden]), button, select, textarea, a[href], [role=button], [role=checkbox], [role=switch], [role=radio], [role=option], [tabindex]";
  const usable = el => shown(el) && !el.matches(":disabled") && el.closest("[inert]") === null;

  // The element that names the item, then what a user would reach for beside it: the controls
  // and handlers in its row (the largest box around it that names no other item), then, for a
  // chart, the nearest element with a handler in line with it, or the nearest mark it draws under
  // a handler on the whole chart, as when the chart's <svg> handles every bar's click.
  const targets = (text, others) => {
    const elements = [...document.body.querySelectorAll("*")].filter(el =>
      !SKIPPED.has(el.tagName) && shown(el) && named(el, text));
    const deepest = elements.filter(el => !elements.some(other => other !== el && el.contains(other)));
    const found = [];
    const add = (el, stage) => { if (found.length < 8 && !found.some(entry => registry[entry.id] === el)) found.push(register(el, stage)); };
    for (const el of deepest.slice(0, 2)) add(el, "label");
    const first = deepest[0];
    if (first === undefined) return found;
    const namesOther = el => others.some(other => named(el, other));
    let row = first;
    for (let up = first.parentElement; up && up !== document.body && !namesOther(up); up = up.parentElement) row = up;
    const inRow = [...row.querySelectorAll("*")].filter(el => usable(el) && (el.matches(CONTROLS) || listens(el)));
    for (let up = first; up && up !== row.parentElement; up = up.parentElement) if (listens(up)) inRow.push(up);
    inRow.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    for (const el of inRow) add(el, "row");
    const at = center(first.getBoundingClientRect());
    const delegated = [...listening].filter(el => el.isConnected && el.contains(first))
      .flatMap(el => [...el.querySelectorAll(GRAPHIC)].filter(inks));
    const near = [...[...listening].filter(el => el.isConnected && !el.contains(first)), ...delegated]
      .filter(el => shown(el) && !namesOther(el))
      .map(el => ({ el, box: el.getBoundingClientRect() }))
      .filter(({ box }) => (box.left <= at.x && at.x <= box.right) || (box.top <= at.y && at.y <= box.bottom))
      .sort((a, b) => Math.hypot(center(a.box).x - at.x, center(a.box).y - at.y) - Math.hypot(center(b.box).x - at.x, center(b.box).y - at.y));
    for (const { el } of near.slice(0, 2)) add(el, "near");
    return found;
  };

  const sameValue = (value, wanted) => norm(value) === norm(wanted) || (norm(value) !== "" && Number(value) === Number(wanted));

  // What the view shows of each label (see Series in the host). Two boxes are in one column when
  // either's center is above or below the other, and in one row when it is beside it.
  const COLUMN = {
    aligned: (a, b) => (a.left <= center(b).x && center(b).x <= a.right) || (b.left <= center(a).x && center(a).x <= b.right),
    gap: (a, b) => Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)),
  };
  const ROW = {
    aligned: (a, b) => (a.top <= center(b).y && center(b).y <= a.bottom) || (b.top <= center(a).y && center(a).y <= b.bottom),
    gap: (a, b) => Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right)),
  };
  const GRAPHIC = "rect, circle, ellipse, line, polygon, polyline, path";
  // Where the line through points crosses the line where coordinate "along" is at: the other coordinate of each crossing.
  const crossings = (points, along, at) => {
    const other = along === "x" ? "y" : "x";
    return points.slice(1).flatMap((point, step) => {
      const last = points[step];
      if ((last[along] - at) * (point[along] - at) > 0 || last[along] === point[along]) return [];
      return [last[other] + (point[other] - last[other]) * (at - last[along]) / (point[along] - last[along])];
    });
  };
  // Whether an element paints its own box, with a background or a border a person sees.
  const CLEAR = /^(transparent|rgba\(.*, 0\))$/;
  const paints = el => {
    const style = getComputedStyle(el);
    return style.backgroundImage !== "none" || !CLEAR.test(style.backgroundColor) ||
      ["Top", "Right", "Bottom", "Left"].some(side => parseFloat(style["border" + side + "Width"]) > 0 &&
        style["border" + side + "Style"] !== "none" && !CLEAR.test(style["border" + side + "Color"]));
  };
  // Whether SVG geometry paints something a person sees: a stroke or a fill, in a color that shows.
  // A line has no fill.
  const shows = color => color !== "none" && !CLEAR.test(color);
  const inks = el => {
    const style = getComputedStyle(el);
    return (parseFloat(style.strokeWidth) > 0 && parseFloat(style.strokeOpacity) > 0 && shows(style.stroke)) ||
      (!(el instanceof SVGLineElement) && parseFloat(style.fillOpacity) > 0 && shows(style.fill));
  };
  const depth = el => { let count = 0; for (let up = el; up && up !== document.body; up = up.parentElement) count++; return count; };
  const series = labels => {
    const matchers = labels.map(text => new RegExp("(?<![\\p{L}\\p{N}])" +
      text.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "iu"));
    // Where text names each label, in order. A label inside a longer one's text, as "Food" in "Food
    // delivery", names only the longer one.
    const matchesIn = text => {
      const all = matchers.flatMap((matcher, index) => [...text.matchAll(new RegExp(matcher.source, "giu"))]
        .map(match => ({ index, at: match.index, end: match.index + match[0].length })));
      return all.filter(match => !all.some(other => other.at <= match.at && match.end <= other.end &&
        other.end - other.at > match.end - match.at)).sort((a, b) => a.at - b.at);
    };
    const namesIn = text => [...new Set(matchesIn(text).map(match => match.index))].sort((a, b) => a - b);
    const boxAround = parts => {
      const boxes = parts.map(({ node }) => node instanceof Element ? node.getBoundingClientRect() : textBox(node));
      const left = Math.min(...boxes.map(box => box.left)), top = Math.min(...boxes.map(box => box.top));
      return new DOMRect(left, top, Math.max(...boxes.map(box => box.right)) - left, Math.max(...boxes.map(box => box.bottom)) - top);
    };
    const runs = runsOf(document.body).filter(run => run.text.trim() !== "");
    // A run's element is the one that holds all of it.
    const pieces = runs.map(({ text, parts }) => {
      let el = parts[0].node instanceof Element ? parts[0].node : parts[0].node.parentElement;
      while (!el.contains(parts[parts.length - 1].node)) el = el.parentElement;
      return { text: norm(text), box: boxAround(parts), el };
    });
    for (const el of document.body.querySelectorAll("*")) {
      const own = ownLabels(el);
      if (own.length > 0 && shown(el)) pieces.push({ text: norm(own.join(" ")), box: el.getBoundingClientRect(), el });
    }
    for (const piece of pieces) piece.names = namesIn(piece.text);
    // Text that names several labels reads as its entries, split at separators such as "·" or ", ",
    // as "$15 Basic · $30 Everyday"; an entry that still names several reads as each label and the
    // text after it, up to the next label, as "Basic $15 Everyday $30".
    const segment = (piece, text, names) => ({ ...piece, text, names, segment: true });
    const segments = pieces.flatMap(piece => piece.names.length < 2 ? [] : piece.text.split(/\s*[·•|;]\s*|,\s+/).flatMap(entry => {
      const names = namesIn(entry);
      if (names.length < 2) return names.length === 1 ? [segment(piece, entry, names)] : [];
      const starts = matchesIn(entry);
      return starts.map(({ index, at }, order) => segment(piece, entry.slice(at, starts[order + 1]?.at), [index]));
    }));
    const own = labels.map((_, index) => [...pieces, ...segments].filter(piece => piece.names.length === 1 && piece.names[0] === index));
    // Where each label is drawn: the box of the text nodes or controls that show it, when what they
    // show names no other label, and the point it marks on an axis. An SVG label marks the x and y it
    // is placed at, since a rotated or end-anchored label's box is not centered on its tick: the
    // innermost x and y its <tspan> and <text> set, as SVG places its first character, so a <tspan>
    // that sets only x takes its <text>'s y. Not dx or dy, which move the text off its tick, as an
    // axis's dy=".35em" centers a label on its row. Any other label marks the center of its box.
    const markedAt = (spanned, box) => {
      const node = spanned[0].node;
      const start = node instanceof Element ? node : node.parentElement;
      const label = start?.closest("text");
      const ctm = label instanceof SVGTextElement ? label.getScreenCTM() : null;
      if (ctm === null) return center(box);
      const first = list => list.baseVal.numberOfItems > 0 ? list.baseVal.getItem(0).value : undefined;
      let x, y;
      for (let el = start; el instanceof SVGTextPositioningElement; el = el === label ? null : el.parentElement) {
        x ??= first(el.x);
        y ??= first(el.y);
      }
      return new DOMPoint(x ?? 0, y ?? 0).matrixTransform(ctm);
    };
    // Each label's anchors, with the <svg> that draws it, if one does.
    const anchors = labels.map((_, index) => runs.flatMap(({ text, parts }) => matchesIn(text).filter(match => match.index === index).flatMap(match => {
      const spanned = parts.filter(({ start, end }) => start < match.end && end > match.at);
      const names = namesIn(norm(text.slice(spanned[0].start, spanned[spanned.length - 1].end)));
      if (names.length !== 1 || names[0] !== index) return [];
      const box = boxAround(spanned);
      const node = spanned[0].node;
      const svg = (node instanceof Element ? node : node.parentElement)?.closest("svg") ?? null;
      return [{ box, at: markedAt(spanned, box), svg }];
    })));
    // The label whose text is nearest box in its column or row, if no other label is as near, as
    // when a line runs under every label.
    const inLine = (box, line) => {
      const gaps = anchors.map(found => Math.min(...found.filter(piece => line.aligned(piece.box, box)).map(piece => line.gap(piece.box, box))));
      const nearest = Math.min(...gaps);
      const names = gaps.flatMap((gap, index) => gap - nearest < 0.5 ? [index] : []);
      return nearest !== Infinity && names.length === 1 ? names[0] : undefined;
    };
    const beside = own.map((found, index) => {
      const texts = found.map(piece => piece.text);
      for (const piece of found.filter(piece => !piece.segment)) {
        let row = piece.el;
        for (let up = row.parentElement; up && up !== document.body &&
          namesIn([textOf(up), ...labelsIn(up)].join(" ")).every(name => name === index); up = up.parentElement) row = up;
        texts.push(textOf(row), ...labelsIn(row));
      }
      for (const piece of pieces) {
        if (piece.names.length === 0 && (inLine(piece.box, COLUMN) === index || inLine(piece.box, ROW) === index)) texts.push(piece.text);
      }
      return [...new Set(texts)].join("\n");
    });
    const marks = [];
    const count = {};
    const add = (index, kind, axis, at) => {
      const key = index + " " + kind + " " + axis;
      count[key] = (count[key] ?? 0) + 1;
      marks.push({ label: index, key: kind + " " + (count[key] - 1), axis, at });
    };
    // An HTML element is a mark by its own painted box, text and children or not, as a bar holding
    // its label is. Marks of one series sit at one depth, so a card or column around each bar, or
    // a bar painted another color, does not mix with the bars.
    const shapes = [...document.body.querySelectorAll("*")].filter(el => el instanceof SVGElement ? el.matches(GRAPHIC) && inks(el) : paints(el));
    // A line or an area: where it crosses each label's column, at its top, and each label's row,
    // at its right end. A label the line's own <svg> draws marks it, before the same word in text
    // around the chart, such as a summary above it.
    const plot = (kind, points, svg) => {
      for (const [index, found] of anchors.entries()) {
        const anchor = found.find(each => each.svg === svg) ?? found[0];
        if (anchor === undefined) continue;
        const at = anchor.at;
        const ys = points.flatMap(line => crossings(line, "x", at.x));
        if (ys.length > 0) add(index, kind, "y", Math.min(...ys));
        const xs = points.flatMap(line => crossings(line, "y", at.y));
        if (xs.length > 0) add(index, kind, "x", Math.max(...xs));
      }
    };
    const onScreen = (el, point) => new DOMPoint(point.x, point.y).matrixTransform(el.getScreenCTM());
    // A chart may draw one line as segments, end to end: those that meet are one line.
    const segmentsDrawn = [];
    for (const [order, el] of shapes.entries()) {
      if (!drawn(el)) continue;
      if (el instanceof SVGLineElement) {
        if (el.getScreenCTM() !== null) segmentsDrawn.push({ svg: el.ownerSVGElement, points: [onScreen(el, el.getPointAtLength(0)), onScreen(el, el.getPointAtLength(el.getTotalLength()))] });
        continue;
      }
      if (el instanceof SVGGeometryElement && el.matches("polygon, polyline, path")) {
        const length = el.getTotalLength();
        if (el.getScreenCTM() === null || !(length > 0)) continue;
        plot("path " + order, [Array.from({ length: 401 }, (_, step) => onScreen(el, el.getPointAtLength(length * step / 400)))], el.ownerSVGElement);
        continue;
      }
      const box = el.getBoundingClientRect();
      if (!onPage(box)) continue;
      const kind = el instanceof SVGElement ? el.tagName : el.tagName + " " + depth(el);
      const column = inLine(box, COLUMN);
      if (column !== undefined) add(column, kind, "y", box.top);
      const row = inLine(box, ROW);
      if (row !== undefined) add(row, kind, "x", box.right);
    }
    const meets = (a, b) => a.some(p => b.some(q => Math.hypot(p.x - q.x, p.y - q.y) < 1));
    const lines = [];
    for (const segment of segmentsDrawn) {
      const joined = lines.filter(line => line.svg === segment.svg && line.segments.some(other => meets(other, segment.points)));
      const merged = { svg: segment.svg, segments: [segment.points, ...joined.flatMap(line => line.segments)] };
      lines.splice(0, lines.length, ...lines.filter(line => !joined.includes(line)), merged);
    }
    for (const [order, line] of lines.entries()) plot("lines " + order, line.segments, line.svg);
    return { beside, marks };
  };

  const elementIds = new WeakMap();
  let nextElementId = 0;
  const idOf = el => {
    if (!elementIds.has(el)) elementIds.set(el, nextElementId++);
    return elementIds.get(el);
  };

  const ops = {
    state: () => ({ pending: state.pending, started: state.started, loaded: document.readyState === "complete" }),
    frames: count => new Promise(resolve => {
      const step = left => left === 0 ? resolve(ops.state()) : requestAnimationFrame(() => step(left - 1));
      step(count);
    }),
    text: () => [textOf(document.body), ...labelsIn(document.body)].filter(Boolean).join("\n"),
    // The text of each element a person sees text in, or a control's value, and of each element
    // around it, but for those that show part of a word.
    texts: () => [...wholeIn(runsOf(document.body))].map(el => ({ id: idOf(el), text: textOf(el) })),
    visible: () => textOf(document.body) !== "" || [...document.body.querySelectorAll("svg, canvas, img, video")].some(shown),
    targets,
    series,
    // A point where a click reaches the element, its center if nothing covers it there.
    aim: id => {
      const el = registry[id];
      el.scrollIntoView({ block: "center", inline: "center" });
      const reaches = (x, y) => { const hit = document.elementFromPoint(x, y); return hit !== null && (hit === el || el.contains(hit)); };
      const middle = center(el.getBoundingClientRect());
      if (reaches(middle.x, middle.y)) return { ...middle, hits: true };
      const FRACTIONS = [0.5, 0.25, 0.75, 0.1, 0.9];
      for (const box of el.getClientRects()) {
        for (const fx of FRACTIONS) {
          for (const fy of FRACTIONS) {
            const x = box.left + box.width * fx, y = box.top + box.height * fy;
            if (reaches(x, y)) return { x, y, hits: true };
          }
        }
      }
      return { ...middle, hits: false };
    },
    // The first control holding "from" that a user can see and edit, and for a select, its option for "to".
    control: (from, to) => {
      const control = [...document.body.querySelectorAll("input, select, textarea")].find(el =>
        !["checkbox", "radio", "hidden", "button", "submit", "reset", "file", "image"].includes(el.type) &&
        usable(el) && !el.readOnly && sameValue(el.value, from));
      if (control === undefined) return null;
      if (!(control instanceof HTMLSelectElement)) return { id: register(control, "control").id, option: null };
      const option = [...control.options].find(option => !option.disabled && (sameValue(option.value, to) || sameValue(option.text, to)));
      return option === undefined ? null : { id: register(control, "control").id, option: option.value };
    },
    // The first select a user can see and use with an option that names "text", and that option.
    optionNamed: text => {
      const wanted = new RegExp("(?<![\\p{L}\\p{N}])" + text.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&") + "(?![\\p{L}\\p{N}])", "iu");
      for (const control of document.body.querySelectorAll("select")) {
        const option = usable(control) ? [...control.options].find(option => !option.disabled && wanted.test(option.text)) : undefined;
        if (option !== undefined) return { id: register(control, "control").id, option: option.value };
      }
      return null;
    },
    element: id => registry[id],
    // The button beside an element showing "from" alone that moves it toward "to".
    stepper: (from, to) => {
      const raise = Number(to) > Number(from);
      const sign = raise ? /^[+＋▲↑]$/ : /^[-−–▼↓]$/;
      const word = raise ? /increase|increment|more|plus|add|up/i : /decrease|decrement|less|minus|remove|down/i;
      const whole = wholeIn(runsOf(document.body));
      const shows = [...document.body.querySelectorAll("*")].filter(el =>
        el.children.length === 0 && whole.has(el) && shown(el) && sameValue(textOf(el), from));
      for (const el of shows) {
        for (let up = el.parentElement, depth = 0; up && depth < 3; up = up.parentElement, depth++) {
          const button = [...up.querySelectorAll("button, [role=button]")].find(candidate => usable(candidate) &&
            (sign.test(candidate.textContent.trim()) || word.test(candidate.getAttribute("aria-label") ?? candidate.getAttribute("title") ?? "")));
          if (button) return register(button, "control").id;
        }
      }
      return null;
    },
    submitButtons: () => [...document.body.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")]
      .filter(el => usable(el) && /calc|split|update|apply|compute|total|\bgo\b|=/i.test(label(el) || el.value || ""))
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
const EditableSchema = z.object({ id: z.number(), option: z.string().nullable() }).nullable();
const ShownTextsSchema = z.array(z.object({ id: z.number(), text: z.string() }));
const SeriesSchema = z.object({
  beside: z.array(z.string()),
  marks: z.array(z.object({ label: z.number(), key: z.string(), axis: z.enum(["x", "y"]), at: z.number() })),
});

/**
 * What a view shows of each of a list of labels, such as a chart's months, as a person would pair
 * them by eye. `beside[i]` is the text shown with label `i`: its own text and tooltips, its row's
 * (the largest element around it that names no other label), and each text in line with it, in
 * its column or its row, and in line with no other label. `marks` are the shapes plotted for a
 * label: a bar or a point in line with it alone, or the point where a line or area crosses its
 * column. A mark's `at` is its top (axis `y`, for a column) or right edge (axis `x`, for a row),
 * in pixels from the frame's top left. Marks of one series share a `key`.
 */
export type Series = z.infer<typeof SeriesSchema>;

/** One mark of `Series`. */
export type SeriesMark = Series["marks"][number];

const TIMED_OUT = Symbol("timed out");

async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  const controller = new AbortController();
  try {
    return await Promise.race([work, delay(ms, TIMED_OUT, { signal: controller.signal })]);
  } finally {
    controller.abort();
  }
}

// The frame style the Workshop gives a view (uiBlockFrame.ts's frameHead), in its light theme, with
// the token values the Workshop computed on 2026-10-28.
const VIEW_STYLE = `<style>
  :root { color-scheme: light; --color-kumo-base: #fcfcfb; --color-kumo-elevated: #f8f8f7;
    --color-kumo-line: #1411100f; --text-color-kumo-default: #1c1a18;
    --text-color-kumo-subtle: oklch(52% 0.006 60); --color-kumo-brand: #ff4801;
    --color-kumo-success: oklch(72.3% 0.219 149.579); --color-kumo-warning: oklch(79.5% 0.184 86.047);
    --color-kumo-danger: oklch(63.7% 0.237 25.331);
    --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    --font-mono: "SF Mono", Menlo, Monaco, Consolas, monospace; }
  html, body { margin: 0; height: auto; background: transparent; }
  body { display: flow-root; padding: 4px; color: var(--text-color-kumo-default);
    font: 14px/1.6 var(--font-sans); letter-spacing: -0.25px; }
  button, input, select, textarea { font: inherit; letter-spacing: inherit; }
  code, kbd, pre, samp { font-family: var(--font-mono); }
</style>`;

// The view's document, with the CSP of the Workshop's frame (sandboxDocument.ts's SANDBOX_HEAD), but
// for one change: where that CSP allows no network, this one allows http(s) and ws(s), so that the
// view's requests reach the routing that blocks and records them. A view with `env` also gets the
// Workshop's Trusted Types CSP (uiBlockFrame.ts).
function viewDocument(html: string, env: boolean): string {
  return `<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src http: https:; frame-src http: https:; script-src data: 'unsafe-inline' 'wasm-unsafe-eval' http: https:; style-src data: 'unsafe-inline' http: https:; img-src data: http: https:; media-src data: http: https:; object-src http: https:; base-uri 'none'; form-action 'none'; connect-src http: https: ws: wss:;">${env ? `
<meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'; trusted-types ui-block default">` : ""}
${VIEW_STYLE}</head>
<body>
${html}
</body>
</html>`;
}

// A stub keeps some members to itself (dup, onRpcBroken, constructor, ...): calling one would run
// it here, in this process, rather than on the binding.
async function invoke(stub: object, method: string, args: unknown[], owner: string): Promise<unknown> {
  const local: object = Object.getPrototypeOf(stub);
  const target: unknown = method in local ? undefined : Reflect.get(stub, method);
  if (typeof target !== "function") throw new TypeError(`${method} is not a method of ${owner}`);
  return await Reflect.apply(target, stub, args);
}

// Every awaited capnweb result owns what it imported.
function disposeResult(value: unknown): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
  const dispose: unknown = Reflect.get(value, Symbol.dispose);
  if (typeof dispose === "function") Reflect.apply(dispose, value, []);
}

// The chat's background shows through the view's transparent page.
const SHELL = `<!DOCTYPE html><body style="margin:0;background:#fcfcfb"><iframe sandbox="allow-scripts"
  style="border:0;width:${FRAME_WIDTH}px;height:${FRAME_HEIGHT}px"></iframe></body>`;

let browser: Promise<Browser> | undefined;

function launchBrowser(): Promise<Browser> {
  // CI's ubuntu-latest blocks the user namespaces Chromium's sandbox needs (actions/runner-images#10443).
  browser ??= chromium.launch({ chromiumSandbox: !process.env.CI }).then(launched => {
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
  /** What the view asked the user to send, through agent.send. */
  readonly messages: unknown[] = [];
  /** Why the view never settled, if it did not. */
  unsettled: string | undefined;

  readonly #context: BrowserContext;
  readonly #binder: ViewBinder;
  // The names the block's `env` attribute lists, or undefined for a view with no `env`.
  readonly #env: readonly string[] | undefined;
  readonly #bindings = new Map<string, Promise<Awaited<RpcPromise<ViewBinding>>>>();
  readonly #opened: Disposable[] = [];
  #page: Page | undefined;
  #frame: Frame | undefined;
  #crash: string | undefined;
  #stuck: string | undefined;
  #closed = false;

  private constructor(context: BrowserContext, binder: ViewBinder, env: readonly string[] | undefined) {
    this.#context = context;
    this.#binder = binder;
    this.#env = env;
  }

  /**
   * Runs `html`, the HTML of an `<inline-html>` block, and waits until it settles: loaded, with no
   * `agent.send` or call on its bindings pending. A view that never settles still opens, with
   * `unsettled` set. `env` is the names the block's tag lists: the view reaches only those, through
   * `binder`; without it, the view has no `env`.
   */
  static async open(html: string, binder: ViewBinder = noBindings, env?: readonly string[]): Promise<RenderedView> {
    const launched = await launchBrowser();
    let view: RenderedView | undefined;
    try {
      view = new RenderedView(await launched.newContext({ viewport: VIEWPORT }), binder, env);
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
    await context.addInitScript({ content: frameScript(this.#env !== undefined) });
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
      frame.srcdoc = ${JSON.stringify(viewDocument(html, this.#env !== undefined))};
    })`), SETTLE_MS);
    if (loaded === TIMED_OUT) {
      this.#stuck = "The view did not finish loading: its code may be holding the page";
      this.unsettled = this.#stuck;
      return;
    }
    this.#frame = page.mainFrame().childFrames().at(0);
    await this.#settle();
  }

  /** The text a person sees in the view, with the SVG titles and labels of what they see. */
  text(): Promise<string> {
    return this.#guard(() => this.#text());
  }

  /** Whether a person sees anything in the view: text, or a drawing with a size. */
  visible(): Promise<boolean> {
    return this.#guard(async () => z.boolean().parse(await this.#frameCall("visible")));
  }

  /** Waits until the view's text passes `test`, or the wait runs out. */
  waitForText(test: (text: string) => boolean): Promise<TextWait> {
    return this.#guard(() => this.#waitForText(test, WAIT_MS));
  }

  /** Waits until what the view shows of `labels` (see `Series`) passes `test`, or the wait runs out. */
  waitForSeries(labels: readonly string[], test: (series: Series) => boolean):
      Promise<{ pass: boolean; series: Series }> {
    return this.#guard(async () => {
      const wait = await this.#waitFor(
          async () => SeriesSchema.parse(await this.#frameCall("series", [...labels])), test, WAIT_MS);
      return { pass: wait.pass, series: wait.value };
    });
  }

  /**
   * The text of each element that holds text a person sees, as `text` reads it, with an id that
   * stays with the element while it is on the page.
   */
  shownTexts(): Promise<{ id: number; text: string }[]> {
    return this.#guard(async () => ShownTextsSchema.parse(await this.#frameCall("texts")));
  }

  /**
   * Picks the item `label` names, as a user would: clicks the element that names it first, then the
   * controls beside it, and then picks its option in a select, until the view calls `agent.send`. A
   * control only gets a click at a point where nothing covers it. `others` names the other items,
   * so "beside it" stops short of them. Returns what it tried.
   */
  click(label: string, others: readonly string[]): Promise<string[]> {
    return this.#guard(async () => {
      const tried: string[] = [];
      const sends = async (act: () => Promise<unknown>) => {
        const before = await this.#state();
        await act();
        const sent = await this.#waitFor(() => this.#state(), state => state.started > before.started, CLICK_SEND_MS);
        if (sent.pass) await this.#settle();
        return sent.pass;
      };
      for (const target of TargetsSchema.parse(await this.#frameCall("targets", label, [...others]))) {
        const aim = AimSchema.parse(await this.#frameCall("aim", target.id));
        // A click on the label lands wherever a user's would, even on something over it.
        if (target.stage !== "label" && !aim.hits) {
          tried.push(`found nothing to click on ${target.description}`);
          continue;
        }
        tried.push(`clicked ${target.description}`);
        if (await sends(() => this.#mouseClick(aim.x, aim.y))) return tried;
      }
      const select = EditableSchema.parse(await this.#frameCall("optionNamed", label));
      if (select !== null) {
        tried.push(`picked ${label} in a select`);
        await sends(() => this.#edit(select, label));
      }
      return tried;
    });
  }

  /**
   * Changes the value the view shows as `from` to `to`, as a user would, and waits until the
   * view's text passes `until`: an edit of the control holding it, if the user can see and edit
   * it (typing, picking an option, or moving a slider), then Enter, then moving on from it, then a
   * button such as "Calculate"; or the stepper beside it.
   */
  setValue(from: string, to: string, until: (text: string) => boolean):
      Promise<TextWait & { how: string }> {
    return this.#guard(async () => {
      const control = EditableSchema.parse(await this.#frameCall("control", from, to));
      if (control !== null) {
        if (!await this.#edit(control, to)) {
          return { pass: false, text: await this.#text(), how: `could not change the control holding ${from}` };
        }
        let wait = await this.#waitForText(until, COMMIT_MS);
        if (wait.pass) return { ...wait, how: `changed the control holding ${from}` };
        const keyboard = this.#requirePage().keyboard;
        await keyboard.press("Enter");
        wait = await this.#waitForText(until, COMMIT_MS);
        if (wait.pass) return { ...wait, how: "changed the control and pressed Enter" };
        await keyboard.press("Tab");
        wait = await this.#waitForText(until, COMMIT_MS);
        if (wait.pass) return { ...wait, how: "changed the control and moved on from it" };
        for (const button of TargetsSchema.parse(await this.#frameCall("submitButtons"))) {
          if (!await this.#clickTarget(button.id)) continue;
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
      for (let step = 0; step < steps; step++) {
        if (!await this.#clickTarget(stepper)) {
          return { pass: false, text: await this.#text(), how: "found nothing to click on its stepper" };
        }
      }
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
    for (const binding of this.#opened.splice(0).toReversed()) binding[Symbol.dispose]();
    await this.#context.close().catch(() => {});
  }

  async #bridge([op, ...args]: unknown[]): Promise<unknown> {
    switch (op) {
      case "record": {
        const [kind, detail] = args;
        if (kind === "error") this.errors.push(String(detail));
        return undefined;
      }
      case "send":
        this.messages.push(args[0]);
        return undefined;
      case "open": {
        const binding = await this.#binding(args[0]);
        return binding.type === "data" ? { type: "data", json: binding.json } : { type: binding.type };
      }
      case "call":
        return this.#call(args);
      default:
        throw new TypeError("The view called the eval host incorrectly");
    }
  }

  #binding(name: unknown): Promise<Awaited<RpcPromise<ViewBinding>>> {
    if (typeof name !== "string" || this.#env === undefined || !this.#env.includes(name)) {
      return Promise.reject(new Error(`env.${String(name)} is not listed in this view's env attribute.`));
    }
    let binding = this.#bindings.get(name);
    if (binding === undefined) {
      binding = this.#open(name);
      this.#bindings.set(name, binding);
    }
    return binding;
  }

  async #open(name: string): Promise<Awaited<RpcPromise<ViewBinding>>> {
    const binding = await this.#binder(name);
    if (this.#closed) {
      binding[Symbol.dispose]();
      throw new Error("This view has closed.");
    }
    this.#opened.push(binding);
    return binding;
  }

  // The Workshop's frame reaches a Gadget as `env.NAME.rpc.method(...)` and a connection as
  // `env.NAME.method(...)`, and nothing else. A result crosses into the frame as plain data.
  async #call([name, member, method, args]: unknown[]): Promise<unknown> {
    if (typeof name !== "string" || (member !== "rpc" && member !== null) ||
        typeof method !== "string" || !Array.isArray(args)) {
      throw new TypeError("A view calls env.NAME.rpc.method() or env.NAME.method()");
    }
    const binding = await this.#binding(name);
    const stub = binding.type === "gadget" ? member === "rpc" ? binding.rpc : undefined
      : binding.type === "connection" && member === null ? binding.session : undefined;
    if (stub === undefined) {
      throw new TypeError(binding.type === "gadget" ? `env.${name} is a Gadget: call env.${name}.rpc.${method}()`
        : binding.type === "connection" ? `env.${name} is a connection: call env.${name}.${method}()`
        : `env.${name} is data: read it with await env.${name}`);
    }
    const result = await invoke(stub, method, args, `env.${name}`);
    try {
      return structuredClone(result);
    } catch (error) {
      throw new TypeError("The binding returned a value this eval cannot pass to a view", { cause: error });
    } finally {
      disposeResult(result);
    }
  }

  #requirePage(): Page {
    if (this.#page === undefined) throw new Error("The view's page is not open");
    return this.#page;
  }

  async #inFrame<T>(work: (frame: Frame) => Promise<T>): Promise<T> {
    if (this.#stuck !== undefined) throw new Error(this.#stuck);
    if (this.#frame === undefined) throw new Error("The view never loaded");
    const result = await within(work(this.#frame), FRAME_CALL_MS);
    if (result === TIMED_OUT) {
      this.#stuck = "The view stopped responding: its code may be holding the page";
      throw new Error(this.#stuck);
    }
    return result;
  }

  #frameCall(op: string, ...args: (string | number | string[])[]): Promise<unknown> {
    return this.#inFrame(frame => frame.evaluate(`__evalView(...${JSON.stringify([op, ...args])})`));
  }

  // Types `to` into the control, or picks its option, through the browser's own editing, which
  // keeps the control's limits such as maxlength or a slider's range. False when the browser
  // refuses.
  async #edit(control: NonNullable<z.infer<typeof EditableSchema>>, to: string): Promise<boolean> {
    const handle = await this.#inFrame(frame => frame.evaluateHandle(`__evalView("element", ${control.id})`));
    const element = handle.asElement();
    try {
      if (element === null) return false;
      if (control.option === null) await element.fill(to, { timeout: COMMIT_MS });
      else await element.selectOption({ value: control.option }, { timeout: COMMIT_MS });
      return true;
    } catch (error) {
      if (this.#browserFailed()) throw error;
      return false;
    } finally {
      await handle.dispose();
    }
  }

  async #state(): Promise<z.infer<typeof StateSchema>> {
    return StateSchema.parse(await this.#frameCall("state"));
  }

  async #text(): Promise<string> {
    return z.string().parse(await this.#frameCall("text"));
  }

  #waitForText(test: (text: string) => boolean, ms: number): Promise<TextWait> {
    return this.#waitFor(() => this.#text(), test, ms).then(({ pass, value }) => ({ pass, text: value }));
  }

  async #waitFor<T>(read: () => Promise<T>, test: (value: T) => boolean, ms: number):
      Promise<{ pass: boolean; value: T }> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (test(value)) return { pass: true, value };
      if (Date.now() >= deadline) return { pass: false, value };
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

  // Clicks the element where nothing covers it. False when nowhere on it is clear.
  async #clickTarget(id: number): Promise<boolean> {
    const aim = AimSchema.parse(await this.#frameCall("aim", id));
    if (aim.hits) await this.#mouseClick(aim.x, aim.y);
    return aim.hits;
  }

  #browserFailed(): boolean {
    return this.#crash !== undefined || this.#context.browser()?.isConnected() === false;
  }

  #hostError(error: unknown): unknown {
    return this.#browserFailed()
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
