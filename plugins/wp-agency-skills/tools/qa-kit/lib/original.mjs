// qa-kit original: the pure parts of comparing an edited client project
// with its original - options, page names, the grouping of changed pixels into
// boxes, the levels of the findings - and a tiny static file server (node:http,
// no dependency) that serves one folder on a random free port.
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'

const GIT = () => process.env.QA_KIT_GIT || 'git'
const BUILT_IN_MASKS = ['canvas', 'video', 'iframe', '[data-qa-mask]']

// A page is a path on the site: `./` or `/` is the start page, `menu.html` = `/menu.html`.
export function normalizePage(page) {
  if (/^[A-Za-z]:[\\/]/.test(page)) {
    throw new Error(`--pages got a Windows path (${page}): write the pages without the leading slash, e.g. menu.html,about/`)
  }
  const at = new URL(page.trim().replace(/^\.?\//, ''), 'http://x/')
  return at.pathname + at.search
}

const list = (value) => value?.split(',').map((s) => s.trim()).filter(Boolean) ?? null

export function originalOptions(args, rules) {
  const opt = (name, fallback = null) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : fallback
  }
  if (!args[0] || args[0].startsWith('--')) {
    throw new Error('usage: qa-kit original <code folder> [--ref <git ref>] [--pages ./,menu.html] [--expect menu.html] [--widths 360,1440] [--mask ".sel"] [--round N]')
  }
  const folder = resolve(args[0])
  const round = opt('round')
  const widths = list(opt('widths'))?.map(Number) ?? rules.original.widths
  if (widths.some((w) => !Number.isInteger(w) || w < 200)) throw new Error(`--widths takes pixel widths, e.g. 390,1440 (got ${opt('widths')})`)
  return {
    folder,
    ref: opt('ref'),
    round: round ? Number(round) : null,
    out: join(folder, 'test-results', 'qa-kit', 'original', round ? `round-${round}` : 'latest'),
    pages: list(opt('pages'))?.map(normalizePage) ?? null,
    expect: list(opt('expect'))?.map(normalizePage) ?? null,
    widths,
    masks: [...BUILT_IN_MASKS, ...(rules.original.mask_selectors ?? []), ...(list(opt('mask')) ?? [])],
  }
}

// Group changed pixels (a 0/1 array of width*height) into boxes: cells of `gap`
// px, cells touching or one cell apart are one region, each region's box is the
// exact extent of its changed pixels. More regions than `cap` merge with a coarser
// grid until they fit. Pure, so the browser can run it too (page.addScriptTag).
export function groupBoxes(changed, width, height, { gap = 8, cap = 20 } = {}) {
  let cell = Math.max(2, gap)
  for (;;) {
    const cols = Math.ceil(width / cell)
    const rows = Math.ceil(height / cell)
    const on = new Uint8Array(cols * rows)
    for (let y = 0; y < height; y++) {
      const row = y * width
      const cy = Math.floor(y / cell) * cols
      for (let x = 0; x < width; x++) if (changed[row + x]) on[cy + Math.floor(x / cell)] = 1
    }
    const label = new Int32Array(cols * rows).fill(-1)
    const regions = []
    for (let i = 0; i < on.length; i++) {
      if (!on[i] || label[i] >= 0) continue
      const id = regions.length
      const cells = []
      const stack = [i]
      label[i] = id
      while (stack.length) {
        const c = stack.pop()
        cells.push(c)
        const cx = c % cols
        const cy = (c - cx) / cols
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = cx + dx
            const ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
            const n = ny * cols + nx
            if (on[n] && label[n] < 0) { label[n] = id; stack.push(n) }
          }
        }
      }
      regions.push(cells)
    }
    if (regions.length > cap) { cell *= 2; continue }
    const boxes = regions.map((cells) => {
      let x0 = width; let y0 = height; let x1 = -1; let y1 = -1; let pixels = 0
      for (const c of cells) {
        const cx = (c % cols) * cell
        const cy = Math.floor(c / cols) * cell
        for (let y = cy; y < Math.min(cy + cell, height); y++) {
          for (let x = cx; x < Math.min(cx + cell, width); x++) {
            if (!changed[y * width + x]) continue
            pixels++
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
          }
        }
      }
      return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, pixels }
    })
    return boxes.sort((a, b) => a.y - b.y || a.x - b.x)
  }
}

const pct = (ratio) => `${(ratio * 100).toFixed(ratio > 0 && ratio < 0.001 ? 3 : 1)}%`

