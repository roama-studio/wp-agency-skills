// Pure parts of `qa-kit wp`: options, the Playground blueprint and the
// judgements of what WordPress wrote (debug.log, page HTML, theme files, SCF fields).
// No browser, no server here.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const SLUG = /^[a-z0-9-]+$/
export const PLAYGROUND = '@wp-playground/cli@3.1.55'
export const BASE_PLUGINS = ['secure-custom-fields', 'contact-form-7']
const MU_PLUGIN = readFileSync(new URL('./wp-qa-kit.php', import.meta.url), 'utf8')

export function wpOptions(args) {
  const opt = (name, fallback = null) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : fallback
  }
  const all = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []))
  if (!args[0] || args[0].startsWith('--')) throw new Error('usage: qa-kit wp <project folder> --theme <theme folder>')
  if (!opt('theme')) throw new Error('--theme <folder of the theme inside the project> is required, e.g. --theme wp-theme/mytheme')
  const folder = resolve(args[0])
  const theme = resolve(folder, opt('theme'))
  const slug = basename(theme)
  if (!SLUG.test(slug)) throw new Error(`the theme folder name "${slug}" is not a valid theme slug (a-z, 0-9, -)`)
  const pluginArg = opt('plugins')
  const plugins = pluginArg === null ? [...BASE_PLUGINS] : pluginArg === 'none' ? [] : pluginArg.split(',').filter(Boolean)
  for (const p of plugins) if (!SLUG.test(p)) throw new Error(`"${p}" is not a wordpress.org plugin slug`)
  const pages = opt('pages')?.split(',').filter(Boolean).map((p) => {
    if (/^[A-Za-z]:[\\/]/.test(p)) {
      throw new Error(`--pages got a Windows path (${p}): write the pages without the leading slash, e.g. menyu/,about/`)
    }
    return `/${p.replace(/^\.?\//, '')}`
  }) ?? []
  const round = opt('round')
  const base = join(folder, 'test-results', 'qa-kit', 'wp')
  return {
    folder, theme, slug, plugins, pages,
    wpCli: all('wp-cli').map((c) => (c.startsWith('wp ') ? c : `wp ${c}`)),
    php: opt('php', '8.3'), wp: opt('wp', 'latest'), port: Number(opt('port', 9400)),
    stress: !args.includes('--no-stress'),
    out: resolve(opt('out', join(base, round ? `round-${round}` : 'latest'))),
  }
}

// How to start `npx <args>` without a shell: the arguments stay an
// array, so a folder name is never read as shell syntax. On Windows `npx` is a .cmd
// shim that Node refuses to spawn without a shell, so node runs npm's own npx-cli.js
// (next to node.exe, or next to the npm the environment names).
export function npxCommand(args, { platform = process.platform, execPath = process.execPath, exists = existsSync, env = process.env } = {}) {
  if (env.QA_KIT_NPX) return { file: env.QA_KIT_NPX, args, shell: false }
  if (platform !== 'win32') return { file: 'npx', args, shell: false }
  const places = [join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')]
  if (env.NPM_CLI_JS) places.push(join(dirname(env.NPM_CLI_JS), 'npx-cli.js'))
  const cli = places.find((p) => exists(p))
  if (!cli) throw new Error(`npx-cli.js not found next to ${execPath}: set QA_KIT_NPX to an npx that can be run without a shell`)
  return { file: execPath, args: [cli, ...args], shell: false }
}

// Options of every process the kit starts in the background (no
// window may open on his desktop). windowsHide = CREATE_NO_WINDOW: the process gets a
// console without a window, and its own children (npx's cmd.exe, Playground's worker
// node) inherit it. Never `detached`: on Windows that means DETACHED_PROCESS (no console
// at all), so every console child opens a NEW visible window (Windows Terminal).
export function hiddenSpawnOptions({ stdio = 'pipe', env = process.env } = {}) {
  return { shell: false, windowsHide: true, detached: false, stdio, env }
}

// How to run the Playground CLI: the copy `npx -y ${PLAYGROUND}` itself installed
// (its _npx/<hash>/package.json names exactly that package; another entry, e.g. for
// @latest, may be half-installed), node running its wp-playground.js directly: no npm,
// no cmd.exe shim, faster. Else `npx -y`.
export function playgroundCommand(args, {
  execPath = process.execPath, env = process.env, exists = existsSync,
  list = (dir) => { try { return readdirSync(dir) } catch { return [] } },
  read = (file) => readFileSync(file, 'utf8'),
  cacheDirs = [env.npm_config_cache, env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'npm-cache'), env.HOME && join(env.HOME, '.npm')].filter(Boolean),
} = {}) {
  const version = PLAYGROUND.split('@').pop()
  for (const cache of cacheDirs) {
    const npx = join(cache, '_npx')
    for (const hash of list(npx)) {
      const cli = join(npx, hash, 'node_modules', '@wp-playground', 'cli')
      const entry = join(npx, hash, 'package.json')
      try {
        if (exists(entry) && (JSON.parse(read(entry))._npx?.packages ?? []).includes(PLAYGROUND)
          && JSON.parse(read(join(cli, 'package.json'))).version === version && exists(join(cli, 'wp-playground.js'))) {
          return { file: execPath, args: [join(cli, 'wp-playground.js'), ...args], shell: false }
        }
      } catch { /* a broken cache entry: try the next */ }
    }
  }
  return npxCommand(['-y', PLAYGROUND, ...args], { execPath, env, exists })
}

