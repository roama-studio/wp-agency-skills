// qa-kit wp-site import|start|stop|health|wp|compare
//
// A copy of a client's WordPress site (its files + a MySQL dump) as a local site in
// WordPress Playground on SQLite, for the engine's agents to edit and check:
//   import  copies the files into <site>/wordpress (without the client's wp-config,
//           caches, backups and database drop-ins), writes our wp-config, imports the
//           dump through Playground's SQLite translator, replaces the live address
//           with http://127.0.0.1:<port> (also serialized and JSON-escaped), and
//           writes <site>/site.json (what was imported, what failed, the admin login).
//   start   serves the site on its port in the background; stop kills it by its pid
//           and by whatever listens on the port, then checks the port is quiet.
//   health  home page 200 without PHP errors, wp-admin reachable through Playground's
//           auto-login (no password), no PHP fatal errors in <site>/wp-log/debug.log.
//   wp      WP-CLI on the site (works while it is served): qa-kit wp-site wp <site> <args>
//   compare the original site against the edited one with the `qa-kit original`
//           machinery: pages from the sitemaps and the menu, 8 widths, masks, JPGs.
// The client's live site is never touched: everything happens in the site folder.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request as playwrightRequest } from 'playwright'
import { compareVersions } from './original.mjs'
import { unzipCommand } from './lib/bridge.mjs'
import { debugLogFindings, hiddenSpawnOptions, htmlPhpErrors, playgroundCommand } from './lib/wp.mjs'
import { summarize, pagesFrom } from './lib/judge.mjs'
import {
  configPrefix, dumpFacts, hiddenLauncherVbs, importable, listenerPids, sitemapLocs, skipCopy, splitSql, urlReplacements, wpConfigText, wpSiteOptions,
} from './lib/wpsite.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const rules = JSON.parse(readFileSync(join(here, 'rules.json'), 'utf8'))
const TOOLS = join(here, '.cache', 'wp-site')
const WP_CLI_URL = 'https://playground.wordpress.net/wp-cli.phar' // the one Playground's own wp-cli step uses
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const NOISE = /^(lockWholeFile: unlock failed|WordPress Playground CLI|PHP \d|Extensions |Mount |\s*$)/

const paths = (site) => ({
  root: site, wordpress: join(site, 'wordpress'), log: join(site, 'wp-log'), imports: join(site, 'import'),
  state: join(site, 'site.json'), server: join(site, 'server.log'),
})

function readState(site) {
  const file = paths(site).state
  if (!existsSync(file)) throw new Error(`${site} is not a qa-kit wp-site folder (no site.json): run qa-kit wp-site import first`)
  return JSON.parse(readFileSync(file, 'utf8'))
}
const writeState = (site, state) => writeFileSync(paths(site).state, JSON.stringify(state, null, 2))

async function answers(url, ms = 2000) {
  try { await fetch(url, { signal: AbortSignal.timeout(ms) }); return true } catch { return false }
}

function portListeners(port) {
  if (process.platform !== 'win32') return []
  const netstat = (proto) => spawnSync('netstat', ['-ano', '-p', proto], { encoding: 'latin1', windowsHide: true }).stdout ?? ''
  return [...new Set([...listenerPids(netstat('TCP'), port), ...listenerPids(netstat('TCPv6'), port)])]
}

// Something serves the port: a listener (the first WordPress request after a start can
// take longer than a quick probe), else an answer within 15 s.
async function serving(port) {
  return portListeners(port).length > 0 || answers(`http://127.0.0.1:${port}/`, 15000)
}

async function tools() {
  mkdirSync(TOOLS, { recursive: true })
  for (const f of ['wp-site-import.php', 'wp-site-cli.php']) copyFileSync(join(here, 'lib', f), join(TOOLS, f))
  const phar = join(TOOLS, 'wp-cli.phar')
  if (!existsSync(phar)) {
    const r = await fetch(WP_CLI_URL)
    if (!r.ok) throw new Error(`could not download WP-CLI from ${WP_CLI_URL}: HTTP ${r.status}`)
    writeFileSync(phar, Buffer.from(await r.arrayBuffer()))
  }
  return TOOLS
}

const mounts = (p, extra = []) => [
  '--mount-dir', p.wordpress, '/wordpress', '--mount-dir', p.log, '/qa-log', '--mount-dir', TOOLS, '/qa-tools', ...extra,
]

