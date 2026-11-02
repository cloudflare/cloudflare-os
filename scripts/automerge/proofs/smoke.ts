#!/usr/bin/env node

// preview-smoke: a deployed preview answers on its two public paths.
//
//   GET /             the router serves the frontend (200, HTML)
//   GET /api/version  the router reaches the backend over its service binding, and the backend's
//                     module loads (200, JSON with a `version` field)
//
// Previews sit behind Cloudflare Access (team cf-cloudflare-os-previews: an unauthenticated GET
// of either path answered 302 to the Access login on 2026-11-02). The smoke therefore sends an
// Access service token, `PREVIEW_ACCESS_CLIENT_ID` and `PREVIEW_ACCESS_CLIENT_SECRET`, which the
// Access application must admit. Without one the result is status `error`, which the gate treats
// as missing.
//
//   node scripts/automerge/proofs/smoke.ts <preview base URL>
//   env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA, PREVIEW_ACCESS_CLIENT_ID, PREVIEW_ACCESS_CLIENT_SECRET

import { pathToFileURL } from "node:url";
import { decide, errored, runProducer, type Outcome } from "./artifact.ts";
import { isObject, parseJson } from "./json.ts";

/** One response, as much of it as the checks read. */
export interface Answer {
  status: number;
  contentType: string;
  location: string;
  body: string;
}

const ACCESS_LOGIN = /^https:\/\/[^/]+\.cloudflareaccess\.com\//;

/** Judges the answers to `GET /` and `GET /api/version`. */
export function evaluateSmoke(url: string, root: Answer, version: Answer): Outcome {
  if ([root, version].some((answer) => answer.status === 302 && ACCESS_LOGIN.test(answer.location))) {
    return errored("Cloudflare Access turned the request away: the Access service token is missing " +
      "or the preview's Access application does not admit it", { url });
  }
  const reasons: string[] = [];
  if (root.status !== 200 || !root.contentType.startsWith("text/html")) {
    reasons.push(`GET / answered ${root.status} ${root.contentType}`);
  }
  let backend = "";
  if (version.status === 200) {
    const body = parseJson(version.body);
    if (isObject(body) && "version" in body) backend = String(body.version);
    else reasons.push("GET /api/version answered 200 without a version field");
  } else {
    reasons.push(`GET /api/version answered ${version.status}`);
  }
  return decide(reasons, { url, root_status: root.status, version_status: version.status, backend_version: backend });
}

async function get(url: string, headers: Record<string, string>): Promise<Answer> {
  const response = await fetch(url, { headers, redirect: "manual" });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    location: response.headers.get("location") ?? "",
    body: await response.text(),
  };
}

async function main(): Promise<void> {
  await runProducer("evidence", "preview-smoke", async () => {
    const base = process.argv[2] ?? "";
    if (!/^https:\/\/[^/]+$/.test(base)) throw new Error(`expected the preview origin, got "${base}"`);
    const id = process.env.PREVIEW_ACCESS_CLIENT_ID ?? "";
    const secret = process.env.PREVIEW_ACCESS_CLIENT_SECRET ?? "";
    if (id === "" || secret === "") {
      return errored("PREVIEW_ACCESS_CLIENT_ID and PREVIEW_ACCESS_CLIENT_SECRET are not configured", { url: base });
    }
    const headers = { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
    return evaluateSmoke(base, await get(`${base}/`, headers), await get(`${base}/api/version`, headers));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