export function blueprint(o, token) {
  return {
    preferredVersions: { php: o.php, wp: o.wp },
    steps: [
      { step: 'defineWpConfigConsts', consts: {
        WP_DEBUG: true, WP_DEBUG_LOG: '/qa-log/debug.log', WP_DEBUG_DISPLAY: false, QA_KIT_TOKEN: token,
      } },
      { step: 'writeFile', path: '/wordpress/wp-content/mu-plugins/qa-kit.php', data: MU_PLUGIN },
      ...o.plugins.map((slug) => ({
        step: 'installPlugin', pluginData: { resource: 'wordpress.org/plugins', slug }, options: { activate: true },
      })),
      { step: 'activateTheme', themeFolderName: o.slug },
      { step: 'setSiteOptions', options: { permalink_structure: '/%postname%/' } },
      ...o.wpCli.map((command) => ({ step: 'wp-cli', command })),
    ],
  }
}

const KINDS = [
  [/^PHP Fatal error/, 'php_fatal'], [/^PHP Parse error/, 'php_parse'], [/^PHP Warning/, 'php_warning'],
  [/^PHP Deprecated/, 'php_deprecated'], [/^PHP Notice/, 'php_notice'],
]
const THEME_LEVEL = { php_fatal: 'fail', php_parse: 'fail', php_warning: 'fail', php_deprecated: 'warn', php_notice: 'warn' }

