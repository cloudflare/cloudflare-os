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
      <span className="truncate">{title}</span>
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

