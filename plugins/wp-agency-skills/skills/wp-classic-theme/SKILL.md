---
name: wp-classic-theme
description: 'Turn an approved static site into a classic WordPress theme the client edits safely: the same markup/CSS/JS, content from Secure Custom Fields (SCF, never ACF PRO) with Local JSON, a content model with hard limits, Contact Form 7, a content importer, menus, image sizes, Site Icon, SEO without plugin clashes, escaping and the direct-access guard, every later edit in the static site AND the theme. Use when building or changing a WordPress theme.'
---

# Classic WordPress theme from a static site

A migration, not a redesign: the static site the client approved is the
source of truth. Markup, classes, ids, `data-*`, CSS and JS move as they
are; only the source of content (SCF, WordPress) and form sending (CF7)
change. A reference build is the free ROAMA base theme (https://github.com/RobiKovach/roama-wp-theme): the
same structure, SCF Local JSON, CF7, leads, importer and client docs.

## 1. Before any PHP: audit and plan (write it down)

Write `WP-MIGRATION-PLAN.md` in the project:

- **Pages**: slug, template, where the content comes from.
- **What repeats** across pages (header, footer, modal, hero, CTA, contact
  tiles) -> one template part each, with `$args`.
- **One data source per thing**: the same services on Home and Services =
  ONE repeater; dishes on Home and Menu = ONE custom post type; event types
  in a slider, a filter and a form select = ONE taxonomy.
- **What must NOT be editable**: section order, heading ids used by CSS/GSAP,
  decor, logos, UI icons, aria-labels, service labels, the developer credit.
- **JS that depends on markup**: list every id/`data-*` the scripts read.
  Content hard-coded in JS (a slides array) moves to JSON printed by PHP.

## 2. Content model: decide every element

For each element: **fixed / editable / repeatable**, and **short / long**.

| Kind | Field | Rule |
|---|---|---|
| title, button, tag, nav label, price, counter | SCF text | **Character Limit always** (`maxlength`) + instruction with the limit; a hint alone is not enough |
| story, description, about | SCF textarea / wysiwyg | paragraphs allowed; the layout holds 3x text (no fixed heights) |
| cards, team, steps, categories | repeater / CPT / taxonomy | the layout works for 1, 2 and many items |
| photo | image (return ID) | any ratio: `object-fit: cover` + `aspect-ratio` on the box, focal point in the instruction |
| links | page link or text+URL pair | never a raw "Link" field the client can break |

Native WordPress strings that SCF cannot limit (menu labels, page titles,
term names): limit in PHP on save (`wp_insert_post_data`,
`pre_insert_term`) and write the advice into WP-SETUP. Record every
decision in `ACF-FIELDS.md` - generate it from `acf-json` with a script,
never by hand.

## 3. Theme layout

```
style.css (header only; Text Domain = slug)  functions.php (only requires inc/*)
header.php footer.php front-page.php page.php index.php 404.php
page-templates/*.php   template-parts/{global,sections,<page>,cards}/*.php
inc/ setup.php enqueue.php acf.php post-types.php helpers.php seo.php cf7.php importer.php
acf-json/   import/ (content.php + media/, first import only)   css/ js/ assets/ (same tree as static)
screenshot.png (1200x900)
```

- Every file in `inc/` starts with `defined( 'ABSPATH' ) || exit;`.
- Prefix every function, constant, option, CPT and taxonomy with the slug.
- Keep `css/ js/ assets/` in the same folder tree as the static site so
  relative `url()` keeps working.

## 4. The WordPress parts

- **Supports** (`after_setup_theme`): `title-tag` (never a hard-coded
  `<title>`), `post-thumbnails`, `html5`, `custom-logo` only if the logo
  is editable, `responsive-embeds`. `register_nav_menus` for each menu;
  `wp_nav_menu` with a fallback; the layout survives +3 items and long
  labels (they compress, then go to the burger).
- **Head/body**: `wp_head()`, `body_class()`, `wp_body_open()`,
  `wp_footer()` - plugins (CF7, SEO, Site Icon) need all four.
- **Enqueue** in the static order, `filemtime` versions, `defer` strategy;
  never `<script src>` in templates. Libraries (GSAP, Lenis) from the
  theme's own files, never a CDN.
- **Images**: `wp_get_attachment_image()` with a correct `sizes`;
  `add_image_size` only for real crops; the hero `fetchpriority="high"`,
  not lazy.
- **Favicon**: the theme ships its own (the logo, or a recognisable
  reduction) AND respects the core Site Icon: print the theme's only when
  `! has_site_icon()`.
- **SEO**: the theme may print title/description/OG from an SEO field
  group, but must step back when an SEO plugin is active
  (`defined('WPSEO_VERSION') || class_exists('RankMath') ||
  function_exists('the_seo_framework')`). Never two sources of meta.
- **Slugs**: Ukrainian slugs are percent-encoded in URLs. Anything that
  compares a slug from a URL with one in markup decodes both
  (`rawurldecode` in PHP, `decodeURIComponent` in JS). Prefer Latin slugs
  for pages and terms the importer creates.

## 5. SCF (Secure Custom Fields)

- Free on wordpress.org: repeater, flexible content, gallery, clone and
  options pages are included (former ACF PRO). **Never ACF PRO.**
- **Local JSON**: `acf/settings/save_json` and `acf/settings/load_json`
  point to the theme's `acf-json/`; groups travel with the theme in git.
  Do not edit the same group in the UI and in JSON at once.
- Options page via `acf_add_options_page()` inside `acf/init`, guarded by
  `function_exists` (works in SCF; checked by `qa-kit wp`). Show an admin
  notice when SCF is missing; the front end still renders with empty fields.
- **Escape late**: `get_field()` returns raw values. `esc_html`,
  `esc_attr`, `esc_url`, `wp_kses_post` (wysiwyg) at the echo. Helpers
  with defaults so an empty field never prints a broken tag.
- A group returns only its defined sub-fields: removing a field kills any
  "legacy fallback" that reads it.

## 6. Contact Form 7

- Forms are created by the importer; the theme picks them by ID from the
  options page. Turn off CF7's CSS/autop and adapt its markup to the
  static form's classes (`wpcf7_form_elements`).
- Keep the static form's UX: labels, the phone mask, the error and thank-you
  states, a honeypot field, a consent line with a link to the privacy policy.
- CF7 wraps each control in `span.wpcf7-form-control-wrap`: make the wrap
  AND the control inside it `display: block` - an inline-block `<textarea>`
  sits on the baseline and adds ~6px (found only by a pixel comparison
  with the static page).
- Every form definition sets Flamingo's `additional_settings`
  (`flamingo_subject`, `flamingo_name`, `flamingo_email`): without them
  Flamingo lists every lead as «[your-subject]» from «[your-email]» when
  the form has no such fields.
- **Leads to Telegram + the client's Google Sheet (reference: the ROAMA
  base theme https://github.com/RobiKovach/roama-wp-theme - `roama/inc/leads.php`,
  `inc/leads-core.php`, `js/leads-utm.js`, `setup/leads-apps-script.gs`,
  `setup/LEADS-SETUP.md`; copy them, rename the prefix):**
  - hook `wpcf7_mail_sent` AND `wpcf7_mail_failed` (mail may be unset at
    launch; spam reaches neither); data from
    `WPCF7_Submission::get_instance()->get_posted_data()` + `get_meta('url')`;
    drop `_*` fields and the honeypot, label the rest;
  - Telegram Bot API `sendMessage`, `parse_mode=HTML` (escape `& < >`,
    ≤ 4096 chars), one send per chat id; the sheet = an Apps Script web app
    on the CLIENT's sheet (JSON + a shared secret, dedupe by lead id, values
    stored as text so «+380…» is no formula) - no Google Cloud service
    account needed; POST with `redirection => 0` and GET the 302 `Location`
    yourself: WP follows the Apps Script 302 as a GET carrying the JSON as a
    query string -> 400 although the row WAS written (seen on a live site);
  - the form result = did the lead reach anyone: on `wpcf7_mail_failed` with a
    channel that took it, `set_status('mail_sent')` + the `mail_sent_ok` message;
    nothing reached -> CF7's error stays; with mail off
    (`skip_mail: on`, never `demo_mode` - it skips Flamingo too) CF7 always says
    «mail_sent»: switch it to `mail_failed` when no channel took the lead;
  - short timeouts (4 s / 8 s); a failure goes to a queue option retried
    hourly by WP-Cron (24 attempts); Flamingo keeps every lead anyway;
  - Settings → «Заявки»: token as a password field never printed back
    (empty keeps it), constants in wp-config.php may override; redact the
    token from stored errors (it is in the API URL); nonces +
    `manage_options`; a «test lead» button that sends only on click;
  - UTM tags + outside referrer + landing page: a few lines of JS into a
    90-day cookie, parsed strictly on the server;
  - test with `qa-kit wp ... --wp-cli "eval-file <test>.php"` and a
    `pre_http_request` filter answering for Telegram/Google (no real
    request), then the real test button on the live site;
  - the client's steps (BotFather, chat id via getUpdates, the sheet, deploy
    «Execute as me / Anyone») are in the reference LEADS-SETUP.md.
