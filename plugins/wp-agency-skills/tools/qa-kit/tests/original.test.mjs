// qa-kit original compares the edited copy of a client project with its original.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changeFindings, contentType, groupBoxes, normalizePage, originalOptions, serveFolder } from '../lib/original.mjs'

const RULES = { original: { widths: [360, 390, 1440], pixel_delta: 0, mask_selectors: ['.ad'], box_gap: 8, max_boxes: 20 } }

test('original options: the folder, the root commit by default, pages, expect, widths and masks', () => {
  const o = originalOptions(['C:/cp/bakery', '--pages', './,menu.html', '--expect', 'menu.html,./', '--widths', '390,1024',
    '--mask', '.hero canvas,#map', '--round', '2'], RULES)
  assert.match(o.folder.replace(/\\/g, '/'), /cp\/bakery$/)
  assert.equal(o.ref, null) // the root commit, found in the repo later
  assert.deepEqual(o.pages, ['/', '/menu.html'])
  assert.deepEqual(o.expect, ['/menu.html', '/'])
  assert.deepEqual(o.widths, [390, 1024])
  assert.deepEqual(o.masks, ['canvas', 'video', 'iframe', '[data-qa-mask]', '.ad', '.hero canvas', '#map'])
  assert.equal(o.round, 2)
  assert.match(o.out.replace(/\\/g, '/'), /cp\/bakery\/test-results\/qa-kit\/original\/round-2$/)
})

test('original options: defaults come from rules.json, --ref names another original', () => {
  const o = originalOptions(['C:/cp/bakery', '--ref', 'abc123'], RULES)
  assert.equal(o.ref, 'abc123')
  assert.equal(o.pages, null)
  assert.equal(o.expect, null)
  assert.deepEqual(o.widths, [360, 390, 1440])
  assert.equal(o.round, null)
  assert.match(o.out.replace(/\\/g, '/'), /test-results\/qa-kit\/original\/latest$/)
  assert.throws(() => originalOptions([], RULES), /usage/)
  assert.throws(() => originalOptions(['C:/cp/bakery', '--widths', '390,wide'], RULES), /--widths/)
  assert.throws(() => originalOptions(['C:/cp/bakery', '--pages', 'C:/Program Files/Git/menu.html'], RULES), /Windows path/)
})

test('pages are written with or without the leading slash, ./ is the start page', () => {
  assert.equal(normalizePage('./'), '/')
  assert.equal(normalizePage('/'), '/')
  assert.equal(normalizePage('menu.html'), '/menu.html')
  assert.equal(normalizePage('/about/'), '/about/')
  assert.equal(normalizePage('about/index.html'), '/about/index.html')
})

test('changed pixels become boxes: nearby ones merge, far ones stay apart, pixels counted', () => {
  const w = 100; const h = 60
  const changed = new Uint8Array(w * h)
  const paint = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) changed[y * w + x] = 1 }
  paint(10, 10, 20, 15)   // one region
  paint(23, 12, 30, 18)   // 3 px away: the same region
  paint(70, 40, 80, 50)   // far away: another box
  const boxes = groupBoxes(changed, w, h, { gap: 4, cap: 20 })
  assert.equal(boxes.length, 2)
  assert.deepEqual(boxes[0], { x: 10, y: 10, w: 21, h: 9, pixels: 11 * 6 + 8 * 7 })
  assert.deepEqual(boxes[1], { x: 70, y: 40, w: 11, h: 11, pixels: 121 })
  assert.deepEqual(groupBoxes(new Uint8Array(w * h), w, h, { gap: 4, cap: 20 }), [])
})

test('more regions than the cap merge into fewer, larger boxes', () => {
  const w = 400; const h = 40
  const changed = new Uint8Array(w * h)
  for (let i = 0; i < 40; i++) changed[20 * w + i * 10] = 1 // 40 single pixels 10 px apart
  const boxes = groupBoxes(changed, w, h, { gap: 2, cap: 5 })
  assert.ok(boxes.length >= 1 && boxes.length <= 5, `${boxes.length} boxes`)
  assert.equal(boxes.reduce((s, b) => s + b.pixels, 0), 40)
})

const pair = (page, width, ratio, extra = {}) => ({ page, width, changed_ratio: ratio, changed_pixels: ratio ? 500 : 0,
  height_original: 2000, height_current: 2000, boxes: ratio ? [{ x: 10, y: 20, w: 100, h: 30, pixels: 500 }] : [],
  evidence: ratio ? `shots/${page}-${width}.jpg` : null, ...extra })

