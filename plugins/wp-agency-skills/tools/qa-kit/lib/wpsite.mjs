// Pure parts of `qa-kit wp-site`: a copy of a client's WordPress site
// (files + a MySQL dump) run in WordPress Playground on SQLite. Options, the dump
// (statements, prefix, addresses), our wp-config.php, the address replacements, what
// is left out of the copy, the listeners of a port and the sitemap. No server here.
import { resolve, join } from 'node:path'

const COMMANDS = ['import', 'start', 'stop', 'health', 'wp', 'compare']
export const USAGE = 'usage:\n'
  + '  qa-kit wp-site import <copy folder: WordPress files + one .sql> <site folder> [--sql <dump>] [--port 9500] [--php 8.3]\n'
  + '  qa-kit wp-site start|stop|health <site folder>\n'
  + '  qa-kit wp-site wp <site folder> <WP-CLI arguments...>\n'
  + '  qa-kit wp-site compare <original site> <edited site> [--pages a/,b/] [--expect a/] [--widths 390,1440] [--mask ".sel"] [--round N]'

const list = (value) => value?.split(',').map((s) => s.trim()).filter(Boolean) ?? null
const page = (p) => {
  if (/^[A-Za-z]:[\\/]/.test(p)) throw new Error(`a Windows path (${p}) where a page is expected: write menyu/, not /menyu/`)
  const at = new URL(p.replace(/^\.?\//, ''), 'http://x/')
  return at.pathname + at.search
}

export function wpSiteOptions(args) {
  const [command, ...rest] = args
  if (!COMMANDS.includes(command)) throw new Error(USAGE)
  if (command === 'wp') {
    if (!rest[0]) throw new Error(`the site folder is missing\n${USAGE}`)
    if (rest.length < 2) throw new Error(`no WP-CLI arguments, e.g. qa-kit wp-site wp <site> option get siteurl\n${USAGE}`)
    return { command, site: resolve(rest[0]), wpArgs: rest.slice(1) }
  }
  const opt = (name, fallback = null) => {
    const i = rest.indexOf(`--${name}`)
    return i >= 0 ? rest[i + 1] : fallback
  }
  const folders = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')))
  const port = Number(opt('port', 9500))
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`--port takes a free port 1024..65535 (got ${opt('port')})`)
  if (command === 'import') {
    if (folders.length < 2) throw new Error(`the copy folder and the site folder are needed\n${USAGE}`)
    const sql = opt('sql')
    return { command, source: resolve(folders[0]), site: resolve(folders[1]), sql: sql ? resolve(sql) : null, port, php: opt('php', '8.3') }
  }
  if (command === 'compare') {
    if (folders.length < 2) throw new Error(`compare needs two site folders: the original and the edited copy\n${USAGE}`)
    const round = opt('round')
    const widths = list(opt('widths'))?.map(Number) ?? null
    if (widths?.some((w) => !Number.isInteger(w) || w < 200)) throw new Error(`--widths takes pixel widths, e.g. 390,1440 (got ${opt('widths')})`)
    const other = resolve(folders[1])
    return {
      command, site: resolve(folders[0]), other, widths, round: round ? Number(round) : null,
      pages: list(opt('pages'))?.map(page) ?? null, expect: list(opt('expect'))?.map(page) ?? null, mask: list(opt('mask')) ?? [],
      out: join(other, 'test-results', 'qa-kit', 'wp-site-compare', round ? `round-${round}` : 'latest'),
    }
  }
  if (!folders[0]) throw new Error(`the site folder is missing\n${USAGE}`)
  return { command, site: resolve(folders[0]) }
}

// A mysqldump split into statements: `;` outside quotes ends one, `-- ` / `#` line
// comments and /* */ (also MySQL's /*! ... */ version comments) are dropped.
export function splitSql(text) {
  const out = []
  let buf = ''
  let quote = null
  const n = text.length
  for (let i = 0; i < n; i++) {
    const c = text[i]
    if (quote) {
      buf += c
      if (c === '\\') { buf += text[++i] ?? ''; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; buf += c; continue }
    const next = text[i + 1]
    if ((c === '-' && next === '-' && /\s/.test(text[i + 2] ?? ' ')) || c === '#') {
      const end = text.indexOf('\n', i)
      i = end < 0 ? n : end - 1
      continue
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 1
      continue
    }
    if (c === ';') {
      const s = buf.trim()
      if (s) out.push(s)
      buf = ''
      continue
    }
    buf += c
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

// What the import runs: tables and rows. Session settings, locks, transactions,
// databases, triggers, routines and views stay out (SQLite has none of them).
export function importable(statement) {
  const s = statement.trim()
  if (/^(SET|LOCK|UNLOCK|USE|START\s+TRANSACTION|BEGIN|COMMIT|ROLLBACK|DELIMITER)\b/i.test(s)) return false
  if (/^CREATE\s+(DATABASE|SCHEMA)\b/i.test(s)) return false
  if (/^(CREATE|DROP)\s+(DEFINER\s*=\s*\S+\s+)?(TRIGGER|PROCEDURE|FUNCTION|EVENT|VIEW)\b/i.test(s)) return false
  if (/^CREATE\s+(OR\s+REPLACE\s+)?(ALGORITHM\s*=\s*\w+\s+)?(DEFINER\s*=\s*\S+\s+)?(SQL\s+SECURITY\s+\w+\s+)?VIEW\b/i.test(s)) return false
  return true
}

export function dumpFacts(text) {
  const prefix = text.match(/CREATE TABLE `(\w*?)options`/)?.[1] ?? null
  const value = (name) => text.match(new RegExp(`'${name}',\\s*'([^']*)'`))?.[1]?.replace(/\/+$/, '') ?? null
  return { prefix, siteurl: value('siteurl'), home: value('home') }
}

export function configPrefix(text) {
  return text.match(/\$table_prefix\s*=\s*['"]([^'"]*)['"]\s*;/)?.[1] ?? null
}

// Our own wp-config.php for the copy: Playground's SQLite drop-in ignores the DB_*
// values, the client's secrets never travel, PHP errors go to /qa-log/debug.log.
export function wpConfigText({ prefix }) {
  if (!/^\w+$/.test(prefix)) throw new Error(`the table prefix "${prefix}" is not a plain table prefix`)
  return `<?php
// Written by qa-kit wp-site: a local Playground copy of the client's site.
define( 'DB_NAME', 'wordpress' );
define( 'DB_USER', 'qa-kit' );
define( 'DB_PASSWORD', '' );
define( 'DB_HOST', 'localhost' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );
$table_prefix = '${prefix}';
define( 'WP_DEBUG', true );
define( 'WP_DEBUG_LOG', '/qa-log/debug.log' );
define( 'WP_DEBUG_DISPLAY', false );
define( 'WP_ENVIRONMENT_TYPE', 'local' );
define( 'DISABLE_WP_CRON', true );
define( 'AUTOMATIC_UPDATER_DISABLED', true );
if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}
require_once ABSPATH . 'wp-settings.php';
`
}

const escape = (url) => url.replace(/\//g, '\\/')

// Every form the live address can take in the database -> the local address: http and
// https, with and without www, plain and with JSON-escaped slashes (Elementor data).
export function urlReplacements(urls, local) {
  const target = local.replace(/\/+$/, '')
  const pairs = []
  const seen = new Set()
  for (const raw of urls) {
    if (!raw || raw.replace(/\/+$/, '') === target) continue
    const u = new URL(raw)
    const path = u.pathname.replace(/\/+$/, '')
    const scheme = u.protocol.replace(':', '')
    const host = u.host
    const other = host.startsWith('www.') ? host.slice(4) : `www.${host}`
    const hosts = /^\d+\.\d+\.\d+\.\d+(:\d+)?$|^localhost(:\d+)?$/.test(host) ? [host] : [host, other]
    for (const h of hosts) {
      for (const s of [scheme, scheme === 'http' ? 'https' : 'http']) {
        const from = `${s}://${h}${path}`
        if (from === target || seen.has(from)) continue
        seen.add(from)
        pairs.push([from, target], [escape(from), escape(target)])
      }
    }
  }
  return pairs
}

// Left out of the copy: the client's config (secrets; ours is written), git, caches,
// backups (often gigabytes), logs, and drop-ins that replace the database or the cache
// layer (they clash with Playground's SQLite drop-in or need Redis/Memcached).
const SKIP = [
  /^wp-config\.php$/, /^\.git$/, /^wp-content\/(cache|upgrade|database|updraft|ai1wm-backups|backups[\w-]*|wpvivid\w*|backwpup[\w-]*)$/,
  /^wp-content\/(debug\.log|db\.php|object-cache\.php|advanced-cache\.php)$/, /^wp-content\/uploads\/backwpup[\w-]*$/,
]
export function skipCopy(rel) {
  const p = rel.replace(/\\/g, '/').replace(/\/+$/, '')
  return SKIP.some((re) => re.test(p))
}

// PIDs listening on a port from `netstat -ano` (Windows, any language): the remote
// address of a listener is 0.0.0.0:0 or [::]:0, whatever the state column says.
export function listenerPids(netstat, port) {
  const pids = new Set()
  for (const line of netstat.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5 || !/^TCP/i.test(cols[0])) continue
    if (!cols[1].endsWith(`:${port}`) || !/^(0\.0\.0\.0|\[::\]|\*):0$/.test(cols[2])) continue
    const pid = Number(cols[cols.length - 1])
    if (pid > 0) pids.add(pid)
  }
  return [...pids]
}

export function sitemapLocs(xml) {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'))
  return /<sitemapindex/i.test(xml) ? { sitemaps: locs, pages: [] } : { sitemaps: [], pages: locs }
}

// The background server on Windows (no window may open on the user's
// desktop). Node's own options cannot do both: a `detached` child outlives qa-kit but
// has no console, so Playground's worker node opens a NEW visible console window
// (Windows Terminal); a non-detached child is killed with qa-kit (libuv's job object).
// So WScript (a windowless program, started detached) runs `cmd /c node ... > log`
// with window style 0: a hidden console that every child inherits.
export function hiddenLauncherVbs(file, args, log) {
  const all = [file, ...args, log]
  if (all.some((a) => a.includes('"'))) throw new Error('an argument with a double quote cannot go through the hidden launcher')
  const q = (a) => `""${a}""`
  const line = `cmd /c ""${[file, ...args].map(q).join(' ')} > ${q(log)} 2>&1""`
  return `' Written by qa-kit wp-site start: runs the Playground server without any window.\r\n`
    + `CreateObject("WScript.Shell").Run "${line}", 0, False\r\n`
}
