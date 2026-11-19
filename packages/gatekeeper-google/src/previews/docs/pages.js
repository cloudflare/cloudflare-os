// Sets the boxes of a Google Doc tab (draw.js) on sheets of paper, as Google Docs does: each
// sheet with its section's margins, header and footer, the body flowing down its columns, and a
// paragraph or a table that a page ends in carried on at the top of the next.
//
// The sheets are measured as they are filled, so they must be laid out at their own size: the
// preview scales them only afterwards.

import { make } from './ui/chrome.js';

const styleSheet = document.createElement('style');
styleSheet.textContent = `
  /* Paper is the document's own, in the light and in the dark: its colors were chosen for it. */
  .sheet { position: relative; box-sizing: border-box; margin: 0 auto 16px; background: #fff;
    color: #000; color-scheme: light; border-radius: 2px; box-shadow: var(--paper);
    overflow: hidden; isolation: isolate; animation: arrive .25s ease-out; }
  .sheet > :is(.head, .foot, .body) { position: absolute; top: 0; left: 0; right: 0; box-sizing: border-box; }
  .area { display: flex; box-sizing: border-box; }
  .col { position: relative; flex: none; min-width: 0; }
  .col.ruled::before { content: ''; position: absolute; top: 0; bottom: 0; left: calc(var(--gap) / -2);
    border-left: 1px solid #000; }
  .notes { position: absolute; bottom: 0; left: 0; right: 0; box-sizing: border-box; }
  .notes::before { content: ''; display: block; width: 144pt; margin: 6pt 0; border-top: 1px solid #000; }
  /* A sheet as long as what is on it: a pageless document, or one read change by change. */
  .sheet.endless > .body { position: static; }
  .pagebreak { display: flex; align-items: center; gap: 8pt; margin: 12pt 0; color: #80868b;
    font: 8pt/1 Arial, sans-serif; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
  .pagebreak::before, .pagebreak::after { content: ''; flex: 1; border-top: 1px dashed #c4c7c5; }
`;
document.head.append(styleSheet);

/** CSS pixels to a point, which the drawing is measured in. */
const PX = 4 / 3;
/** How far past its room a box may reach and still fit: less than anyone could see. */
const SLACK = .5;

const boxOf = element => element.getBoundingClientRect();
/** The space under a paragraph, which may hang off the foot of a page. */
const spaceBelow = element => parseFloat(element.style.paddingBottom) * PX || 0;

/**
 * The lines of a paragraph as the browser broke them: where each starts and ends down the page,
 * and the first thing on it, a text node from its character `offset` or an element.
 */
function linesOf(element) {
  const lines = [];
  const range = document.createRange();
  const add = (node, rect, start) => {
    if (!rect.height) return;
    const line = lines.at(-1);
    // Everything on a line overlaps the rest of it, however small or large it is set.
    if (line && (rect.top + rect.bottom) / 2 < line.bottom) {
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else {
      lines.push({ top: rect.top, bottom: rect.bottom, node, start });
    }
  };
  const visit = parent => {
    for (const node of parent.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        range.selectNodeContents(node);
        for (const [n, rect] of [...range.getClientRects()].entries()) add(node, rect, n === 0);
      } else if (node.nodeType !== Node.ELEMENT_NODE || node.matches('.lift, .row, .tick, br') ||
          node.style.float || node.style.position === 'absolute') {
        // Set against the paragraph rather than on a line of it.
      } else if (node.matches('.obj, .marker, .chip, .rule')) {
        add(node, boxOf(node), true);
      } else {
        visit(node);
      }
    }
  };
  visit(element);
  return lines;
}

