import { appendFile } from 'node:fs/promises'
import * as core from '@actions/core'

const MAX_RETRIES = 3
const BASE_DELAY_MS = 500

export interface RetryOptions {
  /** Number of retries after the initial attempt for transient failures. */
  retries?: number
  /** Base delay in milliseconds; doubled on each subsequent attempt. */
  baseDelayMs?: number
  /** Sleep implementation; injectable for tests. */
  sleep?: (ms: number) => Promise<void>
}

export interface RunOptions {
  retry?: RetryOptions
}

export async function run(options: RunOptions = {}): Promise<void> {
  const registryUrl = core.getInput('registry-url', { required: true })
  const npmRegistryHost = core.getInput('npm-registry-host', { required: true })
  const npmrcPath = core.getInput('npmrc-path', { required: true })

  const oidcToken = await getOidcToken(registryUrl)
  const token = await exchangeToken(registryUrl, oidcToken, options.retry)

  core.setSecret(token)
  core.setOutput('token', token)

  await appendFile(npmrcPath, `//${npmRegistryHost}/:_authToken=${token}\n`)
}

async function getOidcToken(audience: string): Promise<string> {
  try {
    return await core.getIDToken(audience)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/ACTIONS_ID_TOKEN_REQUEST/i.test(message)) {
      throw new Error(
        'Failed to obtain a GitHub OIDC token: the job is missing the `id-token: write` permission. ' +
          'Add the following to the workflow or job:\n' +
          '  permissions:\n' +
          '    id-token: write\n' +
          '    contents: read',
        { cause: err },
      )
    }
    throw new Error(
      `Failed to obtain a GitHub OIDC token for audience "${audience}".`,
      { cause: err },
    )
  }
}

/** Marks an error as a transient failure that is safe to retry. */
function markRetryable(err: Error): Error {
  return Object.assign(err, { retryable: true })
}

function isRetryable(err: unknown): boolean {
  return (
    err instanceof Error && (err as { retryable?: boolean }).retryable === true
  )
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

async function exchangeToken(
  registryUrl: string,
  oidcToken: string,
  options: RetryOptions = {},
): Promise<string> {
  const {
    retries = MAX_RETRIES,
    baseDelayMs = BASE_DELAY_MS,
    sleep = defaultSleep,
  } = options

  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptExchange(registryUrl, oidcToken)
    } catch (err) {
      if (!isRetryable(err) || attempt >= retries) {
        throw err
      }
      const delay = baseDelayMs * 2 ** attempt
      const message =
        err instanceof Error ? err.message.split('\n')[0] : String(err)
      core.warning(
        `Token exchange attempt ${attempt + 1}/${retries + 1} failed; ` +
          `retrying in ${delay}ms. (${message})`,
      )
      await sleep(delay)
    }
  }
}

async function attemptExchange(
  registryUrl: string,
  oidcToken: string,
): Promise<string> {
  const url = `${registryUrl.replace(/\/$/, '')}/api/v1/tokens/exchange`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: oidcToken, provider: 'github-actions' }),
    })
  } catch (err) {
    throw markRetryable(
      new Error(
        `Could not reach the registry token-exchange endpoint at ${url}. ` +
          'Verify the `registry-url` input is correct and that the registry is reachable from this runner ' +
          '(check DNS, firewall/egress rules, and TLS configuration).',
        { cause: err },
      ),
    )
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => '')).trim()
    const hint = hintForStatus(response.status, registryUrl)
    const error = new Error(
      [
        `Token exchange failed: ${response.status} ${response.statusText} (POST ${url})`,
        body && `Response body: ${body}`,
        hint,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    throw isRetryableStatus(response.status) ? markRetryable(error) : error
  }

  let data: unknown
  try {
    data = await response.json()
  } catch (err) {
    throw new Error(
      `Token exchange endpoint at ${url} returned a non-JSON response. ` +
        'Verify the `registry-url` input points at the registry API root.',
      { cause: err },
    )
  }

  const token = (data as { token?: unknown } | null)?.token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      `Token exchange response from ${url} did not contain a "token" field. ` +
        'Verify the `registry-url` input points at the expected registry and that its API contract matches this action.',
    )
  }

  return token
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function hintForStatus(status: number, registryUrl: string): string | null {
  if (status === 401 || status === 403) {
    return (
      `Hint: the registry rejected the OIDC token. ` +
      `Verify that ${registryUrl} is configured to trust this repository/org and the workflow's claims (repo, ref, environment).`
    )
  }
  if (status === 404) {
    return (
      `Hint: the token-exchange endpoint was not found. ` +
      `Verify the \`registry-url\` input (${registryUrl}) points at the registry API root, not a sub-path.`
    )
  }
  if (status === 429) {
    return 'Hint: the registry is rate-limiting this runner. Retry with backoff or contact the registry operator.'
  }
  if (status >= 500) {
    return 'Hint: the registry returned a server error. Retry shortly or check the registry status.'
  }
  return null
}
