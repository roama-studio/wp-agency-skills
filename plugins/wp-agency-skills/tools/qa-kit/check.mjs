// qa-kit check <code folder> --url <running site> [--round N] [--out <dir>] [--baseline <dir>]
//                [--pages /,/rooms.html,>Tab text] [--no-webkit | --webkit] [--country DE]
//
// Measures what a QA engineer should never eyeball: every page (found from the
// start page's links) at every width of rules.json, a landscape phone, zoom
// 200%, reduced motion, axe-core, performance on a slow phone, a broken image,
// long texts, WebKit (iPhone Safari), screenshots compared with the last
// round, and the legal minimum for the client's country (requests to other
// servers before consent). Writes <out>/qa-report.json (findings with level fail/warn/info) and
// the screenshots. It looks only: the site is the one the QA agent started.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import {
  axeFindings, imageFindings, merge, overflowFinding, pagesFrom, perfFindings, regressionFinding, summarize,
} from './lib/judge.mjs'
import { blockedWebkit, forgetWebkit, rememberWebkit } from './lib/webkit.mjs'
import { consentFindings, legalFindings } from './lib/legal.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const rules = JSON.parse(readFileSync(join(here, 'rules.json'), 'utf8'))
const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const WEBKIT_MEMO = join(here, '.webkit-blocked.json')

// A page is a path, optionally followed by the buttons to click there, each after
// a `>`: `/>Агенти` is the tab «Агенти» of a one-page app.
function pageTarget(page) {
  const [path, ...clicks] = page.split('>')
  return { path, clicks: clicks.map((c) => c.trim()).filter(Boolean) }
}

// Git Bash turns an argument like /rooms.html into C:/Program Files/Git/rooms.html.
function sitePath(page, url) {
  if (/^[A-Za-z]:[\\/]/.test(page)) {
    throw new Error(`--pages got a Windows path (${page}): write the pages without the leading slash, e.g. rooms.html,about/`)
  }
  const { path, clicks } = pageTarget(page)
  const at = new URL(path.replace(/^\.?\//, ''), new URL('/', url))
  return [at.pathname + at.search, ...clicks].join('>')
}

function options(args) {
  const opt = (name, fallback = null) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : fallback
  }
  if (!args[0] || args[0].startsWith('--') || !opt('url')) {
    throw new Error('usage: qa-kit check <code folder> --url http://127.0.0.1:<port>/ [--round N]')
  }
  const folder = resolve(args[0])
  const round = opt('round')
  const base = join(folder, 'test-results', 'qa-kit')
  const out = resolve(opt('out', join(base, round ? `round-${round}` : 'latest')))
  const country = opt('country')
  if (country !== null && !/^[A-Za-z]{2}$/.test(country)) {
    throw new Error(`--country takes a two-letter country code (UA, DE, ...), not ${country}`)
  }
  const previous = round && Number(round) > 1 ? join(base, `round-${Number(round) - 1}`) : null
  return {
    folder, url: opt('url'), round: round ? Number(round) : null, out,
    baseline: opt('baseline', previous && existsSync(previous) ? previous : null),
    pages: opt('pages')?.split(',').filter(Boolean).map((p) => sitePath(p, opt('url'))) ?? null,
    webkit: !args.includes('--no-webkit'),
    retryWebkit: args.includes('--webkit'),
    country: country ? country.toUpperCase() : null,
  }
}

const slug = (page) => {
  const { path, clicks } = pageTarget(page)
  const name = path.replace(/^\/|\/$/g, '').replace(/[^\w-]+/g, '-') || 'home'
  return [name, ...clicks.map((c) => c.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-|-$/g, ''))].join('--')
}

// Scroll through the page so lazy images and entrance animations run, then back up.
async function settle(page) {
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const step = Math.max(200, Math.floor(innerHeight * 0.8))
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) { scrollTo(0, y); await wait(120) }
    scrollTo(0, 0)
    await wait(200)
  })
  await sleep(rules.settle_ms)
}

const PAGE_FACTS = () => {
  const imgs = [...document.images]
  return {
    scrollWidth: document.documentElement.scrollWidth,
    h1: document.querySelectorAll('h1').length,
    broken_images: imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute('src')).map((i) => i.getAttribute('src')),
    no_alt: imgs.filter((i) => !i.hasAttribute('alt')).map((i) => i.getAttribute('src')),
    lenis: Boolean(window.lenis) && document.documentElement.classList.contains('lenis'),
    hrefs: [...document.querySelectorAll('a[href]')].map((a) => a.href),
  }
}

