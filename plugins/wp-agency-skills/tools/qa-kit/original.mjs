// qa-kit original <code folder> [--ref <git ref>] [--pages ./,menu.html] [--expect menu.html]
//                   [--widths 360,390,...] [--mask ".selector,..."] [--round N]
//
// Compares the edited copy of a client project with its original: the
// original commit (the root commit, or --ref) is exported to a temporary git
// worktree, both versions are served by a built-in static server on free ports,
// and every page at every width is screenshotted in both with animations frozen
// and canvas / video / iframe / [data-qa-mask] / --mask covered by a solid box.
// Exact comparison: any changed pixel counts (rules.json original.pixel_delta 0).
// A changed page named in --expect is `info` (changed as expected), any other
// change is `warn` (a possible regression), a removed page and console errors only
// in the edited copy are `fail`. Writes <out>/original-report.json and, for each
// changed page and width, one JPG: original | edited copy with the changed regions
// in red boxes. The worktree and both servers are removed at the end, also on error.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { pagesFrom, summarize } from './lib/judge.mjs'
import { changeFindings, exportRef, groupBoxes, headCommit, originalOptions, rootCommit, serveFolder } from './lib/original.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const rules = JSON.parse(readFileSync(join(here, 'rules.json'), 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MASK_COLOR = '#ff00ff'
const GAP = 24 // px between the two halves of an evidence picture

const slug = (page) => page.replace(/^\/|\/$/g, '').replace(/[^\w-]+/g, '-') || 'home'

// The same scroll-through as `check`: lazy images load, entrance animations run.
async function settle(page) {
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const step = Math.max(200, Math.floor(innerHeight * 0.8))
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) { scrollTo(0, y); await wait(120) }
    scrollTo(0, 0)
    await wait(200)
  })
}

// In the page: pause videos, wait for fonts and images, hide the caret, and cover
// every masked element with a solid box at its place in the document.
const FREEZE = async ({ selectors, color }) => {
  for (const v of document.querySelectorAll('video')) { try { v.pause() } catch { /* not playable */ } }
  try { await document.fonts?.ready } catch { /* no fonts API */ }
  // A lazy image that never comes near the screen (a hidden tab, a far slide) never
  // loads: ask for it now, and never wait longer than a few seconds.
  for (const i of document.images) if (i.loading === 'lazy') i.loading = 'eager'
  const loaded = Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = r; i.onerror = r })))
  await Promise.race([loaded, new Promise((r) => setTimeout(r, 5000))])
  scrollTo(0, 0)
  const style = document.createElement('style')
  style.textContent = '*{caret-color:transparent!important;scroll-behavior:auto!important}'
  document.head.append(style)
  let elements
  try { elements = document.querySelectorAll(selectors.join(',')) } catch (e) { return { error: e.message } }
  let masked = 0
  for (const el of elements) {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    const box = document.createElement('div')
    box.setAttribute('data-qa-mask-box', '')
    box.style.cssText = `position:absolute;left:${r.left + scrollX}px;top:${r.top + scrollY}px;width:${r.width}px;height:${r.height}px;`
      + `background:${color};z-index:2147483647;pointer-events:none;margin:0;border:0;box-sizing:border-box`
    document.documentElement.append(box)
    masked++
  }
  return { masked }
}

function watch(page, sink, origin) {
  const add = (m) => sink.add(m.split(origin).join('http://site/'))
  page.on('console', (m) => { if (m.type() === 'error') add(`error: ${m.text()}`) })
  page.on('pageerror', (e) => add(`page error: ${e.message}`))
  page.on('requestfailed', (r) => add(`request failed: ${r.url()} (${r.failure()?.errorText})`))
  page.on('response', (r) => { if (r.status() >= 400) add(`HTTP ${r.status()}: ${r.url()}`) })
}

async function shoot(page, url, opt) {
  await page.goto(url, { waitUntil: 'load', timeout: 45000 })
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
  await settle(page)
  const frozen = await page.evaluate(FREEZE, { selectors: opt.masks, color: MASK_COLOR })
  if (frozen.error) throw new Error(`--mask: ${frozen.error}`)
  await sleep(rules.original.settle_ms)
  const png = await page.screenshot({ fullPage: true, type: 'png', animations: 'disabled', caret: 'hide' })
  return { png, masked: frozen.masked }
}

