// The subservice metric points a suite's requests to Microsoft write, read through a fake METRICS
// dataset on the `cloudflare:workers` stub, as __tests__/upstream.test.ts reads its own.

import { env } from "cloudflare:workers";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import { afterEach, beforeEach } from "vitest";

/** One call as its point counts it: the operation, the outcome, the reason and the HTTP status. */
export type CountedCall = [operation: unknown, outcome: unknown, reason: unknown, status: unknown];

/** A written point's value in one column. */
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  return (slot.startsWith("blob") ? point.blobs : point.doubles)?.[Number(slot.replace(/\D+/, "")) - 1];
}

/**
 * Records the points written during each test of the suite that calls it, and removes the dataset
 * after each.
 * @returns Reads each call counted so far in the running test, in the order its point was written:
 * a point that sums several calls is given once for each.
 */
export function countedCalls(): () => CountedCall[] {
  const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
  let points: AnalyticsEngineDataPoint[] = [];

  beforeEach(() => {
    points = [];
    ambient.METRICS = { writeDataPoint: point => { if (point) points.push(point); } };
    ambient.SUBSERVICE_METRICS = "true";
  });

  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
  });

  return () => points.flatMap(point => {
    const call: CountedCall = [
      column(point, SUBSERVICE_V1_SLOTS.operation), column(point, COMMON_SLOTS.outcome), column(point, SUBSERVICE_V1_SLOTS.reason),
      column(point, SUBSERVICE_V1_SLOTS.httpStatus),
    ];
    return Array.from({ length: Number(column(point, SUBSERVICE_V1_SLOTS.calls)) }, () => call);
  });
}
