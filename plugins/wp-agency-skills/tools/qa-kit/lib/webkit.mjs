// WebKit that cannot start on this machine is remembered: every try
// makes Windows Smart App Control show its blocked-file pop-up again.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

export function blockedWebkit(memo) {
  if (!existsSync(memo)) return null
  try { return JSON.parse(readFileSync(memo, 'utf8')) } catch { return null }
}

export function rememberWebkit(memo, reason) {
  writeFileSync(memo, JSON.stringify({ reason, since: new Date().toISOString().slice(0, 10) }, null, 2))
}

export function forgetWebkit(memo) {
  rmSync(memo, { force: true })
}
