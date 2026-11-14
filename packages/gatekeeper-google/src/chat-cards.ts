// Read-only extraction of what Chat apps show in message cards, both the current `cardsV2` and the
// legacy `cards`. The two formats share their header, section, text paragraph, image, and openLink
// shapes, and their other widget keys don't collide, so one walker reads either.
//
// Cards are app-authored and loosely shaped, so every field is read as unknown and kept only when
// it has the expected type. Nothing here follows a link or runs a card action: action callbacks,
// form inputs, and widgets with nothing to read are dropped, and only http(s) links are kept.

import type { ChatCard, ChatCardLink } from "./chat-types";

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : undefined;
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(record).filter(item => item !== undefined) : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function webUrl(value: unknown): string | undefined {
  const url = str(value);
  if (url === undefined || !URL.canParse(url)) return undefined;
  const { protocol } = new URL(url);
  return protocol === "https:" || protocol === "http:" ? url : undefined;
}

class CardReader {
  readonly lines: string[] = [];
  readonly links: ChatCardLink[] = [];

  text(...values: unknown[]): void {
    for (const value of values) {
      const line = str(value);
      if (line !== undefined) this.lines.push(line);
    }
  }

  /** An `onClick` that opens a URL, directly or from an overflow menu; other actions are dropped. */
  onClick(value: unknown, label: unknown): void {
    const onClick = record(value);
    this.#link(record(onClick?.openLink)?.url, label);
    for (const item of list(record(onClick?.overflowMenu)?.items)) {
      this.#link(record(record(item.onClick)?.openLink)?.url, item.text);
    }
  }

  /** A `cardsV2` button, or a legacy `textButton` / `imageButton` wrapper. */
  button(value: unknown): void {
    const button = record(value);
    if (button === undefined) return;
    const legacy = record(button.textButton) ?? record(button.imageButton);
    if (legacy !== undefined) {
      this.onClick(legacy.onClick, legacy.text ?? legacy.name);
      return;
    }
    this.onClick(button.onClick, button.text ?? button.altText);
  }

  widgets(value: unknown, nested = false): void {
    for (const widget of list(value)) this.#widget(widget, nested);
  }

  #widget(widget: Json, nested: boolean): void {
    const paragraph = record(widget.textParagraph);
    if (paragraph) this.text(paragraph.text);

    const decorated = record(widget.decoratedText) ?? record(widget.keyValue);
    if (decorated) {
      const text = decorated.text ?? decorated.content;
      this.text(decorated.topLabel, text, decorated.bottomLabel);
      this.button(decorated.button);
      this.onClick(decorated.onClick, text);
    }

    for (const button of list(record(widget.buttonList)?.buttons)) this.button(button);
    for (const button of list(widget.buttons)) this.button(button);

    const image = record(widget.image);
    if (image) this.onClick(image.onClick, image.altText);

    for (const chip of list(record(widget.chipList)?.chips)) this.onClick(chip.onClick, chip.label);

    const grid = record(widget.grid);
    if (grid) {
      this.text(grid.title);
      for (const item of list(grid.items)) this.text(item.title, item.subtitle);
      this.onClick(grid.onClick, grid.title);
    }

    // Google doesn't nest columns or carousels, so neither is followed below one level.
    if (nested) return;
    for (const column of list(record(widget.columns)?.columnItems)) this.widgets(column.widgets, true);
    for (const card of list(record(widget.carousel)?.carouselCards)) {
      this.widgets(card.widgets, true);
      this.widgets(card.footerWidgets, true);
    }
  }

  #link(url: unknown, label: unknown): void {
    const href = webUrl(url);
    if (href === undefined) return;
    const text = str(label);
    this.links.push({ ...(text !== undefined ? { label: text } : {}), url: href });
  }
}

function chatCardFromRaw(value: unknown): ChatCard | undefined {
  const card = record(value);
  if (card === undefined) return undefined;
  const header = record(card.header);
  const reader = new CardReader();
  for (const section of list(card.sections)) {
    reader.text(section.header);
    reader.widgets(section.widgets);
  }
  const footer = record(card.fixedFooter);
  reader.button(footer?.primaryButton);
  reader.button(footer?.secondaryButton);
  for (const action of list(card.cardActions)) reader.onClick(action.onClick, action.actionLabel);

  const title = str(header?.title);
  const subtitle = str(header?.subtitle);
  if (title === undefined && subtitle === undefined && reader.lines.length === 0 && reader.links.length === 0) {
    return undefined;
  }
  return {
    ...(title !== undefined ? { title } : {}),
    ...(subtitle !== undefined ? { subtitle } : {}),
    text: reader.lines.join("\n"),
    links: reader.links,
  };
}

/** The readable content of a message's cards, `cardsV2` first; cards with nothing readable are left out. */
export function chatCardsFromRaw(raw: { cards?: unknown; cardsV2?: unknown }): ChatCard[] {
  const cards = [
    ...list(raw.cardsV2).map(entry => entry.card),
    ...(Array.isArray(raw.cards) ? raw.cards : []),
  ];
  return cards.flatMap(card => chatCardFromRaw(card) ?? []);
}
