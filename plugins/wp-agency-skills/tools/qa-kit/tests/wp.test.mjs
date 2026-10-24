import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  blueprint, debugLogFindings, fieldFindings, htmlPhpErrors, lintFindings, themeFileFindings, wpOptions,
} from '../lib/wp.mjs'

const PROJECT = 'C:/cp/mytheme'

test('wp options: the theme folder, its slug, our base plugins and a round', () => {
  const o = wpOptions([PROJECT, '--theme', 'wp-theme/mytheme', '--round', '2'])
  assert.equal(o.slug, 'mytheme')
  assert.match(o.theme.replace(/\\/g, '/'), /cp\/mytheme\/wp-theme\/mytheme$/)
  assert.deepEqual(o.plugins, ['secure-custom-fields', 'contact-form-7'])
  assert.equal(o.php, '8.3')
  assert.equal(o.wp, 'latest')
  assert.equal(o.stress, true)
  assert.deepEqual(o.wpCli, [])
  assert.match(o.out.replace(/\\/g, '/'), /cp\/mytheme\/test-results\/qa-kit\/wp\/round-2$/)
})

test('wp options: plugins, WP-CLI setup commands, versions and no stress', () => {
  const o = wpOptions([PROJECT, '--theme', 'wp-theme/mytheme', '--plugins', 'secure-custom-fields,flamingo',
    '--wp-cli', 'mytheme import', '--wp-cli', 'wp option update blogname Test', '--php', '8.2', '--wp', '6.8',
    '--no-stress', '--pages', 'posluhy/,menyu/'])
  assert.deepEqual(o.plugins, ['secure-custom-fields', 'flamingo'])
  assert.deepEqual(o.wpCli, ['wp mytheme import', 'wp option update blogname Test'])
  assert.equal(o.php, '8.2')
  assert.equal(o.wp, '6.8')
  assert.equal(o.stress, false)
  assert.deepEqual(o.pages, ['/posluhy/', '/menyu/'])
  assert.deepEqual(wpOptions([PROJECT, '--theme', 'wp-theme/mytheme', '--plugins', 'none']).plugins, [])
})

test('wp options: the theme is required and its folder name must be a valid slug', () => {
  assert.throws(() => wpOptions([PROJECT]), /--theme/)
  assert.throws(() => wpOptions([PROJECT, '--theme', 'wp-theme/My Theme']), /slug/)
  assert.throws(() => wpOptions([PROJECT, '--theme', 'x/ok', '--plugins', 'bad slug']), /plugin slug/)
  assert.throws(() => wpOptions([PROJECT, '--theme', 'x/ok', '--pages', 'C:/Program Files/Git/menyu/']), /Windows path/)
})

