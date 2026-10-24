// end-to-end checks of the bridge plugins in WordPress Playground (slow: minutes;
// not part of `npm test`). Run from the repository root:
//
//   node wp-bridge/tests/e2e.mjs engine   <copy site> <edits.json>
//        conflicts, double apply, rollback conflict, invalid sets, deleting a theme file
//   node wp-bridge/tests/e2e.mjs admin    <copy site> <apply plugin zip> <work folder>
//        the plugins uploaded through wp-admin, the export (downloaded archive, work folder
//        gone), apply + rollback through the page, an editor is refused everywhere, removal
//   node wp-bridge/tests/e2e.mjs php74
//        both engines on PHP 7.4 in a fresh Playground WordPress (tests/php74-smoke.php)
//   node wp-bridge/tests/e2e.mjs elementor <work folder>
//        a throwaway Playground with Elementor: export -> two copies -> heading edited ->
//        edit set per element -> applied on a third copy -> the page shows the new text
//
// <copy site> is a `qa-kit wp-site import` folder that is not running. Every process is
// started hidden (no window on the user's desktop) and stopped at the end.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { bridge, exportPlugin } from '../../bridge.mjs'
import { siteState, siteWpCli, startSite, stopSite, importSite } from '../../wpsite.mjs'
import { hiddenSpawnOptions, playgroundCommand } from '../../lib/wp.mjs'

const [part, ...args] = process.argv.slice(2)
const sha = (s) => createHash('sha256').update(s).digest('hex')
const phpString = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const results = []
function ok(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail })
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
}
const wp = async (site, ...a) => (await siteWpCli(site, a)).out.trim().split('\n').pop()
const run = async (cmd, site, file) => (await bridge([cmd, site, file])).result

