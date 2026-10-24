// Pure parts of `qa-kit bridge`: what changed between the original and the
// edited Playground copy of a client's WordPress site (rows of their SQLite databases,
// files of the active theme), Elementor edits per element, the edit set (manifest
// "agency-edits/1"), the plugin's payload.php and a small zip writer (no dependency).
// No server, no database here: the callers pass rows and file lists.
import { createHash } from 'node:crypto'
import { crc32, deflateRawSync } from 'node:zlib'
import { join, resolve } from 'node:path'

export const FORMAT = 'agency-edits/1'
export const POST_FIELDS = ['post_title', 'post_content', 'post_excerpt', 'post_name', 'post_status', 'menu_order', 'post_parent', 'comment_status', 'ping_status']

const list = (v) => v?.split(',').map((x) => x.trim()).filter(Boolean) ?? []
const COMMANDS = ['export-plugin', 'build', 'check', 'apply', 'rollback']
export const USAGE = 'usage:\n'
  + '  qa-kit bridge export-plugin [--out <folder>]\n'
  + '  qa-kit bridge build <original site> <edited site> --order <name> [--note "<text>"] [--out <folder>] [--allow-unsupported]\n'
  + '  qa-kit bridge check|apply|rollback <site> <edits.json>'

export function bridgeOptions(args) {
  const [command, ...rest] = args
  if (!COMMANDS.includes(command)) throw new Error(USAGE)
  const opt = (name, fallback = null) => {
    const i = rest.indexOf(`--${name}`)
    return i >= 0 ? rest[i + 1] : fallback
  }
  const flags = ['allow-unsupported', 'no-warm']
  const folders = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && !flags.includes(rest[i - 1].slice(2))))
  if (command === 'export-plugin') return { command, out: opt('out') ? resolve(opt('out')) : null }
  if (command === 'build') {
    if (folders.length < 2) throw new Error(`build needs the original and the edited site folders\n${USAGE}`)
    const order = opt('order')
    if (!order || !/^[\w.-]{1,80}$/.test(order)) throw new Error(`--order <name> (letters, digits, . _ -) names the edit set, e.g. --order mytheme-2026-10-24\n${USAGE}`)
    return {
      command, original: resolve(folders[0]), edited: resolve(folders[1]), order, note: opt('note', ''),
      out: opt('out') ? resolve(opt('out')) : null, allowUnsupported: rest.includes('--allow-unsupported'), warm: !rest.includes('--no-warm'),
      includeOptions: list(opt('include-option')),
    }
  }
  if (folders.length < 2) throw new Error(`${command} needs a site folder and an edits.json\n${USAGE}`)
  return { command, site: resolve(folders[0]), edits: resolve(folders[1]) }
}

// ---------------------------------------------------------------- what is not an edit

// Options WordPress, caches and Playground change by themselves.
const IGNORED_OPTIONS = /^(_site_transient_.*|_transient_.*|cron|rewrite_rules|recently_edited|recently_activated|auto_updater\.lock|core_updater\.lock|db_upgraded|can_compress_scripts|recovery_keys|recovery_mode_email_last_sent|siteurl|home|fresh_site|finished_updating_comment_type|wp_force_deactivated_plugins|elementor_remote_info_library|elementor_remote_info_feed_data|_elementor_global_css|elementor_log|_elementor_installed_time|elementor_version|elementor_install_history|nonce_key|nonce_salt|auth_key|auth_salt|logged_in_key|logged_in_salt|secret_key|agency_bridge_\w+|user_count|https_detection_errors|wp_attachment_pages_enabled|upload_url_path)$/
// Plugins' own bookkeeping (caches, counters, usage stats, timestamps): Elementor writes
// _elementor_design_system_sync_css_meta and elementor_pointer_assets_data on its own.
const SERVICE_OPTIONS = /(^|_)(cache|cached|transient)(_|$)|assets_data|css_meta|_usage$|usage_data|counter$|_lock$|(^|_)last_(run|check|sync|update)|_timestamp$|_updated?_time$|_install(ed)?_time$|_activation_time$|pointer/
// Options a set may not change (the engine refuses them): reported, never packed.
const BLOCKED_OPTIONS = /^(active_plugins|active_sitewide_plugins|template|stylesheet|admin_email|new_admin_email|users_can_register|default_role|[a-z0-9_]*user_roles|db_version|initial_db_version)$/
const IGNORED_META = /^(_edit_lock|_edit_last|_elementor_css|_elementor_element_cache|_elementor_page_assets|_wp_old_slug|_wp_old_date|_encloseme|_pingme|_wp_trash_meta_status|_wp_trash_meta_time|_wp_desired_post_slug)$/
const IGNORED_POST_TYPES = /^(revision|customize_changeset|oembed_cache|user_request|flamingo_inbound|flamingo_contact|flamingo_outbound|wp_font_face|wp_font_family)$/
// Tables of other things than content: users and their sessions, comments, links.
const IGNORED_TABLES = /^(users|usermeta|comments|commentmeta|links)$/

