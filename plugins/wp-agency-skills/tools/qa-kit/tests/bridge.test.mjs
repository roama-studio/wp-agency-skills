// the pure parts of `qa-kit bridge` (edit sets for the WordPress bridge plugins).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bridgeOptions, dbChanges, editsReport, elementorEdits, manifestId, mapUrls, payloadPhp, safeThemePath, siteToken, themeFileEdits, unzipCommand, zipFiles,
} from '../lib/bridge.mjs'

const unix = (p) => p.replace(/\\/g, '/')
const A = 'http://127.0.0.1:9510'
const B = 'http://127.0.0.1:9511'

function db(url, over = {}) {
  return {
    url, prefix: 'wp_',
    options: [{ option_name: 'blogname', option_value: 'MySite' }, { option_name: 'siteurl', option_value: url }],
    posts: [{ ID: 54, post_type: 'page', post_status: 'publish', post_title: 'Головна', post_name: 'golovna', post_content: `<a href="${url}/menyu/">x</a>`, post_excerpt: '', menu_order: 0, post_parent: 0, comment_status: 'closed', ping_status: 'closed' }],
    postmeta: [{ post_id: 54, meta_key: 'hero_title', meta_value: 'Старий' }, { post_id: 54, meta_key: 'hero_image', meta_value: `${url}/wp-content/uploads/a.jpg` }],
    terms: [{ term_id: 3, name: 'Салати', slug: 'salaty' }], term_taxonomy: [{ term_id: 3, taxonomy: 'menu_cat', description: '', parent: 0 }],
    termmeta: [], tables: { users: [{ ID: 1 }], flamingo_x: [] },
    ...over,
  }
}

test('options: build takes the two copies, an order name and flags; apply/check/rollback a site and edits.json', () => {
  const o = bridgeOptions(['build', 'C:/w/original', 'C:/w/edited', '--order', 'mytheme-1', '--note', 'Тексти головної', '--allow-unsupported'])
  assert.match(unix(o.original), /w\/original$/)
  assert.match(unix(o.edited), /w\/edited$/)
  assert.equal(o.order, 'mytheme-1')
  assert.equal(o.note, 'Тексти головної')
  assert.equal(o.allowUnsupported, true)
  assert.equal(o.out, null)
  assert.equal(o.warm, true)
  assert.equal(bridgeOptions(['build', 'a', 'b', '--no-warm', '--order', 'x']).warm, false)
  assert.deepEqual([bridgeOptions(['build', 'a', 'b', '--allow-unsupported', '--order', 'x']).original, bridgeOptions(['build', 'a', 'b', '--allow-unsupported', '--order', 'x']).edited].map(unix).map((p) => p.split('/').pop()), ['a', 'b'])
  const a = bridgeOptions(['apply', 'C:/w/site', 'C:/w/edits.json'])
  assert.equal(a.command, 'apply')
  assert.match(unix(a.edits), /w\/edits\.json$/)
  assert.equal(bridgeOptions(['export-plugin']).command, 'export-plugin')
})

test('options: unknown command, a missing order, a bad order name, missing folders are refused', () => {
  assert.throws(() => bridgeOptions([]), /usage/)
  assert.throws(() => bridgeOptions(['build', 'a', 'b']), /--order/)
  assert.throws(() => bridgeOptions(['build', 'a', 'b', '--order', 'a b/c']), /--order/)
  assert.throws(() => bridgeOptions(['build', 'a', '--order', 'x']), /original and the edited/)
  assert.throws(() => bridgeOptions(['apply', 'site']), /edits\.json/)
})

test('siteToken: the copy address (plain and JSON-escaped) becomes one token', () => {
  assert.equal(siteToken(`a ${A}/x "${A.replace(/\//g, '\\/')}\\/y"`, A), 'a {{site}}/x "{{site}}\\/y"')
  assert.equal(siteToken(null, A), null)
})

test('dbChanges: two untouched copies on different ports have no changes', () => {
  const r = dbChanges(db(A), db(B))
  assert.deepEqual(r.targets, [])
  assert.deepEqual(r.unsupported, [])
})