// One PHP script in Playground on the site's files (no server): WP-CLI or our import.
function runPhp(site, state, script, { extra = [], live = false } = {}) {
  const p = paths(site)
  return runPlayground(['php', `--php=${state.php}`, `--site-url=${state.url}`, ...mounts(p, extra),
    '--wordpress-install-mode=do-not-attempt-installing', '--', ...script], { live })
}

// The first boot: Playground creates the SQLite database (wp-content/database) and
// installs WordPress from the copied files; only `run-blueprint` and `server` do that.
function firstBoot(site, state) {
  const p = paths(site)
  const empty = join(TOOLS, 'empty-blueprint.json')
  writeFileSync(empty, JSON.stringify({ steps: [] }))
  return runPlayground(['run-blueprint', `--php=${state.php}`, `--site-url=${state.url}`,
    '--mount-dir-before-install', p.wordpress, '/wordpress', '--mount-dir-before-install', p.log, '/qa-log',
    '--wordpress-install-mode=install-from-existing-files-if-needed', `--blueprint=${empty}`])
}

function runPlayground(command, { live = false } = {}) {
  const cli = playgroundCommand(command)
  return new Promise((resolve, reject) => {
    const child = spawn(cli.file, cli.args, hiddenSpawnOptions({ env: { ...process.env, MSYS_NO_PATHCONV: '1' } }))
    let out = ''
    const take = (chunk) => {
      const text = chunk.toString()
      out += text
      if (live) for (const line of text.split(/\r?\n/)) if (line && !NOISE.test(line)) console.log(line)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, out: out.split(/\r?\n/).filter((l) => !NOISE.test(l)).join('\n') }))
  })
}

// A copy's SQLite file in WAL mode answers every WordPress query with "database is
// locked" inside Playground (WAL needs shared memory the WebAssembly file system does
// not give; seen once after a killed server). node:sqlite (built in, no dependency)
// switches it back to the rollback journal before WP-CLI or the server opens it.
export function journalGuard(site) {
  const db = join(paths(site).wordpress, 'wp-content', 'database', '.ht.sqlite')
  if (!existsSync(db)) return null
  const conn = new DatabaseSync(db)
  try {
    const mode = conn.prepare('PRAGMA journal_mode').get().journal_mode
    if (String(mode).toLowerCase() !== 'wal') return mode
    conn.prepare('PRAGMA journal_mode = DELETE').get()
    console.error('qa-kit: the database of the copy was in WAL mode: switched back to DELETE')
    return 'wal->delete'
  } finally {
    conn.close()
  }
}

// WP-CLI on the site. The arguments go through a JSON file (lib/wp-site-cli.php):
// Playground's `php` command would turn every numeric argument into an empty string.
async function wpCli(site, state, args, opts = {}) {
  const p = paths(site)
  mkdirSync(p.imports, { recursive: true })
  journalGuard(site)
  const name = `wp-args-${randomBytes(6).toString('hex')}.json`
  writeFileSync(join(p.imports, name), JSON.stringify(['--path=/wordpress', ...args.map(String)]))
  try {
    return await runPhp(site, state, ['/qa-tools/wp-site-cli.php', `/qa-import/${name}`],
      { ...opts, extra: [...(opts.extra ?? []), '--mount-dir', p.imports, '/qa-import'] })
  } finally {
    rmSync(join(p.imports, name), { force: true })
  }
}

function wordpressRoot(source) {
  for (const sub of ['', 'files', 'public', 'public_html', 'www', join('app', 'public')]) {
    const dir = join(source, sub)
    if (existsSync(join(dir, 'wp-includes', 'version.php'))) return dir
  }
  throw new Error(`${source} has no WordPress files (wp-includes/version.php) at its root or in files/, public/, public_html/, www/`)
}

function findDump(source, sql) {
  if (sql) {
    if (!existsSync(sql)) throw new Error(`the dump ${sql} does not exist`)
    return sql
  }
  const found = readdirSync(source).filter((n) => n.toLowerCase().endsWith('.sql')).map((n) => join(source, n))
  if (found.length !== 1) throw new Error(`${found.length ? 'several' : 'no'} .sql files at the root of ${source}: name the dump with --sql`)
  return found[0]
}

