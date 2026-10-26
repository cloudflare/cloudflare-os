# Release pipeline

How customer instances get deployed.

- `build-release.ts` bundles every deployable worker byte-identically (wrangler dry-run with the
  pinned wrangler), builds the Access-mode frontend asset build, and generates the release manifest —
  the contract between this repo's CI and the deploy service, produced by `manifest-lib.ts` from each
  package's wrangler.jsonc with account-specific values replaced by placeholders (`$ACCOUNT_ID`,
  `$WORKER_NAME(...)`, `$SECRET(...)`, `$PUBLIC_BASE_URL`, ...).
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
