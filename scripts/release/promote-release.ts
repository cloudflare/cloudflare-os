#!/usr/bin/env node

// Promotes an e2e-verified candidate release: copies candidates/<id>/manifest.json to
// releases/<id>/manifest.json. The blobs are already in place — content-addressed and uploaded
// by upload-release.ts before its manifest PUT — so publishing is this single manifest copy.
// The copy is all-or-nothing (manifest-last protocol: the deploy service scans only releases/),
// but NOT isolated: the newer-release guard below is check-then-act, so concurrent promotions
// could still interleave between its LIST and the copy. The caller must serialize runs of this
// script — gadgets-internal's CI runs it in a resource group — and the guard then catches the
// remaining hazard, a promote that starts after a newer release has already published.
//
// Exit-0 guards (benign races must not fail the pipeline):
//   - already promoted: releases/<id>/manifest.json exists (idempotent re-runs)
//   - superseded: a CI-format id (r<run#>-<sha>) with a HIGHER run number already exists under
//     releases/. "Latest" is decided by manifest upload time (deploy's release.ts), so promoting
//     an older candidate after a newer one shipped would ROLL PRODUCTION BACK — the stale PUT
//     would carry the newest timestamp.
//
// A missing candidate manifest is a hard error: the caller asked to promote something that was
// never uploaded (or was cleaned up), and silently succeeding would report a phantom publish.
//
// Env: R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com), R2_BUCKET,
//      R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
// Usage: node scripts/release/promote-release.ts --release-id <id>

import { pathToFileURL } from "node:url";
import { AwsClient } from "aws4fetch";

/** The CI run number of an `r<run#>-<sha>` release id, or null for any other id shape
 *  (dev-<ts> releases carry no ordering claim). */
export function ciRunNumber(releaseId: string): number | null {
  const match = /^r(\d+)-/.exec(releaseId);
  return match ? Number(match[1]) : null;
}

/** The already-published CI release id that supersedes this candidate, or null. Non-CI ids
 *  (either side) never participate: only run numbers are comparable. */
export function supersededBy(candidateId: string, publishedIds: Iterable<string>): string | null {
  const candidateRun = ciRunNumber(candidateId);
  if (candidateRun === null) return null;
  for (const id of publishedIds) {
    const run = ciRunNumber(id);
    if (run !== null && run > candidateRun) return id;
  }
  return null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

function parseArgs(argv: string[]): { releaseId: string } {
  let releaseId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--release-id") releaseId = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!releaseId) throw new Error("--release-id <id> is required");
  return { releaseId };
}

// Key names only (paginated ListObjectsV2, 1000 keys per round trip); manifest bodies are
// never fetched.
async function listPublishedReleaseIds(
  client: AwsClient,
  keyUrl: (key: string) => string,
): Promise<string[]> {
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const params = new URLSearchParams({ "list-type": "2", prefix: "releases/" });
    if (token) params.set("continuation-token", token);
    const response = await client.fetch(`${keyUrl("")}?${params}`, { method: "GET" });
    if (!response.ok) {
      throw new Error(`ListObjectsV2: ${response.status} ${await response.text()}`);
    }
    const xml = await response.text();
    for (const match of xml.matchAll(/<Key>releases\/([^<]+)\/manifest\.json<\/Key>/g)) {
      ids.push(match[1]);
    }
    token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
  } while (token);
  return ids;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = requireEnv("R2_ENDPOINT").replace(/\/$/, "");
  const bucket = requireEnv("R2_BUCKET");
  const client = new AwsClient({
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    service: "s3",
    region: "auto",
  });
  const keyUrl = (key: string) => `${endpoint}/${bucket}/${key}`;

  const publishedKey = `releases/${args.releaseId}/manifest.json`;
  const candidateKey = `candidates/${args.releaseId}/manifest.json`;

  const publishedHead = await client.fetch(keyUrl(publishedKey), { method: "HEAD" });
  if (publishedHead.status === 200) {
    console.log(`already promoted: ${publishedKey}`);
    return;
  }
  if (publishedHead.status !== 404) {
    throw new Error(`HEAD ${publishedKey}: unexpected status ${publishedHead.status}`);
  }

  const candidate = await client.fetch(keyUrl(candidateKey), { method: "GET" });
  if (candidate.status === 404) {
    throw new Error(`candidate not found: ${candidateKey} — was the release uploaded ` +
      "with --candidate?");
  }
  if (!candidate.ok) {
    throw new Error(`GET ${candidateKey}: ${candidate.status} ${await candidate.text()}`);
  }
  const manifestBody = new Uint8Array(await candidate.arrayBuffer());

  const superseder = supersededBy(args.releaseId, await listPublishedReleaseIds(client, keyUrl));
  if (superseder) {
    console.warn(`WARNING: not promoting ${args.releaseId} — a newer release ` +
      `(${superseder}) is already published; promoting now would roll the deploy ` +
      "service back to this older candidate.");
    return;
  }

  // Server-side CopyObject first (no second body transfer); the buffered GET above doubles as
  // the fallback PUT body if the copy path is ever unavailable.
  const copy = await client.fetch(keyUrl(publishedKey), {
    method: "PUT",
    headers: {
      "x-amz-copy-source": `/${bucket}/${candidateKey}`,
      "Content-Type": "application/json",
    },
  });
  // S3 copies can answer 200 with an error document; a real copy answers with CopyObjectResult.
  if (copy.ok && (await copy.text()).includes("<CopyObjectResult")) {
    console.log(`promoted (copy): ${candidateKey} -> ${publishedKey}`);
    return;
  }
  console.warn(`CopyObject unavailable (status ${copy.status}); falling back to PUT`);
  const put = await client.fetch(keyUrl(publishedKey), {
    method: "PUT",
    body: manifestBody,
    headers: { "Content-Type": "application/json" },
  });
  if (!put.ok) {
    throw new Error(`PUT ${publishedKey}: ${put.status} ${await put.text()}`);
  }
  console.log(`promoted (put): ${candidateKey} -> ${publishedKey}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
