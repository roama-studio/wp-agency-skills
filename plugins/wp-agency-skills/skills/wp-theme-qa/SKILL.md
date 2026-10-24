---
name: wp-theme-qa
description: 'Check a classic WordPress theme like a QA engineer: run `qa-kit wp` (the theme in a throwaway WordPress Playground with SCF + CF7 and its importer: PHP lint, theme must-haves, SCF text fields without a limit, every page at 360-1440, 404, internal links, the admin screens, debug.log, and a second pass with the client''s worst case - every filled field at its limit, +3 long menu items), read the report and the screenshots, then the manual checklist (forms, menus, slugs, images of any ratio, SEO step-back, Site Icon). Use when QA checks a WordPress theme or a change to one.'
---

# QA of a WordPress theme

The theme must work in WordPress AND survive what the client will do in
the admin: longer texts, more menu items, more or fewer cards, photos of
any size. The static site's checks (`qa-kit check`) do not run PHP - this
does.

## 1. Run the kit

```bash
./qa-kit wp . --theme wp-theme/<slug> --wp-cli "<slug> import" --round N
```

- It mounts a **copy** of the theme (the project's files are never
  touched), installs `secure-custom-fields` and `contact-form-7` from
  wordpress.org (`--plugins a,b` / `none` to change), runs the setup
  commands, then measures. The first start downloads WordPress and the
  plugins (2-5 min); a full run of ~8 pages takes ~5 min.
- `--pages a/,b/` adds pages the crawl does not find; `--php 8.2` /
  `--wp 6.8` matches the client's host; `--no-stress` skips the second
  pass; `--port` if 9400 is busy.
- It stops the server itself (`server_stopped: true` in the report). If a
  run is killed, free the port before the next run.
- Output: `test-results/qa-kit/wp/round-N/wp-report.json`, `shots/`
  (390 and 1440 of every page, plus any page/width with a finding) and
  `shots/stress/`, `server.log`, `wp-log/debug.log`.

## 2. What the findings mean

| check | level | meaning |
|---|---|---|
| `php_syntax` | fail | a theme file does not parse |
| `php_fatal` / `php_parse` / `php_warning` (theme file) | fail | from debug.log of the whole run (pages, admin, stress) |
| `php_deprecated` / `php_notice` (theme) | warn | breaks on the next PHP; fix while here |
| `php_*` level info | info | WordPress or a plugin, not the theme - only report if the theme causes it |
| `php_error_on_page` / `admin_php_error` | fail | the visitor or the client SEES a PHP error |
| `http_status` / `admin_http_status` / `broken_link` | fail | a page, an admin screen or an internal link answers 4xx/5xx |
| `not_found_status` | fail | a missing address does not answer 404 |
| `plugin_not_active` | fail | the blueprint could not activate a plugin |
| `horizontal_overflow` | fail | sideways scroll at that width |
| `text_outside` / `text_clipped` | warn | text runs off the screen or is cut by its box - look at the screenshot |
| `console` | warn | JS errors / failed requests on the page |
| `scf_text_no_limit` | warn | a short text field without a Character Limit: the client can paste a paragraph |
| `php_no_direct_access_guard`, `theme_no_*`, `theme_hardcoded_title` | warn/fail | theme must-haves (wp-classic-theme skill) |
| `php_eval` | fail | eval/exec/system in the theme |
| `stress_*` | as above | the same checks after the worst case; only NEW problems are reported |

A measurement is not yet a bug: open the screenshot, find the element,
say what a visitor (or the client in the admin) meets. Every bug you file
has the page, the width, the screenshot and the field or file to change.

## 3. Read the stress screenshots

The stress pass fills every filled SCF text/textarea to its Character
Limit (x3 when there is none) and adds 3 long items to every menu. Look at
`shots/stress/*-390.jpg` and `-1440.jpg` against the normal ones:

- headings and buttons wrap without breaking words in the middle, nothing
  is cut, cards in a row keep equal heights or align sensibly;
- the menu compresses, then moves to the burger - it never wraps into a
  second row over the logo and never makes the page scroll sideways;
- a long text in a fixed box (a slider card, a counter) - the box grows or
  the field needs a lower limit (say which).

A text that only breaks ABOVE its limit is not a bug - the limit protects
it. A text that breaks AT its limit is: either the layout or the limit
changes.

## 4. Manual checklist (the kit cannot)

- **Forms** (each CF7 form): empty submit shows the error state; a valid
  submit shows thanks and clears; the phone mask; the message lands in
  Mailpit (Local WP) and in Flamingo; the honeypot and consent line exist.
- **Content counts**: a repeater / CPT / term list with 1, 2 and many
  items (add/remove in the admin); an empty optional field hides its block
  cleanly (no empty tag, no "Array").
- **Images**: replace a photo with a square, a 2:3, a 9:16 and a 3:1 one
  in a hero, a card and a gallery slot; nothing stretches; the focal point
  holds; WordPress's `srcset` is printed.
- **Logic**: every link to a category / anchor / filter resolves; a NEW
  term appears everywhere it should (card, filter, form select); a
  Ukrainian slug (`%d0...`) still matches.
- **Admin**: field instructions say the limit; the options page saves;
  the importer is idempotent (run twice: no duplicates).
- **SEO step-back**: activate an SEO plugin -> only one `<title>` and one
  description in the source.
- **Site Icon**: without one the theme's favicon shows; with one set in
  Customize the core icon replaces it.
- Compare with the static site (`node dev/serve.js` or the project's
  server) at 390 and 1440: the WordPress pages look the same.

## 5. Limits of Playground

SQLite instead of MySQL, no `.htaccess`, no real mail, slower than a host.
It proves PHP and layout; the final check before a launch runs in Local WP
(MySQL + Apache, the host's PHP) with the same checklist. Say plainly in
the report what you could not check.