// A value with the copy's own address replaced by one token (both copies have their own port).
export function siteToken(value, url) {
  if (value == null) return value
  const esc = url.replace(/\//g, '\\/')
  return String(value).split(esc).join('{{site}}').split(url).join('{{site}}')
}

const metaKey = (id, key) => `${id}\u0000${key}`

function group(rows, keyOf) {
  const m = new Map()
  for (const r of rows) {
    const k = keyOf(r)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(r)
  }
  return m
}

/**
 * The changes between two copies. db = { prefix, options, posts, postmeta, terms,
 * term_taxonomy, termmeta, tables: { name: rows } } of each copy, with its url.
 * Returns { targets: [{type, ...}], unsupported: [text], ignored: { what: count } }.
 */
export function dbChanges(a, b, { includeOptions = [] } = {}) {
  const pattern = (p) => new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  const included = (name) => includeOptions.some((p) => pattern(p).test(name))
  const newOptions = []
  const targets = []
  const unsupported = []
  const ignored = {}
  const skip = (what) => { ignored[what] = (ignored[what] ?? 0) + 1 }
  const ta = (v) => siteToken(v, a.url)
  const tb = (v) => siteToken(v, b.url)

  // Options.
  const oa = new Map(a.options.map((r) => [r.option_name, ta(r.option_value)]))
  const ob = new Map(b.options.map((r) => [r.option_name, tb(r.option_value)]))
  for (const name of new Set([...oa.keys(), ...ob.keys()])) {
    if (oa.get(name) === ob.get(name)) continue
    if (IGNORED_OPTIONS.test(name)) { skip(`option ${name.replace(/^(_site_transient_|_transient_).*/, '$1*')}`); continue }
    if (SERVICE_OPTIONS.test(name)) { skip(`option ${name}`); continue }
    if (BLOCKED_OPTIONS.test(name)) { unsupported.push(`опція ${name} (плагіни, тема, ролі, адреса): змінюється вручну в адмінці`); continue }
    // A new option is often a plugin's own setting written when an admin page opened:
    // only the ones named with --include-option go into the set.
    if (!oa.has(name) && !included(name)) { newOptions.push(name); continue }
    targets.push({ type: 'option', name, label: `опція ${name}` })
  }

  // Posts: existing ones field by field; new or deleted ones are not supported.
  const live = (p) => !IGNORED_POST_TYPES.test(p.post_type) && p.post_status !== 'auto-draft'
  const pa = new Map(a.posts.map((p) => [Number(p.ID), p]))
  const pb = new Map(b.posts.map((p) => [Number(p.ID), p]))
  const newPosts = new Set()
  for (const [id, p] of pb) {
    const old = pa.get(id)
    if (!old) {
      if (live(p)) { unsupported.push(`новий запис #${id} (${p.post_type}) «${p.post_title}»: додається вручну в адмінці`); newPosts.add(id) } else skip(`post ${p.post_type || p.post_status}`)
      continue
    }
    if (!live(old) && !live(p)) continue
    for (const field of POST_FIELDS) {
      if (ta(old[field]) === tb(p[field])) continue
      targets.push({ type: 'post_field', post: id, field, label: `${p.post_type} #${id} «${p.post_title}»: ${field}` })
    }
  }
  for (const [id, p] of pa) {
    if (!pb.has(id) && live(p)) unsupported.push(`видалений запис #${id} (${p.post_type}) «${p.post_title}»: видаляється вручну (або статус «чернетка» / «кошик» як правка)`)
  }
  const title = (id) => { const p = pb.get(id) ?? pa.get(id); return p ? `${p.post_type} #${id} «${p.post_title}»` : `запис #${id}` }

  // Post meta: one value per key is supported; Elementor data per element (later).
  const ma = group(a.postmeta, (r) => metaKey(r.post_id, r.meta_key))
  const mb = group(b.postmeta, (r) => metaKey(r.post_id, r.meta_key))
  for (const k of new Set([...ma.keys(), ...mb.keys()])) {
    const va = (ma.get(k) ?? []).map((r) => ta(r.meta_value))
    const vb = (mb.get(k) ?? []).map((r) => tb(r.meta_value))
    if (JSON.stringify(va) === JSON.stringify(vb)) continue
    const [id, key] = k.split('\u0000')
    const post = Number(id)
    if (newPosts.has(post) || (!pa.has(post) && !pb.has(post))) continue
    const p = pb.get(post) ?? pa.get(post)
    if (p && !live(p)) { skip(`meta of ${p.post_type || p.post_status}`); continue }
    if (IGNORED_META.test(key)) { skip(`meta ${key}`); continue }
    if (va.length > 1 || vb.length > 1) { unsupported.push(`${title(post)}: поле ${key} має кілька значень`); continue }
    if (key === '_elementor_data') targets.push({ type: 'elementor_data', post, label: `${title(post)}: Elementor` })
    else targets.push({ type: 'post_meta', post, key, label: `${title(post)}: поле ${key}` })
  }

  // Terms (name, slug in terms; description, parent in term_taxonomy) and their meta.
  const termRows = (db) => {
    const tt = new Map(db.term_taxonomy.map((r) => [Number(r.term_id), r]))
    return new Map(db.terms.map((t) => [Number(t.term_id), { ...t, ...(tt.get(Number(t.term_id)) ?? {}) }]))
  }
  const xa = termRows(a)
  const xb = termRows(b)
  for (const [id, t] of xb) {
    const old = xa.get(id)
    if (!old) { unsupported.push(`новий термін #${id} (${t.taxonomy}) «${t.name}»: додається вручну`); continue }
    for (const field of ['name', 'slug', 'description', 'parent']) {
      if (ta(old[field]) === tb(t[field])) continue
      targets.push({ type: 'term_field', term: id, field, label: `${t.taxonomy} #${id} «${t.name}»: ${field}` })
    }
  }
  for (const [id, t] of xa) if (!xb.has(id)) unsupported.push(`видалений термін #${id} (${t.taxonomy}) «${t.name}»: видаляється вручну`)
  const tma = group(a.termmeta, (r) => metaKey(r.term_id, r.meta_key))
  const tmb = group(b.termmeta, (r) => metaKey(r.term_id, r.meta_key))
  for (const k of new Set([...tma.keys(), ...tmb.keys()])) {
    const va = (tma.get(k) ?? []).map((r) => ta(r.meta_value))
    const vb = (tmb.get(k) ?? []).map((r) => tb(r.meta_value))
    if (JSON.stringify(va) === JSON.stringify(vb)) continue
    const [id, key] = k.split('\u0000')
    if (!xa.has(Number(id)) || !xb.has(Number(id))) continue
    if (va.length > 1 || vb.length > 1) { unsupported.push(`термін #${id}: поле ${key} має кілька значень`); continue }
    targets.push({ type: 'term_meta', term: Number(id), key, label: `термін #${id} «${xb.get(Number(id)).name}»: поле ${key}` })
  }

  // Every other table (plugins' own): changed = not supported; users, comments: ignored.
  for (const name of new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])) {
    if (IGNORED_TABLES.test(name)) {
      if (JSON.stringify(a.tables[name] ?? []) !== JSON.stringify(b.tables[name] ?? [])) skip(`table ${name}`)
      continue
    }
    const ra = JSON.stringify((a.tables[name] ?? []).map((r) => Object.values(r).map(ta)))
    const rb = JSON.stringify((b.tables[name] ?? []).map((r) => Object.values(r).map(tb)))
    if (ra !== rb) unsupported.push(`таблиця ${a.prefix}${name} (дані плагіна) змінена: такі правки не переносяться`)
  }
  return { targets, unsupported, ignored, newOptions }
}