test('the blueprint: debug log in the mounted folder, plugins, the theme, setup, the qa mu-plugin', () => {
  const o = wpOptions([PROJECT, '--theme', 'wp-theme/mytheme', '--wp-cli', 'mytheme import'])
  const bp = blueprint(o, 'tok123')
  assert.deepEqual(bp.preferredVersions, { php: '8.3', wp: 'latest' })
  const [consts, ...rest] = bp.steps
  assert.equal(consts.step, 'defineWpConfigConsts')
  assert.equal(consts.consts.WP_DEBUG, true)
  assert.equal(consts.consts.WP_DEBUG_LOG, '/qa-log/debug.log')
  assert.equal(consts.consts.WP_DEBUG_DISPLAY, false)
  assert.equal(consts.consts.QA_KIT_TOKEN, 'tok123')
  const plugins = rest.filter((s) => s.step === 'installPlugin')
  assert.deepEqual(plugins.map((s) => s.pluginData.slug), ['secure-custom-fields', 'contact-form-7'])
  assert.ok(plugins.every((s) => s.pluginData.resource === 'wordpress.org/plugins' && s.options.activate))
  const order = rest.map((s) => s.step)
  assert.ok(order.indexOf('activateTheme') > order.lastIndexOf('installPlugin'), 'theme after plugins')
  assert.equal(rest.find((s) => s.step === 'activateTheme').themeFolderName, 'mytheme')
  assert.ok(order.indexOf('wp-cli') > order.indexOf('activateTheme'), 'setup after the theme')
  assert.equal(rest.find((s) => s.step === 'wp-cli').command, 'wp mytheme import')
  const mu = rest.find((s) => s.step === 'writeFile')
  assert.equal(mu.path, '/wordpress/wp-content/mu-plugins/qa-kit.php')
  assert.match(mu.data, /QA_KIT_TOKEN/)
  assert.match(mu.data, /token_get_all\(.*TOKEN_PARSE/s, 'the PHP lint of every theme file')
  assert.ok(order.indexOf('writeFile') < order.indexOf('wp-cli'), 'the mu-plugin is there before the setup runs')
  const pretty = rest.find((s) => s.step === 'setSiteOptions')
  assert.equal(pretty.options.permalink_structure, '/%postname%/')
})

test('debug.log: fatal and parse errors fail, warnings fail in the theme, notices and deprecations warn', () => {
  const log = [
    '[15-Oct-2026 21:07:10 UTC] Automatic updates starting...',
    '[15-Oct-2026 21:07:12 UTC] PHP Warning:  Undefined array key "title" in /wordpress/wp-content/themes/mytheme/template-parts/home/why-us.php on line 14',
    '[15-Oct-2026 21:07:13 UTC] PHP Warning:  Undefined array key "title" in /wordpress/wp-content/themes/mytheme/template-parts/home/why-us.php on line 14',
    '[15-Oct-2026 21:07:14 UTC] PHP Deprecated:  strlen(): Passing null to parameter #1 in /wordpress/wp-content/themes/mytheme/inc/helpers.php on line 30',
    '[15-Oct-2026 21:07:15 UTC] PHP Notice:  Function _load_textdomain_just_in_time was called incorrectly in /wordpress/wp-includes/functions.php on line 6121',
    '[15-Oct-2026 21:07:16 UTC] PHP Warning:  foo in /wordpress/wp-content/plugins/contact-form-7/includes/x.php on line 3',
    '[15-Oct-2026 21:07:17 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function get_field() in /wordpress/wp-content/themes/mytheme/front-page.php:12',
    'Stack trace:',
    '#0 {main}',
    '  thrown in /wordpress/wp-content/themes/mytheme/front-page.php on line 12',
    '[15-Oct-2026 21:07:18 UTC] PHP Parse error:  syntax error, unexpected token "}" in /wordpress/wp-content/themes/mytheme/inc/seo.php on line 40',
  ].join('\n')
  const found = debugLogFindings(log, 'mytheme')
  const brief = found.map((f) => [f.check, f.level, f.file, f.line, f.count])
  assert.deepEqual(brief, [
    ['php_warning', 'fail', 'template-parts/home/why-us.php', 14, 2],
    ['php_deprecated', 'warn', 'inc/helpers.php', 30, 1],
    ['php_notice', 'info', 'wp-includes/functions.php', 6121, 1],
    ['php_warning', 'info', 'plugins/contact-form-7/includes/x.php', 3, 1],
    ['php_fatal', 'fail', 'front-page.php', 12, 1],
    ['php_parse', 'fail', 'inc/seo.php', 40, 1],
  ])
  assert.match(found[0].message, /Undefined array key "title"/)
  assert.match(found[0].message, /2x/)
  assert.match(found[3].message, /not the theme/)
  assert.deepEqual(debugLogFindings('', 'mytheme'), [])
})

test('PHP errors printed into a page are found, a normal page is clean', () => {
  const bad = '<html><body><br />\n<b>Warning</b>:  Undefined variable $x in <b>/wordpress/wp-content/themes/mytheme/page.php</b> on line <b>9</b><br />\n<p>There has been a critical error on this website.</p></body></html>'
  assert.deepEqual(htmlPhpErrors(bad), [
    'Warning: Undefined variable $x in /wordpress/wp-content/themes/mytheme/page.php on line 9',
    'There has been a critical error on this website.',
  ])
  assert.deepEqual(htmlPhpErrors('<html><body><h1>Warning: our prices change</h1></body></html>'), [])
})

test('theme files: direct-access guard, title-tag, the hooks every theme needs, no eval', () => {
  const files = [
    { path: 'style.css', text: '/*\nTheme Name: MySite\nText Domain: mytheme\n*/' },
    { path: 'functions.php', text: "<?php\ndefined('ABSPATH') || exit;\nrequire __DIR__ . '/inc/setup.php';" },
    { path: 'inc/setup.php', text: "<?php\nif ( ! defined( 'ABSPATH' ) ) { exit; }\nadd_theme_support('post-thumbnails');" },
    { path: 'inc/helpers.php', text: "<?php\nfunction v_x() { return eval('1;'); }" },
    { path: 'header.php', text: '<!doctype html><html <?php language_attributes(); ?>><head><title>MySite</title><?php wp_head(); ?></head><body <?php body_class(); ?>>' },
    { path: 'footer.php', text: '</body></html>' },
    { path: 'index.php', text: '<?php get_header(); get_footer();' },
  ]
  const found = themeFileFindings(files)
  const brief = found.map((f) => [f.check, f.level, f.file ?? null])
  assert.deepEqual(brief, [
    ['php_no_direct_access_guard', 'warn', 'inc/helpers.php'],
    ['php_eval', 'fail', 'inc/helpers.php'],
    ['theme_hardcoded_title', 'warn', 'header.php'],
    ['theme_no_title_tag', 'warn', null],
    ['theme_no_wp_footer', 'fail', null],
    ['theme_no_wp_body_open', 'warn', null],
    ['theme_no_screenshot', 'info', null],
  ])
})

test('a complete theme has no file findings', () => {
  const files = [
    { path: 'style.css', text: '/*\nTheme Name: Ok\nText Domain: ok\n*/' },
    { path: 'screenshot.png', text: '' },
    { path: 'functions.php', text: "<?php\ndefined( 'ABSPATH' ) || exit;\nadd_theme_support( 'title-tag' );" },
    { path: 'header.php', text: '<head><?php wp_head(); ?></head><body <?php body_class(); ?>><?php wp_body_open(); ?>' },
    { path: 'footer.php', text: '<?php wp_footer(); ?></body>' },
    { path: 'index.php', text: '<?php get_header();' },
    { path: 'template-parts/a.php', text: '<p><?php echo esc_html( $x ); ?></p>' },
  ]
  assert.deepEqual(themeFileFindings(files), [])
})

test('SCF: a short text field without a Character Limit is a warn, textareas and limited texts are fine', () => {
  const fields = [
    { group: 'Головна', name: 'hero_title', label: 'Заголовок', type: 'text', maxlength: '' },
    { group: 'Головна', name: 'hero_btn', label: 'Кнопка', type: 'text', maxlength: 24 },
    { group: 'Головна', name: 'hero_lede', label: 'Опис', type: 'textarea', maxlength: '' },
    { group: 'Головна', name: 'hero_img', label: 'Фото', type: 'image' },
  ]
  const found = fieldFindings(fields)
  assert.deepEqual(found.map((f) => [f.check, f.level, f.file]), [['scf_text_no_limit', 'warn', 'Головна']])
  assert.match(found[0].message, /"Заголовок" \(hero_title\)/)
})

test('the PHP lint: every syntax error fails with its file and line', () => {
  const found = lintFindings([{ file: 'inc/seo.php', line: 40, message: 'syntax error, unexpected token "}"' }])
  assert.deepEqual(found.map((f) => [f.check, f.level, f.file, f.line]), [['php_syntax', 'fail', 'inc/seo.php', 40]])
  assert.match(found[0].message, /unexpected token/)
  assert.deepEqual(lintFindings([]), [])
})

test('theme files: words in comments are not code (no false eval or <title>)', () => {
  const files = [
    { path: 'style.css', text: '/*\nTheme Name: Ok\n*/' },
    { path: 'screenshot.png', text: '' },
    { path: 'functions.php', text: "<?php\ndefined( 'ABSPATH' ) || exit;\nadd_theme_support( 'title-tag' );" },
    { path: 'inc/seo.php', text: "<?php\n/**\n * Minimal SEO: per-page <title> from the field\n */\ndefined( 'ABSPATH' ) || exit;\n// the wind system (by file name)\n# exec( later\n$u = 'http://x.test'; // keep" },
    { path: 'header.php', text: '<head><?php wp_head(); ?></head><body <?php body_class(); ?>><?php wp_body_open(); ?>' },
    { path: 'footer.php', text: '<?php wp_footer(); ?></body>' },
  ]
  assert.deepEqual(themeFileFindings(files), [])
})
