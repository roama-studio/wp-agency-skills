# QA kit

Measured site checks for a QA engineer or a QA agent. With the plugin enabled it is on
PATH as `qa-kit`. The kit only measures and looks; you decide what becomes a bug.

Setup: the first `qa-kit` run installs its Node dependencies (`npm ci`) and Playwright's
Chromium itself. Optional WebKit: `npx playwright install webkit` in this folder.

## `qa-kit check <code folder> --url <running site> [--round N] [--pages rooms.html,about/] [--no-webkit | --webkit] [--country DE]`

The site must already run (the QA agent starts it with the project's own server).
Pages are found from the start page's links (up to `max_pages`); a link that
answers 404 is a `broken_link` and is not checked further.

A one-page app (SPA) shows its tabs without a new address, so links do not find
them. Name them in `--pages`: a path, then `>` and the exact text or aria-label of
the button to click, e.g. `--pages "./,>Агенти і баги,rooms.html>Book"`
(`./` is the start page, `>Tab` a tab on it; `>A>B` clicks two in turn; no commas inside a
text). Every pass opens the page, clicks, waits until the network is quiet and
checks it as a page of its own (screenshots `home--Агенти-і-баги-1440.png`). A
button that is not there at a width (a phone menu hides it) is a `tab_not_found`
warn with those widths, and the tab is not checked there: name the phone path too,
e.g. `>Агенти,>Команда>Агенти`. Then:

- every page at `widths` (320 ... 2560), a landscape phone, zoom 200%: horizontal
  overflow, broken images, console errors and failed requests;
- one `<h1>` and `alt` (1440); axe-core at 390 and 1440 (critical/serious = fail);
- reduced motion: nothing left invisible, Lenis off; Lenis on normally;
- performance at 390 on a slow phone (network and CPU throttled): LCP, CLS, long
  tasks (the lab stand-in for INP), page / JS / image weight, oversized images;
- stress at 360: one image missing, headings and buttons 3x longer;
- WebKit at 390 when it can start (on this machine Windows Smart App Control blocks
  its unsigned libraries: the report says so as `info`). A blocked WebKit is
  remembered in `.webkit-blocked.json` (this machine only, not in git), so
  the next runs do not try it and the blocked-file pop-up does not come back;
  `--webkit` tries again (and forgets the memo when it starts);
- regression: full-page screenshots at 390 and 1440 compared with
  `round-(N-1)`; a `-diff.png` shows the changed pixels in red.
- the legal minimum:
  a fresh visitor who consented to nothing; requests to other servers
  (`third_party_before_consent`, `google_fonts`), a pre-ticked form checkbox,
  the start page's links to a privacy policy (and an Impressum for DE/AT) and
  `[FILL IN: ...]` placeholders left. `--country` is the client's two-letter
  code: EU/EEA = fail, otherwise (Ukraine) or no country = warn. Not legal advice.

Output: `<code folder>/test-results/qa-kit/round-N/qa-report.json` and `shots/`.
Findings have `level` fail / warn / info, `page`, `widths`, `browser`, `view`,
`message`, `screenshot`; the same problem at several widths is one finding.

## `qa-kit code <code folder>`

The QA "code" round: secrets and `.env` files in git, `npm audit` (high/critical =
fail), dependencies nothing imports, files nothing refers to, `console.log`,
external links without `rel="noopener"`, forms without validation or a honeypot,
no CSP. Reads git-tracked files only. Output:
`test-results/qa-kit/code/code-report.json`.

## `qa-kit wp <project folder> --theme <theme folder> [--plugins a,b|none] [--wp-cli "<cmd>"]... [--pages a/,b/] [--php 8.3] [--wp latest] [--port 9400] [--round N] [--no-stress]`

A classic WordPress theme in a throwaway WordPress Playground (
`npx @wp-playground/cli@3.1.55`, downloaded on the first run, nothing added to
package.json). A COPY of the theme is mounted; `secure-custom-fields` and
`contact-form-7` come from wordpress.org (`--plugins` changes them); each
`--wp-cli` command runs after the theme is active (e.g. its importer
`"mytheme import"`). A helper mu-plugin (`lib/wp-qa-kit.php`, token-guarded,
only inside Playground) reports pages, post types, menus and SCF fields,
lints every theme PHP file and applies the stress. Then:

- theme files: PHP syntax, the `ABSPATH` guard in `inc/`, `title-tag`,
  `wp_head` / `wp_footer` / `wp_body_open` / `body_class`, no `eval`/`exec`,
  `screenshot.png`; SCF text fields without a Character Limit;
- every page (all published pages, one archive and single per post type,
  `--pages`) at `wp.widths` with reduced motion: HTTP status, PHP errors in
  the HTML, console errors, horizontal overflow, text outside the screen or
  cut by its box; a missing page must answer 404; internal links;
- the admin screens the client uses (pages, post types, taxonomies, menus,
  media, SCF options pages), logged in as Playground's admin;
- stress: every filled SCF text/textarea at its limit (x3 without one) and
  +3 long items in every menu, then the pages again - only new problems;
- `debug.log` of the whole run: theme fatal/parse/warning = fail,
  deprecated/notice = warn, WordPress or plugins = info.

Output: `<project>/test-results/qa-kit/wp/round-N/wp-report.json`, `shots/`
(JPG; 390 and 1440 always, other widths when they have a finding),
`shots/stress/`, `server.log`, `wp-log/debug.log`. The server is stopped at
the end (`server_stopped` in the report). In Git Bash the kit sets
`MSYS_NO_PATHCONV=1` for Playground itself. A run of ~8 pages takes ~5 min.

## `qa-kit original <code folder> [--ref <git ref>] [--pages ./,menu.html] [--expect menu.html] [--widths 360,390,768,1440] [--mask ".selector,#id"] [--round N]`

An order of edits to an existing project: the client's site
was copied into a code folder whose FIRST commit is the untouched original
and the Developer committed the edits on top. The kit compares the working
copy with that original, exactly:

- the original (`--ref`, default the root commit) is exported to a temporary
  git worktree in the OS temp folder; both versions are served by a built-in
  static server (node:http, free ports, `index.html` for a folder); the
  worktree and both servers are removed at the end, also on error
  (`servers_stopped` in the report);
- pages: `--pages`, else the start page's links of both versions (plus
  `--expect`), up to `max_pages`. A page only in the working copy is
  `page_added` (info when in `--expect`, else warn), only in the original
  `page_removed` (fail), linked but in neither `page_missing` (info);
