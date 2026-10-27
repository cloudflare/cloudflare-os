import { Button } from "@cloudflare/kumo/components/button";
import { cn } from "@cloudflare/kumo/utils";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import type { RefObject } from "react";
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

const separator = <CaretRightIcon aria-hidden="true" size={12} className="shrink-0 text-kumo-subtle" />;

/** Where the picker is, from the tab or root down, each step a button that goes back there. */
export const Breadcrumb = ({ top, location: { trail, detached }, disabled, navRef, onGo }: BreadcrumbProps) => {
  const atTop = trail.length === 0;
  const crumb = (title: string, depth: number) => {
    const isCurrent = depth === trail.length;
    return (
      <Button
        variant="ghost"
        size="xs"
        className={cn("max-w-48 truncate", isCurrent && "text-kumo-strong")}
        aria-current={isCurrent ? "location" : undefined}
        disabled={disabled}
        onClick={() => onGo(depth)}
      >
        {title}
      </Button>
    );
  };
  return (
    <nav ref={navRef} aria-label="Location" className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-sm">
      {/* `aria-disabled` at the top rather than `disabled`, which would drop the focus of a user who
          just went up there; out of the tab order there, since it leads nowhere. */}
      <Button
        variant="ghost"
        size="xs"
        shape="square"
        aria-label="Up one level"
        aria-disabled={atTop || undefined}
        tabIndex={atTop ? -1 : undefined}
        className={cn(atTop && "cursor-not-allowed opacity-50")}
        disabled={disabled}
        icon={<CaretLeftIcon aria-hidden="true" size={14} />}
        onClick={() => {
          if (!atTop) onGo(trail.length - 1);
        }}
      />
      {crumb(top, 0)}
      {detached && !atTop && (
        <>
          {separator}
          <span className="px-1 text-kumo-subtle">…</span>
        </>
      )}
      {trail.map((ancestor, index) => (
        <span key={ancestor.id} className="contents">
          {separator}
          {crumb(ancestor.title, index + 1)}
        </span>
      ))}
    </nav>
  );
};