async function engineChecks(site, editsFile) {
  const set = JSON.parse(readFileSync(editsFile, 'utf8'))
  const opt = set.manifest.edits.find((e) => e.type === 'option' && typeof e.before === 'string' && e.before)
  const other = set.manifest.edits.find((e) => e.type === 'option' && e !== opt && typeof e.before === 'string')
  assert.ok(opt && other, 'the set needs two string option edits')

  // 1. A conflict: the live value changed after the copy was made -> nothing is written.
  await wp(site, 'option', 'update', opt.name, 'changed on the live site')
  let r = await run('check', site, editsFile)
  ok('conflict: check reports it', r.status === 'conflict' && r.items.some((i) => i.state === 'conflict' && i.current === 'changed on the live site'))
  r = await run('apply', site, editsFile)
  ok('conflict: apply refuses', !r.ok && r.status === 'conflict')
  ok('conflict: no other edit was written', (await wp(site, 'option', 'get', other.name)) === other.before)
  await wp(site, 'option', 'update', opt.name, opt.before)

  // 2. Apply, apply again, a rollback conflict, then the rollback.
  r = await run('apply', site, editsFile)
  ok('apply', r.ok && r.status === 'applied', r.message)
  r = await run('apply', site, editsFile)
  ok('apply twice = nothing more', r.ok && r.status === 'already')
  await wp(site, 'option', 'update', other.name, 'changed after the edits')
  r = await run('rollback', site, editsFile)
  ok('rollback conflict: refused', !r.ok && r.status === 'conflict' && r.conflicts?.length === 1)
  ok('rollback conflict: nothing rolled back', (await wp(site, 'option', 'get', opt.name)) === opt.after)
  await wp(site, 'option', 'update', other.name, other.after)
  r = await run('rollback', site, editsFile)
  ok('rollback', r.ok && r.status === 'rolled_back', r.message)
  ok('rollback restored the values', (await wp(site, 'option', 'get', opt.name)) === opt.before)
  const newFile = set.manifest.edits.find((e) => e.type === 'theme_file' && !e.before_sha256)
  if (newFile) {
    const theme = join(site, 'wordpress', 'wp-content', 'themes', set.manifest.theme)
    ok('rollback removed the new file and its new folder', !existsSync(join(theme, newFile.path)) && !existsSync(join(theme, newFile.path.split('/').slice(0, -1).join('/'))))
  }

  // 3. Invalid sets: nothing outside the theme, no blocked options, no unknown fields.
  const evil = Buffer.from('<?php // evil').toString('base64')
  const bad = {
    manifest: { ...set.manifest, id: 'a'.repeat(32), order: 'invalid', edits: [
      { type: 'theme_file', path: '../../../wp-config.php', before_sha256: null, after_sha256: sha('<?php // evil'), label: 'traversal' },
      { type: 'theme_file', path: 'inc/../../x.php', before_sha256: null, after_sha256: sha('<?php // evil'), label: 'dots' },
      { type: 'theme_file', path: 'inc/x.php', before_sha256: null, after_sha256: sha('another content'), label: 'wrong sha' },
      { type: 'theme_file', path: 'x.phar', before_sha256: null, after_sha256: sha('<?php // evil'), label: 'phar' },
      { type: 'option', name: 'siteurl', before: 'a', after: 'b', label: 'siteurl' },
      { type: 'option', name: 'active_plugins', before: [], after: ['evil/evil.php'], label: 'plugins' },
      { type: 'post_field', post: 1, field: 'post_author', before: '1', after: '2', label: 'author' },
      { type: 'eval', code: 'phpinfo();', label: 'eval' },
    ] },
    files: { '../../../wp-config.php': evil, 'inc/../../x.php': evil, 'inc/x.php': evil, 'x.phar': evil },
  }
  const badFile = join(site, 'invalid-set.json')
  writeFileSync(badFile, JSON.stringify(bad))
  r = await run('check', site, badFile)
  ok('invalid set: every item refused', r.status === 'invalid' && r.items.every((i) => i.state === 'invalid'), r.items.map((i) => `${i.label}: ${i.message}`).join(' | '))
  r = await run('apply', site, badFile)
  ok('invalid set: apply writes nothing', !r.ok && !existsSync(join(site, 'wordpress', 'x.php')) && !existsSync(join(site, 'wordpress', 'wp-content', 'themes', set.manifest.theme, 'inc', 'x.php')))

  // 4. Deleting a theme file, and the rollback bringing it back byte for byte.
  const theme = join(site, 'wordpress', 'wp-content', 'themes', set.manifest.theme)
  writeFileSync(join(theme, 'bridge-delete-me.txt'), 'keep me\n')
  const del = { manifest: { ...set.manifest, id: 'b'.repeat(32), order: 'delete', edits: [
    { type: 'theme_file', path: 'bridge-delete-me.txt', before_sha256: sha('keep me\n'), after_sha256: null, label: 'delete' }] }, files: {} }
  const delFile = join(site, 'delete-set.json')
  writeFileSync(delFile, JSON.stringify(del))
  r = await run('apply', site, delFile)
  ok('delete a theme file', r.ok && !existsSync(join(theme, 'bridge-delete-me.txt')))
  r = await run('rollback', site, delFile)
  ok('rollback brings it back', r.ok && readFileSync(join(theme, 'bridge-delete-me.txt'), 'utf8') === 'keep me\n')
}

// ------------------------------------------------------------------ admin (HTTP)

async function upload(page, url, zip) {
  await page.goto(`${url}/wp-admin/plugin-install.php?tab=upload`, { timeout: 120000 })
  await page.locator('#pluginzip').setInputFiles(zip)
  await page.locator('#install-plugin-submit').click()
  await page.waitForLoadState('load', { timeout: 120000 })
  const activate = page.locator('a.button-primary[href*="action=activate"]')
  await activate.waitFor({ timeout: 120000 })
  await activate.click()
  await page.waitForLoadState('load', { timeout: 120000 })
}

async function exportViaAdmin(page, url, outZip) {
  await page.goto(`${url}/wp-admin/tools.php?page=agency-bridge-export`, { timeout: 120000 })
  await page.locator('[data-do="start"]').click()
  const link = page.locator('[data-role="download"]')
  await link.waitFor({ state: 'visible', timeout: 900000 })
  const text = await page.locator('[data-role="text"]').textContent()
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), link.click()])
  await download.saveAs(outZip)
  return text
}

