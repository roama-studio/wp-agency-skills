// qa-kit bridge export-plugin|build|check|apply|rollback
//
// The WordPress bridge for partner sites we reach only through wp-admin:
//   export-plugin  the zip of the "Агенція: експорт" plugin (wp-bridge/export): the
//                  site owner uploads it, exports, downloads the archive; `qa-kit wp-site
//                  import <archive.zip>` turns that into a Playground copy.
//   build          the edit set of an order: what changed between the original and the
//                  edited copy (their SQLite databases and the active theme's files),
//                  values read on both copies by the same PHP engine the plugin uses
//                  (wp-bridge/apply, `cli.php read`), the copy's address turned back into
//                  the live one. Writes edits.json (also for WP-CLI over SSH), EDITS.md
//                  and the "Агенція: правки" plugin zip with the set inside.
//   check|apply|rollback  the engine on a Playground copy (a dry run of the plugin).
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import {
  FORMAT, POST_FIELDS, bridgeOptions, dbChanges, editsReport, elementorEdits, manifestId, mapUrls, payloadPhp, sha256, themeFileEdits, zipFiles,
} from './lib/bridge.mjs'
import { healthSite, siteImportDir, siteState, siteWpCli, startSite, stopSite } from './wpsite.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(here, 'wp-bridge')
const DIST = join(BRIDGE, 'dist')

// Every file under a folder: { relative path: Buffer } (or sha256 with hash: true).
function tree(dir, { hash = false } = {}) {
  const out = {}
  if (!existsSync(dir)) return out
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) {
        const rel = relative(dir, abs).replace(/\\/g, '/')
        const data = readFileSync(abs)
        out[rel] = hash ? sha256(data) : data
      }
    }
  }
  walk(dir)
  return out
}

function pluginZip(folder, slug, extra = {}) {
  const files = tree(join(BRIDGE, folder))
  const entries = Object.entries({ ...files, ...extra })
    .filter(([rel]) => !/^(dist|tests)\//.test(rel))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rel, data]) => ({ name: `${slug}/${rel}`, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') }))
  return zipFiles(entries)
}

export function exportPlugin(out = DIST) {
  mkdirSync(out, { recursive: true })
  const file = join(out, 'agency-bridge-export.zip')
  writeFileSync(file, pluginZip('export', 'agency-bridge-export'))
  return file
}

// The content tables of a copy (its SQLite file, read-only; works while it is served).
function readDb(site) {
  const state = siteState(site)
  const file = join(site, 'wordpress', 'wp-content', 'database', '.ht.sqlite')
  if (!existsSync(file)) throw new Error(`${site} has no database (${file})`)
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const p = state.prefix
    const q = (sql) => db.prepare(sql).all()
    const names = q("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name)
      .filter((n) => n.startsWith(p) && !n.startsWith('_') && !n.startsWith('sqlite_'))
    const has = (t) => names.includes(p + t)
    const rows = (t, cols, order) => (has(t) ? q(`SELECT ${cols} FROM "${p}${t}" ORDER BY ${order}`) : [])
    const core = ['options', 'posts', 'postmeta', 'terms', 'term_taxonomy', 'termmeta']
    const tables = {}
    for (const n of names) {
      const t = n.slice(p.length)
      if (!core.includes(t)) tables[t] = q(`SELECT * FROM "${n}" ORDER BY rowid`)
    }
    return {
      url: state.url, prefix: p, state,
      options: rows('options', 'option_name, option_value', 'option_name'),
      posts: rows('posts', `ID, post_type, ${POST_FIELDS.join(', ')}`, 'ID'),
      postmeta: rows('postmeta', 'post_id, meta_key, meta_value', 'meta_id'),
      terms: rows('terms', 'term_id, name, slug', 'term_id'),
      term_taxonomy: rows('term_taxonomy', 'term_id, taxonomy, description, parent', 'term_taxonomy_id'),
      termmeta: rows('termmeta', 'term_id, meta_key, meta_value', 'meta_id'),
      tables,
    }
  } finally {
    db.close()
  }
}

const lastJson = (out) => {
  const line = out.split('\n').reverse().find((l) => l.trim().startsWith('{'))
  if (!line) throw new Error(`the bridge engine printed no result:\n${out.slice(-1500)}`)
  return JSON.parse(line)
}

// The engine (wp-bridge/apply/cli.php) on a copy: read | check | apply | rollback.
async function engine(site, file, action) {
  const name = `bridge-${randomBytes(6).toString('hex')}.json`
  const copy = join(siteImportDir(site), name)
  writeFileSync(copy, readFileSync(file))
  try {
    const r = await siteWpCli(site, ['eval-file', '/qa-bridge/cli.php', `/qa-import/${name}`, action],
      { extra: ['--mount-dir', join(BRIDGE, 'apply'), '/qa-bridge'] })
    return lastJson(r.out)
  } finally {
    rmSync(copy, { force: true })
  }
}

async function readValues(site, targets) {
  const dir = siteImportDir(site)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `targets-${randomBytes(6).toString('hex')}.json`)
  writeFileSync(file, JSON.stringify(targets))
  const r = await engine(site, file, 'read').finally(() => rmSync(file, { force: true }))
  if (!r.ok || r.values.length !== targets.length) throw new Error(`reading the values on ${site} failed: ${JSON.stringify(r).slice(0, 500)}`)
  return r.values
}

