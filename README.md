# registry-login

GitHub composite action that exchanges a GitHub Actions OIDC token for an
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
| `npmrc-path`        | `.npmrc`                                 | Path to the `.npmrc` file to append the auth token to      |

## Outputs

| Name    | Description                       |
| ------- | --------------------------------- |
| `token` | The exchanged evolve-registry token (masked in logs) |