/** The character of text node `node` that the line under `edge` starts with. */
function lineStart(node, edge) {
  const range = document.createRange();
  const under = offset => {
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const [rect] = range.getClientRects();
    return !!rect && (rect.top + rect.bottom) / 2 > edge;
  };
  let low = 0;
  let high = node.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (under(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** Takes what `element` holds from `node` on, at `offset` of its text, into a paragraph that carries it on. */
function cut(element, node, offset) {
  const range = document.createRange();
  if (offset > 0) {
    range.setStart(node, offset);
  } else {
    // From before the outermost box that starts here, so no empty copy of it is left behind.
    let start = node;
    while (start.parentNode !== element && !start.previousSibling) start = start.parentNode;
    range.setStartBefore(start);
  }
  range.setEndAfter(element.lastChild);
  const rest = element.cloneNode(false);
  rest.append(range.extractContents());
  element.classList.add('cut');
  rest.classList.add('rest');
  for (const name of ['role', 'aria-level', 'data-heading', 'data-before']) rest.removeAttribute(name);
  return rest;
}

/**
 * Ends a paragraph at `bottom`: answers with the paragraph that carries it on, with the element
 * itself when none of it may stay, or with nothing when all of it does. `forced` says something
 * must stay, as when the paragraph is the first thing in its column.
 */
function splitParagraph(element, bottom, forced) {
  const lines = linesOf(element);
  const end = boxOf(element).bottom - spaceBelow(element);
  // Where line `count` ends: halfway to the next, since lines stand a little apart.
  const edge = count => count < lines.length ? (lines[count - 1].bottom + lines[count].top) / 2 : end;
  let fits = 0;
  while (fits < lines.length && edge(fits + 1) <= bottom + SLACK) fits++;
  let keep = fits;
  if ('whole' in element.dataset) keep = 0;
  // Neither a first line nor a last is left on a page alone.
  if ('pairs' in element.dataset && keep === lines.length - 1) keep--;
  if ('pairs' in element.dataset && keep < 2) keep = 0;
  if (keep === 0 && forced) keep = Math.max(1, fits);
  if (keep >= lines.length) return undefined;
  if (keep === 0) return element;
  const { node, start } = lines[keep];
  const offset = node.nodeType === Node.TEXT_NODE && !start ? lineStart(node, edge(keep)) : 0;
  return cut(element, node, offset);
}

/** What `container`, a table cell, holds past `bottom`, taken out of it. */
function takePast(container, bottom) {
  const children = [...container.children];
  const at = children.findIndex(child => boxOf(child).bottom - spaceBelow(child) > bottom + SLACK);
  if (at < 0) return [];
  const rest = split(children[at], bottom, false);
  return [...rest ? [rest] : [], ...children.slice(at + 1)];
}

/** Ends a table's row at `bottom`, if any cell of it has a line that fits: answers with the row that carries it on. */
function splitRow(row, bottom) {
  const starts = [...row.cells].some(cell => {
    const first = cell.firstElementChild;
    const line = first?.matches('.para') ? linesOf(first)[0] : first && boxOf(first);
    return line && line.bottom <= bottom + SLACK;
  });
  if (!starts) return undefined;
  const rest = row.cloneNode(false);
  rest.style.height = '';
  for (const cell of row.cells) {
    const room = bottom - parseFloat(getComputedStyle(cell).paddingBottom);
    rest.appendChild(cell.cloneNode(false)).append(...takePast(cell, room));
  }
  return rest;
}

/** Ends a table at `bottom`, between two rows or inside one: answers as splitParagraph() does. */
function splitTable(table, bottom, forced) {
  const rows = [...table.tBodies[0].rows];
  const heads = rows.filter(row => 'header' in row.dataset);
  let at = rows.findIndex(row => boxOf(row).bottom > bottom + SLACK);
  if (at < 0) return undefined;
  const whole = 'unbroken' in rows[at].dataset || 'header' in rows[at].dataset;
  const part = whole ? undefined : splitRow(rows[at], bottom);
  if (!part && at <= heads.length) {
    if (!forced) return table;
    // A row taller than its page stays, and the table goes on after it.
    if (++at >= rows.length) return undefined;
  }
  const rest = table.cloneNode(false);
  const group = table.querySelector(':scope > colgroup');
  if (group) rest.append(group.cloneNode(true));
  const body = rest.appendChild(make('tbody'));
  // The rows a table repeats at the top of each page.
  if (at >= heads.length) body.append(...heads.map(head => head.cloneNode(true)));
  const moved = part ? [part, ...rows.slice(at + 1)] : rows.slice(at);
  // A cell merged down past the break is carried on, empty, beside the rows it still spans.
  for (const [index, row] of rows.slice(0, at).entries()) {
    for (const cell of row.cells) {
      const left = index + cell.rowSpan - at;
      if (left <= 0) continue;
      const more = cell.cloneNode(false);
      more.rowSpan = left;
      cell.rowSpan = at - index + (part ? 1 : 0);
      const after = [...moved[0].cells].find(other => Number(other.dataset.column) > Number(cell.dataset.column));
      moved[0].insertBefore(more, after ?? null);
    }
  }
  body.append(...moved);
  return rest;
}

function split(element, bottom, forced) {
  if (element.matches('.para')) return splitParagraph(element, bottom, forced);
  if (element.matches('table')) return splitTable(element, bottom, forced);
  return forced ? undefined : element;
}

/**
 * Sets `items` on sheets in `root`, in place of what it holds. An item is `{ element }`, a box of
 * draw.js; `{ element, gap: true }`, a mark that takes no room; or `{ section }`, where that
 * section of `drawing` starts. `draw(blocks)` gives the elements of a header, a footer or a
 * footnote. An `endless` drawing is one sheet as long as the items, with neither.
 */
export function paginate(root, drawing, items, draw, endless) {
  const { page } = drawing;
  root.replaceChildren();
  let section = drawing.sections[0];
  // Whether the next sheet is the first of its section.
  let first = true;
  let number = 0;
  let sheet;
  let area;
  let column;
  // What the column being filled holds.
  let placed = [];
  const sheets = [];

  function newArea() {
    if (area && !area.element.querySelector('.col > *')) area.element.remove();
    const { margins, columns } = section;
    const element = sheet.body.appendChild(make('div', 'area'));
    element.style.padding = `0 ${margins.right}pt 0 ${margins.left}pt`;
    const room = (section.landscape ? page.height : page.width) - margins.left - margins.right;
    const list = columns ?? [{ width: room, gap: 0 }];
    const gaps = list.slice(0, -1).reduce((sum, { gap }) => sum + gap, 0);
    area = {
      element,
      at: 0,
      columns: list.map(({ width, gap }, n) => {
        const box = element.appendChild(make('div', section.columnRule && n ? 'col ruled' : 'col'));
        box.style.width = `${width || (room - gaps) / list.length}pt`;
        if (n < list.length - 1) box.style.marginRight = `${gap}pt`;
        if (n) box.style.setProperty('--gap', `${list[n - 1].gap}pt`);
        return box;
      }),
    };
    column = area.columns[0];
    placed = [];
  }

  function newSheet() {
    const before = number;
    number = first && section.pageNumberStart !== undefined ? section.pageNumberStart : number + 1;
    const { margins } = section;
    const element = root.appendChild(make('section', endless ? 'sheet endless' : 'sheet'));
    element.style.width = `${section.landscape ? page.height : page.width}pt`;
    if (!endless) element.style.height = `${section.landscape ? page.width : page.height}pt`;
    if (page.background) element.style.background = page.background;
    element.setAttribute('aria-label', `Page ${sheets.length + 1}`);
    const body = make('div', 'body');
    if (endless) {
      body.style.padding = `${margins.top}pt 0 ${margins.bottom}pt`;
    } else {
      const even = drawing.evenPages && number % 2 === 0;
      // The header or footer this page takes, set its margin from the page's edge: the body
      // keeps clear of its paragraphs, and not of what is tethered to them.
      const part = (kind, name) => {
        const blocks = drawing[`${kind}s`][section.firstPage && first ? section[`first${name}`]
          : even ? section[`even${name}`] : section[kind]];
        if (!blocks?.length) return 0;
        const box = element.appendChild(make('div', kind === 'header' ? 'head' : 'foot'));
        box.style.padding = `0 ${margins.right}pt 0 ${margins.left}pt`;
        box.append(...draw(blocks));
        for (const field of box.querySelectorAll('[data-field="pageNumber"]')) field.textContent = number;
        const height = boxOf(box.lastElementChild).bottom - boxOf(box).top;
        const edge = margins[kind] * PX;
        box.style.top = `${kind === 'header' ? edge : boxOf(element).height - edge - height}px`;
        return edge + height;
      };
      body.style.top = `${Math.max(margins.top * PX, part('header', 'Header') + (section.headerGap ?? 0) * PX)}px`;
      body.style.bottom = `${Math.max(margins.bottom * PX, part('footer', 'Footer'))}px`;
    }
    element.append(body);
    sheets.push(sheet = { element, body, number, before, empty: true });
    first = false;
    area = undefined;
    newArea();
  }

  function nextColumn() {
    if (++area.at < area.columns.length) {
      column = area.columns[area.at];
      placed = [];
    } else {
      newSheet();
    }
  }

  function enter(index) {
    const turned = !!drawing.sections[index].landscape !== !!section.landscape;
    section = drawing.sections[index];
    if (endless || !(section.newPage || turned)) return void newArea();
    first = true;
    // A section that starts where a sheet has only just been taken has that sheet over.
    if (sheet.empty) {
      sheets.pop().element.remove();
      number = sheet.before;
    }
    newSheet();
  }

  // Where the column being filled ends: at the foot of the body, or at the footnotes over it.
  const limit = () => boxOf(sheet.body).bottom - (sheet.notes ? boxOf(sheet.notes).height : 0);

  // Sets under the body the footnotes `element` refers to, and answers with each and its text.
  function footnotes(element) {
    return [...element.querySelectorAll('[data-footnote]')].flatMap(reference => {
      const blocks = drawing.footnotes[reference.dataset.footnote];
      if (!blocks) return [];
      if (!sheet.notes) {
        sheet.notes = sheet.body.appendChild(make('div', 'notes'));
        sheet.notes.style.padding = `0 ${section.margins.right}pt 0 ${section.margins.left}pt`;
      }
      const text = sheet.notes.appendChild(make('div'));
      text.append(...draw(blocks));
      const mark = reference.cloneNode(true);
      delete mark.dataset.footnote;
      text.querySelector('.para')?.prepend(mark);
      return [{ reference, text }];
    });
  }

  function leave(notes, element) {
    for (const { reference, text } of notes) if (!element?.contains(reference)) text.remove();
    if (sheet.notes && !sheet.notes.firstElementChild) sheet.notes = void sheet.notes.remove();
  }

  newSheet();
  const queue = items.toReversed();
  while (queue.length) {
    const item = queue.pop();
    if (item.section !== undefined) {
      enter(item.section);
      continue;
    }
    const { element } = item;
    // A paragraph ends at a page or column break in it, and what follows starts the next.
    const mark = element.querySelector('.brk');
    if (mark) {
      mark.classList.remove('brk');
      queue.push({ ...item, element: cut(element, mark.nextSibling, 0), before: mark.dataset.break });
    }
    const before = item.before ?? element.dataset.before;
    if (before && endless) column.appendChild(make('div', 'pagebreak', 'Page break'));
    else if (before === 'page' && !sheet.empty) newSheet();
    else if (before && !sheet.empty) nextColumn();
    column.append(element);
    if (endless || item.gap) {
      placed.push(item);
      continue;
    }
    sheet.empty = false;
    const notes = footnotes(element);
    const bottom = limit();
    const rest = boxOf(element).bottom - spaceBelow(element) <= bottom + SLACK ? undefined
      : split(element, bottom, placed.length === 0);
    if (rest !== element) {
      leave(notes, element);
      placed.push(item);
      if (!rest) continue;
      queue.push({ ...item, element: rest, before: undefined });
      nextColumn();
      continue;
    }
    // None of it may stay, so it goes on to the next column, with what is kept beside it.
    leave(notes);
    element.remove();
    queue.push(item);
    let kept = placed.length;
    while (kept > 0 && 'next' in (placed[kept - 1].element.dataset)) kept--;
    if (kept > 0) {
      for (const moved of placed.splice(kept).toReversed()) {
        moved.element.remove();
        queue.push(moved);
      }
    }
    nextColumn();
  }

  for (const { element, number } of sheets) {
    for (const field of element.querySelectorAll('[data-field]')) {
      field.textContent = field.dataset.field === 'pageCount' ? sheets.length : number;
    }
  }
}
