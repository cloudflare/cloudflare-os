// Word-level three-way merge of one block's HTML, for when the same block is
// changed in two places at once: two people typing in one paragraph, or the
// agent's updateBlock landing on the paragraph someone is typing in. Pure
// string code, so the editor and its unit tests run the very same function.
//
// A block is read as a row of tokens: words, runs of whitespace and single
// other characters, each carrying the inline formatting it sits in (its
// "marks": the open tags of the <b>, <a href=…>, <span class=…> around it);
// void elements (<br>, <img>, <col>) as atoms; and, for every structural
// element inside the block (a list item, a nested list, a table row or cell),
// a token where it opens, naming its place by the tag names above it. Each
// side is diffed against the base token by token. Changes that touch
// different stretches of the base all apply; where both sides changed the same
// stretch, the local side's version of that stretch wins (unless both only
// deleted, or both made the same change). Two insertions at one point are both
// kept, the local one first, unless one contains the other.
//
// The block is rebuilt from the merged tokens -- formatting from each token's
// marks, structure from the open tokens -- so the result is always balanced
// HTML. The block element's own tag and attributes (heading level, list kind,
// alignment) merge one by one, the local side winning a conflict. A result
// whose shape none of the inputs had (a list item inside a heading, a ragged
// table) is refused, and the local side is kept whole.
//
// Positions: the merge maps caret positions in the local side into the result.
// A position counts the "units" before it within the block: one per text
// character, one per void element, one per structural element (where it
// opens). Inline formatting elements and comments count nothing. The editor
// measures the DOM the same way (see MARK_TAGS and VOID_TAGS).

/** Inline formatting elements: what they hold carries them as marks, and they count no position. */
export const MARK_TAGS: ReadonlySet<string> = new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "del", "dfn", "em", "font", "i", "ins", "kbd",
  "mark", "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time", "u", "var",
]);
/** Void elements: atoms, one position each. */
export const VOID_TAGS: ReadonlySet<string> = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** The result of {@link mergeBlockHtml}. */
export interface BlockMerge {
  /** The merged block's HTML. */
  html: string;
  /** Where a position in the local side's block lands in the merged block. */
  mapPosition(position: number): number;
}

/* ── Reading HTML ─────────────────────────────────────────────────────────── */

interface HElement { name: string; open: string; children: HNode[] }
type HNode = HElement | { text: string } | { comment: string };

const TAG = /<!--([\s\S]*?)--!?>|<\/([a-zA-Z][^\s/>]*)\s*>|<([a-zA-Z][^\s/>]*)(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/g;
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") {
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});
// The way a browser serializes text, so an untouched stretch comes out as it went in.
const encode = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
const tagNameOf = (open: string) => (/^<([^\s/>]+)/.exec(open)?.[1] ?? "").toLowerCase();

// The block's one top-level element, or null when the HTML is not exactly one element.
function parseElement(html: string): HElement | null {
  const top: HElement = { name: "#top", open: "", children: [] };
  const stack = [top];
  let last = 0;
  const text = (s: string) => { if (s) stack[stack.length - 1].children.push({ text: decode(s) }); };
  for (const m of html.matchAll(TAG)) {
    text(html.slice(last, m.index));
    last = m.index + m[0].length;
    const parent = stack[stack.length - 1];
    if (m[1] !== undefined) parent.children.push({ comment: m[1] });
    else if (m[2] !== undefined) {
      const name = m[2].toLowerCase();
      const at = stack.findLastIndex((e) => e.name === name);
      if (at > 0) stack.length = at;
    } else {
      const el: HElement = { name: m[3].toLowerCase(), open: m[0], children: [] };
      parent.children.push(el);
      if (!VOID_TAGS.has(el.name)) stack.push(el);
    }
  }
  text(html.slice(last));
  const kids = top.children.filter((n) => !("text" in n) || n.text.trim());
  return kids.length === 1 && "name" in kids[0] ? kids[0] : null;
}

/** A block element's own tag: its name and its attributes, each as written (`name="value"`). */
interface RootTag { name: string; attrs: Map<string, string> }
function rootTag(el: HElement): RootTag {
  const attrs = new Map<string, string>();
  const rest = el.open.slice(1 + el.name.length).replace(/\/?>$/, "");
  for (const m of rest.matchAll(ATTRIBUTE)) attrs.set(m[1].toLowerCase(), m[0]);
  return { name: el.name, attrs };
}
const openTagOf = (tag: RootTag) => `<${tag.name}${Array.from(tag.attrs.values(), (a) => " " + a).join("")}>`;

