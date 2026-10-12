# registry-login

GitHub Action that exchanges a GitHub Actions OIDC token for an
evolve-registry token and writes it to `.npmrc`.

## Usage

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: actions/checkout@v6
  - uses: evolve-platform/registry-login@v1
  - run: pnpm publish
```

Releases provide full version tags such as `v1.0.0` and a moving major tag
such as `v1`. To pin a specific release, use
`evolve-platform/registry-login@v1.0.0` and run `pinact run` in the consuming
repository. pinact resolves the tag to a commit SHA and keeps the version in
a comment. Full version tags are never moved; the major tag follows the latest
release in that major version.

## Inputs

| Name                | Default                                  | Description                                                |
| ------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| `registry-url`      | `https://registry.evolve-platform.com`   | Registry base URL (OIDC audience + token exchange host)    |
| `npm-registry-host` | `npm.registry.evolve-platform.com`       | Hostname written to `.npmrc` for npm auth                  |
| `npmrc-path`        | `~/.npmrc`                               | Where to append the auth token. A leading `~/` is expanded. |

## Outputs

| Name    | Description                       |
| ------- | --------------------------------- |
| `token` | The exchanged evolve-registry token (masked in logs) |

## Development

This is a Node 24 TypeScript action. The runtime entry point is the bundled
`dist/index.mjs`, which must be committed.

```bash
pnpm install
pnpm test
pnpm build   # rebuilds dist/index.mjs with tsdown
```

Commit `dist/` alongside source changes — GitHub Actions runs the bundle
directly, no install step.

## Releases

1. Set `version` in `package.json` to the next stable version (`MAJOR.MINOR.PATCH`).
   The initial release uses the existing `1.0.0`.
2. Run `pnpm install --frozen-lockfile`, `pnpm test`, and `pnpm build`. Commit
   the version change and any updated `dist/` files, then merge to the default
   branch.
3. In GitHub Actions, select **Release → Run workflow** on the default branch,
   or run `gh workflow run release.yml` from this repository.

The workflow tests and type-checks the action, verifies that the committed bundle
matches a fresh build, creates the full version tag and a GitHub Release with
generated notes, then updates the major tag. It uses the built-in `GITHUB_TOKEN`
with `contents: write`; no extra release secret is needed. Repository rules must
allow the workflow to create version tags and update major tags.

Re-running the same commit is safe if a release was interrupted. The workflow
rejects a full version tag that already points to another commit, prerelease
versions, and releases that would move the major tag backwards. Bump
`package.json` before releasing another commit.