// The export plugin's archive (files/ + database.sql + export.json) is
// unpacked into <site>/source first; the import then reads that folder.
function unpackArchive(zip, site) {
  const dir = join(site, 'source')
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const cmd = unzipCommand(zip, dir)
  const r = spawnSync(cmd.file, cmd.args, { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`could not unpack ${zip}: ${(r.stderr || r.error?.message || '').slice(0, 500)}`)
  return dir
}

export async function importSite(o) {
  const p = paths(o.site)
  if (existsSync(p.state)) throw new Error(`${o.site} already holds an imported site: import into a new folder`)
  if (await serving(o.port)) throw new Error(`port ${o.port} is busy: pass another --port`)
  if (/\.zip$/i.test(o.source) && statSync(o.source).isFile()) {
    console.log(`unpacking ${o.source}`)
    o = { ...o, archive: o.source, source: unpackArchive(o.source, o.site) }
  }
  const from = wordpressRoot(o.source)
  const dump = findDump(o.source, o.sql)
  const sql = readFileSync(dump, 'utf8')
  const facts = dumpFacts(sql)
  const clientConfig = join(from, 'wp-config.php')
  const cfgPrefix = existsSync(clientConfig) ? configPrefix(readFileSync(clientConfig, 'utf8')) : null
  const prefix = facts.prefix ?? cfgPrefix ?? 'wp_'
  const notes = []
  if (cfgPrefix && facts.prefix && cfgPrefix !== facts.prefix) notes.push(`wp-config prefix ${cfgPrefix} differs from the dump's ${facts.prefix}: the dump's is used`)
  if (!facts.siteurl) notes.push('no siteurl in the dump: the live address was not replaced')

  const skipped = []
  mkdirSync(p.log, { recursive: true })
  mkdirSync(p.imports, { recursive: true })
  console.log(`copying ${from} -> ${p.wordpress}`)
  cpSync(from, p.wordpress, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src)
      if (rel && skipCopy(rel)) { skipped.push(rel.replace(/\\/g, '/')); return false }
      return true
    },
  })
  writeFileSync(join(p.wordpress, 'wp-config.php'), wpConfigText({ prefix }))

  const all = splitSql(sql)
  const statements = all.filter(importable)
  const left = all.filter((s) => !importable(s)).map((s) => s.split(/\s+/).slice(0, 2).join(' ').toUpperCase())
  const leftKinds = Object.fromEntries([...new Set(left)].map((k) => [k, left.filter((x) => x === k).length]))
  writeFileSync(join(p.imports, 'statements.json'), JSON.stringify(statements))

  const url = `http://127.0.0.1:${o.port}`
  const state = { tool: 'qa-kit wp-site', source: o.source, archive: o.archive ?? null, wordpress_from: from, dump, url, port: o.port, php: o.php, prefix,
    live: { siteurl: facts.siteurl, home: facts.home }, imported_at: new Date().toISOString(), notes, skipped_copy: skipped }
  writeState(o.site, state)
  await tools()

  const boot = await firstBoot(o.site, state)
  if (!existsSync(join(p.wordpress, 'wp-content', 'database', '.ht.sqlite'))) {
    throw new Error(`Playground did not create the SQLite database (exit ${boot.code}):
${boot.out.slice(-2000)}`)
  }
  console.log(`importing ${statements.length} statements through the SQLite translator`)
  const imported = await runPhp(o.site, state, ['/qa-tools/wp-site-import.php', '/qa-import/statements.json'],
    { extra: ['--mount-dir', p.imports, '/qa-import'] })
  const line = imported.out.split('\n').reverse().find((l) => l.startsWith('{'))
  if (!line) throw new Error(`the import printed no result (exit ${imported.code}):\n${imported.out.slice(-2000)}`)
  state.import = { ...JSON.parse(line), statements: statements.length, left_out: leftKinds }

  // Only the address forms that really occur in the dump (each WP-CLI run boots PHP).
  state.replacements = []
  for (const [a, b] of urlReplacements([facts.siteurl, facts.home], url)) {
    if (!sql.includes(a)) continue
    const r = await wpCli(o.site, state, ['search-replace', a, b, '--all-tables', '--precise', '--format=count'])
    state.replacements.push({ from: a, to: b, count: Number(r.out.trim().split('\n').pop()) || 0 })
  }
  const admins = await wpCli(o.site, state, ['user', 'list', '--role=administrator', '--field=user_login', '--orderby=ID'])
  state.admin = admins.out.trim().split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? null
  const theme = await wpCli(o.site, state, ['option', 'get', 'stylesheet'])
  state.theme = theme.out.trim().split('\n').pop() || null
  const plugins = await wpCli(o.site, state, ['plugin', 'list', '--status=active', '--field=name'])
  state.plugins = plugins.out.trim().split('\n').map((s) => s.trim()).filter((s) => /^[\w.-]+$/.test(s))
  state.wp = readFileSync(join(p.wordpress, 'wp-includes', 'version.php'), 'utf8').match(/\$wp_version\s*=\s*'([^']+)'/)?.[1] ?? null
  if (!state.admin) notes.push('no administrator found: the wp-admin auto-login will not work')
  writeState(o.site, state)
  return state
}