- every page at `original.widths` (360 ... 1920) in both versions, full
  page, with reduced motion, CSS animations finished / infinite ones reset,
  videos paused, the caret hidden, the same scroll-through as `check`;
  `canvas`, `video`, `iframe`, `[data-qa-mask]`, `original.mask_selectors`
  and `--mask` are covered with a solid magenta box in both (not compared:
  look at them by eye);
- the diff is exact: `original.pixel_delta` is 0, any changed pixel counts
  (also where one version is taller). Changed pixels are grouped into
  regions (`box_gap`, at most `max_boxes` per page and width);
- findings: a changed page named in `--expect` is `original_change` info
  "changed as expected"; a changed page not in `--expect` is warn
  "unexpected change" (a possible regression); without `--expect` every
  change is info; a page in `--expect` where no pixel changed is
  `original_unchanged` warn; console errors, page errors and failed
  requests only in the working copy are `console_new` fail.

Output: `<code folder>/test-results/qa-kit/original/round-N/original-report.json`
(`ref`, `head`, `pages`, `added`, `removed`, `missing`, `pairs` = one per page
and width with `changed_ratio`, `changed_pixels`, `height_original`,
`height_current`, `height_change`, `boxes` [{x, y, w, h, pixels}], `masked`,
`evidence`; `console` per page; `findings` with `widths`, `boxes` per width and
`evidence`) and `shots/<page>-<width>.jpg` only for a changed pair: the
original on the left, the working copy on the right, the changed regions in
red boxes on the right. 3 pages x 8 widths take ~40 s.

## `qa-kit wp-site import|start|stop|health|wp|compare`

A copy of a client's existing WordPress site (its files + one MySQL dump) as a
local site in WordPress Playground on SQLite, for edits without touching the
live site. Recipes: the `wp-edits` skill of this plugin.

- `import <copy> <site> [--sql dump.sql] [--port 9500] [--php 8.3]`: the
  WordPress files (at the copy's root or in `files/`, `public/`, `public_html/`,
  `www/`) are copied to `<site>/wordpress` without the client's `wp-config.php`,
  `.git`, caches, backups, `debug.log` and the `db.php` / `object-cache.php` /
  `advanced-cache.php` drop-ins (`lib/wpsite.mjs` `skipCopy`); our wp-config is
  written (the dump's table prefix, debug to `<site>/wp-log/debug.log`, no
  cron, no auto-updates); a first boot (`run-blueprint`, empty blueprint)
  creates the SQLite database; the dump's statements (split outside quotes,
  comments dropped, SET / LOCK / transactions / triggers / routines / views
  left out) run through `$wpdb` (`lib/wp-site-import.php`) after every table
  of the fresh install is dropped; the live `siteurl` / `home` are replaced
  with `http://127.0.0.1:<port>` by `wp search-replace --precise` (serialized
  data), with http/https, with and without www, plain and JSON-escaped (only
  the forms that occur in the dump). `<site>/site.json` keeps the facts.