function watch(page, sink) {
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) sink.push(`${m.type()}: ${m.text()}`) })
  page.on('pageerror', (e) => sink.push(`page error: ${e.message}`))
  page.on('requestfailed', (r) => sink.push(`request failed: ${r.url()} (${r.failure()?.errorText})`))
  page.on('response', (r) => { if (r.status() >= 400) sink.push(`HTTP ${r.status()}: ${r.url()}`) })
}

async function open(page, url) {
  const response = await page.goto(url, { waitUntil: 'load', timeout: 45000 })
  return response?.status() ?? 0
}

// Click the first button, link or tab whose text or aria-label is exactly this,
// else one whose text goes on with a count (a nav tab with a badge: «Агенти9, 9 чекають»).
const CLICK = (text) => {
  const all = [...document.querySelectorAll('button, a, [role="tab"], [role="button"]')]
  const label = (el) => [el.textContent.trim(), el.getAttribute('aria-label') ?? '']
  const target = all.find((el) => label(el).includes(text)) ?? all.find((el) => label(el).some(
    (l) => l.startsWith(text) && /^\s*[\d,(]/.test(l.slice(text.length))))
  if (target) target.click()
  return Boolean(target)
}

// Open a page and click its tabs; `missing` names the buttons that were not there.
async function openPage(page, url, spec) {
  const { path, clicks } = pageTarget(spec)
  const status = await open(page, new URL(path, url).href)
  const missing = []
  for (const text of clicks) {
    // An app draws its menu after the load: look for the button for up to 5 s.
    let clicked = false
    for (const start = Date.now(); !clicked && Date.now() - start < 5000; await sleep(250)) {
      clicked = await page.evaluate(CLICK, text)
    }
    if (!clicked) { missing.push(text); continue }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
    await sleep(500)
  }
  return { status, missing }
}

// Open a page in a pass. A tab whose button is not there at this width (a phone
// menu hides it) is a warn and is not checked here: a screenshot of the wrong
// page would only mislead.
async function reach(page, opt, path, findings, where) {
  const { status, missing } = await openPage(page, opt.url, path)
  if (!missing.length) return status
  findings.push({ check: 'tab_not_found', level: 'warn', screenshot: null, ...where, page: path,
    message: `nothing to click named ${missing.map((m) => `"${m}"`).join(', ')} here: the tab is not checked at this width` })
  return null
}

async function discover(browser, opt, findings) {
  const page = await browser.newPage()
  const status = await open(page, opt.url)
  if (status >= 400 || status === 0) throw new Error(`the site does not answer at ${opt.url} (HTTP ${status})`)
  const start = new URL(opt.url).pathname
  const found = opt.pages ?? [start, ...pagesFrom(opt.url, (await page.evaluate(PAGE_FACTS)).hrefs)]
  // A link to a page that does not answer is a bug once; the page is not checked further.
  const pages = []
  for (const path of found) {
    const answer = await page.request.get(new URL(pageTarget(path).path, opt.url).href).catch(() => null)
    if (!answer || answer.status() >= 400) {
      findings.push({ check: 'broken_link', level: 'fail', page: path, width: null, browser: 'chromium', screenshot: null,
        message: `a link leads to ${path}, which answers ${answer ? `HTTP ${answer.status()}` : 'nothing'}` })
      continue
    }
    // A tab's buttons are checked per width in each pass (a phone menu differs).
    pages.push(path)
  }
  if (pages.length > rules.max_pages) {
    findings.push({ check: 'pages', level: 'info', page: null, width: null, browser: 'chromium', screenshot: null,
      message: `${pages.length} pages found, the first ${rules.max_pages} checked` })
  }
  await page.close()
  return pages.slice(0, rules.max_pages)
}

async function screenshotPair(page, dir, name) {
  const path = join(dir, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  return path
}

// One pass over every page at one viewport; returns facts per page.
async function pass(browser, opt, pages, findings, view) {
  const { label, width, height, extra = {}, shots = null, browserName = 'chromium' } = view
  const context = await browser.newContext({ viewport: { width, height }, ...extra })
  const page = await context.newPage()
  const facts = {}
  for (const path of pages) {
    const messages = []
    watch(page, messages)
    const where = { page: path, width, browser: browserName, view: label }
    let status
    try { status = await reach(page, opt, path, findings, where) } catch (e) {
      findings.push({ check: 'page_load', level: 'fail', ...where, screenshot: null, message: e.message })
      page.removeAllListeners()
      continue
    }
    if (status === null) { page.removeAllListeners(); continue }
    if (status >= 400) {
      findings.push({ check: 'broken_link', level: 'fail', ...where, screenshot: null, message: `${path} answers HTTP ${status}` })
      page.removeAllListeners()
      continue
    }
    await settle(page)
    const f = await page.evaluate(PAGE_FACTS)
    let screenshot = null
    if (shots) screenshot = await screenshotPair(page, shots, `${slug(path)}-${label}`)
    const over = overflowFinding({ page: path, width, scrollWidth: f.scrollWidth, browser: browserName, screenshot })
    if (over) {
      over.view = label
      if (!screenshot) {
        over.screenshot = join(opt.out, 'shots', `${slug(path)}-${label}-overflow.png`)
        await page.screenshot({ path: over.screenshot })
      }
      findings.push(over)
    }
    for (const src of f.broken_images) {
      findings.push({ check: 'broken_image', level: 'fail', ...where, screenshot, message: `${src} does not load` })
    }
    const unique = [...new Set(messages)]
    for (const m of unique.slice(0, 10)) {
      findings.push({ check: 'console', level: m.startsWith('warning') ? 'warn' : 'fail', ...where, screenshot: null, message: m })
    }
    facts[path] = { ...f, screenshot, messages: unique.length }
    page.removeAllListeners()
  }
  await context.close()
  return facts
}

async function axePass(browser, opt, pages, findings, width) {
  const context = await browser.newContext({ viewport: { width, height: rules.height } })
  const page = await context.newPage()
  for (const path of pages) {
    if (await reach(page, opt, path, findings, { width, browser: 'chromium', view: 'axe' }) === null) continue
    await settle(page)
    await page.addScriptTag({ path: AXE })
    const violations = await page.evaluate(async () =>
      (await window.axe.run(document, { resultTypes: ['violations'] })).violations
        .map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target })) })))
    findings.push(...axeFindings(violations, { page: path, width }, rules))
  }
  await context.close()
}

