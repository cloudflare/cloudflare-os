import { Button } from "@cloudflare/kumo/components/button";
import { cn } from "@cloudflare/kumo/utils";
import { CaretLeftIcon, CaretRightIcon, DotsThreeIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState, type Ref, type RefObject } from "react";
import type { ConfiguratorUIHierarchyAncestor } from "../index.ts";
import { disabledButtonProps } from "./Button.tsx";
import type { Location } from "./hierarchyNodes.ts";

type BreadcrumbProps = {
  /** The open tab's title, or the root's. */
  top: string;
  location: Location;
  disabled: boolean;
  navRef: RefObject<HTMLElement | null>;
  /** Opens the tab or root (depth 0) or the trail's container at that depth. */
  onGo(depth: number): void;
};

/** A trail longer than this folds all but its last two containers behind a button. */
const FOLD_AFTER = 3;

const separator = <CaretRightIcon aria-hidden="true" size={10} className="shrink-0 text-kumo-inactive" />;

/** Where the picker is, from the tab or root down, each step a button that goes back there. */
export const Breadcrumb = ({ top, location: { trail, detached }, disabled, navRef, onGo }: BreadcrumbProps) => {
  // Unfolded for one trail only, so moving anywhere folds it again.
  const [unfolded, setUnfolded] = useState<readonly ConfiguratorUIHierarchyAncestor[] | null>(null);
  const firstRevealed = useRef<HTMLButtonElement>(null);
  // The fold button goes as it unfolds, so focus moves to the first step it showed.
  useLayoutEffect(() => {
    if (unfolded) firstRevealed.current?.focus();
  }, [unfolded]);

  const atTop = trail.length === 0;
  const hidden = trail.length > FOLD_AFTER && unfolded !== trail ? trail.length - 2 : 0;
  const crumb = (title: string, depth: number, ref?: Ref<HTMLButtonElement>) => {
    const isCurrent = depth === trail.length;
    return (
      <Button
        ref={ref}
        variant="ghost"
        size="xs"
        className={cn("max-w-48 truncate px-1", isCurrent && "font-medium text-kumo-strong")}
        aria-current={isCurrent ? "location" : undefined}
        disabled={disabled}
        onClick={() => onGo(depth)}
      >
        {title}
      </Button>
    );
  };
  return (
    <nav ref={navRef} aria-label="Location" className="flex min-w-0 flex-1 flex-wrap items-center text-xs">
      {/* Keeps the focus of a user who just went up to the top, though it leads nowhere there; out of
          the tab order there. */}
      <Button
        variant="ghost"
        size="xs"
        shape="square"
        aria-label="Up one level"
        {...disabledButtonProps({ disabled: atTop, onClick: () => onGo(trail.length - 1) })}
        tabIndex={atTop ? -1 : undefined}
        disabled={disabled}
        icon={<CaretLeftIcon aria-hidden="true" size={14} />}
      />
      {crumb(top, 0)}
      {/* The fold stands in for the gap above a detached trail too. */}
      {hidden > 0 ? (
        <>
          {separator}
          <Button
            variant="ghost"
            size="xs"
            shape="square"
            aria-label={`Show ${hidden} more levels`}
            title={trail.slice(0, hidden).map(({ title }) => title).join(" / ")}
            disabled={disabled}
            icon={<DotsThreeIcon aria-hidden="true" size={14} />}
            onClick={() => setUnfolded(trail)}
          />
        </>
      ) : detached && !atTop && (
        <>
          {separator}
          <span className="px-1 text-kumo-subtle">…</span>
        </>
      )}
      {trail.slice(hidden).map((ancestor, index) => (
        <span key={ancestor.id} className="contents">
          {separator}
          {crumb(ancestor.title, hidden + index + 1, hidden + index === 0 ? firstRevealed : undefined)}
        </span>
      ))}
    </nav>
  );
};
