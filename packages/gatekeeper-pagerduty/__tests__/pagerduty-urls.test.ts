// PagerDuty's links in both regions: the resource each names, as the server parses it and as the
// Workshop matches it against the resource patterns; the canonical link for each; and the region an
// ID token's claims put an account in.

import { describe, expect, it } from "vitest";
import { resolveRequestedResource } from "@gadgets/workshop-shared/gatekeeper";
import { ALL_RESOURCES, RESOURCES, type ResourceKind } from "../src/pagerduty-env";
import { parseResourceUrl, regionOf, resourceUrl, type ResourceRef } from "../src/pagerduty-urls";

/** The kind of resource the Workshop matches `url` to, by the same patterns. */
function workshopKind(url: string): ResourceKind | undefined {
  const result = resolveRequestedResource(ALL_RESOURCES, url);
  if (!result.ok) return undefined;
  return (Object.keys(RESOURCES) as ResourceKind[]).find(kind => RESOURCES[kind] === result.resource);
}

const LINKS: [string, ResourceRef][] = [
  ["https://acme.pagerduty.com", { region: "us", subdomain: "acme", kind: "account" }],
  ["https://acme.pagerduty.com/", { region: "us", subdomain: "acme", kind: "account" }],
  ["https://acme.eu.pagerduty.com/", { region: "eu", subdomain: "acme", kind: "account" }],
  ["https://acme.pagerduty.com/teams/PTEAM01", { region: "us", subdomain: "acme", kind: "team", id: "PTEAM01" }],
  ["https://acme.pagerduty.com/teams/PTEAM01/users", { region: "us", subdomain: "acme", kind: "team", id: "PTEAM01" }],
  ["https://acme.eu.pagerduty.com/service-directory/PSVC001", { region: "eu", subdomain: "acme", kind: "service", id: "PSVC001" }],
  ["https://acme.pagerduty.com/service-directory/PSVC001/activity?x=1", { region: "us", subdomain: "acme", kind: "service", id: "PSVC001" }],
  ["https://acme.pagerduty.com/incidents/Q2W3E4R5T6Y7U8", { region: "us", subdomain: "acme", kind: "incident", id: "Q2W3E4R5T6Y7U8" }],
  ["https://acme.eu.pagerduty.com/incidents/1234", { region: "eu", subdomain: "acme", kind: "incident", id: "1234" }],
  ["https://acme.pagerduty.com/schedules/PSCH001#2026-11-06", { region: "us", subdomain: "acme", kind: "schedule", id: "PSCH001" }],
  ["  https://ACME.pagerduty.com/schedules/PSCH001  ", { region: "us", subdomain: "acme", kind: "schedule", id: "PSCH001" }],
];

describe("parseResourceUrl", () => {
  it.each(LINKS)("reads %s as the Workshop matches it", (url, ref) => {
    expect(parseResourceUrl(url)).toEqual(ref);
    expect(workshopKind(url.trim())).toBe(ref.kind);
  });

  it.each([
    "https://pagerduty.com/teams/PTEAM01",
    "https://acme.pagerduty.com.evil.test/teams/PTEAM01",
    "http://acme.pagerduty.com/teams/PTEAM01",
    "https://acme.pagerduty.com/users/PALICE1",
    "https://acme.pagerduty.com/teams",
    "https://acme.pagerduty.com/teams/pteam01",
    "https://acme.de.pagerduty.com/teams/PTEAM01",
    "not a link",
  ])("refuses %s", url => {
    expect(parseResourceUrl(url)).toBeNull();
  });
});

describe("resourceUrl", () => {
  it.each([
    "https://acme.pagerduty.com/",
    "https://acme.eu.pagerduty.com/",
    "https://acme.pagerduty.com/teams/PTEAM01",
    "https://acme.eu.pagerduty.com/service-directory/PSVC001",
    "https://acme.pagerduty.com/incidents/Q2W3E4R5T6Y7U8",
    "https://acme.eu.pagerduty.com/schedules/PSCH001",
  ])("writes %s as the link for what it names", url => {
    expect(resourceUrl(parseResourceUrl(url)!)).toBe(url);
  });
});

describe("regionOf", () => {
  it.each([
    [{ aud: ["https://api.pagerduty.com", "client"] }, "us"],
    [{ aud: ["client", "https://api.eu.pagerduty.com"] }, "eu"],
    [{ aud: "https://api.eu.pagerduty.com" }, "eu"],
    [{ aud: ["client"], region: "UnitedStates" }, "us"],
    [{ aud: ["client"], region: "EU" }, "eu"],
    [{ aud: ["client"], region: "Mars" }, undefined],
    [{}, undefined],
  ] satisfies [Parameters<typeof regionOf>[0], string | undefined][])("reads %o as %s", (claims, region) => {
    expect(regionOf(claims)).toBe(region);
  });
});
