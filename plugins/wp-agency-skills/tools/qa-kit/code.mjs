// qa-kit code <code folder> [--out <dir>]
//
// The QA "code" round: what a code reviewer looks for before a site goes to
// the client - secrets and .env files in git, npm audit, dependencies nothing
// imports, files nothing refers to, console.log, external links without
// rel="noopener", forms without validation or a honeypot, a missing CSP.
// Reads only git-tracked files; writes <out>/code-report.json.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  auditFindings, consoleLogs, externalLinkProblems, formProblems, secretFindings, trackedEnvFiles,
  unreferencedFiles, unusedDependencies,
} from './lib/code_checks.mjs'
import { summarize } from './lib/judge.mjs'

const TEXT = /\.(m?[jt]sx?|css|scss|html?|json|md|txt|svg|ya?ml|toml|env[\w.-]*|php|py|xml|pem|key)$|(^|\/)\.env[\w.-]*$/i
const SOURCE = /\.(m?[jt]sx?|css|scss|html?|php)$/i

function audit(folder) {
  if (!existsSync(join(folder, 'package-lock.json'))) return null
  // npm sits next to the node running us: the agent's shell may have no PATH to it.
  const cli = [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(existsSync)
  if (!cli) return null
  const done = spawnSync(process.execPath, [cli, 'audit', '--json', '--omit=dev'], { cwd: folder, encoding: 'utf8', timeout: 120000 })
  try { return JSON.parse(done.stdout) } catch { return null }
}

export function codeCheck(args) {
  if (!args[0] || args[0].startsWith('--')) throw new Error('usage: qa-kit code <code folder>')
  const folder = resolve(args[0])
  const i = args.indexOf('--out')
  const out = resolve(i >= 0 ? args[i + 1] : join(folder, 'test-results', 'qa-kit', 'code'))
  const tracked = execFileSync(process.env.QA_KIT_GIT || 'git', ['-C', folder, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  const texts = tracked
    .filter((p) => TEXT.test(p) && existsSync(join(folder, p)) && statSync(join(folder, p)).size < 1_000_000)
    .map((p) => ({ path: p, text: readFileSync(join(folder, p), 'utf8') }))
  const sources = texts.filter((t) => SOURCE.test(t.path) && !/(^|\/)dist\//.test(t.path))
  const pkg = existsSync(join(folder, 'package.json')) ? JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) : {}
  const configs = texts.filter((t) => /\.config\.|package\.json$/.test(t.path))
  const html = sources.filter((t) => /\.html?$|\.php$/.test(t.path))
  const findings = [
    ...secretFindings(texts),
    ...trackedEnvFiles(tracked),
    ...auditFindings(audit(folder)),
    ...unusedDependencies(pkg, [...sources, ...configs]),
    ...unreferencedFiles(tracked.filter((p) => !/(^|\/)dist\//.test(p)), [...sources, ...configs]),
    ...consoleLogs(sources.filter((t) => /\.m?[jt]sx?$/.test(t.path) && !/\.config\./.test(t.path))),
    ...externalLinkProblems(html),
    ...formProblems(html),
  ]
  if (html.length && !html.some((t) => /Content-Security-Policy/i.test(t.text))) {
    findings.push({ check: 'csp', level: 'info', file: null, line: null,
      message: 'no Content-Security-Policy in the pages (the hosting can add it as a header; name it for the handover)' })
  }
  const report = {
    folder, files_checked: texts.length, summary: summarize(findings), findings,
    note: 'fail = must be fixed before delivery, warn = worth a look, info = for the handover. Read the code yourself too.',
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'code-report.json'), JSON.stringify(report, null, 2))
  return { ...report, out }
}
