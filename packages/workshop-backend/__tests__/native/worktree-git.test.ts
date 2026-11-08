import {test, expect} from "vitest";
import {buildSync} from "esbuild";
import {Miniflare} from "miniflare";
import {execFileSync, spawn} from "node:child_process";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {join, resolve} from "node:path";
import {tmpdir} from "node:os";
import {createServer} from "node:http";
import {Readable} from "node:stream";
import {once} from "node:events";

const worker = buildSync({entryPoints: [resolve(import.meta.dirname, "git-fixture.ts")], bundle: true,
  write: false, format: "esm", target: "es2022", external: ["cloudflare:*", "node:*"]}).outputFiles[0].text;
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, {cwd, encoding: "utf8"}).trim();
const spawnGit = async (cwd: string, args: string[], succeeds = true) => {
  const process = spawn("git", ["-c", "protocol.version=2", ...args], {cwd, stdio: ["ignore", "pipe", "pipe"]});
  let stderr = "";
  process.stderr.on("data", chunk => { stderr += chunk; });
  process.stdout.resume();
  const [code] = await once(process, "close");
  if (succeeds) expect(code, stderr).toBe(0); else expect(code, stderr).not.toBe(0);
};

test.each([false, true])("native Git clones a %s upstream/local worktree with correct shallow ancestry", async remote => {
  const dir = mkdtempSync(join(tmpdir(), "worktree-git-"));
  let runtime: Miniflare | undefined;
  // The number of objects in the last pack served.
  let served: number | undefined;
  const server = createServer(async (req, res) => {
    try {
      const response = await runtime!.dispatchFetch(`http://git.invalid${req.url}`, {
        method: req.method, headers: req.headers as Record<string, string>,
        ...(req.method === "POST" ? {body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half"} : {}),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      const body = Buffer.from(await response.arrayBuffer());
      const pack = body.indexOf("PACK");
      if (pack >= 0) served = body.readUInt32BE(pack + 8);
      res.end(body);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  try {
    run(dir, "init", "-q");
    run(dir, "config", "user.name", "Test"); run(dir, "config", "user.email", "test@example.com");
    run(dir, "commit", "--allow-empty", "-qm", "ancestor");
    const ancestor = run(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "unchanged.bin"), Buffer.from([0, 255, 1, 0]));
    writeFileSync(join(dir, "changed.txt"), "base\n");
    run(dir, "add", "."); run(dir, "commit", "-qm", "base");
    const boundary = run(dir, "rev-parse", "HEAD");
    const forbiddenBlob = run(dir, "rev-parse", "HEAD:unchanged.bin");
    const upstreamPack = execFileSync("git", ["pack-objects", "--stdout", "--revs"], {cwd: dir, input: `${boundary}\n^${ancestor}\n`});
    writeFileSync(join(dir, "changed.txt"), "DO local child\n");
    run(dir, "mv", "unchanged.bin", "renamed.bin");
    run(dir, "commit", "-qam", "DO child");
    const head = run(dir, "rev-parse", "HEAD");
    // The worktree's next head, once the agent commits again.
    run(dir, "checkout", "-qb", "next");
    writeFileSync(join(dir, "changed.txt"), "DO grandchild\n");
    run(dir, "commit", "-qam", "DO grandchild");
    const next = run(dir, "rev-parse", "HEAD");
    run(dir, "checkout", "-q", "-");
    // A commit the upstream has on another branch, outside the worktree head's history.
    const unrelated = run(dir, "commit-tree", `${ancestor}^{tree}`, "-p", ancestor, "-m", "unrelated");
    run(dir, "update-ref", "refs/heads/unrelated", unrelated);
    const objects: Record<string, {type: string; bytes: number[]}> = {};
    const ids = run(dir, "rev-list", "--objects", "--all").split("\n").map(line => line.split(" ")[0]);
    for (const oid of ids) {
      const type = run(dir, "cat-file", "-t", oid);
      objects[oid] = {type, bytes: [...execFileSync("git", ["cat-file", type, oid], {cwd: dir})]};
    }
    runtime = new Miniflare({workers: [{config: {
      name: "worktree-git", compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"],
      manifest: {mainModule: "worker.js", modules: {"worker.js": {type: "esm", contents: worker}}},
      env: {
        FIXTURE: {type: "json", value: {heads: [head, next], boundary: remote ? boundary : null,
          objects, upstreamPack: [...upstreamPack], forbiddenBlobs: remote ? [forbiddenBlob] : []}},
        // Like GitHub and GitLab, allow the partial-clone filter the history check uses.
        UPSTREAM: {type: "fetcher", handler: async request => new Response(execFileSync("git",
          ["-c", "uploadpack.allowFilter=true", "upload-pack", "--stateless-rpc", dir], {input: Buffer.from(await request.arrayBuffer()),
            env: {...process.env, GIT_PROTOCOL: "version=2"}}),
          {headers: {"content-type": "application/x-git-upload-pack-result"}})},
      },
    }}]});
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test HTTP port");
    const url = `http://127.0.0.1:${address.port}/repo`;
    await spawnGit(dir, ["clone", url, "clone"]);
    const clone = join(dir, "clone");
    expect(run(clone, "rev-parse", "HEAD")).toBe(head);
    expect(run(clone, "log", "--format=%s")).toBe(remote ? "DO child\nbase" : "DO child\nbase\nancestor");
    expect(run(clone, "show", "HEAD:changed.txt")).toBe("DO local child");
    expect(execFileSync("git", ["show", "HEAD:renamed.bin"], {cwd: clone})).toEqual(Buffer.from([0, 255, 1, 0]));
    expect(run(clone, "rev-parse", "--is-shallow-repository")).toBe(String(remote));
    run(clone, "fsck", "--no-reflogs");
    if (remote) {
      // The integration harness discovers UPGRADE_BASE only after mounting the repository.
      // Fetch an ancestor absent from the shallow worktree using the same origin URL.
      await spawnGit(clone, ["fetch", "--depth=1", "origin", ancestor]);
      expect(run(clone, "show", "-s", "--format=%s", "FETCH_HEAD")).toBe("ancestor");
      expect(run(clone, "rev-parse", "HEAD")).toBe(head);
      run(clone, "fsck", "--no-reflogs");
      await spawnGit(clone, ["fetch", "--depth=1", "origin", unrelated], false);

      // More history beyond the boundary, for the head the clone already has.
      for (const args of [["--deepen=1"], ["--unshallow"]]) {
        const deepened = join(dir, `deepen${args[0]}`);
        await spawnGit(dir, ["clone", url, deepened]);
        await spawnGit(deepened, ["fetch", ...args]);
        expect(run(deepened, "log", "--format=%s")).toBe("DO child\nbase\nancestor");
        if (args[0] === "--unshallow") expect(run(deepened, "rev-parse", "--is-shallow-repository")).toBe("false");
        run(deepened, "fsck", "--no-reflogs");
      }

      // The fresh-start sequence: check out the file base, apply the pending changes, and reset
      // to the head, so that Git shows the changes relative to the head.
      const fresh = join(dir, "fresh");
      run(dir, "init", "-q", fresh);
      await spawnGit(fresh, ["fetch", "-q", url, boundary, head]);
      run(fresh, "checkout", "-q", boundary);
      writeFileSync(join(fresh, "changed.txt"), "pending\n");
      run(fresh, "reset", "-q", "--mixed", head);
      expect(run(fresh, "status", "--porcelain")).toBe("M changed.txt\n D renamed.bin\n?? unchanged.bin");
    }

    // The head moves: fetching it sends only the new commit's objects.
    run(clone, "remote", "set-url", "origin", `${url}1`);
    if (remote) await spawnGit(clone, ["fetch", "--deepen=1"], false);
    await spawnGit(clone, ["fetch", "origin"]);
    expect(run(clone, "rev-parse", "origin/HEAD")).toBe(next);
    expect(served).toBe(3);
    run(clone, "fsck", "--no-reflogs");
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime?.dispose(); rmSync(dir, {recursive: true, force: true});
  }
}, 30_000);
