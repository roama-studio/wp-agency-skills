---
name: wp-edits
description: 'Edit a copy of a client''s existing WordPress site (classic theme or Elementor) without touching the live site: qa-kit wp-site imports the files + MySQL dump (or the archive of the bundled «Агенція: експорт» plugin when you only have wp-admin) into WordPress Playground on SQLite (live address replaced, client config and backups left out), starts/stops it, runs WP-CLI on it (also SCF fields and Elementor _elementor_data), checks its health and compares the original copy with the edited one (sitemap + menu pages, 8 widths, JPG evidence); qa-kit bridge build turns the difference into an edit set (edits.json, EDITS.md, the «Агенція: правки» plugin zip with preflight, backups and rollback; also WP-CLI over SSH) and dry-runs it on a third copy. Checked on a real classic-theme site and on Elementor (2026-10-23/24). Use when working on edits to an existing WordPress site.'
---

# Edits to an existing WordPress site (Playground copy)

First run: a classic-theme site + an Elementor probe, 2026-10-23. The tool is
`qa-kit wp-site` (on PATH with this plugin; its README: `tools/qa-kit/README.md`).
Sister skills: `wp-deploy` (how a site gets copied from / to hosting over SSH),
`wp-classic-theme` (themes you build), `wp-theme-qa` (checking a theme).

## 0. Rules

- **The live site is never touched while editing.** Everything happens in a copy
  in the order's workspace (git-ignored). Reading the live site over SSH (a
  `mysqldump`, `tar` of the files) is allowed only with the site owner's
  permission and is read-only.
- **No passwords.** wp-admin of the copy opens through Playground's auto-login
  link (`site.json` -> `admin`); nobody types the client's password anywhere.
- **Every edit is a command.** Write each change as the WP-CLI command (or the
  changed file) into the order's `EDITS.md` / edit script in the order you ran
  it: after the client approves, the same commands are applied to the live site,
  so new leads and orders on the live site are never overwritten.
- **Two copies:** `original` (never edited: the baseline for QA) and `edited`.
  Import both from the same copy, on different ports.
- **No window on the user's desktop** (Playground starts can open terminal
  windows over the user's work). Every process a tool starts is
  invisible: always go through `qa-kit wp-site` (never `npx @wp-playground/cli`
  by hand: npx runs a `cmd.exe` shim). Inside the kit: `hiddenSpawnOptions`
  (`windowsHide: true`, never `detached`: a detached process has no console, so
  its console children open NEW windows in Windows Terminal), the cached
  Playground CLI run by node itself (`playgroundCommand`), and the long-lived
  server through a WScript launcher with window style 0 (`hiddenLauncherVbs`;
  a non-detached child would die with qa-kit). Check after a start:
  `Get-Process | ? MainWindowHandle -ne 0` shows nothing new. Stop what you start.

## 1. The copy the client gave

A folder with the WordPress files (at its root or in `files/`, `public/`,
`public_html/`, `www/`) and **one** `.sql` dump (mysqldump). From hosting over
SSH (read-only): `mysqldump` with the server-side credentials file (never print
it) and `tar` of the site folder; from Local WP: `wp db export` + the
`app/public` folder. From a backup plugin archive: unpack to the same shape.

## 2. Commands (from the order folder; `Q=qa-kit`, on PATH with this plugin)

```
$Q wp-site import <copy> <work>/original --port 9510   # ~1 min; writes original/site.json
$Q wp-site import <copy> <work>/edited   --port 9511
$Q wp-site start  <work>/edited                        # background; prints the site + admin link
$Q wp-site health <work>/edited                        # home 200, wp-admin, no PHP fatal (exit 1 on fail)
$Q wp-site wp     <work>/edited post list --post_type=page --fields=ID,post_name,post_title
$Q wp-site compare <work>/original <work>/edited --expect ./,menyu/   # starts/stops what is not running
$Q wp-site stop   <work>/edited                        # by pid + whatever listens on the port; checks it is quiet
```

- `import` refuses a folder that already holds a site and a busy port. Read
  `site.json`: `import.failed` + `import.errors` (statements the SQLite
  translator refused), `import.left_out` (SET, LOCK, triggers, procedures,
  views: SQLite has none), `replacements` (how many addresses were changed),
  `skipped_copy` (the client's wp-config, caches, backups, `db.php` /
  `object-cache.php` / `advanced-cache.php` drop-ins), `notes`, `admin`,
  `theme`, `plugins`, `wp`.
- The address is fixed per copy (`http://127.0.0.1:<port>` is written into the
  database), so a copy always runs on its own port.
- `wp` works while the site is served (both use the same SQLite file); each call
  boots PHP in WebAssembly: about 5-8 s. Put many changes into one
  `wp eval '...'` when they belong together.
- `compare` = the `qa-kit original` machinery: pages from both sitemaps
  (`wp-sitemap.xml`, users left out) and the home page links, 8 widths, the
  admin bar and `canvas, video, iframe, [data-qa-mask]` masked, exact pixels,
  JPG evidence (original | edited with red boxes) in
  `<edited>/test-results/qa-kit/wp-site-compare/latest/`. Pages in `--expect`
  are `info`, any other change is `warn` until QA has looked at it. Slow:
  Playground serves every file through PHP: plan ~1-2 min per page for 8 widths;
  narrow with `--pages` / `--widths` while working, all of them before delivery.

## 3. Recipes

**Classic theme / SCF field**: find the field, then change it.
```
$Q wp-site wp <edited> post meta list 54 --format=csv --fields=meta_key,meta_value
$Q wp-site wp <edited> post meta update 54 hero_title "Новий заголовок"
```
Options pages of SCF: `wp option get options_<field>` / `wp option update`.
Theme file edits: edit `<edited>/wordpress/wp-content/themes/<theme>/...` and keep
the changed file list for delivery.

