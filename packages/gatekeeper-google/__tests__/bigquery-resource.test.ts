import { describe, expect, it } from "vitest";
import {
  BIGQUERY_HOST, BIGQUERY_PUBLIC_HOST, BIGQUERY_PUBLIC_RESOURCE_URL_PATTERN,
  BIGQUERY_RESOURCE_URL_PATTERN, bigQueryPublicDataEnabled, bigQueryResourceUrl,
  isPublicDataProject, parseBigQueryResourceUrl, PUBLIC_DATA_PROJECTS,
  type BigQueryResourceScope,
} from "../src/bigquery-resource";

/** Parse a URL that is expected to be a BigQuery one, failing loudly if it is not. */
function parse(url: string): BigQueryResourceScope {
  let scope = parseBigQueryResourceUrl(url);
  if (!scope) throw new Error(`expected ${url} to parse as a BigQuery resource URL`);
  return scope;
}

describe("private resource URLs", () => {
  it("parses each level of narrowing, billing the project it reads", () => {
    expect(parse(`https://${BIGQUERY_HOST}/my-project`)).toEqual({
      kind: "private",
      billingProjectId: "my-project",
      dataProjectId: "my-project",
      datasetId: undefined,
      tableId: undefined,
    });
    expect(parse(`https://${BIGQUERY_HOST}/my-project/analytics`)).toMatchObject({
      kind: "private", dataProjectId: "my-project", datasetId: "analytics", tableId: undefined,
    });
    expect(parse(`https://${BIGQUERY_HOST}/my-project/analytics/customers`)).toMatchObject({
      kind: "private", dataProjectId: "my-project", datasetId: "analytics", tableId: "customers",
    });
  });

  it("round-trips through the canonical form", () => {
    for (let url of [
      `https://${BIGQUERY_HOST}/my-project`,
      `https://${BIGQUERY_HOST}/my-project/analytics`,
      `https://${BIGQUERY_HOST}/my-project/analytics/customers`,
    ]) {
      expect(bigQueryResourceUrl(parse(url))).toBe(url);
    }
  });

  it("accepts the configurator's trailing-slash project-only form", () => {
    expect(parse(`https://${BIGQUERY_HOST}/my-project/`))
        .toEqual(parse(`https://${BIGQUERY_HOST}/my-project`));
  });

  it("requires a project", () => {
    expect(() => parse(`https://${BIGQUERY_HOST}/`)).toThrow(/must include a project ID/);
  });

  it("rejects more segments than project/dataset/table", () => {
    expect(() => parse(`https://${BIGQUERY_HOST}/p/d/t/extra`))
        .toThrow(/must be \/<projectId>/);
  });
});

describe("public resource URLs", () => {
  it("parses the two projects it names", () => {
    expect(parse(`https://${BIGQUERY_PUBLIC_HOST}/my-project/bigquery-public-data`)).toEqual({
      kind: "public",
      billingProjectId: "my-project",
      dataProjectId: "bigquery-public-data",
      datasetId: undefined,
      tableId: undefined,
    });
    expect(parse(
        `https://${BIGQUERY_PUBLIC_HOST}/my-project/bigquery-public-data/samples/shakespeare`,
    )).toEqual({
      kind: "public",
      billingProjectId: "my-project",
      dataProjectId: "bigquery-public-data",
      datasetId: "samples",
      tableId: "shakespeare",
    });
  });

  it("round-trips through the canonical form", () => {
    for (let url of [
      `https://${BIGQUERY_PUBLIC_HOST}/my-project/bigquery-public-data`,
      `https://${BIGQUERY_PUBLIC_HOST}/my-project/bigquery-public-data/samples`,
      `https://${BIGQUERY_PUBLIC_HOST}/my-project/bigquery-public-data/samples/shakespeare`,
    ]) {
      expect(bigQueryResourceUrl(parse(url))).toBe(url);
    }
  });

  it("accepts every allowlisted project", () => {
    for (let project of PUBLIC_DATA_PROJECTS) {
      expect(parse(`https://${BIGQUERY_PUBLIC_HOST}/my-project/${project.projectId}`))
          .toMatchObject({ kind: "public", dataProjectId: project.projectId });
      expect(isPublicDataProject(project.projectId)).toBe(true);
    }
  });

  // The check the "reads only public data" label -- and so the restricted-data exemption -- rests
  // on. Without it a binding could be pointed at a private project the user's token can reach.
  it("rejects a data project outside the allowlist", () => {
    expect(() => parse(`https://${BIGQUERY_PUBLIC_HOST}/my-project/my-private-project`))
        .toThrow(/not a known public BigQuery project/);
    expect(isPublicDataProject("my-private-project")).toBe(false);
  });

  it("requires both projects", () => {
    expect(() => parse(`https://${BIGQUERY_PUBLIC_HOST}/`))
        .toThrow(/must include a billing project ID/);
    expect(() => parse(`https://${BIGQUERY_PUBLIC_HOST}/my-project`))
        .toThrow(/must include a public data project ID/);
  });

  it("rejects more segments than billing/data/dataset/table", () => {
    expect(() => parse(
        `https://${BIGQUERY_PUBLIC_HOST}/my-project/bigquery-public-data/samples/shakespeare/extra`,
    )).toThrow(/must be \/<billingProjectId>/);
  });
});

