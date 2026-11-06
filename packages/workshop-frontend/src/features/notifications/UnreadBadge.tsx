import { Badge } from "@cloudflare/kumo";

/** Accessible unread-message count; zero is deliberately silent. */
export const UnreadBadge = ({ count }: { count: number }) =>
  count > 0 ? (
    <span role="img" className="inline-flex shrink-0" aria-label={`${count} unread ${count === 1 ? "message" : "messages"}`}>
      <Badge variant="blue">{count}</Badge>
    </span>
  ) : null;
