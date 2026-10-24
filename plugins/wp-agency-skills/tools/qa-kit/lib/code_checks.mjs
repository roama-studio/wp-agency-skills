// Pure checks of a project's source texts for the QA "code" mode: no git, no npm.
// Each takes [{ path, text }] (or names) and returns findings
// { check, level, file, line, message } - a secret's value is never repeated.

function finding(check, level, file, message, line = null) {
  return { check, level, file, line, message }
}

const SECRETS = [
  ['an Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI-style secret key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['a Stripe secret key', /\b[sr]k_live_[A-Za-z0-9]{20,}\b/],
  ['a Telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ['a private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
]

const lineOf = (text, index) => text.slice(0, index).split('\n').length

export function secretFindings(files) {
  const out = []
  for (const { path, text } of files) {
    for (const [name, pattern] of SECRETS) {
      const match = pattern.exec(text)
      if (match) {
        out.push(finding('secret', 'fail', path, `${name} is committed in the repository (move it out of git)`,
          lineOf(text, match.index)))
        break
      }
    }
  }
  return out
}

export function trackedEnvFiles(paths) {
  return paths
    .filter((p) => /(^|\/)\.env(\.[\w-]+)?$/.test(p) && !/\.(example|sample|template)$/.test(p))
    .map((p) => finding('env_file', 'fail', p, 'an environment file is tracked by git'))
}

// Tools a project uses from the command line or its config, not by import.
const TOOLING = new Set(['vite', 'playwright', '@playwright/test', 'prettier', 'eslint', 'oxlint', 'vitest',
  'typescript', 'sass', 'postcss', 'autoprefixer', 'serve', 'http-server', 'npm-run-all', 'concurrently'])

export function unusedDependencies(pkg, sources) {
  // package.json names every dependency itself: only real imports and configs count.
  const all = sources.filter((s) => !/(^|\/)package(-lock)?\.json$/.test(s.path)).map((s) => s.text).join('\n')
  const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
  return names
    .filter((name) => !TOOLING.has(name) && !name.startsWith('@types/'))
    .filter((name) => {
      const quoted = new RegExp(`['"\`]${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(/[^'"\`]*)?['"\`]`)
      return !quoted.test(all)
    })
    .map((name) => finding('unused_dependency', 'warn', 'package.json', `${name} is a dependency but nothing imports it`))
}

const CODE = /\.(m?js|ts|css|html|svg|png|jpe?g|webp|avif|gif|woff2?|glb|mp4|webm)$/i
const ROOT_FILES = /^(index\.html|[^/]+\.config\.[mc]?[jt]s|package(-lock)?\.json|README\.md)$/

export function unreferencedFiles(files, texts) {
  const all = texts.map((t) => t.text).join('\n')
  return files
    .filter((f) => CODE.test(f) && !ROOT_FILES.test(f) && !/(^|\/)(tests?|test-results|scripts)\//.test(f))
    .filter((f) => !f.endsWith('.html') || f.includes('/'))
    .filter((f) => {
      const name = f.split('/').pop()
      const served = f.replace(/^public\//, '')
      return !all.includes(name) && !all.includes(served)
    })
    .map((f) => finding('unreferenced_file', 'warn', f, 'no other file refers to it (dead code or a leftover asset)'))
}

export function consoleLogs(files) {
  const out = []
  for (const { path, text } of files) {
    if (/(^|\/)(tests?|scripts)\/|\.(spec|test)\./.test(path)) continue
    text.split('\n').forEach((line, i) => {
      if (/\bconsole\.(log|debug)\(/.test(line)) {
        out.push(finding('console_log', 'warn', path, 'console.log left in shipped code', i + 1))
      }
    })
  }
  return out
}

export function externalLinkProblems(files) {
  const out = []
  for (const { path, text } of files) {
    for (const match of text.matchAll(/<a\b[^>]*>/gi)) {
      const tag = match[0]
      const href = /href=["']([^"']+)/i.exec(tag)?.[1] ?? ''
      if (!/target=["']_blank/i.test(tag) || !/^https?:/i.test(href)) continue
      if (!/rel=["'][^"']*noopener/i.test(tag)) {
        out.push(finding('external_link', 'warn', path, `${href} opens a new tab without rel="noopener"`,
          lineOf(text, match.index)))
      }
    }
  }
  return out
}

export function formProblems(files) {
  const out = []
  for (const { path, text } of files) {
    for (const match of text.matchAll(/<form\b[\s\S]*?<\/form>/gi)) {
      const form = match[0]
      const line = lineOf(text, match.index)
      if (!/\brequired\b|aria-required|pattern=/i.test(form)) {
        out.push(finding('form_validation', 'warn', path, 'a form has no required fields (no validation in the page)', line))
      }
      if (!/tabindex=["']-1["'][^>]*autocomplete=["']off|autocomplete=["']off["'][^>]*tabindex=["']-1|honeypot|class=["'][^"']*\bhp\b/i.test(form)) {
        out.push(finding('form_honeypot', 'warn', path, 'a form has no honeypot field against spam bots', line))
      }
    }
  }
  return out
}

export function auditFindings(audit) {
  if (!audit || !audit.metadata) {
    return [finding('npm_audit', 'info', 'package.json', 'npm audit did not run (no lock file or no network)')]
  }
  const v = audit.metadata.vulnerabilities ?? {}
  const out = []
  if ((v.critical ?? 0) + (v.high ?? 0) > 0) {
    out.push(finding('npm_audit', 'fail', 'package.json', `${v.critical ?? 0} critical and ${v.high ?? 0} high vulnerabilities (npm audit)`))
  }
  if ((v.moderate ?? 0) > 0) {
    out.push(finding('npm_audit', 'warn', 'package.json', `${v.moderate} moderate vulnerabilities (npm audit)`))
  }
  return out
}
