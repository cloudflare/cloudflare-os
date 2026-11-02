# Contributing to Cloudflare OS

At this time, we are not seeking outside contribution.

AI has made writing code easy. The hard part, today, is not writing the code, but reviewing it, making sure quality stays high, and keeping the product coherent. In that light, unfortunately, external code contributions are "donating" the easy part of the job, while creating more of the hard work.

With that said, we are happy to accept small, trivially-verified PRs that fix a problem. However, we ask that you refrain from submitting low-value PRs (e.g. typo fixes) or PRs that are more than a dozen or so lines. Such PRs will be closed with a reference to this guideline.

If you have a big idea you'd like us to consider, feel free to [open a discussion](https://github.com/cloudflare/cloudflare-os/discussions) about it.

This policy may change in the future as the project matures. Until then, thank you for your understanding.

## What CI runs on your pull request

Lint, build and tests ([`ci.yml`](.github/workflows/ci.yml)) run on every pull request, including
those from forks.

[`risk-review.yml`](.github/workflows/risk-review.yml) posts a `risk-review` check on your pull
request. It rates the change from the paths and lines it touches, and records whether the
auto-merge rules would let it merge without a person. For now that record changes nothing: the
check only mirrors whether the pull request is approved, and it is not required. It never runs your
code.

Preview deployments ([`preview.yml`](.github/workflows/preview.yml)) do **not**, this is
deliberate. Deploying a preview requires a Cloudflare API token that can create Workers
and storage on a Cloudflare-owned account, and GitHub structurally withholds repository secrets
from `pull_request` runs whose head is a fork. If you see the preview job skipped on your PR,
that is working as intended — a maintainer will deploy one if the change needs manual review.
See [`.github/workflows/README.md`](.github/workflows/README.md).
