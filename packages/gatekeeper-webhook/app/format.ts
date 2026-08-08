import type { DeliverySummary, EndpointStatus } from "../src/types";

/** Human label for an endpoint status, matching the filter tabs. */
export function statusLabel(status: EndpointStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "disabled":
      return "Not enabled";
    case "failing":
      return "Needs attention";
  }
}

/** Tailwind classes for the status pill. */
export function statusTone(status: EndpointStatus): string {
  switch (status) {
    case "active":
      return "bg-kumo-fill text-kumo-default";
    case "disabled":
      return "bg-kumo-tint text-kumo-subtle";
    case "failing":
      return "bg-kumo-danger-tint text-kumo-danger";
  }
}

/** Compact relative time, e.g. "3m ago". Absolute once past a week. */
export function formatRelative(timestamp: number, now: number): string {
  const delta = now - timestamp;
  if (delta < 0) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Byte count for a delivery row. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One-line summary of a delivery's outcome, including its failure reason when it has one. */
export function describeDelivery(delivery: DeliverySummary): string {
  switch (delivery.outcome) {
    case "delivered":
      return delivery.attempts > 1
        ? `Delivered after ${delivery.attempts} attempts`
        : "Delivered";
    case "queued":
      return delivery.attempts === 0
        ? "Queued"
        : `Retrying (attempt ${delivery.attempts}${delivery.error ? `: ${delivery.error}` : ""})`;
    case "failed":
      return `Failed after ${delivery.attempts} attempts${delivery.error ? `: ${delivery.error}` : ""}`;
  }
}