describe("deployment flag", () => {
  it("is off unless explicitly enabled", () => {
    // The important case: an unset var must not enable a new data source.
    expect(bigQueryPublicDataEnabled({})).toBe(false);
    for (let value of ["", " ", "false", "0", "no", "off", "TRUE ish", "1"]) {
      expect(bigQueryPublicDataEnabled({ ENABLE_BIGQUERY_PUBLIC_DATA: value })).toBe(false);
    }
  });

  it("accepts \"true\" regardless of case or surrounding whitespace", () => {
    // wrangler vars are strings, and a value pasted into a deploy wizard often carries either.
    for (let value of ["true", "TRUE", "True", " true ", "\ttrue\n"]) {
      expect(bigQueryPublicDataEnabled({ ENABLE_BIGQUERY_PUBLIC_DATA: value })).toBe(true);
    }
  });
});

describe("shared validation", () => {
  // Segments are positional and empty ones are dropped, so a table can never slide into the
  // dataset's slot on the way in; the invariant has to be enforced on the way *out*, or a
  // dataset-less scope would serialize to a URL that parses back as a different one.
  it("rejects building a URL for a table with no dataset", () => {
    expect(() => bigQueryResourceUrl({
      kind: "public",
      billingProjectId: "my-project",
      dataProjectId: "bigquery-public-data",
      tableId: "shakespeare",
    })).toThrow(/Cannot scope to a table without specifying a dataset/);
  });

  it("collapses empty path segments rather than shifting them", () => {
    expect(parse(`https://${BIGQUERY_PUBLIC_HOST}/my-project/bigquery-public-data//shakespeare`))
        .toMatchObject({ datasetId: "shakespeare", tableId: undefined });
    expect(parse(`https://${BIGQUERY_HOST}/my-project//customers`))
        .toMatchObject({ datasetId: "customers", tableId: undefined });
  });

  it("rejects non-https URLs on both hosts", () => {
    expect(() => parse(`http://${BIGQUERY_HOST}/my-project`)).toThrow(/must use https/);
    expect(() => parse(`http://${BIGQUERY_PUBLIC_HOST}/my-project/bigquery-public-data`))
        .toThrow(/must use https/);
  });

  it("rejects query strings and fragments", () => {
    expect(() => parse(`https://${BIGQUERY_HOST}/my-project?a=1`))
        .toThrow(/must not include query strings or fragments/);
    expect(() => parse(`https://${BIGQUERY_HOST}/my-project#frag`))
        .toThrow(/must not include query strings or fragments/);
    expect(() => parse(`https://${BIGQUERY_PUBLIC_HOST}/my-project/bigquery-public-data?a=1`))
        .toThrow(/must not include query strings or fragments/);
  });

  it("returns null for a URL belonging to another vendor, so connect() can fall through", () => {
    expect(parseBigQueryResourceUrl("https://mail.google.com/#inbox")).toBeNull();
    expect(parseBigQueryResourceUrl("https://docs.google.com/document/d/abc")).toBeNull();
    // Not a prefix match: a lookalike host is somebody else's problem, not a public binding.
    expect(parseBigQueryResourceUrl(`https://evil-${BIGQUERY_PUBLIC_HOST}/p/bigquery-public-data`))
        .toBeNull();
  });

  // Why the public form gets its own hostname instead of a marker segment: a marker would also
  // match `:projectId/*`, and both `matchesResourceUrlPattern` and the frontend's resource
  // matching would see two candidate resource types for one URL.
  it("keeps the two resource URLPatterns disjoint", () => {
    let privatePattern = new URLPattern(BIGQUERY_RESOURCE_URL_PATTERN);
    let publicPattern = new URLPattern(BIGQUERY_PUBLIC_RESOURCE_URL_PATTERN);
    // `matchesResourceUrlPattern` tries the URL both with and without a trailing slash, so a
    // pattern is only truly disjoint from a URL if neither form matches.
    let matches = (pattern: URLPattern, url: string) =>
        pattern.test(url) || pattern.test(url.endsWith("/") ? url.replace(/\/+$/, "") : `${url}/`);

    for (let url of [
      `https://${BIGQUERY_HOST}/my-project`,
      `https://${BIGQUERY_HOST}/my-project/analytics/customers`,
    ]) {
      expect(matches(privatePattern, url)).toBe(true);
      expect(matches(publicPattern, url)).toBe(false);
    }
    for (let url of [
      `https://${BIGQUERY_PUBLIC_HOST}/my-project/bigquery-public-data`,
      `https://${BIGQUERY_PUBLIC_HOST}/my-project/bigquery-public-data/samples/shakespeare`,
    ]) {
      expect(matches(publicPattern, url)).toBe(true);
      expect(matches(privatePattern, url)).toBe(false);
    }
  });

  it("percent-encodes and decodes segments symmetrically", () => {
    let url = bigQueryResourceUrl({
      kind: "private",
      billingProjectId: "my project",
      dataProjectId: "my project",
      datasetId: "a/b",
    });
    expect(url).toBe(`https://${BIGQUERY_HOST}/my%20project/a%2Fb`);
    expect(parse(url)).toMatchObject({ dataProjectId: "my project", datasetId: "a/b" });
  });
});
