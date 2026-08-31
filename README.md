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
`dist/index.js`, which must be committed.

```bash
pnpm install
pnpm test
pnpm build   # rebuilds dist/index.js with tsdown
```

Commit `dist/` alongside source changes — GitHub Actions runs the bundle
directly, no install step.