async function adminChecks(site, applyZip, work) {
  mkdirSync(work, { recursive: true })
  const state = await startSite(site, { quiet: true })
  const url = state.url
  const browser = await chromium.launch()
  try {
    const admin = await browser.newContext({ acceptDownloads: true })
    const page = await admin.newPage()
    page.on('dialog', (d) => d.accept())
    await page.goto(`${url}/wp-admin/?playground_force_auto_login_as_user=${state.admin}`, { timeout: 120000 })

    // Export plugin: upload, export, download.
    await upload(page, url, exportPlugin(join(work, 'dist')))
    const archive = join(work, 'export.zip')
    const text = await exportViaAdmin(page, url, archive)
    const uploads = join(site, 'wordpress', 'wp-content', 'uploads')
    ok('export: archive downloaded', existsSync(archive) && readFileSync(archive).length > 1e6, `${text}`)
    await new Promise((r) => setTimeout(r, 1500))
    ok('export: work folder removed after the download', !readdirSync(uploads).some((n) => /^agency-bridge-[a-f0-9]{32}$/.test(n) && existsSync(join(uploads, n, 'database.sql')))
      && (await wp(site, 'eval', 'echo get_option("agency_bridge_export_job") ? "job" : "none";')) === 'none')

    // Apply plugin: upload, the page, apply, rollback.
    await upload(page, url, applyZip)
    await page.goto(`${url}/wp-admin/tools.php?page=agency-bridge-apply`, { timeout: 120000 })
    const rows = await page.locator('table.widefat tbody tr').count()
    ok('apply page lists the edits', rows > 0, `${rows} rows`)
    await page.locator('button:has-text("Застосувати правки")').click()
    await page.waitForLoadState('load')
    ok('apply page: applied', /застосовано правок/.test(await page.locator('.notice').first().textContent()))
    await page.locator('button:has-text("Відкотити")').click()
    await page.waitForLoadState('load')
    ok('apply page: rolled back', /відкочено правок/.test(await page.locator('.notice').first().textContent()))

    // An editor is refused by every page and handler.
    await siteWpCli(site, ['user', 'create', 'bridge-editor', 'bridge-editor@example.test', '--role=editor'])
    const ed = await browser.newContext()
    const ep = await ed.newPage()
    await ep.goto(`${url}/wp-admin/?playground_force_auto_login_as_user=bridge-editor`, { timeout: 120000 })
    for (const slug of ['agency-bridge-apply', 'agency-bridge-export']) {
      const r = await ep.goto(`${url}/wp-admin/tools.php?page=${slug}`)
      ok(`editor: ${slug} page refused`, r.status() === 403 || /not allowed|Недостатньо прав|не маєте/.test(await ep.content()), `HTTP ${r.status()}`)
    }
    const post = async (path, form) => ed.request.post(`${url}${path}`, { form, maxRedirects: 0 })
    let r = await post('/wp-admin/admin-post.php', { action: 'agency_bridge_apply', do: 'apply', _wpnonce: 'x' })
    ok('editor: apply handler refused', r.status() === 403, `HTTP ${r.status()}`)
    r = await post('/wp-admin/admin-ajax.php', { action: 'agency_bridge_export', do: 'start', _ajax_nonce: 'x' })
    ok('editor: export AJAX refused', r.status() === 403, `HTTP ${r.status()}`)
    r = await ed.request.get(`${url}/wp-admin/admin-post.php?action=agency_bridge_export_download&_wpnonce=x`, { maxRedirects: 0 })
    ok('editor: download refused', r.status() === 403, `HTTP ${r.status()}`)
    // An admin without the nonce is refused as well.
    r = await admin.request.post(`${url}/wp-admin/admin-post.php`, { form: { action: 'agency_bridge_apply', do: 'apply' }, maxRedirects: 0 })
    ok('admin without a nonce: refused', r.status() === 403, `HTTP ${r.status()}`)
    // The payload and the engine are not readable as files.
    for (const f of ['agency-bridge-apply/edits/payload.php', 'agency-bridge-apply/cli.php', 'agency-bridge-apply/includes/class-agency-bridge-edits.php']) {
      r = await ed.request.get(`${url}/wp-content/plugins/${f}`)
      const body = await r.text()
      ok(`direct ${f}: nothing leaks`, !/manifest|agency-edits|base64|class Agency/.test(body) && body.length < 200, `HTTP ${r.status()}, ${body.length} bytes`)
    }

    // Removal through the buttons.
    for (const slug of ['agency-bridge-apply', 'agency-bridge-export']) {
      await page.goto(`${url}/wp-admin/tools.php?page=${slug}`)
      await page.locator('button:has-text("Видалити плагін")').click()
      await page.waitForLoadState('load')
      ok(`remove ${slug}`, !existsSync(join(site, 'wordpress', 'wp-content', 'plugins', slug)))
    }
    return archive
  } finally {
    await browser.close()
    await stopSite(site)
  }
}

