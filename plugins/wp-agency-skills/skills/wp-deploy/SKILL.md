---
name: wp-deploy
description: 'Move a finished WordPress site from Local WP to the client''s shared hosting over SSH + WP-CLI: what the site owner does in the panel (DB, PHP version, SSH key, a permission rule), exporting the Local DB, packing without local files, wp-config from server-side credentials, importing, search-replace (also the CF7 sender @site.local), the mail plugin off Mailpit, permalinks, noindex until the client launches, live QA with a normal browser user agent, cleanup and the open items for the site owner. Checked on a real site (ukraine.com.ua, 2026-10-23). Use when a WordPress site goes live or moves to another host.'
---

# WordPress deploy: Local -> shared hosting (SSH + WP-CLI)

First real run: 2026-10-23, shared hosting ukraine.com.ua. Builds on `wp-local-install`
(WP-CLI from an agent's shell) and `wp-classic-theme` (the theme). Edits to a
client's EXISTING WordPress site happen on a Playground copy first: `wp-edits`.

## 0. What only the site owner can do (ask once, all together)

- **SSH key.** We make an ed25519 key (`~/.ssh/<site>_<host>`, never in git); the
  owner adds the `.pub` in the panel (or appends it to `~/.ssh/authorized_keys`
  from the panel's terminal). The private key never leaves this machine.
- **Database.** On shared hosting (ukraine.com.ua and most others) a MySQL DB +
  user exist **only via the panel**. A DB password is a credential: the agent never
  types it into a form. The owner creates the DB and stores its data on the
  server with a prompt that never echoes the password:
  ```
  read -p "DB_NAME: " N; read -p "DB_USER: " U; read -p "DB_HOST: " H; read -s -p "DB_PASS: " P; echo; printf "DB_NAME='%s'\nDB_USER='%s'\nDB_HOST='%s'\nDB_PASS='%s'\n" "$N" "$U" "$H" "$P" > ~/.<site>-db && chmod 600 ~/.<site>-db && unset P && echo DB-OK
  ```
  (Alternative: the panel's one-click WordPress install creates the DB; we then
  reuse its `wp-config.php` and overwrite the files.)
- **PHP version** of the site in the panel (match the plugins: CF7 6.2 needs 8.3).
- **Permission rule.** Auto mode blocks "production deploy" commands; never work
  around it. The owner adds, via `/permissions` -> Allow -> Project local:
  `Bash(ssh -i ~/.ssh/<key> <user>@<host> *)` and `Bash(scp -i ~/.ssh/<key> *)`.
- **Local site started** (the right one: check `mysqld` listens on the site's
  port from `%APPDATA%\Local\sites.json`, not another site's).

## 1. Check before touching anything

`ssh ... 'echo SSH-OK; test -f ~/.<site>-db && echo DBFILE-OK'`, then connect to
the DB with `MYSQL_PWD="$DB_PASS" mysql -h "$DB_HOST" -u "$DB_USER" "$DB_NAME"`
(print only `${#DB_PASS}`, never the value). The DB must be empty.
The host's CLI PHP may be older than the site's: run WP-CLI as
`/usr/local/php83/bin/php $(command -v wp)` (path per host).

## 2. Export and pack (on this machine)

- `wp db export deploy/<site>-local.sql --default-character-set=utf8mb4`.
- `tar -czf` the site root **without** `wp-config.php`, `local-xdebuginfo.php`,
  `wp-content/debug.log`, `wp-content/updraft`, `wp-content/upgrade` and unused
  default themes (keep one, e.g. twentytwentyfive, as a fallback).
- Upload both to `~/<site>-staging/` with scp (not into the web root).

## 3. On the server (one script, `set -euo pipefail`)

1. Move the host's stub `index.html` aside; untar into the web root.
2. `wp config create --dbname --dbuser --dbhost --dbprefix --dbcharset=utf8mb4
   --skip-check --prompt=dbpass <<< "$DB_PASS"` (password from the env file, never
   on the command line), `chmod 600 wp-config.php`; `WP_DEBUG false`,
   `DISALLOW_FILE_EDIT true`, `WP_ENVIRONMENT_TYPE production`, `shuffle-salts`.
3. Import with **`mysql ... < dump.sql`** - on ukraine.com.ua `wp db import`
   fails (`ERROR 1064 ... near 'SOURCE ...'`).
4. Find every spelling of the old domain first: `wp db search "<site>.local"
   --all-tables`. Expect: `siteurl`/`home`, content links, the Privacy Policy
   draft, and the **CF7 sender `wordpress@<site>.local`** in `_mail` meta.
   Replace `@<site>.local` -> `@<domain without www>`, then
   `http://<site>.local` -> `https://www.<domain>`, `--skip-columns=guid`,
   `--dry-run` first. What is left must be guids only.
5. `wp rewrite structure '/%postname%/'`; `--hard` may not write `.htaccess`
   on the host - the archived one (the standard WP block) works.
6. **Mail plugin off Local's Mailpit:** FluentSMTP keeps `127.0.0.1:<mailpit
   port>` from Local. Switch its connection to PHP mail (`provider = default`)
   until the owner sets a real SMTP mailbox.
7. **Indexing off** until the client launches: `wp option update blog_public 0`
   (check `<meta name='robots' content='noindex, nofollow'>`). A host-managed
   static `robots.txt` may exist (adm.tools) - noindex is what counts.
8. Delete the dump and the archive from staging.

## 4. Live QA

- `curl` every page: 200; a missing page 404; `http://` and the bare domain 301
  to `https://www.`.
- Some hosts answer **403 to the `HeadlessChrome` user agent** (qa-kit check
  fails at the start) - run Playwright with a normal Chrome UA: every page at
  360/768/1440, console errors, failed requests, horizontal scroll, old or
  `http://` URLs, full-page screenshots **after scrolling through** (scroll
  reveals and pinned sections are empty in an unscrolled full-page shot).
- Do not submit forms yourself (it sends a message): the owner sends one test.

## 5. Mail (seen 2026-10-23)

- CF7 sends to `[_site_admin_email]` = Settings → General. Changing it (and the
  user's profile email) in wp-admin waits for a confirmation link sent to the NEW
  address - if host mail does not arrive, it never applies and leads go to Local's
  `dev-email@wpengine.local`. Set both with WP-CLI when the owner gives the address:
  `wp option update admin_email ...`, `wp user update 1 --user_email=... --skip-email`.
- FluentSMTP from Local: `return_path yes` forces the envelope sender to a mailbox
  that does not exist - turn it off (or deactivate the plugin until a real SMTP).
- ukraine.com.ua: adm.tools → Хостинг → «Пошта з сайту» shows every mail() call;
  `stat=Sent (Message accepted for delivery)` there is NOT delivery. On a new
  account mail to Gmail did not arrive at all (the day counter stayed «0 з 500»)
  -> ask the host's support with the log id; the leads still reach Telegram + the
  Sheet and Flamingo.

## 6. Open items for the site owner (report, do not do)

- The admin login and password come from Local (`admin`, admin email
  `dev-email@wpengine.local`): the owner sets a strong password and a real email
  in wp-admin (the agent never sets passwords).
- Real cron for WP-Cron, backups schedule (UpdraftPlus), SMTP mailbox, cache by
  the host's server, indexing on at launch - each only when the owner says.