// In a worker page: the pixel diff of two screenshots (also where only one of them
// has pixels), the boxes of the changed regions, and the side-by-side evidence.
const DIFF = async ({ a, b, delta, gap, cap, quality, between }) => {
  const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src })
  const [x, y] = await Promise.all([load(a), load(b)])
  const w = Math.max(x.width, y.width)
  const h = Math.max(x.height, y.height)
  const read = (img) => { const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data }
  const p = read(x)
  const q = read(y)
  const changed = new Uint8Array(w * h)
  let count = 0
  for (let i = 0, k = 0; i < p.length; i += 4, k++) {
    const present = p[i + 3] > 0
    if (present !== (q[i + 3] > 0)) { changed[k] = 1; count++; continue }
    if (!present) continue
    const d = Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2]))
    if (d > delta) { changed[k] = 1; count++ }
  }
  const result = { width: w, height: h, height_original: x.height, height_current: y.height, changed: count, boxes: [], jpg: null }
  if (!count) return result
  result.boxes = window.__groupBoxes(changed, w, h, { gap, cap })
  const c = document.createElement('canvas')
  c.width = x.width + between + y.width
  c.height = h
  const g = c.getContext('2d')
  g.fillStyle = '#e5e5e5'
  g.fillRect(0, 0, c.width, c.height)
  g.drawImage(x, 0, 0)
  g.drawImage(y, x.width + between, 0)
  g.strokeStyle = '#e11d48'
  g.lineWidth = 3
  for (const box of result.boxes) g.strokeRect(x.width + between + box.x - 2, box.y - 2, box.w + 4, box.h + 4)
  result.jpg = c.toDataURL('image/jpeg', quality / 100)
  return result
}

async function answers(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true } catch { return false }
}

async function exists(url) {
  const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) }).catch(() => null)
  return Boolean(r && r.status < 400)
}

async function linkedPages(browser, version) {
  const page = await browser.newPage()
  try {
    const response = await page.goto(version.url, { waitUntil: 'load', timeout: 45000 })
    if (!response || response.status() >= 400) return null
    const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href))
    return ['/', ...pagesFrom(version.url, hrefs)]
  } finally {
    await page.close()
  }
}

// Which pages to compare: --pages, else the start page's links of both versions
// (plus --expect); each is sorted into both / added / removed / missing.
async function sortPages(browser, opt, original, current) {
  const fromCurrent = await linkedPages(browser, current)
  if (!fromCurrent) throw new Error(opt.noStartPage ?? `${opt.folder} has no index.html at its root: pass the folder of the site`)
  const fromOriginal = (await linkedPages(browser, original)) ?? []
  const wanted = [...new Set([...(opt.pages ?? [...fromCurrent, ...fromOriginal]), ...(opt.expect ?? [])])]
  const sorted = { pages: [], added: [], removed: [], missing: [] }
  for (const page of wanted) {
    const [inOriginal, inCurrent] = await Promise.all([exists(new URL(page, original.url).href), exists(new URL(page, current.url).href)])
    if (inOriginal && inCurrent) sorted.pages.push(page)
    else if (inCurrent) sorted.added.push(page)
    else if (inOriginal) sorted.removed.push(page)
    else sorted.missing.push(page)
  }
  sorted.skipped = sorted.pages.length > rules.max_pages ? sorted.pages.splice(rules.max_pages) : []
  return sorted
}

