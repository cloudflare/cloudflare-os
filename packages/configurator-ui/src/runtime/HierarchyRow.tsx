import { Badge } from "@cloudflare/kumo/components/badge";
import { cn } from "@cloudflare/kumo/utils";
import { CaretRightIcon } from "@phosphor-icons/react";
import type { KeyboardEvent, ReactNode } from "react";

type ChoiceBodyProps = {
  mark: "checked" | "unchecked" | "none";
  icon: ReactNode;
  title: string;
  subtitle?: string;
  badge?: string;
  meta?: string;
};

const EXTENSION = /\.[^.\s]{1,7}$/u;
const graphemes = new Intl.Segmenter();

/**
 * A title whose end stays in view while the rest gives way: an extension and up to 3 characters
 * before it, counted as the user sees them, so an accent or an emoji is not cut from its letter.
 * The parts are flex items, which a browser names apart, as "Bud get.xlsx", so assistive technology
 * gets the title whole.
 */
const Title = ({ title }: { title: string }) => {
  const extension = EXTENSION.exec(title);
  const start = extension ? [...graphemes.segment(title.slice(0, extension.index))].at(-3)?.index : 0;
  if (!start) return <span className="truncate">{title}</span>;
  return (
    <span className="flex min-w-0">
      <span aria-hidden="true" className="truncate">{title.slice(0, start)}</span>
      <span aria-hidden="true" className="shrink-0 whitespace-pre">{title.slice(start)}</span>
      <span className="sr-only">{title}</span>
    </span>
  );
};

/**
 * What the root's card and every row show: a radio's look (or room for one, so icons line up), an
 * icon and two lines. The look is only a cue; `aria-selected` or `aria-pressed` says it.
 */
export const ChoiceBody = ({ mark, icon, title, subtitle, badge, meta }: ChoiceBodyProps) => (
  <>
    <span
      className={cn("flex size-4 shrink-0 items-center justify-center rounded-full",
        mark === "checked" && "bg-kumo-brand ring ring-kumo-brand",
        mark === "unchecked" && "bg-kumo-base ring ring-kumo-line")}
    >
      {mark === "checked" && <span className="size-2 rounded-full bg-kumo-base" />}
    </span>
    <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center overflow-hidden text-kumo-subtle [&>svg]:size-5">
      {icon}
    </span>
    {/* The title has the first line to itself; the badge, the subtitle and the meta share the second. */}
    <span className="flex min-w-0 flex-1 flex-col">
      <Title title={title} />
      {(badge || subtitle || meta) && (
        <span className="flex min-w-0 items-center gap-2 text-xs text-kumo-subtle">
          {badge && (
            <Badge variant="secondary" className="min-w-0 max-w-1/2 py-0">
              <span className="truncate">{badge}</span>
            </Badge>
          )}
          <span className="min-w-0 flex-1 truncate">{subtitle}</span>
          {meta && <span className="max-w-1/3 shrink-0 truncate tabular-nums">{meta}</span>}
        </span>
      )}
    </span>
  </>
);

type RowProps = Omit<ChoiceBodyProps, "mark"> & {
  /** What activating the row does; `none` for a node that can be neither chosen nor opened. */
  action: "choose" | "open" | "none";
  selected: boolean;
  disabled: boolean;
  /** Whether the list's single tab stop is on this row. */
  tabbable: boolean;
  onFocus(): void;
  onActivate(): void;
};

/** One option of the list. Moving between rows is the list's job; activating one is the row's. */
export const Row = ({ action, selected, disabled, tabbable, onFocus, onActivate, ...body }: RowProps) => {
  const inert = disabled || action === "none";
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const activates = event.key === "Enter" || event.key === " " || (event.key === "ArrowRight" && action === "open");
    if (inert || !activates) return;
    event.preventDefault();
    onActivate();
  };
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={inert || undefined}
      tabIndex={!disabled && tabbable ? 0 : -1}
      onFocus={onFocus}
      onClick={inert ? undefined : onActivate}
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-h-10 items-center gap-3 rounded-md px-2 py-1.5 text-sm outline-none",
        "focus-visible:ring-2 focus-visible:ring-kumo-focus",
        inert ? "cursor-default" : "cursor-pointer hover:bg-kumo-tint",
        action === "none" && "text-kumo-inactive",
        selected && "bg-kumo-tint text-kumo-strong",
      )}
    >
      <ChoiceBody {...body} mark={selected ? "checked" : action === "choose" ? "unchecked" : "none"} />
      {/* Room for the caret on every row, so their meta lines up. */}
      <span className="size-4 shrink-0 text-kumo-subtle">
        {action === "open" && <CaretRightIcon aria-hidden="true" size={16} />}
      </span>
    </div>
  );
};

// Varied, as names are; fixed, so they do not flicker from one render to the next.
const PLACEHOLDER_WIDTHS = [
  ["w-7/12", "w-1/3"], ["w-5/12", "w-1/4"], ["w-2/3", "w-1/3"], ["w-1/3", "w-1/5"], ["w-1/2", "w-1/4"], ["w-5/12", "w-1/5"],
];

/** The shape of a listing still loading, which its rows replace without a jump. */
export const PlaceholderRows = () => (
  <div aria-hidden="true" className="flex flex-col">
    {PLACEHOLDER_WIDTHS.map(([title, subtitle]) => (
      <div key={title + subtitle} className="flex min-h-10 items-center gap-3 px-2 py-1.5">
        <span className="size-4 shrink-0" />
        <span className="size-5 shrink-0 animate-pulse rounded bg-kumo-fill" />
        <span className="flex flex-1 flex-col gap-1.5">
          <span className={cn("h-3 animate-pulse rounded bg-kumo-fill", title)} />
          <span className={cn("h-2.5 animate-pulse rounded bg-kumo-fill", subtitle)} />
        </span>
      </div>
    ))}
  </div>
);