// ---------------------------------------------------------------- Elementor

function flatten(elements, parent = '', out = []) {
  ;(elements ?? []).forEach((el, index) => {
    out.push({ id: String(el.id ?? ''), parent, index, elType: el.elType ?? '', widgetType: el.widgetType ?? '', settings: el.settings ?? {} })
    if (Array.isArray(el.elements) && el.elements.length) flatten(el.elements, String(el.id ?? ''), out)
  })
  return out
}

const canon = (v) => JSON.stringify(v === undefined ? null : v)

/**
 * Edits per element setting when the page keeps its structure (same elements in the same
 * places), else null: the whole _elementor_data is then one post_meta edit.
 */
export function elementorEdits(post, before, after, label = `запис #${post}`) {
  const fa = flatten(before)
  const fb = flatten(after)
  const shape = (f) => JSON.stringify(f.map((e) => [e.id, e.parent, e.index, e.elType, e.widgetType]))
  if (shape(fa) !== shape(fb)) return null
  const edits = []
  fa.forEach((ea, i) => {
    const sa = Array.isArray(ea.settings) ? {} : ea.settings
    const sb = Array.isArray(fb[i].settings) ? {} : fb[i].settings
    for (const key of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      if (canon(sa[key]) === canon(sb[key])) continue
      edits.push({
        type: 'elementor', post, element: ea.id, setting: key, before: sa[key] ?? null, after: sb[key] ?? null,
        label: `${label}: Elementor ${ea.widgetType || ea.elType} ${ea.id}: ${key}`,
      })
    }
  })
  return edits
}

