import {test, expect} from "vitest";
import {build, buildSync} from "esbuild";
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

      // Commits can be fetched by ID, several in one fetch: check out the boundary, change a
      // file, and reset to the head, so that Git shows the changes relative to the head.
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

// The container's side of a command (see plans/tree-sync-replicas.md), with native Git against
// the kernel's snapshot() and submit(), served by replica-fixture.ts.
test("native Git syncs a replica's files with snapshots and submissions", async () => {
  const fixture = (await build({entryPoints: [resolve(import.meta.dirname, "replica-fixture.ts")], bundle: true,
    write: false, format: "esm", target: "es2022", external: ["cloudflare:*", "node:*"], plugins: [{
      // The kernel's RPC classes carry capnweb-validate decorators, which only its bundler
      // plugin compiles; nothing here is called over RPC.
      name: "no-validation", setup(build) {
        build.onResolve({filter: /^capnweb-validate$/}, () => ({path: "capnweb-validate", namespace: "stub"}));
        build.onLoad({filter: /.*/, namespace: "stub"}, () => ({contents: "export const validateRpc = () => () => {};"}));
      },
    }]})).outputFiles[0].text;
  const dir = mkdtempSync(join(tmpdir(), "worktree-replica-"));
  const runtime = new Miniflare({workers: [{config: {name: "replica", compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"], manifest: {mainModule: "worker.js", modules: {"worker.js": {type: "esm", contents: fixture}}},
  }}]});
  // The number of objects in the last pack served.
  let served: number | undefined;
  const server = createServer(async (req, res) => {
    try {
      const response = await runtime.dispatchFetch(`http://replica.invalid${req.url}`, {
        method: req.method, headers: req.headers as Record<string, string>,
        ...(req.method === "POST" ? {body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half"} : {}),
      });
      const body = Buffer.from(await response.arrayBuffer());
      if (req.url?.startsWith("/repo/") && body.includes("PACK")) served = body.readUInt32BE(body.indexOf("PACK") + 8);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(body);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test HTTP port");
    const base = `http://127.0.0.1:${address.port}`;
    const call = async (path: string, body?: BodyInit) => {
      const response = await fetch(`${base}${path}`, {method: "POST", body});
      if (!response.ok) throw new Error(await response.text());
      return response;
    };
    await spawnGit(dir, ["clone", `${base}/repo`, "clone"]);
    const clone = join(dir, "clone");
    const git = (args: string[], options: {input?: Buffer} = {}) => execFileSync("git", args, {cwd: clone,
      env: {...process.env, GIT_INDEX_FILE: join(clone, ".git", "replica-index")}, ...options});
    const actualTree = () => { git(["add", "-A"]); return git(["write-tree"], {}).toString().trim(); };

    // Step 1 of each command: check out the snapshot, unless the files already have its tree.
    const snapshot = async () => {
      const result = await (await call("/snapshot")).json() as {tree: string; head: string; command: number};
      const actual = actualTree();
      served = undefined;
      if (actual !== result.tree) {
        await spawnGit(clone, ["fetch", "-q", "origin", result.tree]);
        git(["read-tree", "-m", "-u", actual, result.tree]);
      }
      run(clone, "reset", "-q", "--mixed", result.head);
      return result;
    };
    // Step 3: submit the files' tree, with what the snapshot's lacks.
    const submit = async (from: {tree: string; command: number}) => {
      const tree = actualTree();
      const pack = execFileSync("sh", ["-c", 'git rev-list --objects "$1" "^$2" | git pack-objects -q --stdout', "sh", tree, from.tree],
        {cwd: clone});
      const result = await (await call(`/submit?command=${from.command}&tree=${tree}`, pack)).json() as {tree: string};
      return {tree, result: result.tree};
    };

    // The agent's code edited a file before the command: the snapshot has it, as uncommitted.
    await call("/write?path=a.txt", "one\ntwo\nagent\n");
    const first = await snapshot();
    expect(served).toBe(2);
    expect(run(clone, "show", "HEAD:a.txt")).toBe("one\ntwo");
    expect(execFileSync("cat", ["a.txt"], {cwd: clone, encoding: "utf8"})).toBe("one\ntwo\nagent\n");
    expect(run(clone, "status", "--porcelain")).toBe("M a.txt");

    // A formatter rewrites a file, adds one and makes a script executable.
    writeFileSync(join(clone, "lib", "b.txt"), "formatted bee\n");
    writeFileSync(join(clone, "new.sh"), "#!/bin/sh\n", {mode: 0o755});
    const submitted = await submit(first);
    expect(submitted.result).toBe(submitted.tree);
    expect(await (await call("/read?path=lib/b.txt")).text()).toBe("formatted bee\n");

    // A second command finds the files in sync, and transfers nothing.
    const second = await snapshot();
    expect(second.tree).toBe(submitted.tree);
    expect(served).toBeUndefined();

    // A command cut off part way (say, by a restart) leaves the files dirty, with a new
    // untracked file. The next snapshot's checkout restores them.
    writeFileSync(join(clone, "a.txt"), "half-written\n");
    writeFileSync(join(clone, "junk.txt"), "junk\n");
    const third = await snapshot();
    expect(third.tree).toBe(submitted.tree);
    expect(actualTree()).toBe(submitted.tree);
    expect(execFileSync("ls", [clone], {encoding: "utf8"}).split("\n")).not.toContain("junk.txt");
    expect(execFileSync("cat", ["a.txt"], {cwd: clone, encoding: "utf8"})).toBe("one\ntwo\nagent\n");
    expect(run(clone, "status", "--porcelain")).toBe("M a.txt\n M lib/b.txt\n?? new.sh");
    run(clone, "fsck", "--no-reflogs");
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.dispose(); rmSync(dir, {recursive: true, force: true});
  }
}, 60_000);
