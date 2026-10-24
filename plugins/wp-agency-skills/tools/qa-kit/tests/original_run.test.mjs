// qa-kit original on a tiny two-page site in a temp git repo: the edited
// page is reported changed with boxes, the other one 0%; the same tree twice is 0%.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { originalCheck } from '../original.mjs'

const GIT = process.env.QA_KIT_GIT || 'git'
const git = (dir, ...args) => execFileSync(GIT, ['-C', dir, '-c', 'user.name=qa', '-c', 'user.email=qa@test', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' }).trim()

const PAGE = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="style.css"></head><body><header><a href="./">Home</a> <a href="menu.html">Menu</a></header>
<main><h1>${title}</h1>${body}</main><footer>© 2025 Bakery</footer></body></html>`

function site(dir, menuBody) {
  writeFileSync(join(dir, 'index.html'), PAGE('Bakery', '<p>Fresh bread every morning.</p><canvas id="c" width="200" height="60"></canvas>'))
  writeFileSync(join(dir, 'menu.html'), PAGE('Menu', menuBody))
  writeFileSync(join(dir, 'style.css'), 'body{margin:0;font:16px/1.5 Arial,sans-serif}main{padding:24px}footer{padding:16px;margin-top:900px;background:#eee}canvas{background:#f80}')
}

test('the edited page is changed with boxes, the untouched page is 0%, the same tree twice is 0%', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-orig-run-'))
  git(dir, 'init', '-q')
  site(dir, '<ul><li>Rye bread</li><li>Croissant</li></ul>')
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'original')
  site(dir, '<ul><li>Rye bread</li><li>Croissant</li><li>Cinnamon roll</li></ul>')
  git(dir, 'commit', '-q', '-am', 'edit: a menu line')

  const report = await originalCheck([dir, '--widths', '390,1024', '--expect', './'])
  assert.equal(report.pages.length, 2)
  assert.deepEqual(report.widths, [390, 1024])
  assert.equal(report.pairs.length, 4)
  for (const p of report.pairs.filter((p) => p.page === '/')) {
    assert.equal(p.changed_ratio, 0, `home at ${p.width}`)
    assert.deepEqual(p.boxes, [])
    assert.equal(p.evidence, null)
    assert.equal(p.masked, 1) // the canvas
  }
  for (const p of report.pairs.filter((p) => p.page === '/menu.html')) {
    assert.ok(p.changed_ratio > 0, `menu at ${p.width}`)
    assert.ok(p.boxes.length >= 1)
    assert.ok(p.height_current > p.height_original, 'one more line makes the page taller')
    assert.ok(p.boxes.every((b) => b.y > 60), 'the change sits below the header')
    assert.ok(existsSync(join(report.out, p.evidence)), p.evidence)
  }
  const menu = report.findings.find((f) => f.page === '/menu.html')
  assert.equal(menu.check, 'original_change')
  assert.equal(menu.level, 'warn') // --expect named only ./
  assert.match(menu.message, /unexpected change/)
  const home = report.findings.find((f) => f.page === '/' && f.check === 'original_unchanged')
  assert.ok(home, 'an expected page without a change is said so')
  assert.equal(report.summary.fail, 0)
  assert.equal(report.servers_stopped, true)
  const written = JSON.parse(readFileSync(join(report.out, 'original-report.json'), 'utf8'))
  assert.equal(written.pairs.length, 4)
  assert.match(report.ref, /^[0-9a-f]{40}$/)
  assert.equal(report.ref, git(dir, 'rev-list', '--max-parents=0', 'HEAD'))
  assert.ok(!existsSync(report.export), 'the temporary export of the original is removed')

  const same = await originalCheck([dir, '--ref', 'HEAD', '--widths', '390,1024', '--expect', 'menu.html'])
  assert.ok(same.pairs.every((p) => p.changed_ratio === 0), JSON.stringify(same.pairs.map((p) => [p.page, p.width, p.changed_ratio])))
  assert.equal(same.findings.filter((f) => f.check === 'original_change').length, 0)
})

// a lazy image that never enters the screen (a hidden filter tab, a slide
// far to the side) never loads; the page must still be compared, not wait forever.
test('a lazy image that never loads does not hang the comparison', { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-orig-lazy-'))
  git(dir, 'init', '-q')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  writeFileSync(join(dir, 'pic.png'), png)
  const page = (h1) => `<!doctype html><html><head><meta charset="utf-8"><title>Gallery</title></head><body><h1>${h1}</h1>
<div style="position:absolute;left:-9000px;top:0;width:200px"><img loading="lazy" src="pic.png" width="200" height="200" alt=""></div>
<div style="display:none"><img loading="lazy" src="pic.png?2" width="200" height="200" alt=""></div></body></html>`
  writeFileSync(join(dir, 'index.html'), page('Gallery'))
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'original')
  writeFileSync(join(dir, 'index.html'), page('Our gallery'))
  git(dir, 'commit', '-q', '-am', 'edit')
  const report = await originalCheck([dir, '--widths', '390', '--expect', './'])
  assert.equal(report.pairs.length, 1)
  assert.ok(report.pairs[0].changed_ratio > 0)
})
