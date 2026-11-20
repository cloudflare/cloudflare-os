# Gatekeeper Acme Service

Connects an Acme Service account so gadgets can read its items and, once the user approves, rename
them.

`pnpm create-gatekeeper` wrote this package. Wherever only the provider's documentation can say
what is right it wrote an invented answer and marked it `STOP(<id>)`; `pnpm --filter
@gadgets/acme-gatekeeper test:run` lists the marks that are left. Replace this paragraph once
there are none.

## What a gadget can do

See [`src/types.d.ts`](src/types.d.ts), the interface gadgets are given.

## Actions

[`action-table.json`](action-table.json) lists every action with its kind's tag, its auto-approval
verdict, how it is delivered and its fence. A test keeps it in step with the code; regenerate it
with `pnpm --filter @gadgets/acme-gatekeeper exec vitest run -u`, and read the diff: regenerating
accepts any change.

// #if openapi
## The provider's API

[`openapi.json`](openapi.json) is Acme Service's OpenAPI description, and
[`openapi-operations.jsonl`](openapi-operations.jsonl) lists the operations the gatekeeper calls,
one line each as `pnpm exec gatekeeper-openapi-schema openapi.json --list` prints it. The typed
client's schema is generated from the two into `src/openapi/`. The `generate:openapi` script in
`package.json` pins the description by hash, so after replacing it, set the script's `--sha256`
to the new file's (`sha256sum openapi.json`). After that or a change to the list, regenerate and
commit the output:

```sh
pnpm --filter @gadgets/acme-gatekeeper generate:openapi
```

// #endif
## Sharing a workspace

Every read reports the item it depends on, and an observer sees it only if their own Acme Service
connection can read that item.
