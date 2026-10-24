---
name: wp-local-install
description: 'Install a client WordPress site locally with Local WP and WP-CLI step by step, and the agency base plugin standard - only what is necessary, one plugin per need (SCF, CF7 + Flamingo, FluentSMTP, UpdraftPlus, Limit Login Attempts Reloaded, Cyr-To-Lat, a cache matched to the host server, SEO only if the theme has none), with why, settings and what never to install. Use when setting up a WordPress site or choosing its plugins.'
---

# Local WordPress install and the base plugins

Written from research (2026-10-15) and checked on a real install
(2026-10-16: Local 10.1, PHP 8.3.29, nginx, MySQL 8.4, WordPress 7.1.3). Mark anything you find different in the project
CHANGELOG and propose the change to this skill.

## 0. Before installing: ask the host

Find the client's hosting first - it decides PHP and the cache plugin:
PHP version (**Contact Form 7 6.2 needs PHP 8.3**), web server (the
`Server:` header or the plan page: LiteSpeed / Apache / nginx), server
cache, backups, malware scan (Imunify360), SMTP mailbox. Locally use the
same PHP version and Apache (or nginx if the host is nginx).

## 1. Local WP (Windows)

1. Install Local (localwp.com). Allow `local.exe` in Defender Firewall /
   the antivirus; accept both UAC prompts (hosts file, SSL).
2. **Create a site** -> Custom: the host's PHP, web server, MySQL. Site
   files: `C:\Users\<user>\Local Sites\<site>\app\public`. Slow sites:
   use the `.test` suffix instead of `.local`.
3. Admin user: a strong password kept outside git (a password manager);
   never `admin/admin`.
4. **WP-CLI**: Local's "Open site shell", or the Local CLI (Local 10.2+,
   Preferences > Advanced): `localwp list --json`,
   `localwp cli <site> "<wp command>"`. From an agent's shell (no site
   shell, Local 10.1): a wrapper script, see 1a.
5. **Mail**: Local catches all mail in Mailpit (Tools > Mailpit): check
   every form there before any SMTP is set.

### 1a. WP-CLI from an agent's shell (Windows, checked on a real site)

Local keeps everything an agent needs; the site must be **started** in Local.

- The site id, domain, PHP version and ports: `%APPDATA%\Local\sites.json`
  (`services.mysql.ports.MYSQL`, `services.mailpit.ports.WEB/SMTP`).
- Run `php.exe` of `%APPDATA%\Local\lightning-services\php-<ver>\bin\win64`
  with `-c %APPDATA%\Local\run\<id>\conf\php\php.ini` (it holds
  `mysqli.default_port` = the site's MySQL port, so `DB_HOST localhost`
  works) and Local's `resources\extraResources\bin\wp-cli\wp-cli.phar
  --path="<site>\app\public"`.
- Environment: `MYSQL_HOME=%APPDATA%\Local\run\<id>\conf\mysql` (its
  `[client]` section: `wp db export` needs it), `WP_CLI_CONFIG_PATH` =
  Local's `wp-cli\config.yaml`, `TEMP`/`TMP` = the user's temp (else "Temp
  directory isn't writable: C:\Windows\TEMP"), and on PATH: the PHP folder,
  its `ImageMagick` subfolder (else "Unable to load php_imagick.dll") and
  `lightning-services\mysql-<ver>\bin\win64\bin` (mysql, mysqldump). In Git
  Bash write PATH entries as `/c/Users/...` - a `C:/...` entry breaks PATH
  at the colon.
- Log every call (`echo "$ wp $*" >> commands.log`, then `| tee -a`).
- Local's defaults to fix: the site title = the Local site name (a theme
  importer that keeps a custom title will not replace it: set `blogname`);
  `admin_email` = `dev-email@wpengine.local` (fine locally, Mailpit gets it);
  Hello Dolly / Akismet are not installed (nothing to delete); "Hello world",
  "Sample Page" and the comment are.
- `MSYS_NO_PATHCONV=1` in Git Bash: without it `wp rewrite structure
  '/%postname%/'` stored `/C:/Program Files/Git/%postname%/` (MSYS turned the
  argument into a path; pages still worked, so only `wp option get
  permalink_structure` showed it - check it after setting).
- `PHPRC=%APPDATA%\Local\run\<id>\conf\php` and `WP_CLI_PHP` = Local's
  php.exe: WP-CLI starts a child `wp` itself (the flush inside `wp rewrite
  structure`), and without them that child has no php.ini -> "Your PHP
  installation appears to be missing the MySQL extension".
6. Database: Adminer on the Database tab (HeidiSQL by host/port if it
   hangs).
7. **Stop the site before closing Local.** Closing Local with a running site
   can leave its `mysqld.exe` alive; the next "Start site" then fails with
   "Can't connect to MySQL server on '::1:<new port>' (10061)" (the orphan
   holds the data dir on the OLD port). Find it: `mysqld.exe` whose command
   line has `run\<site id>\conf\mysql\my.cnf` and a dead parent; stop it
   cleanly with `mysqladmin --host=127.0.0.1 --port=<old port> -uroot -proot
   shutdown` (never kill it: InnoDB), then Stop + Start the site in Local
   (seen on a real site, 2026-10-18).

## 2. WP-CLI install script (log every command, stop at the first error)

```bash
wp db export before-install.sql                     # first, always
wp core language install uk --activate
wp option update timezone_string "Europe/Kyiv"
wp rewrite structure '/%postname%/' && wp rewrite flush
wp plugin install cyr2lat --activate                 # BEFORE any content: Latin slugs (/posluhy/, /pro-nas/)
cp -r <copy>/wp-theme/<slug> "<site>/app/public/wp-content/themes/<slug>" && diff -rq ...   # from the WORKING copy
wp plugin install secure-custom-fields contact-form-7 flamingo --activate
wp theme activate <slug>
wp <slug> import                                     # the theme's importer (wp-classic-theme skill)
wp plugin install fluent-smtp updraftplus limit-login-attempts-reloaded --activate
wp post delete 1 2 --force                           # Hello world + Sample Page (the comment goes with post 1)
wp post delete <id of «Contact form 1»> --force       # CF7's stock form, the theme uses its own
wp option update blogname "<client's site name>"     # Local named it after the Local site
wp eval-file fluentsmtp-mailpit.php                  # FluentSMTP -> Mailpit, see below
wp config set WP_DEBUG true --raw && wp config set WP_DEBUG_LOG true --raw && wp config set WP_DEBUG_DISPLAY false --raw
```

Locally FluentSMTP sends to Mailpit, so the forms take the same path as on
the host: an SMTP connection `127.0.0.1:<mailpit SMTP port>`, no auth, no
encryption, From = `wordpress@<site>.local`. Save it through the plugin's
own `\FluentMail\App\Models\Settings::store()` from `wp eval-file`, then `wp_mail()` a
test and read `http://127.0.0.1:<mailpit WEB port>/api/v1/messages`. On the
host the same screen gets the real mailbox.

