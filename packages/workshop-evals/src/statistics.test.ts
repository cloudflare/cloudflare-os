import { describe, expect, it } from "vitest";
import {
  mean, metricDistribution, sampleStandardDeviation, tMeanInterval, wilsonInterval,
} from "./statistics.js";

describe("wilsonInterval", () => {
  it("keeps a unanimous pass inside [0, 1]", () => {
    const bounds = wilsonInterval(3, 3);
    expect(bounds?.high).toBeCloseTo(1, 10);
    expect(bounds?.low).toBeGreaterThan(0.29);
    expect(bounds?.low).toBeLessThan(1);
  });

  it("keeps a unanimous failure inside [0, 1]", () => {
    const bounds = wilsonInterval(0, 3);
    expect(bounds?.low).toBeCloseTo(0, 10);
    expect(bounds?.high).toBeLessThan(0.71);
  });

  it("narrows as trials accumulate", () => {
    const few = wilsonInterval(5, 10);
    const many = wilsonInterval(50, 100);
    expect((many?.high ?? 0) - (many?.low ?? 0)).toBeLessThan((few?.high ?? 0) - (few?.low ?? 0));
  });

  it("has no interval without trials", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it("rejects impossible counts", () => {
    expect(() => wilsonInterval(4, 3)).toThrow("between zero and trials");
  });
});

describe("sampleStandardDeviation", () => {
  it("needs at least two observations", () => {
    expect(sampleStandardDeviation([1])).toBeNull();
  });

  it("uses the sample denominator", () => {
    expect(sampleStandardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.1381, 4);
  });
});

describe("tMeanInterval", () => {
  it("brackets the mean", () => {
    const bounds = tMeanInterval([10, 12, 14, 16]);
    expect(bounds?.low).toBeLessThan(13);
    expect(bounds?.high).toBeGreaterThan(13);
  });

  it("has no interval below two observations", () => {
    expect(tMeanInterval([4])).toBeNull();
  });
});

describe("metricDistribution", () => {
  it("interpolates quantiles", () => {
    expect(metricDistribution([1, 2, 3, 4])).toEqual({ mean: 2.5, p50: 2.5, p90: 3.7 });
  });

  it("has no distribution without observations", () => {
    expect(metricDistribution([])).toBeNull();
  });
});

describe("mean", () => {
  it("refuses an empty sample", () => {
    expect(() => mean([])).toThrow("empty sample");
  });
});
