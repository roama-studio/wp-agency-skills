// the pure parts of `qa-kit wp-site` (a copy of a client's WordPress site in Playground).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  configPrefix, dumpFacts, importable, listenerPids, sitemapLocs, skipCopy, splitSql, urlReplacements, wpConfigText, wpSiteOptions,
} from '../lib/wpsite.mjs'

const unix = (p) => p.replace(/\\/g, '/')

test('options: import takes the copy, the site folder, the dump and a fixed port', () => {
  const o = wpSiteOptions(['import', 'C:/w/copy', 'C:/w/site', '--sql', 'C:/w/copy/db.sql', '--port', '9512'])
  assert.equal(o.command, 'import')
  assert.match(unix(o.source), /w\/copy$/)
  assert.match(unix(o.site), /w\/site$/)
  assert.match(unix(o.sql), /w\/copy\/db\.sql$/)
  assert.equal(o.port, 9512)
  assert.equal(o.php, '8.3')
})

test('options: import defaults to port 9500 and no dump named (found later in the copy)', () => {
  const o = wpSiteOptions(['import', 'copy', 'site'])
  assert.equal(o.port, 9500)
  assert.equal(o.sql, null)
})

test('options: start/stop/health take one site folder; wp passes everything after the folder to WP-CLI', () => {
  assert.equal(wpSiteOptions(['start', 'site']).command, 'start')
  assert.equal(wpSiteOptions(['stop', 'site']).command, 'stop')
  const o = wpSiteOptions(['wp', 'site', 'post', 'meta', 'get', '5', '_elementor_data', '--format=json'])
  assert.deepEqual(o.wpArgs, ['post', 'meta', 'get', '5', '_elementor_data', '--format=json'])
})

test('options: compare takes two sites and the original-check options', () => {
  const o = wpSiteOptions(['compare', 'C:/w/original', 'C:/w/edited', '--expect', 'menyu/', '--widths', '390,1440', '--mask', '.map', '--round', '2'])
  assert.match(unix(o.site), /w\/original$/)
  assert.match(unix(o.other), /w\/edited$/)
  assert.deepEqual(o.expect, ['/menyu/'])
  assert.deepEqual(o.widths, [390, 1440])
  assert.deepEqual(o.mask, ['.map'])
  assert.equal(o.round, 2)
  assert.match(unix(o.out), /w\/edited\/test-results\/qa-kit\/wp-site-compare\/round-2$/)
})

test('options: unknown command, missing folders, a bad port are refused', () => {
  assert.throws(() => wpSiteOptions([]), /usage/)
  assert.throws(() => wpSiteOptions(['launch', 'site']), /usage/)
  assert.throws(() => wpSiteOptions(['import', 'copy']), /site folder/)
  assert.throws(() => wpSiteOptions(['compare', 'a']), /two site folders/)
  assert.throws(() => wpSiteOptions(['import', 'a', 'b', '--port', '80']), /port/)
  assert.throws(() => wpSiteOptions(['wp', 'site']), /WP-CLI/)
})

