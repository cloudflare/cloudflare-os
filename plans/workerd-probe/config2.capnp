using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .testWorker),
    (name = "kv", worker = .kvWorker),
    (name = "r2", worker = .r2Worker),
    (name = "dodisk", disk = (path = "dodata", writable = true)),
  ],
  sockets = [ (name = "http", address = "*:8812", http = (), service = "main") ],
);

const testWorker :Workerd.Worker = (
  modules = [ (name = "test2.js", esModule = embed "test2.js") ],
  compatibilityDate = "2025-01-01",
  bindings = [
    (name = "KV", kvNamespace = "kv"),
    (name = "R2", r2Bucket = "r2"),
  ],
);

const kvWorker :Workerd.Worker = (
  modules = [ (name = "kv.js", esModule = embed "kv.js") ],
  compatibilityDate = "2025-01-01",
  durableObjectNamespaces = [ (className = "KvStore", uniqueKey = "kv-store-key") ],
  durableObjectStorage = (localDisk = "dodisk"),
  bindings = [ (name = "STORE", durableObjectNamespace = "KvStore") ],
);

const r2Worker :Workerd.Worker = (
  modules = [ (name = "r2.js", esModule = embed "r2.js") ],
  compatibilityDate = "2025-01-01",
  durableObjectNamespaces = [ (className = "R2Store", uniqueKey = "r2-store-key") ],
  durableObjectStorage = (localDisk = "dodisk"),
  bindings = [ (name = "STORE", durableObjectNamespace = "R2Store") ],
);
