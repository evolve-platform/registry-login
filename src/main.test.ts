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
  })

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

  it('throws when the OIDC request fails', async () => {
    vi.spyOn(core, 'getIDToken').mockRejectedValue(new Error('OIDC boom'))
    vi.spyOn(globalThis, 'fetch')

    await expect(run()).rejects.toThrow('OIDC boom')
  })

  it('throws when the exchange endpoint returns non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    )

    await expect(run()).rejects.toThrow(/Token exchange failed: 403/)
  })

  it('throws when the exchange response is missing the token field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {}))

    await expect(run()).rejects.toThrow(/did not contain a token/)
  })

  it('throws when the exchange response token is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { token: '' }),
    )

    await expect(run()).rejects.toThrow(/did not contain a token/)
  })
})
