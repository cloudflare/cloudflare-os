using Workerd = import "/workerd/workerd.capnp";

# Wires the three services behind REAL workerd bindings, so the tests exercise the same binding
# client a deployment would. `--experimental` is not needed here (no Worker Loader), but the DO
# storage directory must exist before boot or workerd fails with `Directory named "dodisk" not
# found` — the test harness creates it.

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .probeWorker),
    (name = "kv", worker = .kvWorker),
    (name = "r2", worker = .r2Worker),
    (name = "assets", worker = .assetsWorker),
    (name = "dodisk", disk = (path = "dodata", writable = true)),
    # allowDotfiles stays false: it is doing real work, keeping .DS_Store and friends unreachable.
    (name = "dist", disk = (path = "public")),
  ],
  sockets = [ (name = "http", address = "*:8813", http = (), service = "main") ],
);

const probeWorker :Workerd.Worker = (
  modules = [ (name = "probe.js", esModule = embed "probe.js") ],
  compatibilityDate = "2026-02-02",
  bindings = [
    (name = "KV", kvNamespace = "kv"),
    (name = "R2", r2Bucket = "r2"),
    (name = "ASSETS", service = "assets"),
  ],
);

const kvWorker :Workerd.Worker = (
  modules = [ (name = "kv.js", esModule = embed "../../src/kv.js") ],
  compatibilityDate = "2026-02-02",
  durableObjectNamespaces = [ (className = "KvStore", uniqueKey = "fieldos-test-kv", enableSql = true) ],
  durableObjectStorage = (localDisk = "dodisk"),
  bindings = [ (name = "STORE", durableObjectNamespace = "KvStore") ],
);

const r2Worker :Workerd.Worker = (
  modules = [ (name = "r2.js", esModule = embed "../../src/r2.js") ],
  compatibilityDate = "2026-02-02",
  durableObjectNamespaces = [ (className = "R2Store", uniqueKey = "fieldos-test-r2", enableSql = true) ],
  durableObjectStorage = (localDisk = "dodisk"),
  bindings = [ (name = "STORE", durableObjectNamespace = "R2Store") ],
);

const assetsWorker :Workerd.Worker = (
  modules = [ (name = "assets.js", esModule = embed "../../src/assets.js") ],
  compatibilityDate = "2026-02-02",
  bindings = [ (name = "DIST", service = "dist") ],
);