test('dbChanges: a changed option, post field, meta and term are targets; service noise is ignored', () => {
  const b = db(B)
  b.options = [...b.options.map((o) => (o.option_name === 'blogname' ? { ...o, option_value: 'MySite!' } : o)),
    { option_name: '_transient_feed_x', option_value: '1' }, { option_name: 'cron', option_value: 'a:1:{}' }]
  b.posts = [{ ...b.posts[0], post_title: 'Нова головна' }]
  b.postmeta = [...b.postmeta.map((m) => (m.meta_key === 'hero_title' ? { ...m, meta_value: 'Новий' } : m)),
    { post_id: 54, meta_key: '_edit_lock', meta_value: '1:1' }, { post_id: 54, meta_key: 'hero_note', meta_value: 'нове поле' }]
  b.terms = [{ term_id: 3, name: 'Салати й закуски', slug: 'salaty' }]
  const r = dbChanges(db(A), b)
  assert.deepEqual(r.targets.map((t) => [t.type, t.name ?? t.field ?? t.key]).sort(), [
    ['option', 'blogname'], ['post_field', 'post_title'], ['post_meta', 'hero_note'], ['post_meta', 'hero_title'], ['term_field', 'name']].sort())
  assert.equal(r.ignored['option _transient_*'], 1)
  assert.equal(r.ignored.option_cron ?? r.ignored['option cron'], 1)
  assert.equal(r.ignored['meta _edit_lock'], 1)
  assert.deepEqual(r.unsupported, [])
})

