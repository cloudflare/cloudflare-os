import { useContext, type ReactNode } from "react";
import { Tooltip } from "@cloudflare/kumo";
import { EnvelopeSimple } from "@phosphor-icons/react";
import { TimelineContext } from "./readTimelineContext";

/**
 * Marks the chat unread from the message at `sequence`, among that message's own actions, so the
 * person comes back to it as new; nothing when the chat isn't tracked for reading.
 */
export const MarkUnreadButton = ({ sequence, className }: { sequence: number; className: string }) => {
  const timeline = useContext(TimelineContext);
  if (!timeline || sequence > timeline.latestSequence) return null;
  return (
    <Tooltip content="Mark unread from here" asChild>
      <button
        type="button"
        onClick={() => timeline.markUnread(sequence)}
        className={className}
        aria-label="Mark unread from here"
      >
        <EnvelopeSimple size={15} />
      </button>
    </Tooltip>
  );
};

/** One rendered work item, which may group several persisted timeline records. */
export const TimelineReadItem = ({
  start,
  end,
  unreadEnd = end,
  previousUnreadEnd = start - 1,
  children,
}: {
  start: number;
  end: number;
  unreadEnd?: number | null;
  previousUnreadEnd?: number;
  children: ReactNode;
}) => {
  const timeline = useContext(TimelineContext);
  return (
    <div
      className="group/read relative flow-root min-w-0"
      data-read-start={start}
      data-read-end={end}
      data-unread-through={unreadEnd ?? undefined}
    >
      {timeline?.divider !== undefined &&
        unreadEnd !== null &&
        previousUnreadEnd < timeline.divider &&
        unreadEnd >= timeline.divider && (
          <div
            role="separator"
            aria-label="New since your last visit"
            data-unread-divider
            className="my-4 flex items-center gap-3 text-xs font-medium text-kumo-brand"
          >
            <span className="h-px flex-1 bg-kumo-brand" />
            New
            <span className="h-px flex-1 bg-kumo-brand" />
          </div>
        )}
      {children}
      <div data-read-through={end} className="h-px w-full" aria-hidden="true" />
    </div>
  );
};
