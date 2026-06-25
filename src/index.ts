import * as core from '@actions/core'
import { run } from './main.js'

run().catch((err: unknown) => {
  core.setFailed(formatError(err))
})

function formatError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const lines: string[] = [err.message]
  let cause: unknown = (err as { cause?: unknown }).cause
  while (cause instanceof Error) {
    const code = (cause as { code?: string }).code
    lines.push(
      code
        ? `  caused by: ${cause.message} [${code}]`
        : `  caused by: ${cause.message}`,
    )
    cause = (cause as { cause?: unknown }).cause
  }
  return lines.join('\n')
}