export async function startSite(site, { quiet = false } = {}) {
  const state = readState(site)
  const p = paths(site)
  if (await serving(state.port)) return { ...state, already: true }
  journalGuard(site)
  const args = ['server', `--port=${state.port}`, `--php=${state.php}`, `--site-url=${state.url}`,
    '--mount-dir-before-install', p.wordpress, '/wordpress', '--mount-dir-before-install', p.log, '/qa-log',
    '--wordpress-install-mode=do-not-attempt-installing', '--define-bool', 'PLAYGROUND_FORCE_AUTO_LOGIN_ENABLED', 'true']
  const cli = playgroundCommand(args)
  writeFileSync(p.server, '')
  let child = null
  if (process.platform === 'win32') {
    const vbs = join(site, 'start-server.vbs')
    writeFileSync(vbs, hiddenLauncherVbs(cli.file, cli.args, p.server))
    // wscript is a windowless program: detached only lets it outlive qa-kit, no console appears.
    spawn('wscript.exe', ['//B', '//Nologo', vbs], { detached: true, windowsHide: true, stdio: 'ignore' }).unref()
  } else {
    const fd = openSync(p.server, 'a')
    child = spawn(cli.file, cli.args, { ...hiddenSpawnOptions({ stdio: ['ignore', fd, fd] }), detached: true })
    child.unref()
    closeSync(fd)
  }
  const until = Date.now() + rules.wp.start_timeout_s * 1000
  for (;;) {
    const log = existsSync(p.server) ? readFileSync(p.server, 'utf8') : ''
    if (/Ready!/.test(log)) break
    if (/^Error/m.test(log) || child?.exitCode != null || Date.now() > until) throw new Error(`Playground did not start (see ${p.server})`)
    await sleep(500)
  }
  await answers(`${state.url}/`, 60000) // the first request boots WordPress in every worker: slow
  state.server = { pid: child?.pid ?? portListeners(state.port)[0] ?? null, started_at: new Date().toISOString() }
  writeState(site, state)
  if (!quiet) console.log(`serving ${state.url}/ (admin: ${adminUrl(state)})`)
  return state
}

export const adminUrl = (state) => `${state.url}/wp-admin/?playground_force_auto_login_as_user=${encodeURIComponent(state.admin ?? 'admin')}`

export async function stopSite(site) {
  const state = readState(site)
  const kill = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  if (process.platform === 'win32') {
    if (state.server?.pid) kill(state.server.pid)
    // The launcher's cmd and Playground's main node have this site's folder in their
    // command line; the listener (Playground's worker) is caught by the port below.
    const path = paths(site).wordpress.replace(/'/g, "''")
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${path}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
    { windowsHide: true })
    for (let i = 0; i < 10; i++) {
      const pids = portListeners(state.port)
      if (!pids.length) break
      pids.forEach(kill)
      await sleep(500)
    }
  } else if (state.server?.pid) {
    try { process.kill(-state.server.pid, 'SIGTERM') } catch { /* gone */ }
  }
  for (let i = 0; i < 20 && (await answers(`${state.url}/`)); i++) await sleep(500)
  const stopped = !portListeners(state.port).length && !(await answers(`${state.url}/`))
  delete state.server
  writeState(site, state)
  return { stopped, url: state.url }
}

export async function healthSite(site) {
  const state = readState(site)
  const p = paths(site)
  const findings = []
  const f = (check, level, page, message) => ({ check, level, page, width: null, browser: null, screenshot: null, file: null, line: null, message })
  const req = await playwrightRequest.newContext()
  try {
    const home = await req.get(`${state.url}/`, { timeout: 60000 })
    if (home.status() !== 200) findings.push(f('home_status', 'fail', '/', `the home page answers HTTP ${home.status()}`))
    for (const e of htmlPhpErrors(await home.text())) findings.push(f('php_error_on_page', 'fail', '/', e))
    const admin = await req.get(adminUrl(state), { timeout: 60000 })
    const html = await admin.text()
    if (admin.status() >= 400) findings.push(f('admin_status', 'fail', '/wp-admin/', `wp-admin answers HTTP ${admin.status()}`))
    else if (/wp-login\.php/.test(admin.url()) || !/id="wpadminbar"|class="wp-admin/.test(html)) {
      findings.push(f('admin_login', 'fail', '/wp-admin/', `the auto-login as "${state.admin}" did not reach wp-admin`))
    }
    for (const e of htmlPhpErrors(html)) findings.push(f('admin_php_error', 'fail', '/wp-admin/', e))
  } finally {
    await req.dispose()
  }
  const debug = join(p.log, 'debug.log')
  if (existsSync(debug)) {
    for (const d of debugLogFindings(readFileSync(debug, 'utf8'), state.theme ?? '-')) {
      // A fatal anywhere breaks the copy; warnings of plugins stay info for the agents to read.
      findings.push(/php_(fatal|parse)/.test(d.check) ? { ...d, level: 'fail' } : d)
    }
  }
  return { url: state.url, admin: adminUrl(state), findings, summary: summarize(findings) }
}

