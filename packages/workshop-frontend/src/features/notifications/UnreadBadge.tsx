import { Badge } from "@cloudflare/kumo";

/** Accessible thread or workspace unread count; zero is deliberately silent. */
export const UnreadBadge = ({ count }: { count: number }) =>
  count > 0 ? (
    <span className="inline-flex shrink-0" aria-label={`${count} unread ${count === 1 ? "thread" : "threads"}`}>
      <Badge variant="blue">{count}</Badge>
    </span>
  ) : null;