// ---------------------------------------------------------------- values and files

// Every string inside a value with the copy's address replaced by the live one
// (plain and JSON-escaped, also inside JSON kept as a string).
export function mapUrls(value, from, to) {
  if (typeof value === 'string') {
    const esc = (u) => u.replace(/\//g, '\\/')
    return value.split(esc(from)).join(esc(to)).split(from).join(to)
  }
  if (Array.isArray(value)) return value.map((v) => mapUrls(v, from, to))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapUrls(v, from, to)]))
  return value
}

// Changed theme files: { path: sha256 } of both copies -> edits (added, changed, removed).
const SAFE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/
const SAFE_EXT = /\.(php|css|js|mjs|json|svg|png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|eot|txt|html?|xml|pot?|mo|twig|scss|map|md)$/i
export const safeThemePath = (p) => SAFE_PATH.test(p) && SAFE_EXT.test(p) && !p.includes('..') && p.length < 300

export function themeFileEdits(before, after) {
  const edits = []
  const unsupported = []
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (before[path] === after[path]) continue
    if (!safeThemePath(path)) { unsupported.push(`файл теми ${path}: такий шлях або тип файлу плагін не записує`); continue }
    edits.push({ type: 'theme_file', path, before_sha256: before[path] ?? null, after_sha256: after[path] ?? null,
      label: `файл теми ${path}${before[path] ? (after[path] ? '' : ' (видалити)') : ' (новий)'}` })
  }
  return { edits, unsupported }
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// The set's id: the hash of everything it does.
export function manifestId(manifest, files) {
  const { id, created_at: _at, ...rest } = manifest
  return sha256(JSON.stringify({ rest, files: Object.keys(files).sort().map((k) => [k, sha256(Buffer.from(files[k], 'base64'))]) })).slice(0, 32)
}