- `start <site>`: `server` in the background without any window (Windows: a
  WScript launcher `<site>/start-server.vbs` with window style 0 runs the cached
  Playground CLI with node itself, output in `<site>/server.log`; every other
  child uses `hiddenSpawnOptions`: windowsHide, never detached),
  `PLAYGROUND_FORCE_AUTO_LOGIN_ENABLED`: wp-admin opens with
  `/wp-admin/?playground_force_auto_login_as_user=<admin>`, no password and no
  admin bar for visitors. `stop <site>`: kills the pid tree and every listener
  of the port (`netstat`, any Windows language), then checks it is quiet.
- `health <site>`: the home page 200 without PHP errors, wp-admin reached
  through the auto-login, PHP fatal / parse errors in `debug.log` = fail.
  Exit 1 on a fail.
- `wp <site> <args...>`: WP-CLI (`https://playground.wordpress.net/wp-cli.phar`,
  downloaded once into `.cache/wp-site/`, the same file Playground's own
  `wp-cli` step uses) through `lib/wp-site-cli.php`, which reads the arguments
  from a JSON file: Playground's `php` command empties numeric arguments.
- `compare <original site> <edited site> [--pages] [--expect] [--widths] [--mask] [--round N]`:
  starts what is not running (and stops it after), takes the pages from both
  sitemaps and the home page links, and runs the `original` comparison
  (`compareVersions` in `original.mjs`) with `#wpadminbar` masked too. Output:
  `<edited>/test-results/qa-kit/wp-site-compare/latest/wp-site-compare-report.json`
  and `shots/`.

## `qa-kit bridge export-plugin|build|check|apply|rollback`

The bridge for sites reachable only through wp-admin (no SSH): two plugins in
`wp-bridge/` (the site owner's guide in Ukrainian: `wp-bridge/README.md`).

- `export-plugin [--out dir]`: `wp-bridge/dist/agency-bridge-export.zip` («Агенція:
  експорт»): Tools page, AJAX steps of a few seconds (resumable: SQL dump through
  `$wpdb` in UTC like mysqldump, then the files into a zip; ZipArchive, else PclZip),
  `files/` + `database.sql` + `export.json`, no `wp-config.php` / `.env` / caches /
  backups / archives; private folder in uploads, admin + nonce download, removed after
  the download, after 24 h, on deactivation. `qa-kit wp-site import <archive.zip>`
  unpacks it (Windows: System32 bsdtar) into `<site>/source` and imports.
- `build <original> <edited> --order <name> [--note] [--out] [--include-option a,b*]
  [--allow-unsupported] [--no-warm]`: opens home + wp-admin on both copies once (plugin
  self-init lands in both), diffs their SQLite databases (`lib/bridge.mjs dbChanges`:
  options, post fields, post meta, terms, term meta; service noise ignored; new options
  only when named), the active theme's files, reads every value on both copies with
  the plugin's own engine (`wp-bridge/apply/cli.php read`), maps the copy's address to
  the live one, Elementor per element setting (`elementorEdits`), and writes
  `<edited>/bridge/<order>/edits.json`, `EDITS.md` and
  `agency-bridge-apply-<order>.zip` («Агенція: правки»: preflight, backups, apply,
  rollback; the set inside `edits/payload.php`). No zip while something is not
  supported (new posts, uploads, plugin files...) unless `--allow-unsupported`.
- `check|apply|rollback <site> <edits.json>`: the same engine on a Playground copy (a
  dry run; the live address in the set is mapped to the copy's).
- Slow end-to-end checks (not in `npm test`): `node wp-bridge/tests/e2e.mjs
  php74|engine|admin|elementor` (see its header).

## Rules and tests

Tolerances live in `rules.json`; the judgements in `lib/judge.mjs`,
`lib/legal.mjs`, `lib/code_checks.mjs` and `lib/original.mjs` (options, box
grouping, levels, the static server) and `lib/wpsite.mjs` (wp-site options, the dump, the address forms, the copy filter, port listeners) and `lib/bridge.mjs` (bridge options, the copy diff, Elementor edits, the edit set, the zip writer) are pure and tested: `npm --prefix qa_kit test`
(`tests/original_run.test.mjs` runs `original` on a two-page site in a temp git repo).
