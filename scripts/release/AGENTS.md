# Release pipeline

How customer instances get deployed.

- `build-release.ts` bundles every deployable worker byte-identically (wrangler dry-run with the
  pinned wrangler), builds the Access-mode frontend asset build, and generates the release manifest —
  the contract between this repo's CI and the deploy service, produced by `manifest-lib.ts` from each
  package's wrangler.jsonc with account-specific values replaced by placeholders (`$ACCOUNT_ID`,
  `$WORKER_NAME(...)`, `$SECRET(...)`, `$PUBLIC_BASE_URL`, ...).
- The bundles are minified (`WORKER_BUNDLE_SETTINGS` in `scripts/worker-config.ts`). A release
  carries no source map: `collectModules` drops the `.map` files, so an instance installed from a
  release reports stack positions in the minified bundle. To read one, check out the release's
  commit, run `pnpm build`, then `pnpm exec wrangler deploy --dry-run --outdir <dir>` in the
  Worker's package, which writes the bundle with its map. The map fits the release when the
  bundle's SHA-256 is the module's in the manifest.
- The build fails if a bundle holds a character above U+00FF: V8 would store all of that Worker's
  source two bytes per character. Minifying leaves one only in a regular expression literal or a
  legal comment (`/*!`, `@license`).
- Public CI runs the build on every pull request, forks included, so it must not need a secret or
  a `CI_*` variable.
- Each worker's manifest entry has a `kind`: `backend`, `router`, `gatekeeper` or `internal`. An
  `internal` worker (`INTERNAL_WORKERS` in `manifest-lib.ts`, listed by name) is one that other
  workers reach through a service binding and nothing routes to. Its kind is what says it is
  deployed with every instance, as the backend and the router are: it is not `installable`, and it
  carries no `shortName`, `BASE_URL`, inputs or `preinstall`, each of which belongs to a gatekeeper
  install.
- `upload-release.ts` mirrors the release to R2 content-addressed, manifest last; with `--candidate`
  the manifest lands under `candidates/<id>/` (invisible to the deploy service) so e2e can verify it,
  and `promote-release.ts` then copies it to `releases/<id>/` — publishing is that single
  all-or-nothing manifest copy. The copy is not isolated against concurrent promotions, so CI
  serializes promote runs (a GitLab resource group) and the script's newer-release guard skips
  candidates that a later release has already superseded.
- The manifest is covered by a golden-file test; after an intentional manifest change, regenerate
  with `UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts` and review the golden diff.
- Running the flow by hand (upload and promote need `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`):
  - `node scripts/release/build-release.ts --out release-out` — build everything into `release-out/`
    (id defaults to `r<CI_PIPELINE_IID>-<sha7>` in CI, `dev-<timestamp>` locally; override with
    `--release-id <id>`).
  - `node scripts/release/upload-release.ts --release release-out --candidate` — mirror to R2; omit
    `--candidate` to publish directly (bypasses the gate — CI never does this).
  - `node scripts/release/promote-release.ts --release-id <id>` — copy the verified candidate's
    manifest into `releases/<id>/`.

## Deploy-wizard inputs

An installable gatekeeper's user-supplied inputs default to OAuth `CLIENT_ID`/`CLIENT_SECRET`
secrets; a per-package `deploy-inputs.json` overrides them, and `NO_DEFAULT_CRED_INPUTS` in
`manifest-lib.ts` opts out gatekeepers that take no third-party OAuth app credentials (the wizard
blocks Install on unfilled secret inputs, so a spurious default makes a gatekeeper uninstallable).
Backend instance-state vars (`ADMINS`, `CLOUDFLARE_OS_DEPLOYMENT`, ...) are injected by the deploy
service at PUT time, never manifest-templated.