// Findings from the measured pairs. `expect` = the pages the edits touch (null =
// no --expect: every change is info). The QA agent still looks at every change.
export function changeFindings({ pairs, added = [], removed = [], missing = [], consoleNew = {} }, expect) {
  const out = []
  const where = (page, extra = {}) => ({ page, width: null, browser: 'chromium', screenshot: null, ...extra })
  const expected = (page) => expect === null || expect.includes(page)
  const byPage = new Map()
  for (const p of pairs) {
    if (!byPage.has(p.page)) byPage.set(p.page, [])
    byPage.get(p.page).push(p)
  }
  for (const [page, list] of byPage) {
    const changed = list.filter((p) => p.changed_ratio > 0)
    if (!changed.length) continue
    const worst = Math.max(...changed.map((p) => p.changed_ratio))
    const regions = changed.map((p) => `${p.width}: ${p.boxes.length} region${p.boxes.length === 1 ? '' : 's'}`).join(', ')
    const heights = changed.filter((p) => p.height_current !== p.height_original)
      .map((p) => `${p.height_current - p.height_original > 0 ? '+' : ''}${p.height_current - p.height_original} px at ${p.width}`)
    const verdict = expected(page) ? 'changed as expected' : 'unexpected change (a possible regression: look at it)'
    const message = `${verdict}: up to ${pct(worst)} of the page differs from the original (${regions}`
      + `${heights.length ? `; height ${heights.join(', ')}` : ''}); the red boxes in the evidence show where`
    const boxes = Object.fromEntries(changed.map((p) => [p.width, p.boxes]))
    const evidence = changed.map((p) => p.evidence).filter(Boolean)
    out.push({ check: 'original_change', level: expected(page) ? 'info' : 'warn', ...where(page), widths: changed.map((p) => p.width), screenshot: evidence[0] ?? null, message, boxes, evidence })
  }
  for (const page of expect ?? []) {
    const list = byPage.get(page)
    if (list && list.length && list.every((p) => p.changed_ratio === 0)) {
      out.push({ check: 'original_unchanged', level: 'warn', ...where(page), widths: list.map((p) => p.width),
        message: 'named in --expect, but no pixel changed against the original at any width: was the edit made here?' })
    }
  }
  for (const page of removed) {
    out.push({ check: 'page_removed', level: 'fail', ...where(page), widths: [], message: 'the page exists in the original but not in the edited copy' })
  }
  for (const page of added) {
    out.push({ check: 'page_added', level: expected(page) ? 'info' : 'warn', ...where(page), widths: [],
      message: `a page the original does not have${expected(page) ? '' : ' (not in --expect: check that an edit asked for it)'}` })
  }
  for (const page of missing) {
    out.push({ check: 'page_missing', level: 'info', ...where(page), widths: [], message: 'linked, but missing in both the original and the edited copy (not a regression)' })
  }
  for (const [page, messages] of Object.entries(consoleNew)) {
    for (const m of messages.slice(0, 10)) {
      out.push({ check: 'console_new', level: 'fail', ...where(page), widths: [], message: `only in the edited copy: ${m}` })
    }
  }
  return out
}

// --- git: the original export -------------------------------------------------------------

export function rootCommit(folder) {
  const roots = execFileSync(GIT(), ['-C', folder, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  if (!roots.length) throw new Error(`${folder} has no commits: the original must be the first commit`)
  return roots[roots.length - 1]
}

export function headCommit(folder) {
  return execFileSync(GIT(), ['-C', folder, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

// A detached git worktree of `ref` in the OS temp folder; `remove()` takes it away again.
export function exportRef(folder, ref) {
  const commit = execFileSync(GIT(), ['-C', folder, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim()
  execFileSync(GIT(), ['-C', folder, 'worktree', 'prune'], { encoding: 'utf8' })
  const dir = mkdtempSync(join(tmpdir(), 'qa-kit-original-'))
  rmSync(dir, { recursive: true, force: true }) // git wants to create the folder itself
  execFileSync(GIT(), ['-C', folder, 'worktree', 'add', '--detach', dir, commit], { encoding: 'utf8', stdio: 'pipe' })
  return {
    dir, commit,
    remove() {
      try { execFileSync(GIT(), ['-C', folder, 'worktree', 'remove', '--force', dir], { encoding: 'utf8', stdio: 'pipe' }) } catch { /* removed below */ }
      rmSync(dir, { recursive: true, force: true })
      try { execFileSync(GIT(), ['-C', folder, 'worktree', 'prune'], { encoding: 'utf8', stdio: 'pipe' }) } catch { /* nothing to prune */ }
    },
  }
}

// --- the static file server ---------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
}

export function contentType(name) {
  return TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

// Serves `root` read-only at http://127.0.0.1:<free port>/: index.html for a folder
// (a folder without the trailing slash redirects to it, like every web server),
// nothing outside the folder, no caching. Resolves to { url, port, close }.
export function serveFolder(root) {
  const base = resolve(root)
  const server = createServer((req, res) => {
    const end = (status, body = '') => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(body) }
    let pathname
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x/').pathname) } catch { return end(400, 'bad path') }
    if (pathname.includes('\0')) return end(400, 'bad path')
    const file = resolve(base, `.${pathname}`)
    if (file !== base && !file.startsWith(base + sep)) return end(404, 'not found')
    let target = file
    if (existsSync(target) && statSync(target).isDirectory()) {
      if (!pathname.endsWith('/')) {
        res.writeHead(301, { location: `${pathname}/`, 'cache-control': 'no-store' })
        return res.end()
      }
      target = join(target, 'index.html')
    }
    if (!existsSync(target) || !statSync(target).isFile()) return end(404, 'not found')
    res.writeHead(200, { 'content-type': contentType(target), 'content-length': statSync(target).size, 'cache-control': 'no-store' })
    if (req.method === 'HEAD') return res.end()
    createReadStream(target).pipe(res)
  })
  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      ok({
        url: `http://127.0.0.1:${port}/`, port,
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()) }),
      })
    })
  })
}