test('a changed page is info when expected, warn when not; without --expect every change is info', () => {
  const pairs = [pair('/', 390, 0), pair('/menu.html', 390, 0.012), pair('/menu.html', 1440, 0.004), pair('/about.html', 390, 0.001)]
  const withExpect = changeFindings({ pairs, added: [], removed: [], missing: [], consoleNew: {} }, ['/menu.html'])
  const menu = withExpect.find((f) => f.page === '/menu.html')
  assert.equal(menu.check, 'original_change')
  assert.equal(menu.level, 'info')
  assert.match(menu.message, /changed as expected/)
  assert.match(menu.message, /1\.2%/)
  assert.deepEqual(menu.widths, [390, 1440])
  assert.deepEqual(menu.evidence, ['shots//menu.html-390.jpg', 'shots//menu.html-1440.jpg'])
  assert.deepEqual(menu.boxes[390], [{ x: 10, y: 20, w: 100, h: 30, pixels: 500 }])
  const about = withExpect.find((f) => f.page === '/about.html')
  assert.equal(about.level, 'warn')
  assert.match(about.message, /unexpected change/)
  assert.equal(withExpect.find((f) => f.page === '/'), undefined)
  const noExpect = changeFindings({ pairs, added: [], removed: [], missing: [], consoleNew: {} }, null)
  assert.ok(noExpect.every((f) => f.level === 'info'))
  assert.equal(noExpect.length, 2)
})

test('an expected page that did not change is said so; a height change is named', () => {
  const pairs = [pair('/menu.html', 390, 0), pair('/menu.html', 1440, 0.01, { height_current: 2048 }), pair('/about.html', 390, 0)]
  const out = changeFindings({ pairs, added: [], removed: [], missing: [], consoleNew: {} }, ['/menu.html', '/about.html'])
  const menu = out.find((f) => f.page === '/menu.html')
  assert.match(menu.message, /height \+48 px/)
  const about = out.find((f) => f.page === '/about.html')
  assert.equal(about.check, 'original_unchanged')
  assert.equal(about.level, 'warn')
  assert.match(about.message, /no pixel changed/)
})

test('a removed page fails, an added page is flagged, new console errors fail, a page missing in both is info', () => {
  const out = changeFindings({ pairs: [], added: ['/new.html'], removed: ['/old.html'], missing: ['/gone.html'],
    consoleNew: { '/menu.html': ['error: Uncaught TypeError: x is not a function'] } }, ['/new.html'])
  const by = (check) => out.find((f) => f.check === check)
  assert.equal(by('page_removed').level, 'fail')
  assert.equal(by('page_removed').page, '/old.html')
  assert.equal(by('page_added').level, 'info')
  assert.equal(by('console_new').level, 'fail')
  assert.match(by('console_new').message, /only in the edited copy/)
  assert.equal(by('page_missing').level, 'info')
  assert.equal(changeFindings({ pairs: [], added: ['/new.html'], removed: [], missing: [], consoleNew: {} }, ['/']).find((f) => f.check === 'page_added').level, 'warn')
})

test('content types of the static server', () => {
  assert.equal(contentType('index.html'), 'text/html; charset=utf-8')
  assert.equal(contentType('a/style.css'), 'text/css; charset=utf-8')
  assert.equal(contentType('app.mjs'), 'text/javascript; charset=utf-8')
  assert.equal(contentType('logo.svg'), 'image/svg+xml')
  assert.equal(contentType('photo.webp'), 'image/webp')
  assert.equal(contentType('font.woff2'), 'font/woff2')
  assert.equal(contentType('data.json'), 'application/json; charset=utf-8')
  assert.equal(contentType('clip.mp4'), 'video/mp4')
  assert.equal(contentType('what.ever'), 'application/octet-stream')
})

test('the static server: a directory serves its index.html, files their type, nothing outside the folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-orig-'))
  mkdirSync(join(root, 'about'))
  writeFileSync(join(root, 'index.html'), '<h1>home</h1>')
  writeFileSync(join(root, 'about', 'index.html'), '<h1>about</h1>')
  writeFileSync(join(root, 'style.css'), 'h1{color:red}')
  writeFileSync(join(root, 'pretty name.txt'), 'ok')
  const server = await serveFolder(root)
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
    const get = async (path) => { const r = await fetch(server.url + path.replace(/^\//, ''), { redirect: 'manual' }); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() } }
    assert.deepEqual(await get('/'), { status: 200, type: 'text/html; charset=utf-8', text: '<h1>home</h1>' })
    assert.equal((await get('/about/')).text, '<h1>about</h1>')
    assert.equal((await get('/about')).status, 301)
    assert.deepEqual(await get('/style.css?v=2'), { status: 200, type: 'text/css; charset=utf-8', text: 'h1{color:red}' })
    assert.equal((await get('/pretty%20name.txt')).text, 'ok')
    assert.equal((await get('/nothing.html')).status, 404)
    assert.equal((await get('/../original.test.mjs')).status, 404)
  } finally {
    await server.close()
  }
  await assert.rejects(fetch(server.url))
})
