import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@actions/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from './main.js'

const REGISTRY_URL = 'https://registry.example.test'
const NPM_HOST = 'npm.registry.example.test'
const OIDC_TOKEN = 'oidc-token-abc'
const REGISTRY_TOKEN = 'registry-token-xyz'

function mockInputs(npmrcPath: string) {
  vi.spyOn(core, 'getInput').mockImplementation((name: string) => {
    switch (name) {
      case 'registry-url':
        return REGISTRY_URL
      case 'npm-registry-host':
        return NPM_HOST
      case 'npmrc-path':
        return npmrcPath
      default:
        return ''
    }
  })
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('run', () => {
  let tempDir: string
  let npmrcPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'registry-login-'))
    npmrcPath = join(tempDir, '.npmrc')
    mockInputs(npmrcPath)
    vi.spyOn(core, 'getIDToken').mockResolvedValue(OIDC_TOKEN)
    vi.spyOn(core, 'setSecret').mockImplementation(() => {})
    vi.spyOn(core, 'setOutput').mockImplementation(() => {})
    vi.spyOn(core, 'warning').mockImplementation(() => {})
  })

  // No-op sleep so retry tests don't actually wait on backoff delays.
  const noWait = { retry: { sleep: async () => {} } }

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('exchanges the OIDC token and writes the npmrc entry', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { token: REGISTRY_TOKEN }))

    await run()

    expect(fetchMock).toHaveBeenCalledWith(
      `${REGISTRY_URL}/api/v1/tokens/exchange`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          token: OIDC_TOKEN,
          provider: 'github-actions',
        }),
      }),
    )
    expect(core.setSecret).toHaveBeenCalledWith(REGISTRY_TOKEN)
    expect(core.setOutput).toHaveBeenCalledWith('token', REGISTRY_TOKEN)

    const contents = await readFile(npmrcPath, 'utf8')
    expect(contents).toBe(`//${NPM_HOST}/:_authToken=${REGISTRY_TOKEN}\n`)
  })

  it('points to the id-token permission when the OIDC env var is missing', async () => {
    vi.spyOn(core, 'getIDToken').mockRejectedValue(
      new Error('Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable'),
    )
    vi.spyOn(globalThis, 'fetch')

    await expect(run()).rejects.toThrow(/id-token: write/)
  })

  it('wraps other OIDC failures with the audience', async () => {
    vi.spyOn(core, 'getIDToken').mockRejectedValue(new Error('OIDC boom'))
    vi.spyOn(globalThis, 'fetch')

    const err = await run().catch((e: Error) => e)
    expect(err.message).toMatch(/Failed to obtain a GitHub OIDC token/)
    expect(err.message).toContain(REGISTRY_URL)
    expect((err as Error & { cause?: Error }).cause).toMatchObject({
      message: 'OIDC boom',
    })
  })

  it('explains network failures reaching the exchange endpoint', async () => {
    const cause = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(
        new Error('getaddrinfo ENOTFOUND registry.example.test'),
        { code: 'ENOTFOUND' },
      ),
    })
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(cause)

    const err = await run(noWait).catch((e: Error) => e)
    expect(err.message).toMatch(/Could not reach the registry token-exchange/)
    expect(err.message).toContain(`${REGISTRY_URL}/api/v1/tokens/exchange`)
    expect(err.message).toMatch(/DNS, firewall/)
    expect((err as Error & { cause?: Error }).cause).toBe(cause)
  })

  it('includes status, URL, and a hint when the exchange returns 403', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    )

    const err = await run().catch((e: Error) => e)
    expect(err.message).toMatch(/Token exchange failed: 403 Forbidden/)
    expect(err.message).toContain(`POST ${REGISTRY_URL}/api/v1/tokens/exchange`)
    expect(err.message).toContain('Response body: forbidden')
    expect(err.message).toMatch(/configured to trust this repository/)
  })

  it('hints about the URL path when the exchange returns 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 404, statusText: 'Not Found' }),
    )

    await expect(run()).rejects.toThrow(/registry API root, not a sub-path/)
  })

  it('hints about rate limiting on 429 after exhausting retries', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('', { status: 429, statusText: 'Too Many Requests' }),
      )

    await expect(run(noWait)).rejects.toThrow(/rate-limiting/)
    // initial attempt + 3 retries
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('hints about a server error on 5xx after exhausting retries', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('boom', {
        status: 503,
        statusText: 'Service Unavailable',
      }),
    )

    await expect(run(noWait)).rejects.toThrow(
      /registry returned a server error/,
    )
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('retries transient failures and succeeds', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('boom', {
          status: 503,
          statusText: 'Service Unavailable',
        }),
      )
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, { token: REGISTRY_TOKEN }))

    await run(noWait)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(core.setOutput).toHaveBeenCalledWith('token', REGISTRY_TOKEN)

    const contents = await readFile(npmrcPath, 'utf8')
    expect(contents).toBe(`//${NPM_HOST}/:_authToken=${REGISTRY_TOKEN}\n`)
  })

  it('does not retry non-transient failures (403)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
      )

    await expect(run(noWait)).rejects.toThrow(/Token exchange failed: 403/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('flags a non-JSON exchange response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>nope</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    )

    await expect(run()).rejects.toThrow(/returned a non-JSON response/)
  })

  it('flags a missing token field with the URL and a hint', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {}))

    const err = await run().catch((e: Error) => e)
    expect(err.message).toMatch(/did not contain a "token" field/)
    expect(err.message).toContain(`${REGISTRY_URL}/api/v1/tokens/exchange`)
  })

  it('flags an empty token value', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { token: '' }),
    )

    await expect(run()).rejects.toThrow(/did not contain a "token" field/)
  })
})