test('splitSql: statements split on ; outside quotes, comments dropped, escaped quotes kept', () => {
  const sql = `-- MySQL dump 10.13
/*!40101 SET NAMES utf8 */;
DROP TABLE IF EXISTS \`wp_options\`;
CREATE TABLE \`wp_options\` (
  \`option_id\` bigint unsigned NOT NULL AUTO_INCREMENT, -- trailing
  PRIMARY KEY (\`option_id\`)
) ENGINE=InnoDB /*!50100 something */;
INSERT INTO \`wp_options\` VALUES (1,'siteurl','http://a.local','yes'),(2,'blogdescription','It\\'s; fine -- not a comment','yes');
`
  const s = splitSql(sql)
  assert.equal(s.length, 3)
  assert.match(s[0], /^DROP TABLE IF EXISTS `wp_options`$/)
  assert.match(s[1], /^CREATE TABLE/)
  assert.doesNotMatch(s[1], /trailing|50100/)
  assert.match(s[2], /It\\'s; fine -- not a comment/)
})

test('importable: data and tables yes; session settings, locks, databases and routines no', () => {
  assert.equal(importable('INSERT INTO `wp_posts` VALUES (1)'), true)
  assert.equal(importable('CREATE TABLE `wp_posts` (id int)'), true)
  assert.equal(importable('DROP TABLE IF EXISTS `wp_posts`'), true)
  for (const s of ['SET NAMES utf8mb4', 'LOCK TABLES `wp_posts` WRITE', 'UNLOCK TABLES', 'USE `db`',
    'CREATE DATABASE x', 'START TRANSACTION', 'COMMIT', 'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET @a = 1',
    'CREATE DEFINER=`root`@`localhost` PROCEDURE p() BEGIN END']) {
    assert.equal(importable(s), false, s)
  }
})

test('dumpFacts: the table prefix, siteurl and home from a mysqldump', () => {
  const sql = "CREATE TABLE `wpx7_options` (`option_id` int);\nINSERT INTO `wpx7_options` VALUES (1,'siteurl','https://www.cafe.com.ua','yes'),(2,'home','https://www.cafe.com.ua/','yes');"
  assert.deepEqual(dumpFacts(sql), { prefix: 'wpx7_', siteurl: 'https://www.cafe.com.ua', home: 'https://www.cafe.com.ua' })
  assert.deepEqual(dumpFacts('nothing'), { prefix: null, siteurl: null, home: null })
})

test('configPrefix: $table_prefix of the client wp-config.php', () => {
  assert.equal(configPrefix("<?php\n$table_prefix = 'abc_';\n"), 'abc_')
  assert.equal(configPrefix('<?php\n$table_prefix  =  "wp_" ;'), 'wp_')
  assert.equal(configPrefix('<?php'), null)
})

test('wpConfigText: our wp-config with the prefix, debug to the log, no client secrets', () => {
  const text = wpConfigText({ prefix: 'abc_' })
  assert.match(text, /\$table_prefix = 'abc_';/)
  assert.match(text, /WP_DEBUG_LOG', '\/qa-log\/debug\.log'/)
  assert.match(text, /WP_DEBUG_DISPLAY', false/)
  assert.match(text, /wp-settings\.php/)
  assert.throws(() => wpConfigText({ prefix: "x'; evil" }), /prefix/)
})

test('urlReplacements: http/https, www and bare host, JSON-escaped slashes, all to the local address', () => {
  const r = urlReplacements(['https://www.cafe.com.ua', 'https://www.cafe.com.ua/'], 'http://127.0.0.1:9512')
  const pairs = new Map(r)
  assert.equal(pairs.get('https://www.cafe.com.ua'), 'http://127.0.0.1:9512')
  assert.equal(pairs.get('http://www.cafe.com.ua'), 'http://127.0.0.1:9512')
  assert.equal(pairs.get('https://cafe.com.ua'), 'http://127.0.0.1:9512')
  assert.equal(pairs.get('http://cafe.com.ua'), 'http://127.0.0.1:9512')
  assert.equal(pairs.get('https:\\/\\/www.cafe.com.ua'), 'http:\\/\\/127.0.0.1:9512')
  assert.equal(r.length, 8)
  assert.deepEqual(urlReplacements(['http://mytheme.local'], 'http://127.0.0.1:9500').map(([a]) => a),
    ['http://mytheme.local', 'http:\\/\\/mytheme.local', 'https://mytheme.local', 'https:\\/\\/mytheme.local',
      'http://www.mytheme.local', 'http:\\/\\/www.mytheme.local', 'https://www.mytheme.local', 'https:\\/\\/www.mytheme.local'])
  assert.deepEqual(urlReplacements(['http://127.0.0.1:9500'], 'http://127.0.0.1:9500'), [])
})

test('urlReplacements: a site in a sub-folder keeps its path', () => {
  const r = new Map(urlReplacements(['https://cafe.ua/shop'], 'http://127.0.0.1:9500'))
  assert.equal(r.get('https://cafe.ua/shop'), 'http://127.0.0.1:9500')
  assert.equal(r.get('https://cafe.ua/shop'.replace(/\//g, '\\/')), 'http:\\/\\/127.0.0.1:9500')
})

test('listenerPids: the processes listening on a port, in any Windows language', () => {
  const netstat = `
  Proto  Lokale Adresse         Remoteadresse          Status           PID
  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN          1100
  TCP    127.0.0.1:9512         0.0.0.0:0              ABHÖREN          4321
  TCP    127.0.0.1:9512         127.0.0.1:55437        WARTEND          0
  TCP    127.0.0.1:55437        127.0.0.1:9512         HERGESTELLT      777
  TCP    [::]:9512              [::]:0                 LISTENING        16332
  TCP    [::]:95120             [::]:0                 LISTENING        999
`
  assert.deepEqual(listenerPids(netstat, 9512), [4321, 16332])
  assert.deepEqual(listenerPids(netstat, 1), [])
})

test('sitemapLocs: page and sub-sitemap addresses from a WordPress sitemap', () => {
  const index = '<?xml version="1.0"?><sitemapindex><sitemap><loc>http://127.0.0.1:9500/wp-sitemap-posts-page-1.xml</loc></sitemap></sitemapindex>'
  assert.deepEqual(sitemapLocs(index), { sitemaps: ['http://127.0.0.1:9500/wp-sitemap-posts-page-1.xml'], pages: [] })
  const pages = '<urlset><url><loc>http://127.0.0.1:9500/</loc></url><url><loc>http://127.0.0.1:9500/menyu/</loc></url></urlset>'
  assert.deepEqual(sitemapLocs(pages), { sitemaps: [], pages: ['http://127.0.0.1:9500/', 'http://127.0.0.1:9500/menyu/'] })
})

test('skipCopy: the client config, caches, backups, logs and drop-ins that clash with SQLite stay out', () => {
  for (const p of ['wp-config.php', '.git', 'wp-content/cache', 'wp-content/updraft', 'wp-content/ai1wm-backups',
    'wp-content/upgrade', 'wp-content/debug.log', 'wp-content/db.php', 'wp-content/object-cache.php',
    'wp-content/advanced-cache.php', 'wp-content/database', 'wp-content/backups-dup-lite', 'wp-content/uploads/backwpup-abc-backups']) {
    assert.equal(skipCopy(p), true, p)
  }
  for (const p of ['wp-content/themes/x/style.css', 'wp-content/uploads/2026/10/a.jpg', 'wp-includes/version.php',
    'wp-content/plugins/elementor/elementor.php', 'index.php', 'wp-content/themes/x/wp-config.php']) {
    assert.equal(skipCopy(p), false, p)
  }
})

test('hidden spawn: every background process is windowless, not detached (no new console window)', async () => {
  const { hiddenSpawnOptions } = await import('../lib/wp.mjs')
  const o = hiddenSpawnOptions({ stdio: ['ignore', 3, 3], env: { A: '1' } })
  assert.equal(o.windowsHide, true)
  assert.equal(o.detached, false)
  assert.equal(o.shell, false)
  assert.deepEqual(o.stdio, ['ignore', 3, 3])
  assert.equal(o.env.A, '1')
  assert.equal(hiddenSpawnOptions().windowsHide, true)
})

test('playgroundCommand: the cached Playground CLI runs with node itself, else npx', async () => {
  const { playgroundCommand, PLAYGROUND } = await import('../lib/wp.mjs')
  const version = PLAYGROUND.split('@').pop()
  const cache = 'C:/Users/x/AppData/Local/npm-cache'
  const pkg = `${cache}/_npx/abc/node_modules/@wp-playground/cli/package.json`
  const files = { [pkg]: JSON.stringify({ version }), [`${cache}/_npx/abc/package.json`]: JSON.stringify({ _npx: { packages: [PLAYGROUND] } }),
    [`${cache}/_npx/old/package.json`]: JSON.stringify({ _npx: { packages: ['@wp-playground/cli@latest'] } }),
    [`${cache}/_npx/old/node_modules/@wp-playground/cli/package.json`]: JSON.stringify({ version }) }
  const fs = {
    execPath: 'C:/node/node.exe', cacheDirs: [cache],
    list: (dir) => (unix(dir).endsWith('_npx') ? ['old', 'abc'] : []),
    exists: (p) => unix(p) in files || unix(p).endsWith('wp-playground.js'),
    read: (p) => files[unix(p)],
  }
  const c = playgroundCommand(['server', '--port=9510'], fs)
  assert.equal(c.file, 'C:/node/node.exe')
  assert.match(unix(c.args[0]), /_npx\/abc\/node_modules\/@wp-playground\/cli\/wp-playground\.js$/)
  assert.deepEqual(c.args.slice(1), ['server', '--port=9510'])
  const none = playgroundCommand(['server'], { ...fs, list: () => [], env: { QA_KIT_NPX: 'npx' } })
  assert.deepEqual(none.args, ['-y', PLAYGROUND, 'server'])
})

test('hiddenLauncherVbs: the server starts through WScript with window style 0 and its output in the log', async () => {
  const { hiddenLauncherVbs } = await import('../lib/wpsite.mjs')
  const vbs = hiddenLauncherVbs('C:\Program Files\nodejs\node.exe', ['C:\cache\wp-playground.js', 'server', '--port=9511', '--site-url=http://127.0.0.1:9511'], 'C:\w\site\server.log')
  assert.match(vbs, /CreateObject\("WScript\.Shell"\)/)
  assert.match(vbs, /, 0, False\s*$/m)
  assert.ok(vbs.includes('""C:\Program Files\nodejs\node.exe""'), vbs)
  assert.ok(vbs.includes('> ""C:\w\site\server.log"" 2>&1'), vbs)
  assert.throws(() => hiddenLauncherVbs('node', ['a"b'], 'log'), /quote/)
})

test('journalGuard: a copy left in WAL mode goes back to the rollback journal', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { DatabaseSync } = await import('node:sqlite')
  const { journalGuard } = await import('../wpsite.mjs')
  const site = mkdtempSync(join(tmpdir(), 'qa-wpsite-'))
  const dir = join(site, 'wordpress', 'wp-content', 'database')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, '.ht.sqlite'))
  db.exec('CREATE TABLE t (a int)')
  db.prepare('PRAGMA journal_mode = WAL').get()
  db.close()
  assert.equal(journalGuard(site), 'wal->delete')
  assert.equal(journalGuard(site), 'delete')
  assert.equal(journalGuard(join(site, 'none')), null)
})