const PERF_OBSERVERS = () => {
  window.__qa = { lcp: null, cls: 0, long: 0 }
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__qa.lcp = e.startTime })
    .observe({ type: 'largest-contentful-paint', buffered: true })
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__qa.cls += e.value })
    .observe({ type: 'layout-shift', buffered: true })
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__qa.long += Math.max(0, e.duration - 50) })
    .observe({ type: 'longtask', buffered: true })
}

async function performancePass(browser, opt, pages, findings) {
  const p = rules.performance
  const measures = {}
  for (const path of pages) {
    const context = await browser.newContext({ viewport: { width: p.width, height: p.height }, isMobile: true, hasTouch: true })
    await context.addInitScript(PERF_OBSERVERS)
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: p.network.latency_ms,
      downloadThroughput: (p.network.download_kbps * 1024) / 8, uploadThroughput: (p.network.upload_kbps * 1024) / 8,
    })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: p.cpu_slowdown })
    const reached = await reach(page, opt, path, findings, { width: p.width, browser: 'chromium', view: 'performance' })
    if (reached === null) { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); await context.close(); continue }
    await sleep(3000)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    const m = await page.evaluate(() => {
      const res = performance.getEntriesByType('resource')
      const nav = performance.getEntriesByType('navigation')[0]
      const kb = (n) => Math.round(n / 1024)
      const size = (e) => e.transferSize || e.encodedBodySize || 0
      const bySrc = new Map(res.map((e) => [e.name, size(e)]))
      return {
        lcp_ms: window.__qa.lcp === null ? null : Math.round(window.__qa.lcp),
        cls: Math.round(window.__qa.cls * 1000) / 1000,
        long_tasks_ms: Math.round(window.__qa.long),
        page_kb: kb(res.reduce((s, e) => s + size(e), size(nav ?? {}))),
        js_kb: kb(res.filter((e) => e.initiatorType === 'script' || /\.m?js(\?|$)/.test(e.name)).reduce((s, e) => s + size(e), 0)),
        images: [...document.images].filter((i) => i.currentSrc && i.naturalWidth).map((i) => ({
          src: new URL(i.currentSrc).pathname, kb: kb(bySrc.get(i.currentSrc) ?? 0),
          natural_width: i.naturalWidth, shown_width: Math.round(i.getBoundingClientRect().width * devicePixelRatio),
        })),
      }
    })
    findings.push(...perfFindings(m, { page: path, width: p.width }, p))
    findings.push(...imageFindings(m.images, { page: path, width: p.width }, p))
    measures[path] = { ...m, images: m.images.length }
    await context.close()
  }
  return measures
}

