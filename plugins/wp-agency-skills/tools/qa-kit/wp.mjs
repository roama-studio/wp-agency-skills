// qa-kit wp <project folder> --theme <theme folder> [--plugins a,b|none] [--wp-cli "<cmd>"]...
//           [--pages menyu/,about/] [--php 8.3] [--wp latest] [--port 9400] [--round N] [--no-stress]
//
// Runs a classic theme in a throwaway WordPress Playground: a COPY of the
// theme is mounted (the project's files are never touched), our base plugins are
// installed from wordpress.org, the setup commands run (e.g. the theme's importer),
// then it measures: PHP syntax of every theme file, the theme's must-haves, SCF text
// fields without a limit, every page (and one of each post type) at 360..1440 for
// PHP errors, console errors, horizontal overflow and text outside the screen, a
// missing page (404), internal links, the admin screens the client will use, and
// a second pass after the client's worst case (every filled SCF text at its limit,
// +3 long menu items). PHP warnings of the whole run come from debug.log.
// Writes <out>/wp-report.json and JPG screenshots; stops the server at the end.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { merge, overflowFinding, summarize } from './lib/judge.mjs'
import {
  blueprint, debugLogFindings, fieldFindings, hiddenSpawnOptions, htmlPhpErrors, lintFindings, playgroundCommand, themeFileFindings, wpOptions,
} from './lib/wp.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const rules = JSON.parse(readFileSync(join(here, 'rules.json'), 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MISSING = '/qa-kit-no-such-page/'

function finding(check, level, where, message) {
  return { check, level, page: where.page ?? null, width: where.width ?? null, browser: 'chromium',
    screenshot: where.screenshot ?? null, file: null, line: null, message }
}

function themeFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) { if (!['node_modules', '.git', 'import'].includes(name)) walk(full); continue }
      const path = relative(root, full).replace(/\\/g, '/')
      out.push({ path, text: /\.(php|css)$/.test(name) ? readFileSync(full, 'utf8') : '' })
    }
  }
  walk(root)
  return out
}

function startServer(o, files, log) {
  const args = ['server', `--port=${o.port}`, `--php=${o.php}`, `--wp=${o.wp}`,
    '--mount-dir-before-install', files.logDir, '/qa-log',
    '--mount-dir', files.theme, `/wordpress/wp-content/themes/${o.slug}`,
    `--blueprint=${files.blueprint}`]
  const cli = playgroundCommand(args)
  const child = spawn(cli.file, cli.args, hiddenSpawnOptions({ env: { ...process.env, MSYS_NO_PATHCONV: '1' } }))
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Playground did not start in ${rules.wp.start_timeout_s} s (see ${log})`)),
      rules.wp.start_timeout_s * 1000)
    const read = (chunk) => {
      const text = chunk.toString()
      appendFileSync(log, text)
      if (/Ready!/.test(text)) { clearTimeout(timer); resolve() }
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Playground stopped (exit ${code}) before it was ready: see ${log}`)) })
  })
  return { child, ready }
}

async function answers(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(2000) }); return true } catch { return false }
}

async function stopServer(child, base) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  else child.kill('SIGTERM')
  for (let i = 0; i < 20 && (await answers(base)); i++) await sleep(500)
}

