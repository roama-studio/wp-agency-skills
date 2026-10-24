import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  axeFindings, grade, imageFindings, merge, overflowFinding, pagesFrom, perfFindings,
  regressionFinding, summarize,
} from '../lib/judge.mjs'

const rules = JSON.parse(readFileSync(new URL('../rules.json', import.meta.url)))

test('rules cover every width the QA checklist needs, from 320', () => {
  for (const w of [320, 360, 390, 428, 768, 1440, 1920, 2560]) assert.ok(rules.widths.includes(w))
  assert.equal(rules.zoom.factor, 2)
})

test('grade: ok below warn, warn between, fail at or above fail', () => {
  assert.equal(grade(100, { warn: 200, fail: 400 }), 'ok')
  assert.equal(grade(250, { warn: 200, fail: 400 }), 'warn')
  assert.equal(grade(400, { warn: 200, fail: 400 }), 'fail')
})

test('overflow: a page wider than the viewport fails, an equal one passes', () => {
  assert.equal(overflowFinding({ page: '/', width: 320, scrollWidth: 320 }), null)
  const f = overflowFinding({ page: '/', width: 320, scrollWidth: 372, browser: 'chromium', screenshot: 's.png' })
  assert.equal(f.check, 'horizontal_overflow')
  assert.equal(f.level, 'fail')
  assert.equal(f.width, 320)
  assert.equal(f.screenshot, 's.png')
  assert.match(f.message, /372/)
})

test('axe: critical and serious fail, moderate warns, minor is dropped', () => {
  const violations = [
    { id: 'color-contrast', impact: 'serious', help: 'Contrast', nodes: [{ target: ['.a'] }, { target: ['.b'] }] },
    { id: 'region', impact: 'moderate', help: 'Landmarks', nodes: [{ target: ['div'] }] },
    { id: 'x', impact: 'minor', help: 'Minor', nodes: [{ target: ['p'] }] },
  ]
  const found = axeFindings(violations, { page: '/', width: 1440 }, rules)
  assert.deepEqual(found.map((f) => [f.check, f.level]), [['axe:color-contrast', 'fail'], ['axe:region', 'warn']])
  assert.match(found[0].message, /2 element/)
  assert.match(found[0].message, /\.a/)
})

test('performance: slow LCP fails, CLS warns, fast page has no findings', () => {
  const p = rules.performance
  const ok = perfFindings({ lcp_ms: 900, cls: 0.01, long_tasks_ms: 0, page_kb: 400, js_kb: 50 }, { page: '/' }, p)
  assert.deepEqual(ok, [])
  const bad = perfFindings({ lcp_ms: p.lcp_ms.fail + 1, cls: p.cls.warn + 0.01, long_tasks_ms: 0, page_kb: 400, js_kb: 50 },
    { page: '/' }, p)
  assert.deepEqual(bad.map((f) => [f.check, f.level]), [['performance:lcp_ms', 'fail'], ['performance:cls', 'warn']])
})

test('performance: an unmeasured LCP is reported, not passed silently', () => {
  const found = perfFindings({ lcp_ms: null, cls: 0, long_tasks_ms: 0, page_kb: 1, js_kb: 1 }, { page: '/' },
    rules.performance)
  assert.equal(found[0].check, 'performance:lcp_ms')
  assert.equal(found[0].level, 'info')
})

test('images: heavy files and images much larger than shown are named', () => {
  const p = rules.performance
  const found = imageFindings([
    { src: '/big.jpg', kb: p.image_kb.fail + 10, natural_width: 1600, shown_width: 1600 },
    { src: '/huge.jpg', kb: 50, natural_width: 4000, shown_width: 390 },
    { src: '/fine.webp', kb: 40, natural_width: 780, shown_width: 390 },
  ], { page: '/', width: 390 }, p)
  assert.deepEqual(found.map((f) => [f.check, f.level]), [['image_weight', 'fail'], ['image_oversize', 'warn']])
  assert.match(found[1].message, /huge\.jpg/)
})

test('regression: a page that changed more than the tolerance warns with the diff picture', () => {
  const tol = rules.regression
  assert.equal(regressionFinding({ page: '/', width: 390, ratio: 0, diff: 'd.png' }, tol), null)
  const f = regressionFinding({ page: '/', width: 390, ratio: tol.changed_ratio + 0.05, diff: 'd.png' }, tol)
  assert.equal(f.check, 'regression')
  assert.equal(f.level, 'warn')
  assert.equal(f.screenshot, 'd.png')
  const resized = regressionFinding({ page: '/', width: 390, ratio: 1, size_changed: true, diff: null }, tol)
  assert.match(resized.message, /height/)
})

test('pagesFrom: same-origin pages only, without hashes, files or duplicates', () => {
  const pages = pagesFrom('http://127.0.0.1:5173/', [
    'http://127.0.0.1:5173/rooms.html#top', 'http://127.0.0.1:5173/rooms.html',
    'http://127.0.0.1:5173/#contacts', 'https://instagram.com/x', 'mailto:a@b.c', 'tel:+380',
    'http://127.0.0.1:5173/menu.pdf', 'http://127.0.0.1:5173/img/a.jpg', 'http://127.0.0.1:5173/about/',
  ])
  assert.deepEqual(pages, ['/rooms.html', '/about/'])
})

test('summarize counts levels and lists the checks that failed', () => {
  const s = summarize([
    { check: 'a', level: 'fail' }, { check: 'a', level: 'fail' }, { check: 'b', level: 'warn' },
    { check: 'c', level: 'info' },
  ])
  assert.deepEqual(s, { fail: 2, warn: 1, info: 1, failed_checks: ['a'] })
})

test('merge: the same problem at several widths becomes one finding with its widths', () => {
  const merged = merge([
    { check: 'console', level: 'fail', page: '/', width: 320, browser: 'chromium', message: 'error: x', screenshot: null },
    { check: 'console', level: 'fail', page: '/', width: 1440, browser: 'chromium', message: 'error: x', screenshot: 'a.png' },
    { check: 'console', level: 'fail', page: '/a', width: 320, browser: 'chromium', message: 'error: x', screenshot: null },
  ])
  assert.equal(merged.length, 2)
  assert.deepEqual(merged[0].widths, [320, 1440])
  assert.equal(merged[0].screenshot, 'a.png')
})
