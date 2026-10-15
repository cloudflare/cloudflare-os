/// <reference types="node" />

import { expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pullGitPack } from "../src/git-transport";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "commit.gpgSign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@localhost",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@localhost" },
  }).trim();
}

it("hydrates a complete depth-one native checkout from the same raw pack API as lazy DO reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "workshop-git-pull-"));
  const source = join(root, "source"), checkout = join(root, "checkout");
  try {
    await mkdir(source); await mkdir(checkout);
    git(source, "init", "--quiet");
    await writeFile(join(source, "a.txt"), "first\n");
    git(source, "add", "."); git(source, "commit", "--quiet", "-m", "first");
    await writeFile(join(source, "a.txt"), "second\n");
    const binary = Uint8Array.of(0, 128, 255, 13, 10);
    await mkdir(join(source, "nested"));
    await writeFile(join(source, "nested", "attachment.bin"), binary);
    git(source, "add", "."); git(source, "commit", "--quiet", "-m", "second");
    const commit = git(source, "rev-parse", "HEAD");
    git(checkout, "init", "--quiet");
    const pack = await pullGitPack(async body => {
      const backend = spawn("git", ["upload-pack", "--stateless-rpc", source], {
        env: {...process.env, GIT_PROTOCOL: "version=2"},
        stdio: ["pipe", "pipe", "inherit"],
      });
      backend.stdin.end(body);
      return new Response(Readable.toWeb(backend.stdout) as unknown as ReadableStream<Uint8Array>);
    }, [commit], {type: "commit", commitHistory: {kind: "depth", depth: 1}});
    // Raw PACK does not include the protocol's shallow-info section. Record the known boundary
    // before strict native import, otherwise Git quite correctly rejects its absent parents.
    await writeFile(join(checkout, ".git", "shallow"), commit + "\n");
    const importer = spawn("git", ["-C", checkout, "index-pack", "--stdin", "--strict"],
      {stdio: ["pipe", "ignore", "inherit"]});
    const finished = new Promise<number | null>((resolve, reject) => {
      importer.on("error", reject); importer.on("exit", resolve);
    });
    await pipeline(Readable.fromWeb(pack as unknown as import("node:stream/web").ReadableStream<Uint8Array>), importer.stdin);
    expect(await finished).toBe(0);
    git(checkout, "update-ref", "refs/heads/workshop", commit);
    git(checkout, "read-tree", "--reset", "-u", commit);
    expect(git(checkout, "rev-list", "--count", commit)).toBe("1");
    expect(await readFile(join(checkout, "a.txt"), "utf8")).toBe("second\n");
    expect(new Uint8Array(await readFile(join(checkout, "nested", "attachment.bin")))).toEqual(binary);
    expect(git(checkout, "remote")).toBe("");
    expect(git(checkout, "config", "--local", "--list")).not.toMatch(/https|credential|token/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}, 15_000);
