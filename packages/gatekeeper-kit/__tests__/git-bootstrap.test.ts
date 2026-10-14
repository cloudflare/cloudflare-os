/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { validateBootstrapFetch } from "../src/git-bootstrap";
import { DELIM_PKT, FLUSH_PKT, encodePktLine } from "../src/git-transport";

const oid = "a".repeat(40);
const request = (arguments_: string[], suffix: Uint8Array[] = []) => Buffer.concat([
  encodePktLine("command=fetch"), encodePktLine("agent=git/2.39.5"), DELIM_PKT,
  ...arguments_.map(encodePktLine), FLUSH_PKT, ...suffix,
]);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "commit.gpgSign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@localhost",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@localhost" },
  }).trim();
}

describe("immutable Git bootstrap capability", () => {
  it("allows a shallow fetch and native Git's negotiation options", () => {
    validateBootstrapFetch(oid, request([`want ${oid}`, "deepen 1", "done"]));
    validateBootstrapFetch(oid, request(["thin-pack", "ofs-delta", "no-progress", "include-tag", "sideband-all",
      `want ${oid}`, "deepen 1", `have ${"b".repeat(40)}`, "done"]));
  });

  it.each<[string, string[]]>([
    ["another commit", [`want ${"b".repeat(40)}`, "deepen 1", "done"]],
    ["duplicate want", [`want ${oid}`, `want ${oid}`, "deepen 1", "done"]],
    ["deeper history", [`want ${oid}`, "deepen 10", "done"]],
    ["unbounded history", [`want ${oid}`, "done"]],
    ["filtered tree", [`want ${oid}`, "deepen 1", "filter blob:none", "done"]],
    ["ref name", ["want refs/heads/main", "deepen 1", "done"]],
    ["second command", [`want ${oid}`, "deepen 1", "command=ls-refs"]],
  ])("rejects %s", (_label, arguments_) => {
    expect(() => validateBootstrapFetch(oid, request(arguments_))).toThrow();
  });

  it.each([FLUSH_PKT, DELIM_PKT, encodePktLine(`want ${oid}`)])("rejects data after the final flush (%j)", suffix => {
    expect(() => validateBootstrapFetch(oid, request([`want ${oid}`, "deepen 1", "done"], [suffix]))).toThrow();
  });

  it("rejects invalid commit ids, framing, encoding, discovery, and oversized requests", () => {
    for (const commit of ["main", "a".repeat(39), "A".repeat(40)])
      expect(() => validateBootstrapFetch(commit, request([`want ${oid}`, "deepen 1", "done"]))).toThrow();
    for (const bytes of [new Uint8Array(65537), new TextEncoder().encode("0003"), new TextEncoder().encode("0008x"),
      new Uint8Array([48, 48, 48, 53, 255]),
      Buffer.concat([encodePktLine("command=ls-refs"), FLUSH_PKT]),
      Buffer.concat([encodePktLine("command=fetch"), FLUSH_PKT])])
      expect(() => validateBootstrapFetch(oid, bytes)).toThrow();
  });

  it("serves native Git's actual v2 request without exposing ref discovery or credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "workshop-git-bootstrap-"));
    const source = join(root, "repo.git"), checkout = join(root, "checkout");
    let server: ReturnType<typeof createServer> | undefined;
    try {
      await mkdir(source);
      git(source, "init", "--quiet");
      await writeFile(join(source, "a.txt"), "first\n");
      git(source, "add", "a.txt");
      git(source, "commit", "--quiet", "-m", "first");
      await writeFile(join(source, "a.txt"), "second\n");
      git(source, "commit", "--quiet", "-am", "second");
      const commit = git(source, "rev-parse", "HEAD");
      const calls: string[] = [];
      server = createServer(async (req, res) => {
        calls.push(`${req.method} ${req.url}`);
        // The bridge advertises capabilities itself; the upstream never sees discovery.
        if (req.method === "GET") {
          res.setHeader("content-type", "application/x-git-upload-pack-advertisement");
          res.end(Buffer.concat([
            ...["version 2", "agent=workshop", "fetch=shallow", "object-format=sha1"].map(encodePktLine), FLUSH_PKT,
          ]));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        try { validateBootstrapFetch(commit, body); } catch { res.writeHead(403).end(); return; }
        const backend = spawn("git", ["http-backend"], {
          env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", GIT_PROTOCOL: "version=2",
            PATH_INFO: "/repo.git/git-upload-pack", REQUEST_METHOD: "POST",
            CONTENT_TYPE: "application/x-git-upload-pack-request", CONTENT_LENGTH: String(body.length) },
          stdio: ["pipe", "pipe", "ignore"],
        });
        backend.stdin.end(body);
        // Fixtures are tiny; production returns the HTTP body stream without collecting it.
        const output: Buffer[] = [];
        for await (const chunk of backend.stdout) output.push(chunk);
        const all = Buffer.concat(output), headersEnd = all.indexOf("\r\n\r\n");
        res.setHeader("content-type", "application/x-git-upload-pack-result");
        res.end(all.subarray(headersEnd + 4));
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No fixture port");
      await mkdir(checkout);
      git(checkout, "init", "--quiet");
      await promisify(execFile)("git", ["-C", checkout, "-c", "protocol.version=2", "-c", "credential.helper=",
        "fetch", "--no-tags", "--depth=1", `http://127.0.0.1:${address.port}/repo.git`, commit]);
      expect(git(checkout, "rev-parse", "FETCH_HEAD")).toBe(commit);
      expect(git(checkout, "rev-list", "--count", "FETCH_HEAD")).toBe("1");
      expect(git(checkout, "show", "FETCH_HEAD:a.txt")).toBe("second");
      expect(calls).toEqual(["GET /repo.git/info/refs?service=git-upload-pack", "POST /repo.git/git-upload-pack"]);
      expect(git(checkout, "remote")).toBe("");
    } finally {
      if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