test('dbChanges: new and deleted posts, plugins, multi-value meta and plugin tables are reported, not packed', () => {
  const b = db(B)
  b.posts = [...b.posts, { ID: 60, post_type: 'dish', post_status: 'publish', post_title: 'Борщ', post_name: 'borshch' },
    { ID: 61, post_type: 'revision', post_status: 'inherit', post_title: 'r' }]
  b.postmeta = [...b.postmeta, { post_id: 60, meta_key: 'price', meta_value: '120' },
    { post_id: 54, meta_key: 'tags', meta_value: 'a' }, { post_id: 54, meta_key: 'tags', meta_value: 'b' }]
  b.options = [...b.options, { option_name: 'active_plugins', option_value: 'a:1:{i:0;s:3:"x/x";}' }]
  b.tables = { ...b.tables, flamingo_x: [{ id: 1 }] }
  const a = db(A)
  a.posts = [...a.posts, { ID: 40, post_type: 'post', post_status: 'publish', post_title: 'Стара новина' }]
  const r = dbChanges(a, b)
  assert.deepEqual(r.targets, [])
  const text = r.unsupported.join('\n')
  assert.match(text, /новий запис #60 \(dish\) «Борщ»/)
  assert.match(text, /видалений запис #40/)
  assert.match(text, /active_plugins/)
  assert.match(text, /tags має кілька значень/)
  assert.match(text, /wp_flamingo_x/)
  assert.doesNotMatch(text, /price/) // meta of the new post goes with the post
  assert.equal(r.ignored['post revision'], 1)
})

test('dbChanges: a new option is left out (plugin settings) unless named with --include-option (* works)', () => {
  const b = db(B)
  b.options = [...b.options, { option_name: 'updraft_s3', option_value: 'a:0:{}' }, { option_name: 'options_new_field', option_value: 'x' },
    { option_name: '_options_new_field', option_value: 'field_1' }]
  let r = dbChanges(db(A), b)
  assert.deepEqual(r.targets, [])
  assert.deepEqual(r.newOptions.sort(), ['_options_new_field', 'options_new_field', 'updraft_s3'])
  r = dbChanges(db(A), b, { includeOptions: ['options_*', '_options_new_field'] })
  assert.deepEqual(r.targets.map((t) => t.name).sort(), ['_options_new_field', 'options_new_field'])
  assert.deepEqual(r.newOptions, ['updraft_s3'])
  assert.equal(bridgeOptions(['build', 'a', 'b', '--order', 'x', '--include-option', 'options_*, a.b']).includeOptions.join('|'), 'options_*|a.b')
  assert.deepEqual(dbChanges(db(A), b, { includeOptions: ['a.b'] }).targets, []) // the dot is literal
})

test('dbChanges: the plugins\' own bookkeeping options (caches, usage, timestamps) are not edits', () => {
  const a = db(A)
  const b = db(B)
  const names = ['_elementor_design_system_sync_css_meta', 'elementor_pointer_assets_data', 'elementor_controls_usage', 'wpseo_last_run', 'litespeed_cache_counter', 'my_plugin_cache']
  a.options = [...a.options, ...names.map((n) => ({ option_name: n, option_value: '1' })), { option_name: 'elementor_cpt_support', option_value: 'a:1:{i:0;s:4:"page";}' }]
  b.options = [...b.options, ...names.map((n) => ({ option_name: n, option_value: '2' })), { option_name: 'elementor_cpt_support', option_value: 'a:2:{i:0;s:4:"page";i:1;s:4:"post";}' }]
  const r = dbChanges(a, b)
  assert.deepEqual(r.targets.map((t) => t.name), ['elementor_cpt_support'])
  for (const n of names) assert.equal(r.ignored[`option ${n}`], 1, n)
})

test('dbChanges: _elementor_data becomes an elementor_data target', () => {
  const a = db(A, { postmeta: [{ post_id: 54, meta_key: '_elementor_data', meta_value: '[{"id":"a1"}]' }] })
  const b = db(B, { postmeta: [{ post_id: 54, meta_key: '_elementor_data', meta_value: '[{"id":"a1","settings":{"title":"x"}}]' }] })
  assert.deepEqual(dbChanges(a, b).targets.map((t) => [t.type, t.post]), [['elementor_data', 54]])
})

const page = (title, extra = []) => [{ id: 's1', elType: 'section', settings: { gap: 'wide' }, elements: [
  { id: 'c1', elType: 'column', settings: {}, elements: [
    { id: 'w1', elType: 'widget', widgetType: 'heading', settings: { title, size: 'xl' } }, ...extra] }] }]

test('elementorEdits: one edit per changed setting when the page keeps its shape', () => {
  const edits = elementorEdits(5, page('Старий'), page('Новий'), 'page #5')
  assert.deepEqual(edits.map((e) => [e.element, e.setting, e.before, e.after]), [['w1', 'title', 'Старий', 'Новий']])
  assert.match(edits[0].label, /Elementor heading w1: title/)
  const removed = elementorEdits(5, page('a'), [{ ...page('a')[0], settings: {} }])
  assert.deepEqual(removed.map((e) => [e.element, e.setting, e.after]), [['s1', 'gap', null]])
})

test('elementorEdits: an added or moved element = null (the whole data goes as one meta edit)', () => {
  assert.equal(elementorEdits(5, page('a'), page('a', [{ id: 'w2', elType: 'widget', widgetType: 'button', settings: {} }])), null)
})

test('mapUrls: every string in a value gets the live address, plain and JSON-escaped', () => {
  const v = { url: `${B}/a.jpg`, list: [`x ${B.replace(/\//g, '\\/')}\\/b`], n: 3, none: null }
  assert.deepEqual(mapUrls(v, B, 'https://www.mytheme.ua'), { url: 'https://www.mytheme.ua/a.jpg', list: ['x https:\\/\\/www.mytheme.ua\\/b'], n: 3, none: null })
})

test('themeFileEdits: added, changed and removed files; unsafe paths are reported', () => {
  const r = themeFileEdits({ 'style.css': 'a', 'inc/old.php': 'b', 'x.php': 'c' },
    { 'style.css': 'a2', 'assets/new.svg': 'd', 'x.php': 'c', '.htaccess': 'e', 'a/../../wp-config.php': 'f' })
  assert.deepEqual(r.edits.map((e) => [e.path, e.before_sha256, e.after_sha256]), [
    ['assets/new.svg', null, 'd'], ['inc/old.php', 'b', null], ['style.css', 'a', 'a2']])
  assert.equal(r.unsupported.length, 2)
  assert.equal(safeThemePath('inc/hero.php'), true)
  for (const bad of ['../x.php', '/etc/passwd.txt', 'a/../b.php', '.env', 'x.phar', 'a\\b.php', 'C:/x.php']) assert.equal(safeThemePath(bad), false, bad)
})

test('manifestId: the same set gives the same id; another value or file another id', () => {
  const m = { format: 'agency-edits/1', order: 'o', created_at: '1', theme: 't', site: { home: 'h' }, edits: [{ type: 'option', name: 'a', before: '1', after: '2' }] }
  const f = { 'style.css': Buffer.from('x').toString('base64') }
  const id = manifestId(m, f)
  assert.match(id, /^[a-f0-9]{32}$/)
  assert.equal(manifestId({ ...m, created_at: '2' }, f), id)
  assert.notEqual(manifestId({ ...m, edits: [{ ...m.edits[0], after: '3' }] }, f), id)
  assert.notEqual(manifestId(m, { 'style.css': Buffer.from('y').toString('base64') }), id)
})

test('payloadPhp: PHP that exits without WordPress and returns the set as base64 JSON', () => {
  const php = payloadPhp({ manifest: { order: 'Тест' }, files: {} })
  assert.match(php, /^<\?php/)
  assert.match(php, /if \( ! defined\( 'ABSPATH' \) \) \{\n\texit;/)
  const b64 = php.match(/return '([A-Za-z0-9+/=]+)';/)[1]
  assert.deepEqual(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')), { manifest: { order: 'Тест' }, files: {} })
})

test('editsReport: a Ukrainian table of the edits plus what must be done by hand', () => {
  const md = editsReport({ id: 'abc', order: 'o1', created_at: 'now', theme: 'mytheme', site: { home: 'https://v.ua' }, note: '',
    edits: [{ type: 'post_meta', label: 'page #54: поле hero_title', before: 'Старий', after: 'Новий' },
      { type: 'theme_file', label: 'файл теми style.css', before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64) }] },
  ['новий запис #60'], { 'meta _edit_lock': 2 }, ['updraft_s3'])
  assert.match(md, /\| 1 \| поле запису \| page #54: поле hero_title \| Старий \| Новий \|/)
  assert.match(md, /\| 2 \| файл теми .*sha aaaaaaaaaa \| sha bbbbbbbbbb \|/)
  assert.match(md, /## Не переноситься плагіном/)
  assert.match(md, /meta _edit_lock: 2/)
  assert.match(md, /## Нові опції не включено[\s\S]*- updraft_s3/)
})

test('unzipCommand: System32 bsdtar on Windows (Git Bash tar reads no zip), unzip elsewhere', () => {
  assert.deepEqual(unzipCommand('a.zip', 'd', { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } }).args, ['-xf', 'a.zip', '-C', 'd'])
  assert.match(unix(unzipCommand('a.zip', 'd', { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } }).file), /^C:\/Windows\/System32\/tar\.exe$/)
  assert.equal(unzipCommand('a.zip', 'd', { platform: 'linux' }).file, 'unzip')
})

const unzipper = unzipCommand('t.zip', '.')
test('zipFiles: a zip other tools unpack', { skip: spawnSync(unzipper.file, process.platform === 'win32' ? ['--version'] : ['-v'], { windowsHide: true }).status !== 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-bridge-zip-'))
  try {
    const big = Buffer.from('a'.repeat(5000))
    writeFileSync(join(dir, 't.zip'), zipFiles([{ name: 'p/a.txt', data: Buffer.from('привіт') }, { name: 'p/sub/b.txt', data: big }, { name: 'p/empty.txt', data: Buffer.alloc(0) }]))
    const r = spawnSync(unzipper.file, unzipper.args, { cwd: dir, windowsHide: true })
    assert.equal(r.status, 0, String(r.stderr))
    assert.equal(readFileSync(join(dir, 'p', 'a.txt'), 'utf8'), 'привіт')
    assert.deepEqual(readFileSync(join(dir, 'p', 'sub', 'b.txt')), big)
    assert.equal(readFileSync(join(dir, 'p', 'empty.txt')).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