// ------------------------------------------------------------------ Elementor

async function elementorChecks(work) {
  work = resolve(work)
  mkdirSync(work, { recursive: true })
  const bp = join(work, 'elementor-blueprint.json')
  const data = [{ id: 'b1a2c3d', elType: 'container', settings: {}, elements: [
    { id: 'e1f2a3b', elType: 'widget', widgetType: 'heading', settings: { title: 'Старий заголовок Elementor' }, elements: [] },
    { id: 'e9f8a7b', elType: 'widget', widgetType: 'text-editor', settings: { editor: '<p>Текст сторінки</p>' }, elements: [] }] }]
  writeFileSync(bp, JSON.stringify({
    steps: [
      { step: 'setSiteOptions', options: { permalink_structure: '/%postname%/', blogname: 'Elementor probe' } },
      { step: 'runPHP', code: `<?php require '/wordpress/wp-load.php'; $id = wp_insert_post(array('post_type'=>'page','post_status'=>'publish','post_title'=>'Probe','post_name'=>'probe')); update_post_meta($id,'_elementor_edit_mode','builder'); update_post_meta($id,'_elementor_template_type','wp-page'); update_post_meta($id,'_elementor_version','3.0.0'); update_post_meta($id,'_elementor_data', wp_slash(${phpString(JSON.stringify(data))}));` },
      // Elementor last: WordPress with Elementor active did not load in a runPHP step.
      { step: 'installPlugin', pluginData: { resource: 'wordpress.org/plugins', slug: 'elementor' }, options: { activate: true } },
    ],
  }))
  const port = 9520
  const cmd = playgroundCommand(['server', `--port=${port}`, '--php=8.3', `--blueprint=${bp}`, '--define-bool', 'PLAYGROUND_FORCE_AUTO_LOGIN_ENABLED', 'true'])
  const child = spawn(cmd.file, cmd.args, hiddenSpawnOptions({ stdio: ['ignore', 'pipe', 'pipe'] }))
  let log = ''
  child.stdout.on('data', (c) => { log += c })
  child.stderr.on('data', (c) => { log += c })
  const url = `http://127.0.0.1:${port}`
  const browser = await chromium.launch()
  try {
    for (let i = 0; i < 600 && !/Ready!/.test(log) && child.exitCode == null; i++) await new Promise((r) => setTimeout(r, 500))
    writeFileSync(join(work, 'elementor-server.log'), log)
    const why = log.split('\n').filter((l) => /Fatal|Error|error:|Warning: /.test(l)).slice(0, 15).join('\n')
    assert.match(log, /Ready!/, `the Elementor Playground did not start (see ${join(work, 'elementor-server.log')}):\n${why}`)
    const ctx = await browser.newContext({ acceptDownloads: true })
    const page = await ctx.newPage()
    page.on('dialog', (d) => d.accept())
    await page.goto(`${url}/wp-admin/?playground_force_auto_login_as_user=admin`, { timeout: 180000 })
    const front = await (await ctx.request.get(`${url}/probe/`)).text()
    ok('elementor: the probe page renders the heading', front.includes('Старий заголовок Elementor'))
    await upload(page, url, exportPlugin(join(work, 'dist')))
    const archive = join(work, 'elementor-export.zip')
    ok('elementor: exported', /Готово/.test(await exportViaAdmin(page, url, archive)))
  } finally {
    await browser.close()
    child.kill()
    // Playground's worker may outlive its parent: stop whatever listens on the port.
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`],
    { windowsHide: true, stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 2000))
  }

  // Two copies from the archive; the heading edited by the element id on one of them.
  const orig = join(work, 'original')
  const edit = join(work, 'edited')
  const third = join(work, 'third')
  for (const [dir, p] of [[orig, 9521], [edit, 9522], [third, 9523]]) {
    if (!existsSync(join(dir, 'site.json'))) await importSite({ source: join(work, 'elementor-export.zip'), site: dir, sql: null, port: p, php: '8.3' })
  }
  const s = siteState(edit)
  ok('elementor: archive imported (no failed statements)', s.import.failed === 0, `${s.import.ran}/${s.import.statements}`)
  const pageId = (await wp(edit, 'post', 'list', '--post_type=page', '--name=probe', '--field=ID')).trim()
  await siteWpCli(edit, ['eval', `$d=json_decode(get_post_meta(${pageId},'_elementor_data',true),true); $d[0]['elements'][0]['settings']['title']='Новий заголовок Elementor'; update_post_meta(${pageId},'_elementor_data',wp_slash(wp_json_encode($d))); echo 'ok';`])
  const built = await bridge(['build', orig, edit, '--order', 'elementor-probe', '--out', join(work, 'set')])
  const el = built.manifest.edits.filter((e) => e.type === 'elementor')
  ok('elementor: one edit per element setting', el.length === 1 && el[0].element === 'e1f2a3b' && el[0].setting === 'title' && el[0].after === 'Новий заголовок Elementor',
    JSON.stringify(built.manifest.edits.map((e) => [e.type, e.element ?? e.key ?? e.name, e.setting])))
  const set = join(work, 'set', 'edits.json')
  let r = await run('apply', third, set)
  ok('elementor: applied on the third copy', r.ok, r.message)
  await startSite(third, { quiet: true })
  try {
    const html = await (await fetch(`${siteState(third).url}/probe/`)).text()
    ok('elementor: the page shows the new heading', html.includes('Новий заголовок Elementor') && !html.includes('Старий заголовок Elementor'))
    ok('elementor: the other widget kept its text', html.includes('Текст сторінки'))
  } finally {
    await stopSite(third)
  }
  r = await run('rollback', third, set)
  ok('elementor: rolled back', r.ok, r.message)
  const raw = await wp(third, 'post', 'meta', 'get', pageId, '_elementor_data')
  ok('elementor: the data is the original again', raw.includes('Старий заголовок Elementor'))
}

// Both engines on PHP 7.4 in a fresh Playground WordPress (tests/php74-smoke.php).
async function php74() {
  const cmd = playgroundCommand(['php', '--php=7.4', '--mount-dir', fileURLToPath(new URL('..', import.meta.url)), '/qa-bridge', '--', '/qa-bridge/tests/php74-smoke.php'])
  const out = await new Promise((done, fail) => {
    const child = spawn(cmd.file, cmd.args, hiddenSpawnOptions({ env: { ...process.env, MSYS_NO_PATHCONV: '1' } }))
    let text = ''
    child.stdout.on('data', (c) => { text += c })
    child.stderr.on('data', (c) => { text += c })
    child.on('error', fail)
    child.on('exit', () => done(text))
  })
  const line = out.split('\n').reverse().find((l) => l.trim().startsWith('{'))
  if (!line) throw new Error(`no result from PHP 7.4:\n${out.slice(-2000)}`)
  const r = JSON.parse(line)
  ok('php 7.4: runs', /^7\.4\./.test(r.php), r.php)
  ok('php 7.4: apply + rollback', r.check === 'ready' && r.apply === 'applied' && r.applied && r.rollback === 'rolled_back' && r.restored, line)
  ok('php 7.4: export in small steps', r.export === 'done' && r.export_steps > 3 && r.export_has_db && r.export_cleaned, `${r.export_steps} steps, ${r.export_bytes} bytes`)
  ok('php 7.4: export through PclZip (no zip extension)', r.pclzip === 'done' && r.pclzip_ok, `${r.pclzip_steps} steps`)
}

try {
  if (part === 'php74') await php74()
  else if (part === 'engine') await engineChecks(resolve(args[0]), resolve(args[1]))
  else if (part === 'admin') await adminChecks(resolve(args[0]), resolve(args[1]), resolve(args[2]))
  else if (part === 'elementor') await elementorChecks(args[0])
  else throw new Error('usage: e2e.mjs php74 | engine <site> <edits.json> | admin <site> <apply zip> <work> | elementor <work>')
} finally {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) process.exitCode = 1
}