Versions checked (2026-10-16): SCF 6.9.6, CF7 6.2.2, Flamingo 2.6.4,
FluentSMTP 2.4.1, UpdraftPlus 1.26.11, Limit Login Attempts Reloaded 3.3.10,
Cyr-To-Lat 7.1.0.

Pin versions in the project's `WP-SETUP.md` (`--version=x.y.z`) once a
site goes live, so a rebuild is the same site. Before anything that
changes data: `wp db export before-<step>.sql`.

## 3. The base plugin standard (only what is necessary)

One plugin per real need. Anything outside this list needs a written
reason in WP-SETUP.md.

| Need | Plugin | Why this one | Key settings |
|---|---|---|---|
| Fields | **Secure Custom Fields** | wordpress.org fork of ACF incl. repeater, gallery, options pages; free; our themes use Local JSON | nothing - groups load from the theme's `acf-json/` |
| Forms | **Contact Form 7** | light, hookable (`wpcf7_mail_sent` for Telegram/Sheets), forms made by our importer | Integration: Cloudflare Turnstile (free) |
| Form messages | **Flamingo** | official CF7 companion: every lead stored even if mail fails, spam queue visible | nothing; CFDB7 only if the client needs one-click CSV |
| Mail | **FluentSMTP** | fully free incl. the email log and a fallback connection | the domain mailbox or a transactional provider; From = a domain address (SPF/DKIM) |
| Backups | **UpdraftPlus** (free) | schedules + remote storage (the client's Google Drive) | files weekly (keep 4), DB daily (keep 14), one remote; check the host's own backups too |
| Login protection | **Limit Login Attempts Reloaded** | light; the host's WAF/Imunify does scanning | default lockouts, XML-RPC protection on |
| Ukrainian slugs | **Cyr-To-Lat** | readable Latin URLs instead of `%d0%..`; install BEFORE creating content | default; `wp cyr2lat regenerate` for existing slugs |
| Cache | **by the host's server** | LiteSpeed host -> **LiteSpeed Cache**; Apache/nginx -> **WP Super Cache** (Simple mode); managed host cache -> **none** | never minify/combine GSAP, Lenis or the theme's JS again; test the site after enabling |
| SEO | **only if the theme has none** | our themes print title/description/OG (seo.php) and step back for a plugin; if one is needed: The SEO Framework (lightest) | never two sources of meta |

Optional, only with a reason: Complianz (only when analytics/marketing
pixels load for EU visitors), Redirection (only when replacing an old site
with indexed URLs), Converter for Media (WebP, only when the theme does
not ship WebP and LiteSpeed does not optimise images).

**Never install**: ACF / ACF PRO next to SCF; a second form, SMTP, backup,
cache or SEO plugin; Wordfence AND Solid Security together (or either on
a weak shared host - LLAR is enough); W3 Total Cache (complex, breaks
layouts); page builders (Elementor) on our own themes; "nulled" premium
plugins, ever.

## 4. After install

- Settings > General: site language Українська, the client's e-mail.
- Settings > Reading: the static front page (the importer sets it).
- Appearance > Customize > Site Identity: Site Icon if the client wants
  a different favicon than the theme's.
- Remove default content: Hello world, Sample Page, the sample comment.
- Run `./qa-kit wp` on the theme (wp-theme-qa skill) and the manual
  checks of WP-SETUP.md (forms land in Mailpit and in Flamingo).

## 5. Later (not in this skill yet)

Deploy to the host: the `wp-deploy` skill.