// The plugin's edits/payload.php: PHP, so the web server never serves the set as a file.
export function payloadPhp(payload) {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  return `<?php\n// Agency bridge edit set, built by qa-kit bridge build.\nif ( ! defined( 'ABSPATH' ) ) {\n\texit;\n}\nreturn '${b64}';\n`
}

const TYPE_UA = { option: 'налаштування', post_field: 'запис', post_meta: 'поле запису', term_field: 'термін', term_meta: 'поле терміна', elementor: 'Elementor', theme_file: 'файл теми' }
const short = (v) => {
  if (v == null) return '(немає)'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return (s.length > 120 ? `${s.slice(0, 120)}…` : s).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

// EDITS.md: the set for the manager, QA and the site owner (Ukrainian).
export function editsReport(manifest, unsupported, ignored, newOptions = []) {
  const lines = [`# Набір правок «${manifest.order}»`, '', `- id: \`${manifest.id}\``, `- підготовлено: ${manifest.created_at}`,
    `- живий сайт: ${manifest.site.home}, тема \`${manifest.theme}\``, `- правок: ${manifest.edits.length}`, '']
  if (manifest.note) lines.push(manifest.note, '')
  lines.push('| № | Що | Де | Було | Стане |', '|---|---|---|---|---|')
  manifest.edits.forEach((e, i) => {
    const before = e.type === 'theme_file' ? (e.before_sha256 ? `sha ${e.before_sha256.slice(0, 10)}` : '(немає)') : short(e.before)
    const after = e.type === 'theme_file' ? (e.after_sha256 ? `sha ${e.after_sha256.slice(0, 10)}` : '(видалити)') : short(e.after)
    lines.push(`| ${i + 1} | ${TYPE_UA[e.type] ?? e.type} | ${short(e.label)} | ${before} | ${after} |`)
  })
  if (unsupported.length) lines.push('', '## Не переноситься плагіном (зробити вручну)', '', ...unsupported.map((u) => `- ${u}`))
  if (newOptions.length) {
    lines.push('', '## Нові опції не включено', '', 'Опції, яких не було в оригіналі. Зазвичай це налаштування плагінів, які вони записують самі, коли відкривається адмінка.'
      + ' Якщо якусь із них створила правка (наприклад, нове поле SCF), зберіть набір знову з `--include-option <назва>`. Підтримується `*`.', '', ...newOptions.map((n) => `- ${n}`))
  }
  const ign = Object.entries(ignored)
  if (ign.length) lines.push('', '## Пропущено як службове (не правки)', '', ...ign.map(([k, n]) => `- ${k}: ${n}`))
  lines.push('', 'Застосувати: плагін «Агенція: правки» (zip) через «Плагіни → Додати → Завантажити», або по SSH:',
    '`wp eval-file <plugin>/cli.php edits.json check|apply|rollback`.', '')
  return lines.join('\n')
}

// ---------------------------------------------------------------- zip

// How to unpack a zip without a dependency: Windows' own bsdtar (System32, not the GNU tar
// of Git Bash, which reads no zip), elsewhere `unzip`.
export function unzipCommand(zip, dir, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return { file: join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), args: ['-xf', zip, '-C', dir] }
  return { file: 'unzip', args: ['-q', '-o', zip, '-d', dir] }
}

/** A zip (deflate, or stored when that is smaller) of [{ name, data: Buffer }]. */
export function zipFiles(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8')
    const crc = crc32(data) >>> 0
    const deflated = deflateRawSync(data)
    const stored = deflated.length >= data.length
    const body = stored ? data : deflated
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12) // 1980-01-01: reproducible zips
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4) // made by: unix, 2.0
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38) // a regular file, rw-r--r--
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, body)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + body.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}