const plainAliases = (state, home) => [...new Set((state.replacements ?? []).map((x) => x.from)
  .filter((u) => !u.includes('\\/') && u !== home))]

// Plugins write their own settings the first time wp-admin opens (UpdraftPlus: a dozen
// options). Both copies open the home page and wp-admin once before the comparison, so
// that noise lands in both and only the real edits differ.
async function warm(site) {
  const state = await startSite(site, { quiet: true })
  try {
    await healthSite(site)
  } finally {
    if (!state.already) await stopSite(site)
  }
}

export async function build(o) {
  if (o.warm !== false) for (const site of [o.original, o.edited]) await warm(site)
  const A = readDb(o.original)
  const B = readDb(o.edited)
  const live = (B.state.live?.home ?? B.state.live?.siteurl ?? '').replace(/\/+$/, '')
  if (!live) throw new Error(`${o.edited}/site.json names no live address (live.home): cannot map the copy's address back`)
  const opt = (db, name) => db.options.find((r) => r.option_name === name)?.option_value ?? null
  const theme = opt(B, 'stylesheet')
  const template = opt(B, 'template')
  const ch = dbChanges(A, B, { includeOptions: o.includeOptions ?? [] })
  const unsupported = [...ch.unsupported]

  // Files: the active theme is packed; anything else that changed is reported.
  const wpc = (site) => join(site, 'wordpress', 'wp-content')
  const ta = tree(join(wpc(o.original), 'themes', theme), { hash: true })
  const tb = tree(join(wpc(o.edited), 'themes', theme), { hash: true })
  const themeEdits = themeFileEdits(ta, tb)
  unsupported.push(...themeEdits.unsupported)
  const others = [['plugins', 'плагіни'], ['mu-plugins', 'mu-plugins'], ...(template && template !== theme ? [[`themes/${template}`, `батьківська тема ${template}`]] : [])]
  for (const [rel, what] of others) {
    const fa = tree(join(wpc(o.original), rel), { hash: true })
    const fb = tree(join(wpc(o.edited), rel), { hash: true })
    const changed = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].filter((k) => fa[k] !== fb[k])
    if (changed.length) unsupported.push(`${what}: змінено файлів ${changed.length} (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', …' : ''}): плагін їх не переносить`)
  }
  const ua = new Set(Object.keys(tree(join(wpc(o.original), 'uploads'))))
  const newUploads = Object.keys(tree(join(wpc(o.edited), 'uploads'))).filter((k) => !ua.has(k) && !/^agency-bridge-[a-f0-9]{32}\//.test(k))
  if (newUploads.length) unsupported.push(`нові файли в uploads: ${newUploads.length} (${newUploads.slice(0, 3).join(', ')}${newUploads.length > 3 ? ', …' : ''}): медіа додаються вручну`)

  // Values: the same PHP reader on both copies, the address mapped back to the live site.
  const reads = ch.targets.map((t) => (t.type === 'elementor_data' ? { type: 'post_meta', post: t.post, key: '_elementor_data' } : t))
  const [va, vb] = await Promise.all([readValues(o.original, reads), readValues(o.edited, reads)])
  const edits = []
  ch.targets.forEach((t, i) => {
    if (va[i].error || vb[i].error) { unsupported.push(`${t.label}: ${va[i].error ?? vb[i].error}`); return }
    const before = mapUrls(va[i].value, A.url, live)
    const after = mapUrls(vb[i].value, B.url, live)
    if (JSON.stringify(before) === JSON.stringify(after)) return
    const { type: _t, ...where } = t
    if (t.type !== 'elementor_data') { edits.push({ ...t, before, after }); return }
    let pa = null
    let pb = null
    try { pa = JSON.parse(va[i].value ?? 'null'); pb = JSON.parse(vb[i].value ?? 'null') } catch { /* not JSON: whole value */ }
    const per = Array.isArray(pa) && Array.isArray(pb)
      ? elementorEdits(t.post, mapUrls(pa, A.url, live), mapUrls(pb, B.url, live), t.label.replace(/: Elementor$/, '')) : null
    if (per) edits.push(...per)
    else edits.push({ type: 'post_meta', post: t.post, key: '_elementor_data', before, after, label: `${where.label} (уся сторінка: змінено структуру)` })
  })
  const files = {}
  for (const e of themeEdits.edits) {
    if (e.after_sha256) files[e.path] = readFileSync(join(wpc(o.edited), 'themes', theme, e.path)).toString('base64')
    edits.push(e)
  }

  const manifest = {
    format: FORMAT, id: '', order: o.order, created_at: new Date().toISOString(), note: o.note ?? '', theme,
    site: { home: live, aliases: plainAliases(B.state, live) }, edits,
    source: { original: o.original, edited: o.edited },
  }
  manifest.id = manifestId(manifest, files)
  const out = o.out ?? join(o.edited, 'bridge', o.order)
  mkdirSync(out, { recursive: true })
  const payload = { manifest, files }
  writeFileSync(join(out, 'edits.json'), JSON.stringify(payload, null, 1))
  writeFileSync(join(out, 'EDITS.md'), editsReport(manifest, unsupported, ch.ignored, ch.newOptions))
  let zip = null
  if (edits.length && (!unsupported.length || o.allowUnsupported)) {
    zip = join(out, `agency-bridge-apply-${o.order}.zip`)
    writeFileSync(zip, pluginZip('apply', 'agency-bridge-apply', { 'edits/payload.php': payloadPhp(payload), 'edits/index.php': '<?php\n// Silence is golden.\n' }))
  }
  return { out, manifest, unsupported, ignored: ch.ignored, newOptions: ch.newOptions, zip }
}

export async function bridge(args) {
  const o = bridgeOptions(args)
  if (o.command === 'export-plugin') return { command: o.command, file: exportPlugin(o.out ?? DIST) }
  if (o.command === 'build') return { command: o.command, ...(await build(o)) }
  if (!existsSync(o.edits)) throw new Error(`${o.edits} does not exist`)
  // A dry run on a copy: the set speaks of the live address, the copy has its own.
  const payload = JSON.parse(readFileSync(o.edits, 'utf8'))
  const url = siteState(o.site).url
  const home = payload.manifest?.site?.home
  if (home && home !== url) {
    payload.manifest.edits = payload.manifest.edits.map((e) => ({ ...e, ...('before' in e ? { before: mapUrls(e.before, home, url) } : {}), ...('after' in e ? { after: mapUrls(e.after, home, url) } : {}) }))
    payload.manifest.site = { home: url, aliases: [] }
  }
  const tmp = join(siteImportDir(o.site), `set-${randomBytes(6).toString('hex')}.json`)
  writeFileSync(tmp, JSON.stringify(payload))
  try {
    return { command: o.command, result: await engine(o.site, tmp, o.command) }
  } finally {
    rmSync(tmp, { force: true })
  }
}