// Reduced motion: Lenis off, and no text left invisible once motion is gone.
async function reducedMotionPass(browser, opt, pages, findings, normalFacts) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const result = {}
  for (const path of pages) {
    if (await reach(page, opt, path, findings, { width: 390, browser: 'chromium', view: 'reduced-motion' }) === null) continue
    await settle(page)
    const r = await page.evaluate(() => {
      const hidden = [...document.querySelectorAll('h1,h2,h3,h4,p,li,a,button,img,figure')].filter((el) => {
        if (el.closest('[aria-hidden="true"],[hidden],dialog:not([open]),nav[aria-expanded="false"]')) return false
        const s = getComputedStyle(el)
        const box = el.getBoundingClientRect()
        return box.width > 0 && (Number(s.opacity) < 0.05 || s.visibility === 'hidden')
      })
      return {
        lenis: Boolean(window.lenis) && document.documentElement.classList.contains('lenis'),
        hidden: hidden.slice(0, 5).map((el) => `${el.tagName.toLowerCase()} "${(el.textContent || el.alt || '').trim().slice(0, 40)}"`),
        hidden_count: hidden.length,
      }
    })
    const where = { page: path, width: 390, browser: 'chromium', screenshot: null }
    if (r.hidden_count) {
      where.screenshot = join(opt.out, 'shots', `${slug(path)}-reduced-motion.png`)
      await page.screenshot({ path: where.screenshot, fullPage: true })
      findings.push({ check: 'reduced_motion_hidden', level: 'fail', ...where,
        message: `${r.hidden_count} element(s) stay invisible with reduced motion, e.g. ${r.hidden.join(', ')}` })
    }
    if (r.lenis) findings.push({ check: 'lenis_reduced_motion', level: 'warn', ...where, message: 'Lenis is still on with reduced motion' })
    if (!normalFacts[path]?.lenis) findings.push({ check: 'lenis', level: 'warn', ...where, width: 1440, message: 'Lenis smooth scroll is not on (window.lenis and <html class="lenis">)' })
    result[path] = r
  }
  await context.close()
  return result
}

// A broken image and texts three times longer must not break the layout.
async function stressPass(browser, opt, pages, findings) {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } })
  const page = await context.newPage()
  for (const path of pages) {
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    let broke = false
    await page.route(/\.(jpe?g|png|webp|avif|gif)(\?.*)?$/i, (route) => {
      if (!broke) { broke = true; return route.fulfill({ status: 404, body: '' }) }
      return route.continue()
    })
    if (await reach(page, opt, path, findings, { width: 360, browser: 'chromium', view: 'stress' }) === null) {
      await page.unroute(/\.(jpe?g|png|webp|avif|gif)(\?.*)?$/i)
      page.removeAllListeners('pageerror')
      continue
    }
    await settle(page)
    const wide = await page.evaluate(() => document.documentElement.scrollWidth)
    const where = { page: path, width: 360, browser: 'chromium' }
    if (broke && (wide > 360 || errors.length)) {
      const shot = join(opt.out, 'shots', `${slug(path)}-broken-image.png`)
      await page.screenshot({ path: shot, fullPage: true })
      findings.push({ check: 'stress_broken_image', level: 'warn', ...where, screenshot: shot,
        message: `with one image missing the page ${wide > 360 ? `is ${wide} px wide` : `throws: ${errors[0]}`}` })
    }
    await page.unroute(/\.(jpe?g|png|webp|avif|gif)(\?.*)?$/i)
    const longWide = await page.evaluate((factor) => {
      for (const el of document.querySelectorAll('h1,h2,h3,button,.btn,a[class*="button"],nav a')) {
        if (el.children.length === 0 && el.textContent.trim()) el.textContent = Array(factor).fill(el.textContent.trim()).join(' ')
      }
      return document.documentElement.scrollWidth
    }, rules.long_text_factor)
    if (longWide > 360) {
      const shot = join(opt.out, 'shots', `${slug(path)}-long-text.png`)
      await page.screenshot({ path: shot, fullPage: true })
      findings.push({ check: 'stress_long_text', level: 'warn', ...where, screenshot: shot,
        message: `headings and buttons ${rules.long_text_factor}x longer make the page ${longWide} px wide` })
    }
    page.removeAllListeners('pageerror')
  }
  await context.close()
}