// The place of an error, relative to the theme (or wp-content / WordPress for others).
function where(text, slug) {
  const m = text.match(/ in (\/\S+?\.php)(?: on line (\d+)|:(\d+))/)
  if (!m) return { file: null, line: null, ours: false }
  const path = m[1]
  const line = Number(m[2] ?? m[3])
  const themeAt = `/wp-content/themes/${slug}/`
  if (path.includes(themeAt)) return { file: path.split(themeAt)[1], line, ours: true }
  if (path.includes('/wp-content/')) return { file: path.split('/wp-content/')[1], line, ours: false }
  return { file: path.replace(/^\/wordpress\//, ''), line, ours: false }
}

export function debugLogFindings(text, slug) {
  const out = new Map()
  for (const raw of text.split(/\r?\n/)) {
    const entry = raw.replace(/^\[[^\]]+\]\s*/, '')
    const kind = KINDS.find(([re]) => re.test(entry))?.[1]
    if (!kind) continue
    const message = entry.replace(/^PHP [A-Za-z ]+?:\s+/, '').replace(/\s+/g, ' ').trim()
    const at = where(entry, slug)
    const key = [kind, at.file, at.line, message].join('\u0000')
    const seen = out.get(key)
    if (seen) { seen.count += 1; continue }
    out.set(key, { check: kind, level: at.ours ? THEME_LEVEL[kind] : 'info', file: at.file, line: at.line, message, count: 1 })
  }
  return [...out.values()].map((f) => ({
    ...f, page: null, width: null, browser: null, screenshot: null,
    message: `${f.message}${f.count > 1 ? ` (${f.count}x)` : ''}${f.level === 'info' ? ' - not the theme (WordPress or a plugin)' : ''}`,
  }))
}

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

// PHP errors that reached the visitor: the `<b>Warning</b>:` form PHP prints, and
// WordPress's own "critical error" page.
export function htmlPhpErrors(html) {
  const out = []
  const re = /<b>(Fatal error|Parse error|Warning|Notice|Deprecated)<\/b>:\s*([\s\S]*?)(?:<br\s*\/?>|$)/g
  for (const m of html.matchAll(re)) {
    out.push(decode(`${m[1]}: ${m[2].replace(/<[^>]+>/g, '')}`).replace(/\s+/g, ' ').trim())
  }
  if (/There has been a critical error on this website/.test(html)) out.push('There has been a critical error on this website.')
  return out
}

const GUARDED_DIRS = /^(inc|includes|lib)\//
const GUARD = /defined\s*\(\s*['"]ABSPATH['"]\s*\)/
const DANGEROUS = /(?<![\w$>:])(eval|exec|shell_exec|system|passthru|proc_open|popen)\s*\(/
// PHP comments out, so words in them are not taken for code (`http://` in a string stays).
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)(\/\/|#)[^\n]*/g, '$1')

// Static facts of the theme's files ({ path relative to the theme, text }).
export function themeFileFindings(files) {
  const theme = (check, level, message, file = null) => ({
    check, level, file, line: null, page: null, width: null, browser: null, screenshot: null, message,
  })
  const found = []
  const php = files.filter((f) => f.path.endsWith('.php')).map((f) => ({ ...f, text: code(f.text) }))
  for (const f of php) {
    if (GUARDED_DIRS.test(f.path) && !GUARD.test(f.text)) {
      found.push(theme('php_no_direct_access_guard', 'warn',
        "no `defined( 'ABSPATH' ) || exit;` at the top: the file can be opened directly by its address", f.path))
    }
    const bad = f.text.match(DANGEROUS)
    if (bad) found.push(theme('php_eval', 'fail', `${bad[1]}() in a theme file: never run code from strings or shell`, f.path))
    if (/<title[\s>]/i.test(f.text)) {
      found.push(theme('theme_hardcoded_title', 'warn',
        "a hard-coded <title>: let WordPress print it (add_theme_support( 'title-tag' ))", f.path))
    }
  }
  const all = php.map((f) => f.text).join('\n')
  if (!/add_theme_support\s*\(\s*['"]title-tag['"]/.test(all)) {
    found.push(theme('theme_no_title_tag', 'warn', "no add_theme_support( 'title-tag' ): SEO plugins and WordPress cannot set the page title"))
  }
  const needs = [
    ['wp_head', 'fail', 'no wp_head(): plugins (CF7, SEO, Site Icon) cannot add their styles, scripts and tags'],
    ['wp_footer', 'fail', 'no wp_footer(): plugin scripts (CF7 forms) and the admin bar never load'],
    ['wp_body_open', 'warn', 'no wp_body_open() after <body>: plugins that add code at the body start have no place'],
    ['body_class', 'warn', 'no body_class() on <body>: page, template and logged-in classes are missing'],
  ]
  for (const [fn, level, message] of needs) {
    if (!new RegExp(`\\b${fn}\\s*\\(`).test(all)) found.push(theme(`theme_no_${fn}`, level, message))
  }
  if (!files.some((f) => /^screenshot\.(png|jpe?g|webp)$/i.test(f.path))) {
    found.push(theme('theme_no_screenshot', 'info', 'no screenshot.png (1200x900): the theme shows blank in Appearance > Themes'))
  }
  return found
}

// SCF fields the client fills (from the qa-kit mu-plugin): a short text without a hard limit.
export function fieldFindings(fields) {
  return fields.filter((f) => f.type === 'text' && !(Number(f.maxlength) > 0)).map((f) => ({
    check: 'scf_text_no_limit', level: 'warn', file: f.group ?? null, line: null, page: null, width: null,
    browser: null, screenshot: null,
    message: `SCF text field "${f.label}" (${f.name}) has no Character Limit: a client can paste a paragraph into a short text`,
  }))
}

// Theme files with a PHP syntax error (from the mu-plugin's lint).
export function lintFindings(errors) {
  return errors.map((e) => ({
    check: 'php_syntax', level: 'fail', file: e.file, line: e.line ?? null, page: null, width: null, browser: null,
    screenshot: null, message: `PHP syntax error: ${e.message}`,
  }))
}
