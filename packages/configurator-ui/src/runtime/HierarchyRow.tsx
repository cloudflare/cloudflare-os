import { Badge } from "@cloudflare/kumo/components/badge";
import { cn } from "@cloudflare/kumo/utils";
import { CaretRightIcon } from "@phosphor-icons/react";
import { memo, type KeyboardEvent, type ReactNode } from "react";
import { splitTitle } from "./hierarchyNodes.ts";

type ChoiceBodyProps = {
  mark: "checked" | "unchecked" | "none";
  icon: ReactNode;
  title: string;
  subtitle?: string;
  badge?: string;
  meta?: string;
};

/**
 * A title whose end stays in view while the rest gives way. The parts are flex items, which a
 * browser names apart, as "Bud get.xlsx", so assistive technology gets the title whole.
 */
const Title = ({ title }: { title: string }) => {
  const split = splitTitle(title);
  if (!split) return <span className="truncate">{title}</span>;
  const [head, tail] = split;
  return (
    <span className="flex min-w-0">
      <span aria-hidden="true" className="truncate">{head}</span>
      <span aria-hidden="true" className="shrink-0 whitespace-pre">{tail}</span>
      <span className="sr-only">{title}</span>
    </span>
  );
};

/**
 * What the root's card and every row show: a radio's look (or room for one, so icons line up), an
 * icon on a raised tile and two lines. The look is only a cue; `aria-selected` or `aria-pressed`
 * says it. An unchosen ring strengthens while the nearest `group/choice` ancestor is hovered.
 */
export const ChoiceBody = ({ mark, icon, title, subtitle, badge, meta }: ChoiceBodyProps) => (
  <>
    {/* A ring, and a dot inside it when chosen, in Kumo's contrast colour as its own Radio is:
        near-black in light mode, white in dark. The dot is the radio's own fill showing through an
        inset ring of the background, so it stays centred however the browser rounds the border
        (1.5px draws as 1px at 1x); a 3px gap keeps its edges on whole pixels at 1x and 2x. Unchosen,
        the ring is Kumo's interactive border and takes the subtle text colour while its row is
        hovered, which shows against a hovered row in dark mode as the inactive colour does not. */}
    <span
      className={cn("size-4 shrink-0 rounded-full",
        mark !== "none" && "border-[1.5px]",
        mark === "checked" && "border-kumo-contrast bg-kumo-contrast inset-ring-3 inset-ring-kumo-base",
        mark === "unchecked" && "border-kumo-interact bg-kumo-base group-hover/choice:border-(color:--text-color-kumo-subtle)")}
    />
    {/* A raised tile without a border: a translucent fill of the icon's grey, which shows on a hovered
        or chosen row as on a plain one, and Kumo's smallest shadow. */}
    <span
      aria-hidden="true"
      className={cn("flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md",
        "bg-current/10 text-kumo-subtle shadow-xs [&>svg]:size-4.5")}
    >
      {icon}
    </span>
    {/* The badge ends the title's line and the meta the next, so they line up down the list. */}
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-center gap-2">
        <Title title={title} />
        {badge && (
          <Badge variant="secondary" className="ml-auto min-w-0 max-w-1/3 py-0">
            <span className="truncate">{badge}</span>
          </Badge>
        )}
      </span>
      {(subtitle || meta) && (
        <span className="flex min-w-0 items-center gap-2 text-xs text-kumo-subtle">
          <span className="min-w-0 flex-1 truncate">{subtitle}</span>
          {meta && <span className="max-w-1/3 shrink-0 truncate tabular-nums">{meta}</span>}
        </span>
      )}
    </span>
  </>
);

type RowProps = Omit<ChoiceBodyProps, "mark"> & {
  id: string;
  /** What activating the row does; `none` for a node that can be neither chosen nor opened. */
  action: "choose" | "open" | "none";
  selected: boolean;
  disabled: boolean;
  /** Whether the list's single tab stop is on this row. */
  tabbable: boolean;
  onFocus(id: string): void;
  onActivate(id: string): void;
};

/**
 * One option of the list. Moving between rows is the list's job; activating one is the row's.
 * Memoized, since every move of focus and every key typed in the search box redraws the picker, and
 * a long listing redrawn whole lags behind the keys: the list passes handlers that keep their
 * identity and take the row's id, and an icon element that does too.
 */
export const Row = memo(function Row({ id, action, selected, disabled, tabbable, onFocus, onActivate, ...body }: RowProps) {
  const inert = disabled || action === "none";
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const activates = event.key === "Enter" || event.key === " " || (event.key === "ArrowRight" && action === "open");
    if (inert || !activates) return;
    event.preventDefault();
    onActivate(id);
  };
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={inert || undefined}
      tabIndex={!disabled && tabbable ? 0 : -1}
      onFocus={() => onFocus(id)}
      onClick={inert ? undefined : () => onActivate(id)}
      onKeyDown={onKeyDown}
      className={cn(
        // Each row a layout and paint boundary, so moving focus down a long listing repaints the rows
        // it changed rather than every row.
        "flex min-h-10 items-center gap-3 rounded-md px-2 py-1.5 text-sm outline-none contain-content",
        "focus-visible:ring-2 focus-visible:ring-kumo-focus",
        inert ? "cursor-default" : "group/choice cursor-pointer hover:bg-kumo-tint",
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
});

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
        <span className="size-7 shrink-0 animate-pulse rounded-md bg-kumo-fill" />
        <span className="flex flex-1 flex-col gap-1.5">
          <span className={cn("h-3 animate-pulse rounded bg-kumo-fill", title)} />
          <span className={cn("h-2.5 animate-pulse rounded bg-kumo-fill", subtitle)} />
        </span>
      </div>
    ))}
  </div>
);