// Pixel comparison of two PNGs inside the browser (no image package needed).
async function compare(browser, before, after, diffPath, tol) {
  const page = await browser.newPage()
  const data = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`
  const r = await page.evaluate(async ({ a, b, delta }) => {
    const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src })
    const [x, y] = await Promise.all([load(a), load(b)])
    const w = Math.min(x.width, y.width)
    const h = Math.min(x.height, y.height)
    const read = (img) => { const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h) }
    const p = read(x).data
    const q = read(y)
    let changed = 0
    for (let i = 0; i < p.length; i += 4) {
      const d = Math.max(Math.abs(p[i] - q.data[i]), Math.abs(p[i + 1] - q.data[i + 1]), Math.abs(p[i + 2] - q.data[i + 2]))
      if (d > delta) { changed++; q.data[i] = 255; q.data[i + 1] = 0; q.data[i + 2] = 0 } else {
        q.data[i] = q.data[i] * 0.3 + 178; q.data[i + 1] = q.data[i + 1] * 0.3 + 178; q.data[i + 2] = q.data[i + 2] * 0.3 + 178
      }
    }
    const c = document.createElement('canvas'); c.width = w; c.height = h
    c.getContext('2d').putImageData(q, 0, 0)
    return { ratio: changed / (w * h), size_changed: Math.abs(x.height - y.height) > 4, png: changed ? c.toDataURL('image/png') : null }
  }, { a: data(before), b: data(after), delta: tol.pixel_delta })
  await page.close()
  if (r.png) writeFileSync(diffPath, Buffer.from(r.png.split(',')[1], 'base64'))
  return { ratio: r.ratio, size_changed: r.size_changed, diff: r.png ? diffPath : null }
}

const LEGAL_FACTS = (placeholder) => ({
  links: [...document.querySelectorAll('a[href]')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })),
  prechecked: [...document.querySelectorAll('form input[type="checkbox"]')].filter((i) => i.checked)
    .map((i) => i.name || i.id || (i.closest('label')?.textContent ?? '').trim().slice(0, 40) || 'checkbox'),
  placeholders: document.body.innerText.split(placeholder).length - 1,
})

// The legal minimum: a fresh visitor who has consented to nothing.
async function legalPass(browser, opt, pages, findings) {
  const legal = rules.legal
  const result = { country: opt.country, pages: {} }
  for (const path of pages) {
    const context = await browser.newContext({ viewport: { width: 1440, height: rules.height } })
    const page = await context.newPage()
    const requests = []
    page.on('request', (r) => requests.push(r.url()))
    if (await reach(page, opt, path, findings, { width: 1440, browser: 'chromium', view: 'legal' }) === null) {
      await context.close()
      continue
    }
    await settle(page)
    const facts = { page: path, ...(await page.evaluate(LEGAL_FACTS, legal.placeholder)) }
    findings.push(...consentFindings({ page: path, origin: new URL(opt.url).origin, requests }, opt.country, legal))
    findings.push(...legalFindings(facts, opt.country, legal, { start: path === pages[0] }))
    result.pages[path] = { requests: requests.length, prechecked: facts.prechecked, placeholders: facts.placeholders }
    await context.close()
  }
  return result
}

async function webkitPass(opt, pages, findings) {
  const known = opt.retryWebkit ? null : blockedWebkit(WEBKIT_MEMO)
  if (known) {
    const reason = `${known.reason} (remembered since ${known.since}; --webkit tries again)`
    findings.push({ check: 'webkit', level: 'info', page: null, width: null, browser: 'webkit', screenshot: null, message: `not checked: ${reason}` })
    return { available: false, reason }
  }
  let browser
  try { browser = await webkit.launch() } catch (e) {
    const blocked = /missing dependencies|closed/i.test(e.message)
    const reason = blocked
      ? 'WebKit cannot start on this machine (Windows Smart App Control blocks its unsigned libraries)'
      : e.message.split('\n')[0]
    if (blocked) rememberWebkit(WEBKIT_MEMO, reason)
    findings.push({ check: 'webkit', level: 'info', page: null, width: null, browser: 'webkit', screenshot: null, message: `not checked: ${reason}` })
    return { available: false, reason }
  }
  forgetWebkit(WEBKIT_MEMO)
  const w = rules.webkit
  const shots = join(opt.out, 'shots', 'webkit')
  mkdirSync(shots, { recursive: true })
  const facts = await pass(browser, opt, pages, findings,
    { label: `webkit-${w.width}`, width: w.width, height: w.height, extra: { hasTouch: true }, shots, browserName: 'webkit' })
  for (const [path, f] of Object.entries(facts)) {
    if (!f.lenis) findings.push({ check: 'lenis', level: 'warn', page: path, width: w.width, browser: 'webkit', screenshot: f.screenshot, message: 'Lenis is not on in WebKit' })
  }
  const version = browser.version()
  await browser.close()
  return { available: true, version }
}

export async function check(args) {
  const opt = options(args)
  const shots = join(opt.out, 'shots')
  mkdirSync(shots, { recursive: true })
  const findings = []
  const browser = await chromium.launch()
  try {
    const pages = await discover(browser, opt, findings)
    const facts = {}
    for (const width of rules.widths) {
      const keep = rules.regression.widths.includes(width) ? shots : null
      facts[width] = await pass(browser, opt, pages, findings, { label: `${width}`, width, height: rules.height, shots: keep })
    }
    for (const path of pages) {
      const f = facts[1440]?.[path]
      if (!f) continue
      const where = { page: path, width: 1440, browser: 'chromium', screenshot: f.screenshot }
      if (f.h1 !== 1) findings.push({ check: 'h1', level: 'fail', ...where, message: `${f.h1} <h1> on the page (exactly one expected)` })
      for (const src of f.no_alt) findings.push({ check: 'img_alt', level: 'fail', ...where, message: `${src} has no alt attribute` })
    }
    const lp = rules.landscape_phone
    await pass(browser, opt, pages, findings, { label: 'landscape-phone', width: lp.width, height: lp.height, extra: { isMobile: true, hasTouch: true } })
    const z = rules.zoom
    await pass(browser, opt, pages, findings, { label: 'zoom-200', width: z.width / z.factor, height: z.height / z.factor, extra: { deviceScaleFactor: z.factor } })
    for (const width of [390, 1440]) await axePass(browser, opt, pages, findings, width)
    const reduced = await reducedMotionPass(browser, opt, pages, findings, facts[1440] ?? {})
    await stressPass(browser, opt, pages, findings)
    const performance = await performancePass(browser, opt, pages, findings)
    const legal = await legalPass(browser, opt, pages, findings)
    const regression = []
    if (opt.baseline) {
      for (const path of pages) {
        for (const width of rules.regression.widths) {
          const name = `${slug(path)}-${width}.png`
          const before = join(opt.baseline, 'shots', name)
          const after = join(shots, name)
          if (!existsSync(before) || !existsSync(after)) continue
          const r = await compare(browser, before, after, join(shots, `${slug(path)}-${width}-diff.png`), rules.regression)
          regression.push({ page: path, width, ...r })
          const f = regressionFinding({ page: path, width, ...r }, rules.regression)
          if (f) findings.push(f)
        }
      }
    }
    const webkitInfo = opt.webkit ? await webkitPass(opt, pages, findings) : { available: false, reason: 'skipped (--no-webkit)' }
    const merged = merge(findings)
    const report = {
      url: opt.url, round: opt.round, pages, widths: rules.widths,
      browsers: { chromium: browser.version(), webkit: webkitInfo },
      baseline: opt.baseline, summary: summarize(merged), findings: merged,
      performance, reduced_motion: reduced, regression, legal,
      screenshots: shots,
      note: 'fail = clearly broken, warn = worth a look, info = not measured. Look at each finding yourself before it becomes a bug.',
    }
    writeFileSync(join(opt.out, 'qa-report.json'), JSON.stringify(report, null, 2))
    return report
  } finally {
    await browser.close()
  }
}

export { options as checkOptions, openPage, pageTarget, slug }