/* ── Tokens ───────────────────────────────────────────────────────────────── */

const WORD = /[\p{L}\p{N}_'’]+|\s+|[^\s]/gu;

interface Token {
  kind: "text" | "atom" | "open" | "resume";
  /** What the diff compares. */
  key: string;
  /** Positions it takes (see the top of the file). */
  units: number;
  /** Open tags of the inline formatting around it, outermost first. */
  marks: string[];
  /** The decoded text, or the atom's / structural element's HTML (its open tag). */
  html: string;
  /** For open and resume tokens: the structural tag names from the block down to the element. */
  path: string[];
}

/** A block read as tokens, plus the shapes it has: which child kinds appear under which elements. */
interface Linear {
  tokens: Token[];
  /** `parent>child` pairs inside the block; `child` is a tag name or "#inline". */
  pairs: Set<string>;
  /** Child kinds directly under the block element. */
  rootKids: Set<string>;
}

// Spaces compare by kind, not by how many or which: browsers swap spaces and
// non-breaking spaces as you type, and the agent's Markdown trims them. Only a
// line break, or any spacing in a code block, is compared as written.
const SPACE = /^\s+$/;
const spaceKey = (word: string, exact: boolean) => !SPACE.test(word) ? word : exact || word.includes("\n") ? word.replace(/\u00a0/g, " ") : " ";
const isSpace = (t: Token) => t.kind === "text" && SPACE.test(t.html);

const isStructural = (n: HNode) => "name" in n && !MARK_TAGS.has(n.name) && !VOID_TAGS.has(n.name);
function linearize(root: HElement): Linear {
  const exactSpaces = root.name === "pre";
  const tokens: Token[] = [], pairs = new Set<string>(), rootKids = new Set<string>();
  const note = (path: string[], kid: string) => { if (path.length) pairs.add(path[path.length - 1] + ">" + kid); else rootKids.add(kid); };
  const walk = (el: HElement, marks: string[], path: string[]) => {
    el.children.forEach((child, i) => {
      if ("text" in child) {
        for (const word of child.text.match(WORD) ?? []) tokens.push({ kind: "text", key: "t" + marks.join("") + "\0" + spaceKey(word, exactSpaces), units: word.length, marks, html: word, path });
        if (child.text) note(path, "#inline");
      } else if ("comment" in child) {
        tokens.push({ kind: "atom", key: "c" + child.comment, units: 0, marks, html: `<!--${child.comment}-->`, path });
      } else if (VOID_TAGS.has(child.name)) {
        tokens.push({ kind: "atom", key: "a" + marks.join("") + "\0" + child.open, units: 1, marks, html: child.open, path });
        note(path, "#inline");
      } else if (MARK_TAGS.has(child.name)) {
        walk(child, [...marks, child.open], path);
      } else {
        const inner = [...path, child.name];
        note(path, child.name);
        tokens.push({ kind: "open", key: "s" + path.join(">") + "\0" + child.open, units: 1, marks: [], html: child.open, path: inner });
        walk(child, [], inner);
        // Inline content after a nested element (text after a sub-list in an item) goes back to this one.
        if (el.children.slice(i + 1).some((n) => !isStructural(n))) tokens.push({ kind: "resume", key: "r" + path.join(">"), units: 0, marks: [], html: "", path });
      }
    });
  };
  walk(root, [], []);
  return { tokens, pairs, rootKids };
}

/* ── Rebuilding ───────────────────────────────────────────────────────────── */

interface RNode { name: string; open: string; kids: (RNode | Token)[] }

function rebuild(tag: RootTag, tokens: Token[]): RNode {
  const root: RNode = { name: tag.name, open: openTagOf(tag), kids: [] };
  const stack: { node: RNode; path: string[] }[] = [{ node: root, path: [] }];
  const top = () => stack[stack.length - 1];
  const isPrefix = (p: string[], of: string[]) => p.length <= of.length && p.every((n, i) => n === of[i]);
  for (const tok of tokens) {
    if (tok.kind === "text" || tok.kind === "atom") { top().node.kids.push(tok); continue; }
    const parentPath = tok.kind === "open" ? tok.path.slice(0, -1) : tok.path;
    while (stack.length > 1 && !isPrefix(top().path, parentPath)) stack.pop();
    if (tok.kind === "resume") continue;
    // A parent whose own open token the merge removed is supplied bare.
    while (top().path.length < parentPath.length) {
      const name = parentPath[top().path.length];
      const node: RNode = { name, open: `<${name}>`, kids: [] };
      top().node.kids.push(node);
      stack.push({ node, path: parentPath.slice(0, top().path.length + 1) });
    }
    const node: RNode = { name: tok.path[tok.path.length - 1], open: tok.html, kids: [] };
    top().node.kids.push(node);
    stack.push({ node, path: tok.path });
  }
  return root;
}

function serialize(node: RNode): string {
  if (VOID_TAGS.has(node.name)) return node.open;
  let out = node.open;
  const open: string[] = [];
  const closeTo = (k: number) => { while (open.length > k) out += `</${tagNameOf(open.pop()!)}>`; };
  for (const kid of node.kids) {
    if (!("key" in kid)) { closeTo(0); out += serialize(kid); continue; }
    let k = 0;
    while (k < open.length && k < kid.marks.length && open[k] === kid.marks[k]) k++;
    closeTo(k);
    for (const m of kid.marks.slice(k)) { out += m; open.push(m); }
    out += kid.kind === "text" ? encode(kid.html) : kid.html;
  }
  closeTo(0);
  return out + `</${node.name}>`;
}

// Whether the rebuilt block has only shapes some input had (the block element's
// own children judged against inputs with the same tag), and tables stay
// rectangular -- the editor's table model has no spans.
function wellFormed(root: RNode, inputs: { tag: RootTag; lin: Linear }[]): boolean {
  if (VOID_TAGS.has(root.name)) return !root.kids.length;
  const pairs = new Set<string>(), rootKids = new Set<string>();
  for (const { tag, lin } of inputs) {
    lin.pairs.forEach((p) => pairs.add(p));
    if (tag.name === root.name) lin.rootKids.forEach((k) => rootKids.add(k));
  }
  const kindOf = (kid: RNode | Token) => "key" in kid ? (kid.units ? "#inline" : null) : kid.name;
  const check = (node: RNode, isRoot: boolean): boolean => node.kids.every((kid) => {
    const kind = kindOf(kid);
    if (kind && !(isRoot ? rootKids.has(kind) : pairs.has(node.name + ">" + kind))) return false;
    return "key" in kid || check(kid, false) && (kid.name !== "table" || rectangular(kid));
  });
  return check(root, true) && (root.name !== "table" || rectangular(root));
}
function rectangular(table: RNode): boolean {
  const widths: number[] = [];
  const rows = (n: RNode): void => n.kids.forEach((k) => {
    if ("key" in k) return;
    if (k.name === "tr") widths.push(k.kids.filter((c) => !("key" in c) && (c.name === "td" || c.name === "th")).length);
    else if (k.name !== "colgroup") rows(k);
  });
  rows(table);
  const colgroup = table.kids.find((k): k is RNode => !("key" in k) && k.name === "colgroup");
  if (colgroup) widths.push(colgroup.kids.filter((c) => "key" in c && tagNameOf(c.html) === "col").length);
  return widths.every((w) => w === widths[0]);
}

/* ── Diff ─────────────────────────────────────────────────────────────────── */

/** Base tokens [s, e) replaced by the side's tokens [bs, be). */
interface Hunk { s: number; e: number; bs: number; be: number }

// Beyond this many cells the middle of a diff is taken as one change: coarser, never wrong.
const MAX_DIFF_CELLS = 1_000_000;
function diff(a: string[], b: string[]): Hunk[] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const n = a.length - p - q, m = b.length - p - q;
  if (!n && !m) return [];
  if (!n || !m || (n + 1) * (m + 1) > MAX_DIFF_CELLS) return [{ s: p, e: p + n, bs: p, be: p + m }];
  const w = m + 1, lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i * w + j] = a[p + i] === b[p + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  }
  const hunks: Hunk[] = [];
  let open: Hunk | null = null, i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[p + i] === b[p + j]) { open = null; i++; j++; continue; }
    if (!open) hunks.push(open = { s: p + i, e: p + i, bs: p + j, be: p + j });
    if (j < m && (i >= n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) open.be = p + ++j;
    else open.e = p + ++i;
  }
  return hunks;
}

