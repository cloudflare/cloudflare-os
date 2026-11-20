// A dataset for a test that reads the subservice points the gatekeeper writes. It is bound on
// the bindings the metrics read (`cloudflare:workers`), which a Node test and a Workers-pool test
// share with the code they run, and unbound by `unbindWrittenCalls`, which a file that binds one
// calls in its `afterEach`.

import { env } from "cloudflare:workers";
import {
  COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot,
} from "@gadgets/observability/metrics";

/** A written point: its service, operation, outcome and HTTP status, and the calls it stands for. */
export type WrittenCall = [
  service: string, operation: string, outcome: string, httpStatus: number, calls: number,
];

/** How a written point's call was answered: its operation, outcome, reason and HTTP status. */
export type WrittenAnswer = [operation: string, outcome: string, reason: string, httpStatus: number];

/** The points written since the dataset was bound, or since they were last dropped. */
export type WrittenCalls = {
  /** Each point of the Google gatekeeper's requests, in the order written. */
  (): WrittenCall[];
  /** The points of the requests named `operation`. */
  of(operation: string): WrittenCall[];
  /**
   * How each request whose name matches `named` was answered, in the order written. The reason
   * is empty where a point has none.
   */
  answers(named: RegExp): WrittenAnswer[];
  /** Forgets the points written so far. */
  drop(): void;
};

// A point's value in one column.
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  return (slot.startsWith("blob") ? point.blobs : point.doubles)?.[Number(slot.replace(/\D+/, "")) - 1];
}

// The bindings the metrics read.
const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };

/** Unbinds the dataset `writtenCalls` bound, where a test bound one. For a file's `afterEach`. */
export function unbindWrittenCalls(): void {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
}

/**
 * Binds a dataset that keeps the points written to it, until `unbindWrittenCalls` is called.
 * @returns Reads the points of the source `gatekeeper.google.api`.
 */
export function writtenCalls(): WrittenCalls {
  let points: AnalyticsEngineDataPoint[] = [];
  ambient.METRICS = { writeDataPoint: point => { if (point) points.push(point); } };
  ambient.SUBSERVICE_METRICS = "true";

  let written = () => points
    .filter(point => column(point, SUBSERVICE_V1_SLOTS.source) === "gatekeeper.google.api");
  let read = (): WrittenCall[] => written()
    .map(point => [
      String(column(point, SUBSERVICE_V1_SLOTS.service)),
      String(column(point, SUBSERVICE_V1_SLOTS.operation)),
      String(column(point, COMMON_SLOTS.outcome)),
      Number(column(point, SUBSERVICE_V1_SLOTS.httpStatus)),
      Number(column(point, SUBSERVICE_V1_SLOTS.calls)),
    ]);
  return Object.assign(read, {
    of: (operation: string) => read().filter(([, named]) => named === operation),
    answers: (named: RegExp) => written()
      .map((point): WrittenAnswer => [
        String(column(point, SUBSERVICE_V1_SLOTS.operation)),
        String(column(point, COMMON_SLOTS.outcome)),
        String(column(point, SUBSERVICE_V1_SLOTS.reason)),
        Number(column(point, SUBSERVICE_V1_SLOTS.httpStatus)),
      ])
      .filter(([operation]) => named.test(operation)),
    drop: () => { points.length = 0; },
  });
}
