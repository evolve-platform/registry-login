import { appendFile } from 'node:fs/promises'
import * as core from '@actions/core'

export async function run(): Promise<void> {
  const registryUrl = core.getInput('registry-url', { required: true })
  const npmRegistryHost = core.getInput('npm-registry-host', { required: true })
  const npmrcPath = core.getInput('npmrc-path', { required: true })

  const oidcToken = await core.getIDToken(registryUrl)

  const token = await exchangeToken(registryUrl, oidcToken)

  core.setSecret(token)
  core.setOutput('token', token)

  await appendFile(npmrcPath, `//${npmRegistryHost}/:_authToken=${token}\n`)
}

async function exchangeToken(
  registryUrl: string,
  oidcToken: string,
): Promise<string> {
  const url = `${registryUrl.replace(/\/$/, '')}/api/v1/tokens/exchange`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: oidcToken, provider: 'github-actions' }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Token exchange failed: ${response.status} ${response.statusText} — ${body}`,
    )
  }

  const data = (await response.json()) as { token?: unknown }
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw new Error('Token exchange response did not contain a token')
  }

  return data.token
}