/* ── Merge ────────────────────────────────────────────────────────────────── */

/** A merged token, and the index of the local side's token it is (-1 when it is not one). */
interface Out { tok: Token; mine: number }

/**
 * Merges two concurrent versions of one block: `base` is the version both started from, `theirs`
 * the other side's (the server's), `mine` the local draft. Changes to different parts of the base
 * both survive; where both changed the same stretch, `mine` wins that stretch. See the top of the
 * file for the whole rule and for what a position is.
 */
export function mergeBlockHtml(base: string, theirs: string, mine: string): BlockMerge {
  const identity = (p: number) => p;
  if (theirs === base || theirs === mine) return { html: mine, mapPosition: identity };
  const bEl = parseElement(base), tEl = parseElement(theirs), mEl = parseElement(mine);
  if (!bEl || !tEl || !mEl) return mine === base ? { html: theirs, mapPosition: identity } : { html: mine, mapPosition: identity };
  const [B, T, M] = [bEl, tEl, mEl].map((el) => ({ tag: rootTag(el), lin: linearize(el) }));

  // The block element itself: tag name and each attribute, mine winning where both changed it.
  const pick = <V>(b: V, t: V, m: V) => m !== b ? m : t;
  const tag: RootTag = { name: pick(B.tag.name, T.tag.name, M.tag.name), attrs: new Map() };
  for (const name of new Set([...M.tag.attrs.keys(), ...T.tag.attrs.keys()])) {
    const value = pick(B.tag.attrs.get(name), T.tag.attrs.get(name), M.tag.attrs.get(name));
    if (value !== undefined) tag.attrs.set(name, value);
  }

  const base_ = B.lin.tokens, mineToks = M.lin.tokens, theirToks = T.lin.tokens;
  const keys = (ts: Token[]) => ts.map((t) => t.key);
  // A change that also deletes the spaces at its edge gives those up as a change
  // of their own, so they meet the spacing rule below.
  const splitSpaces = (hunks: Hunk[], side: Token[]) => hunks.flatMap((h): Hunk[] => {
    const parts: Hunk[] = [];
    let { s, e } = h;
    if (h.bs === h.be || !isSpace(side[h.bs])) {
      let k = s;
      while (k < e && isSpace(base_[k])) k++;
      if (k > s && k < e) { parts.push({ s, e: k, bs: h.bs, be: h.bs }); s = k; }
    }
    let tail: Hunk | null = null;
    if (h.bs === h.be || !isSpace(side[h.be - 1])) {
      let k = e;
      while (k > s && isSpace(base_[k - 1])) k--;
      if (k < e && k > s) { tail = { s: k, e, bs: h.be, be: h.be }; e = k; }
    }
    parts.push({ s, e, bs: h.bs, be: h.be });
    if (tail) parts.push(tail);
    return parts;
  });
  const mineHunks = splitSpaces(diff(keys(base_), keys(mineToks)), mineToks);
  const theirHunks = splitSpaces(diff(keys(base_), keys(theirToks)), theirToks);
  // Which token of a side each base token is, where that side kept it.
  const keptBy = (hunks: Hunk[]) => {
    const of = new Int32Array(base_.length).fill(-1);
    let i = 0, j = 0;
    for (const h of hunks) { while (i < h.s) of[i++] = j++; i = h.e; j = h.be; }
    while (i < base_.length) of[i++] = j++;
    return of;
  };
  const mineOf = keptBy(mineHunks), theirOf = keptBy(theirHunks);

  // Changes touching the same stretch of the base, transitively, form one
  // cluster. A change of spacing alone also joins a change right beside it, so
  // a trimmed space can't glue the word typed after it to the word before.
  const spacesOnly = (h: Hunk, side: Token[]) => base_.slice(h.s, h.e).every(isSpace) && side.slice(h.bs, h.be).every(isSpace);
  const all = [
    ...mineHunks.map((h) => ({ ...h, mine: true, spaces: spacesOnly(h, mineToks) })),
    ...theirHunks.map((h) => ({ ...h, mine: false, spaces: spacesOnly(h, theirToks) })),
  ];
  const parent = all.map((_, k) => k);
  const find = (k: number): number => parent[k] === k ? k : (parent[k] = find(parent[k]));
  all.forEach((x, k) => all.forEach((y, l) => {
    if (l <= k || x.mine === y.mine) return;
    const overlap = x.s < y.e && y.s < x.e || x.s === x.e && y.s === y.e && x.s === y.s ||
      (x.spaces || y.spaces) && x.s <= y.e && y.s <= x.e;
    if (overlap) parent[find(k)] = find(l);
  }));
  const clusters = new Map<number, typeof all>();
  all.forEach((h, k) => { const r = find(k); clusters.set(r, [...clusters.get(r) ?? [], h]); });
  const ordered: { hs: typeof all; s: number; e: number }[] = [];
  for (const c of Array.from(clusters.values(), (hs) => ({ hs, s: Math.min(...hs.map((h) => h.s)), e: Math.max(...hs.map((h) => h.e)) }))
    .sort((x, y) => x.s - y.s || (x.e - x.s) - (y.e - y.s))) {
    // Clusters are written one after another, so one that starts inside the last is part of it.
    const last = ordered[ordered.length - 1];
    if (last && c.s < last.e) { last.hs = [...last.hs, ...c.hs]; last.e = Math.max(last.e, c.e); }
    else ordered.push(c);
  }

  // A kept token is written as the local side has it (its kind of space), else as the other side has it.
  const baseOut = (i: number): Out => ({ tok: mineOf[i] >= 0 ? mineToks[mineOf[i]] : theirOf[i] >= 0 ? theirToks[theirOf[i]] : base_[i], mine: mineOf[i] });
  const apply = (hs: Hunk[], side: Token[], isMine: boolean, s: number, e: number): Out[] => {
    const res: Out[] = [];
    let i = s;
    for (const h of [...hs].sort((x, y) => x.s - y.s)) {
      while (i < h.s) res.push(baseOut(i++));
      for (let j = h.bs; j < h.be; j++) res.push({ tok: side[j], mine: isMine ? j : -1 });
      i = h.e;
    }
    while (i < e) res.push(baseOut(i++));
    return res;
  };
  const sameKeys = (x: Out[], y: Out[]) => x.length === y.length && x.every((o, k) => o.tok.key === y[k].tok.key);
  const contains = (outer: Out[], inner: Out[]) => {
    for (let k = 0; k + inner.length <= outer.length; k++) if (inner.every((o, l) => o.tok.key === outer[k + l].tok.key)) return true;
    return false;
  };

  const out: Out[] = [];
  let i = 0;
  for (const c of ordered) {
    while (i < c.s) out.push(baseOut(i++));
    const mh = c.hs.filter((h) => h.mine), th = c.hs.filter((h) => !h.mine);
    const mm = apply(mh, mineToks, true, c.s, c.e), tt = apply(th, theirToks, false, c.s, c.e);
    if (!th.length || sameKeys(mm, tt)) out.push(...mm);
    else if (!mh.length) out.push(...tt);
    else if (c.hs.every((h) => h.bs === h.be)) {
      // Both only deleted: everything either side deleted goes.
      for (let k = c.s; k < c.e; k++) if (!c.hs.some((h) => h.s <= k && k < h.e)) out.push(baseOut(k));
    } else if (th.every((h) => h.spaces)) out.push(...mm);
    else if (mh.every((h) => h.spaces)) out.push(...tt);
    else if (c.s === c.e && !contains(mm, tt) && !contains(tt, mm)) {
      // Both inserted here: both stay, the local text first, one space between.
      out.push(...mm, ...(mm.length && isSpace(mm[mm.length - 1].tok) && tt.length && isSpace(tt[0].tok) ? tt.slice(1) : tt));
    } else out.push(...mm);
    i = c.e;
  }
  while (i < base_.length) out.push(baseOut(i++));

  const tokens = out.map((o) => o.tok);
  const root = rebuild(tag, tokens);
  if (!wellFormed(root, [B, T, M])) return { html: mine, mapPosition: identity };
  const sameTag = (x: RootTag) => x.name === tag.name && x.attrs.size === tag.attrs.size && Array.from(tag.attrs).every(([k, v]) => x.attrs.get(k) === v);
  const sameAs = (side: Token[]) => side.length === tokens.length && side.every((t, k) => t.key === tokens[k].key && t.html === tokens[k].html);
  const html = sameTag(M.tag) && sameAs(mineToks) ? mine : sameTag(T.tag) && sameAs(theirToks) ? theirs : serialize(root);

  // Positions: each local token's start, and where it landed (if it survived).
  const mineStart: number[] = [];
  let pos = 0;
  for (const t of mineToks) { mineStart.push(pos); pos += t.units; }
  const landed = new Array<number>(mineToks.length).fill(-1);
  pos = 0;
  for (const o of out) { if (o.mine >= 0) landed[o.mine] = pos; pos += o.tok.units; }
  const total = pos;
  return {
    html,
    mapPosition(p: number) {
      if (p <= 0) return 0;
      // The token the position follows: a caret sticks to what is before it.
      let k = mineToks.findIndex((t, x) => t.units > 0 && mineStart[x] < p && p <= mineStart[x] + t.units);
      if (k < 0) return total;
      if (landed[k] >= 0) return landed[k] + p - mineStart[k];
      // That token was deleted on the other side: just after the nearest earlier one that survived.
      while (--k >= 0) if (landed[k] >= 0 && mineToks[k].units > 0) return landed[k] + mineToks[k].units;
      return 0;
    },
  };
}