// The pages to compare: every page in both sites' sitemaps and the home page's links.
async function sitePages(url) {
  const pages = new Set(['/'])
  const todo = [`${url}/wp-sitemap.xml`]
  for (let i = 0; i < todo.length && i < 30; i++) {
    const r = await fetch(todo[i]).catch(() => null)
    if (!r?.ok) continue
    const locs = sitemapLocs(await r.text())
    todo.push(...locs.sitemaps.filter((s) => !/-users-\d+\.xml$/.test(s)))
    for (const loc of locs.pages) { try { const u = new URL(loc); if (u.origin === url) pages.add(u.pathname + u.search) } catch { /* not a URL */ } }
  }
  const home = await fetch(`${url}/`).catch(() => null)
  if (home?.ok) {
    const hrefs = [...(await home.text()).matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'))
    for (const path of pagesFrom(`${url}/`, hrefs)) if (!/^\/(wp-|feed|comments\/feed)|\/feed\/$|\?/.test(path)) pages.add(path)
  }
  return [...pages]
}

export async function compareSites(o) {
  const a = readState(o.site)
  const b = readState(o.other)
  if (a.port === b.port) throw new Error(`both sites use port ${a.port}: import the edited copy with another --port`)
  const started = []
  const report = { tool: 'qa-kit wp-site compare', original: o.site, edited: o.other }
  try {
    for (const site of [o.site, o.other]) {
      const s = readState(site)
      if (!(await serving(s.port))) { await startSite(site, { quiet: true }); started.push(site) }
    }
    const [pa, pb] = await Promise.all([sitePages(a.url), sitePages(b.url)])
    const pages = o.pages ?? [...new Set([...pa, ...pb])].filter((p) => !p.startsWith('/wp-'))
    const opt = { widths: o.widths ?? rules.original.widths, masks: ['canvas', 'video', 'iframe', '[data-qa-mask]', '#wpadminbar',
      ...(rules.original.mask_selectors ?? []), ...o.mask], pages, expect: o.expect, out: o.out, folder: o.other,
    noStartPage: `${b.url}/ did not answer: is the edited site running?` }
    mkdirSync(o.out, { recursive: true })
    Object.assign(report, { widths: opt.widths, masks: opt.masks }, await compareVersions({ url: `${a.url}/` }, { url: `${b.url}/` }, opt))
  } finally {
    for (const site of started) await stopSite(site)
    report.servers_started_and_stopped = started.length
    mkdirSync(o.out, { recursive: true })
    writeFileSync(join(o.out, 'wp-site-compare-report.json'), JSON.stringify(report, null, 2))
  }
  return { ...report, out: o.out }
}

// WP-CLI on a copy for other tools (qa-kit bridge): extra mounts, the output returned.
export async function siteWpCli(site, args, { extra = [] } = {}) {
  await tools()
  return wpCli(site, readState(site), args, { extra })
}

export const siteState = (site) => readState(site)
export const siteImportDir = (site) => paths(site).imports

export async function wpSite(args) {
  const o = wpSiteOptions(args)
  if (o.command === 'import') return { command: o.command, state: await importSite(o) }
  if (o.command === 'start') return { command: o.command, state: await startSite(o.site) }
  if (o.command === 'stop') return { command: o.command, ...(await stopSite(o.site)) }
  if (o.command === 'health') return { command: o.command, ...(await healthSite(o.site)) }
  if (o.command === 'compare') return { command: o.command, report: await compareSites(o) }
  await tools()
  const r = await wpCli(o.site, readState(o.site), o.wpArgs, { live: true })
  return { command: o.command, code: r.code }
}