**Elementor** (probe: Elementor 4.3.5, WordPress 7.1.3): the page lives in the
post meta `_elementor_data` (JSON, slashes escaped), not in theme files. Change
it by the element id, never by a text search-replace on the raw JSON:
```
$Q wp-site wp <edited> eval '$id=5; $d=json_decode(get_post_meta($id,"_elementor_data",true),true);
  $walk=function(&$els) use (&$walk){ foreach($els as &$e){ if(($e["id"]??"")==="e1f2a3b") $e["settings"]["title"]="Новий текст";
  if(!empty($e["elements"])) $walk($e["elements"]); } }; $walk($d);
  update_post_meta($id,"_elementor_data",wp_slash(wp_json_encode($d))); echo "saved";'
$Q wp-site wp <edited> elementor flush-css
```
Find the id: `wp post meta get <id> _elementor_data` and look for the widget
(`widgetType`, `settings.title` / `editor` / `text`). `wp_slash()` is needed or
WordPress strips the backslashes of the JSON. After every Elementor change:
`elementor flush-css`, then check the page. Global colours/fonts live in the
active kit (`wp option get elementor_active_kit` -> its `_elementor_page_settings`).

## 4. Only wp-admin: the bridge plugins

When the client gives only a wp-admin login (no SSH / FTP): the two bundled plugins,
guide for the site owner in `tools/qa-kit/wp-bridge/README.md` (Ukrainian). Nobody but
the owner logs in.

1. **Copy.** `$Q bridge export-plugin --out <folder>` -> `<folder>/agency-bridge-export.zip`.
   The owner uploads it, «Інструменти → Агенція: експорт», downloads the archive,
   removes the plugin. `$Q wp-site import <archive>.zip <work>/original --port 9510`
   (and `edited`, 9511): the zip is unpacked by the import itself.
2. **Edit** the `edited` copy as in 2-3 above; QA compares as usual.
3. **Edit set.** `$Q bridge build <work>/original <work>/edited --order <name> --note "<what>"`:
   finds every change itself (both databases, the active theme's files), reads the
   values with the plugin's own PHP engine, maps the copy's address back to the live
   one; Elementor changes go per element setting. Read `EDITS.md`:
   - «Не переноситься плагіном»: new / deleted posts and terms, new media, plugin files,
     plugin settings (`active_plugins`), multi-value fields, plugins' own tables -> plan
     them as manual steps (no zip is built until `--allow-unsupported`);
   - «Нові опції не включено»: options that did not exist in the original are left
     out (mostly plugins' own settings written when wp-admin opened). If an edit created
     one (a new SCF option field `options_x` + `_options_x`), build again with
     `--include-option options_x,_options_x` (`*` works).
4. **Dry run** on a third copy from the same archive: `$Q bridge check|apply|rollback
   <work>/dry <...>/edits.json` (`apply` must say `applied`, a second `apply` `already`,
   `rollback` `rolled_back`; `$Q bridge build <work>/dry <work>/edited ...` after the
   apply must find 0 edits).
5. **Live.** The owner uploads `agency-bridge-apply-<order>.zip`, «Інструменти → Агенція:
   правки»: every edit is checked first (the live value must still be the one we copied:
   else «Конфлікт», nothing is written), backups, apply, caches flushed (Elementor CSS
   too), «Відкотити» restores exactly. With SSH: `wp eval-file <plugin>/cli.php
   edits.json check|apply|rollback`.

Rules: the set never changes the address, plugins, theme, roles, admin, cron or keys;
files only inside the active theme (no `..`, no dot files, known types, sha256
checked); a conflict means a NEW set from a fresh copy, never forcing.

## 5. Known limits (say them when they bite)

- **SQLite, not MySQL.** The translator handles normal WordPress dumps (a real
  site: 36/36 statements). Plugins with raw MySQL-only SQL (FULLTEXT search, stored
  procedures, triggers, views, `INSERT ... ON DUPLICATE` in odd forms) may fail:
  read `import.errors` and the page errors. Then use Local WP (`wp-local-install`).
- **Big sites.** The dump is read whole into memory; uploads are copied. A dump
  over ~200 MB or a site over a few GB: expect slow imports; ask whether a
  partial copy (no old uploads) is enough.
- **PHP extensions.** Playground has the common ones (intl, mbstring, gd, ...);
  ionCube-encoded plugins, Imagick-only code and Redis/Memcached caches do not
  run. Caching / security plugins that need the server (LiteSpeed, Wordfence's
  firewall) can be deactivated in the copy (`wp plugin deactivate`): say so.
- **Licensed plugins** (Elementor Pro, ACF PRO, ...) are in the client's files and
  run in the copy; never download or update them; their licence checks may
  complain offline (ignore, do not "activate" licences).
- **No mail, no cron** in the copy (`DISABLE_WP_CRON`). Forms submit but send nothing.
- **Playground bugs met:** the `php` command turns numeric arguments into empty
  strings (`post get 54` -> `post get ""`): `qa-kit wp-site wp` passes the
  arguments through a file, so always use it, never Playground's `php` directly.
  Only `run-blueprint` / `server` create the SQLite database (the import does a
  first boot with an empty blueprint). A copy's SQLite file once ended in WAL
  mode (after a killed server): inside Playground every WordPress query then
  fails with "database is locked" / "Cannot escape data without an active
  database connection". `wp` and `start` switch it back first (`journalGuard`,
  node:sqlite). A lazy image that never reaches the screen (hidden gallery
  filter) made the comparison wait forever: images are now asked eagerly and
  waited for at most 5 s.
