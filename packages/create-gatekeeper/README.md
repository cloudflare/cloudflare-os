# create-gatekeeper

Writes a new gatekeeper package, built on [`gatekeeper-kit`](../gatekeeper-kit/README.md), and
registers it where the repository lists gatekeepers by hand. It is a command, not a deployable
Worker.

```sh
pnpm create-gatekeeper <name> --auth <oauth|api-key> [--hooks <app|subscription>] --display "<Provider Name>" \
  [--openapi <description.json> [--operations <operationId>,...|<lines.jsonl>]]
```

| Flag | Meaning |
|---|---|
| `<name>` | The vendor id, 1-20 lowercase letters and digits, starting with a letter: the package is `packages/gatekeeper-<name>`, served under `/gatekeeper/<name>`. |
| `--auth <kind>` | How a user connects: `oauth`, an authorization-code grant with PKCE, or `api-key`, a key the user pastes into the connect page. Required. |
| `--hooks <kind>` | Event hooks fed by the provider's webhooks: `app`, one webhook for the deployment, or `subscription`, webhooks the gatekeeper adds through the provider's API. |
| `--display <text>` | The provider's name as users read it. Defaults to `<name>`, capitalized. |
| `--openapi <file>` | The provider's OpenAPI description, a local JSON or YAML file. The package's `generate:openapi` script pins it by hash, and the package keeps no copy: a description can be megabytes. Nothing is fetched. |
| `--openapi-url <url>` | Where that description is published, an `https` URL, which the script then generates from. Without it the script takes the file as its argument. |
| `--fetch` | Download the description from `--openapi-url`, in place of `--openapi`. The package is pinned to what the URL serves then, so give it a URL of one version, such as a file at a commit. |
| `--keep-description` | Keep a copy of the description in the package, which the script generates from instead. |
| `--operations <ids>` | With `--openapi`, the operations the gatekeeper calls, whose schema is generated now. Without it, the description's operations are printed to choose from. |
| `--out <dir>` | Write the package there and register nothing: the way to try the command out. |
| `--no-install` | Skip `pnpm install` and `pnpm types:generate` afterwards. |

The package is written for an invented provider, and every answer only the real provider's
documentation or a design decision can give is marked `STOP(<id>)`. It compiles, and its workerd
suite (`test:workerd`) passes against a fake of the invented provider; its Node tests fail until
no mark is left.

The full guide is the `write-gatekeeper` skill:
[`SKILL.md`](../../.agents/skills/write-gatekeeper/SKILL.md) for the design and review of a
gatekeeper, and [`SKELETON.md`](../../.agents/skills/write-gatekeeper/SKELETON.md) for what the
command writes, what it leaves, and how the generated tests and hooks work.

## Layout

- `bin/create-gatekeeper.ts` is the command: it reads the description, writes the files, and
  registers the package.
- `src/scaffold.ts` renders the files, and touches nothing on disk but the template.
- `template/` holds a layer per choice (`base`, `auth-*`, `hooks`, `hooks-*`, `openapi-schema`);
  a later layer's file replaces an earlier one of the same path. The provider is `acme`, `Acme`,
  `ACME` and, in prose, `Acme Service`, renamed throughout: keep `Acme Service` on one line, and
  put no article before it, since which one depends on the provider's name. `// #if <feature>`,
  `// #else` and `// #endif` lines keep a block for `hooks`, `hooks-app`, `hooks-subscription`,
  `openapi` or `openapi-copy`; blocks do not nest, and each file must parse as TypeScript where it lies.

`pnpm --filter @gadgets/create-gatekeeper test:run` generates a package for each variant, compiles
it and runs its workerd suite, then runs a generated package's connect flow and hook driver in
workerd.