// Both versions are already served (original.url, current.url): sort the pages,
// screenshot each in both at every width, diff them and judge the changes. Used by
// `qa-kit original` (static copies) and `qa-kit wp-site compare` (WordPress copies).
// opt: { widths, masks, pages, expect, out, folder, noStartPage }.
export async function compareVersions(original, current, opt) {
  const o = rules.original
  const shots = join(opt.out, 'shots')
  mkdirSync(shots, { recursive: true })
  const browser = await chromium.launch()
  try {
    const sorted = await sortPages(browser, opt, original, current)
    const worker = await browser.newPage()
    await worker.addScriptTag({ content: `window.__groupBoxes = ${groupBoxes.toString()}` })
    const messages = { original: {}, current: {} }
    const pairs = []
    for (const width of opt.widths) {
      const contexts = {}
      for (const [name, version] of [['original', original], ['current', current]]) {
        const context = await browser.newContext({ viewport: { width, height: rules.height }, reducedMotion: 'reduce' })
        contexts[name] = { context, page: await context.newPage(), version }
      }
      for (const page of sorted.pages) {
        const shotOf = async (name) => {
          const { page: tab, version } = contexts[name]
          messages[name][page] ??= new Set()
          watch(tab, messages[name][page], version.url.replace(/\/$/, ''))
          try { return await shoot(tab, new URL(page, version.url).href, opt) } finally { tab.removeAllListeners() }
        }
        const [before, after] = await Promise.all([shotOf('original'), shotOf('current')])
        const data = (png) => `data:image/png;base64,${png.toString('base64')}`
        const r = await worker.evaluate(DIFF, { a: data(before.png), b: data(after.png), delta: o.pixel_delta, gap: o.box_gap,
          cap: o.max_boxes, quality: o.jpg_quality, between: GAP })
        let evidence = null
        if (r.jpg) {
          evidence = `shots/${slug(page)}-${width}.jpg`
          writeFileSync(join(opt.out, evidence), Buffer.from(r.jpg.split(',')[1], 'base64'))
        }
        pairs.push({ page, width, changed_ratio: r.changed / (r.width * r.height), changed_pixels: r.changed,
          height_original: r.height_original, height_current: r.height_current, height_change: r.height_current - r.height_original,
          boxes: r.boxes, masked: after.masked, masked_original: before.masked, evidence })
      }
      for (const { context } of Object.values(contexts)) await context.close()
    }
    await worker.close()
    const consoleNew = {}
    const consoleReport = {}
    for (const page of sorted.pages) {
      const was = [...(messages.original[page] ?? [])]
      const is = [...(messages.current[page] ?? [])]
      const fresh = is.filter((m) => !was.includes(m))
      if (fresh.length) consoleNew[page] = fresh
      if (was.length || is.length) consoleReport[page] = { original: was, current: is, new: fresh }
    }
    const findings = changeFindings({ pairs, added: sorted.added, removed: sorted.removed, missing: sorted.missing, consoleNew }, opt.expect)
    for (const f of findings) {
      f.screenshot = f.screenshot ? join(opt.out, f.screenshot) : null
      if (f.evidence) f.evidence = f.evidence.map((e) => join(opt.out, e))
    }
    if (sorted.skipped.length) {
      findings.push({ check: 'pages', level: 'info', page: null, width: null, widths: [], browser: 'chromium', screenshot: null,
        message: `${sorted.pages.length + sorted.skipped.length} pages found, the first ${rules.max_pages} compared (name the rest in --pages)` })
    }
    return { pages: sorted.pages, added: sorted.added, removed: sorted.removed, missing: sorted.missing, skipped: sorted.skipped,
      pairs, console: consoleReport, findings, summary: summarize(findings), screenshots: shots,
      note: 'Exact comparison (any changed pixel counts). Masked areas (magenta boxes) are not compared: look at them by eye. '
        + 'A changed page in --expect is info, any other change is warn: the QA agent looks at every one before it becomes a bug.' }
  } finally {
    await browser.close()
  }
}

export async function originalCheck(args) {
  const opt = originalOptions(args, rules)
  if (!existsSync(join(opt.folder, '.git'))) throw new Error(`${opt.folder} is not a git repository (the original must be its first commit)`)
  const ref = opt.ref ?? rootCommit(opt.folder)
  const exported = exportRef(opt.folder, ref)
  rmSync(opt.out, { recursive: true, force: true })
  mkdirSync(opt.out, { recursive: true })
  const o = rules.original
  const report = {
    tool: 'qa-kit original', folder: opt.folder, ref: exported.commit, head: headCommit(opt.folder), round: opt.round,
    widths: opt.widths, expect: opt.expect, masks: opt.masks, pixel_delta: o.pixel_delta, export: exported.dir,
  }
  const servers = []
  try {
    const [original, current] = await Promise.all([serveFolder(exported.dir), serveFolder(opt.folder)])
    servers.push(original, current)
    Object.assign(report, await compareVersions(original, current, opt))
  } finally {
    for (const s of servers) await s.close()
    exported.remove()
    report.servers_stopped = !(await answers(servers[0]?.url ?? 'http://127.0.0.1:1/')) && !(await answers(servers[1]?.url ?? 'http://127.0.0.1:1/'))
    writeFileSync(join(opt.out, 'original-report.json'), JSON.stringify(report, null, 2))
  }
  return { ...report, out: opt.out }
}