// What a visitor meets: text that sits (partly) outside the screen, or is cut by its own box.
export const TEXT_FACTS = () => {
  const W = document.documentElement.clientWidth
  const name = (el) => {
    const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('')
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : cls}`
  }
  // The part of the screen where the element can show: the viewport cut by every
  // ancestor that clips (overflow hidden/clip). null = it never shows sideways cut:
  // a scroller (auto/scroll), an off-canvas (fixed) or a hidden ancestor.
  const window_ = (el) => {
    let left = 0
    let right = W
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.position === 'fixed' || /(auto|scroll)/.test(cs.overflowX) || a.hidden
        || a.getAttribute('aria-hidden') === 'true' || cs.visibility === 'hidden') return null
      if (/(hidden|clip)/.test(cs.overflowX)) {
        const r = a.getBoundingClientRect()
        left = Math.max(left, r.left)
        right = Math.min(right, r.right)
      }
    }
    return { left, right }
  }
  const outside = []
  const clipped = []
  for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,a,button,li,label,span,dd,figcaption,blockquote')) {
    const texts = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim())
    if (!texts.length) continue
    const own = texts.map((n) => n.textContent).join('').trim()
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (!r.width || !r.height || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
    // A visually hidden label (screen readers only: a 1px box that clips its text) is meant to be cut.
    if (r.width <= 1 && r.height <= 1 && (/(hidden|clip)/.test(cs.overflow) || cs.clipPath !== 'none' || cs.clip !== 'auto')) continue
    // The text itself, not the box: a nowrap line runs out of a full-width block.
    const range = document.createRange()
    const edges = texts.map((n) => { range.selectNodeContents(n); return range.getBoundingClientRect() })
    const right = Math.max(...edges.map((e) => e.right))
    const left = Math.min(...edges.map((e) => e.left))
    const label = `${name(el)} "${own.slice(0, 40)}"`
    // Cut = the text runs out of its own element AND crosses an edge of what can show.
    // A card peeking from a slider moves with its text inside it: by design.
    const box = window_(el)
    const runsOut = right > r.right + 1 || left < r.left - 1
    const crosses = box && runsOut && ((right > box.right + 1 && left < box.right) || (left < box.left - 1 && right > box.left))
    if (crosses) outside.push(label)
    if (/(hidden|clip)/.test(cs.overflow) && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2)) clipped.push(label)
  }
  return { scrollWidth: document.documentElement.scrollWidth, outside: outside.slice(0, 30), clipped: clipped.slice(0, 30),
    hrefs: [...document.querySelectorAll('a[href]')].map((a) => a.href) }
}

async function settle(page) {
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const step = Math.max(200, Math.floor(innerHeight * 0.8))
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) { scrollTo(0, y); await wait(60) }
    scrollTo(0, 0)
  })
  await sleep(rules.wp.settle_ms)
}

const shotName = (path) => path.replace(/^\/|\/$/g, '').replace(/[^\p{L}\p{N}_-]+/gu, '-') || 'home'

// One pass over the pages at the widths; returns findings and the facts per page/width.
async function pass(browser, base, pages, widths, { shots, label, before, keepShots }) {
  const found = []
  const facts = new Map()
  const hrefs = new Set()
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: rules.height }, reducedMotion: 'reduce' })
    for (const path of pages) {
      const page = await context.newPage()
      const errors = []
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
      page.on('pageerror', (e) => errors.push(`page error: ${e.message}`))
      page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(base) && !r.url().includes(MISSING)) errors.push(`HTTP ${r.status()}: ${r.url().slice(base.length)}`) })
      const where = { page: path, width }
      let response
      try {
        response = await page.goto(base + path, { waitUntil: 'load', timeout: 60000 })
      } catch (e) {
        found.push(finding(`${label}page_load`, 'fail', where, `the page did not load: ${e.message.split('\n')[0]}`))
        await page.close(); continue
      }
      const status = response?.status() ?? 0
      const html = response ? await response.text() : ''
      await settle(page)
      const f = await page.evaluate(TEXT_FACTS)
      f.hrefs.forEach((h) => hrefs.add(h))
      facts.set(`${path} ${width}`, f)
      const file = join(shots, `${shotName(path)}-${width}.jpg`)
      const shot = relative(dirname(shots), file).replace(/\\/g, '/')
      const at = { ...where, screenshot: shot }
      const local = []
      if (path === MISSING) {
        if (status !== 404) local.push(finding('not_found_status', 'fail', at, `a missing page answers HTTP ${status}, not 404`))
      } else if (status >= 400) {
        local.push(finding(`${label}http_status`, 'fail', at, `the page answers HTTP ${status}`))
      }
      for (const e of htmlPhpErrors(html)) local.push(finding(`${label}php_error_on_page`, 'fail', at, e))
      const over = overflowFinding({ page: path, width, scrollWidth: f.scrollWidth, screenshot: shot })
      if (over) local.push({ ...over, check: `${label}${over.check}`, file: null, line: null })
      const old = before?.get(`${path} ${width}`)
      // New after the stress = an element that had no such problem before (its text changed).
      const element = (x) => x.split(' "')[0]
      const fresh = (list, key) => list.filter((x) => !(old?.[key] ?? []).map(element).includes(element(x)))
      const outside = fresh(f.outside, 'outside')
      const clipped = fresh(f.clipped, 'clipped')
      if (outside.length) local.push(finding(`${label}text_outside`, 'warn', at, `text outside the screen: ${outside.slice(0, 5).join('; ')}`))
      if (clipped.length) local.push(finding(`${label}text_clipped`, 'warn', at, `text cut by its box: ${clipped.slice(0, 5).join('; ')}`))
      if (path !== MISSING) for (const e of [...new Set(errors)].slice(0, 5)) local.push(finding(`${label}console`, 'warn', where, e))
      if (local.length || keepShots.includes(width)) await page.screenshot({ path: file, fullPage: true, type: 'jpeg', quality: 70 })
      found.push(...local)
      await page.close()
    }
    await context.close()
  }
  return { found, facts, hrefs }
}

async function adminPass(browser, base, info) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`${base}/wp-login.php`, { waitUntil: 'load' })
  await page.fill('#user_login', 'admin')
  await page.fill('#user_pass', 'password')
  await Promise.all([page.waitForNavigation({ timeout: 60000 }), page.click('#wp-submit')])
  const urls = ['/wp-admin/', '/wp-admin/edit.php?post_type=page', '/wp-admin/nav-menus.php', '/wp-admin/upload.php',
    ...info.pages.map((p) => `/wp-admin/post.php?post=${p.id}&action=edit`),
    ...info.post_types.flatMap((t) => [`/wp-admin/edit.php?post_type=${t.name}`, `/wp-admin/post-new.php?post_type=${t.name}`]),
    ...info.taxonomies.map((t) => `/wp-admin/edit-tags.php?taxonomy=${t.name}&post_type=${t.types[0] ?? 'post'}`),
    ...info.options.map((slug) => `/wp-admin/admin.php?page=${slug}`)]
  const found = []
  for (const url of urls) {
    const r = await context.request.get(base + url, { timeout: 60000 })
    const html = await r.text()
    if (r.status() >= 400) found.push(finding('admin_http_status', 'fail', { page: url }, `the admin screen answers HTTP ${r.status()}`))
    if (/wp-login\.php/.test(r.url())) found.push(finding('admin_login', 'fail', { page: url }, 'not logged in: the admin screen redirected to the login'))
    for (const e of htmlPhpErrors(html)) found.push(finding('admin_php_error', 'fail', { page: url }, e))
  }
  await context.close()
  return { found, urls }
}

async function brokenLinks(base, hrefs, crawled) {
  const found = []
  const seen = new Set(crawled)
  const todo = []
  for (const h of hrefs) {
    const u = new URL(h)
    if (u.origin !== base || u.pathname.startsWith('/wp-admin') || u.pathname.startsWith('/wp-login')) continue
    const path = u.pathname + u.search
    if (seen.has(path)) continue
    seen.add(path)
    todo.push(path)
  }
  for (const path of todo.slice(0, rules.wp.max_links)) {
    const r = await fetch(base + path, { redirect: 'follow' }).catch(() => null)
    if (!r || r.status >= 400) found.push(finding('broken_link', 'fail', { page: path }, `an internal link answers ${r ? `HTTP ${r.status}` : 'nothing'}`))
  }
  return found
}

export async function wpCheck(args) {
  const o = wpOptions(args)
  if (!existsSync(join(o.theme, 'style.css'))) throw new Error(`${o.theme} is not a theme folder (no style.css)`)
  const base = `http://127.0.0.1:${o.port}`
  if (await answers(base)) throw new Error(`port ${o.port} is busy: stop that server or pass --port`)
  rmSync(o.out, { recursive: true, force: true })
  const shots = join(o.out, 'shots')
  const files = { theme: join(o.out, 'theme', o.slug), logDir: join(o.out, 'wp-log'), blueprint: join(o.out, 'blueprint.json') }
  mkdirSync(shots, { recursive: true })
  mkdirSync(join(shots, 'stress'), { recursive: true })
  mkdirSync(files.logDir, { recursive: true })
  cpSync(o.theme, files.theme, { recursive: true })
  const token = randomBytes(16).toString('hex')
  writeFileSync(files.blueprint, JSON.stringify(blueprint(o, token), null, 2))
  const log = join(o.out, 'server.log')
  writeFileSync(log, '')

  const findings = [...themeFileFindings(themeFiles(files.theme))]
  const report = { tool: 'qa-kit wp', theme: o.theme, slug: o.slug, plugins_asked: o.plugins, setup: o.wpCli }
  const { child, ready } = startServer(o, files, log)
  let browser
  try {
    await ready
    const ask = async (action) => (await fetch(`${base}/?qa_kit=${action}&token=${token}`)).json()
    const info = await ask('info')
    const lint = await ask('lint')
    Object.assign(report, { wp: info.wp, php: info.php, plugins: info.plugins, php_files: lint.files, site_icon: Boolean(info.site_icon) })
    findings.push(...lintFindings(lint.errors), ...fieldFindings(info.fields))
    for (const p of o.plugins) {
      if (!info.plugins.some((a) => a.startsWith(`${p}/`))) findings.push(finding('plugin_not_active', 'fail', {}, `the plugin ${p} is not active`))
    }
    const front = info.pages.find((p) => p.id === info.front_page)
    const pages = [...new Set(['/', ...info.pages.filter((p) => p !== front).map((p) => p.path),
      ...info.post_types.flatMap((t) => [t.archive, t.single]).filter(Boolean), ...o.pages, MISSING])]
    report.pages = pages
    browser = await chromium.launch()
    const widths = rules.wp.widths
    const normal = await pass(browser, base, pages, widths, { shots, label: '', keepShots: rules.wp.shot_widths })
    findings.push(...normal.found, ...(await brokenLinks(base, normal.hrefs, pages)))
    const admin = await adminPass(browser, base, info)
    report.admin = admin.urls
    findings.push(...admin.found)
    if (o.stress) {
      report.stress = await ask('stress')
      const stressed = await pass(browser, base, pages.filter((p) => p !== MISSING), widths,
        { shots: join(shots, 'stress'), label: 'stress_', before: normal.facts, keepShots: rules.wp.shot_widths })
      findings.push(...stressed.found)
    }
  } finally {
    await browser?.close()
    await stopServer(child, base)
    const debug = join(files.logDir, 'debug.log')
    if (existsSync(debug)) findings.push(...debugLogFindings(readFileSync(debug, 'utf8'), o.slug))
    report.findings = merge(findings)
    report.summary = summarize(report.findings)
    report.server_stopped = !(await answers(base))
    writeFileSync(join(o.out, 'wp-report.json'), JSON.stringify(report, null, 2))
    rmSync(join(o.out, 'theme'), { recursive: true, force: true })
  }
  return { ...report, out: o.out }
}