- Anti-spam: Cloudflare Turnstile from CF7 > Integration, not reCAPTCHA
  on top of it.

## 7. The importer (first content in one click)

The client must open a WordPress that already looks exactly like the
approved design. Write `inc/importer.php` + `import/content.php`:
media with alt texts, pages with templates, the static front page, every
SCF field, CPT items, terms, forms, menus, permalinks `/%postname%/`.
Idempotent: a second run skips what exists; "overwrite" only on demand.
Expose it in Appearance and as a WP-CLI command (`wp <slug> import`) -
`qa-kit wp` uses that command.

## 8. Security checklist (every PHP file)

- `defined( 'ABSPATH' ) || exit;` in `inc/`; no `eval`, `exec`, `system`.
- Escape every output; sanitize every save (`sanitize_text_field`,
  `absint`, `esc_url_raw`); nonce + `current_user_can` on any admin action
  (the importer button).
- No secrets in the theme (bot tokens, keys live in `wp-config.php` or
  options, never in git).

## 9. Edits after launch: static AND theme

While both copies live, every design fix lands in the static files AND in
the theme's `css/`/`js/`/templates - edited in place so the theme's
intentional differences survive. Rebuild the theme zip, check it by
content (`unzip -l`, not by name), log it in the project CHANGELOG.

## 10. Done means

- `./qa-kit wp . --theme wp-theme/<slug> --wp-cli "<slug> import"`: 0 fail
  (see the `wp-theme-qa` skill), the screenshots look like the static site.
- WP-SETUP.md (install steps, plugins, what the client may change and the
  limits), ACF-FIELDS.md (generated), CF7-FORMS.md, CHANGELOG.
- The theme zip has the folder `<slug>/` at its root.
