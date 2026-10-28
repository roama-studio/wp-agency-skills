# WordPress agency skills for Claude Code

**Потрібен сайт? → [ROAMA, веб-студія](https://robikovach.github.io/roama-studio/)** ·
**Need a website? → [ROAMA web studio](https://robikovach.github.io/roama-studio/)**

## Українською

Плагін для [Claude Code](https://code.claude.com) з тим, як веб-студія ROAMA робить WordPress-сайти:
5 навичок (skills) і інструмент перевірки `qa-kit`. Усе перевірено на справжніх сайтах.

| Навичка | Що вміє |
|---|---|
| `wp-classic-theme` | класична тема з погодженого статичного сайту: Secure Custom Fields (ніколи ACF PRO) з лімітами символів, Contact Form 7, заявки в Telegram і Google-таблицю, імпорт вмісту, SEO без конфліктів із плагінами, безпека |
| `wp-theme-qa` | перевірка теми як QA-інженер: `qa-kit wp` у WordPress Playground (PHP, кожна сторінка на 360–1440, адмінка, debug.log, найгірший випадок — усі поля на межі ліміту) + ручний список |
| `wp-local-install` | локальний WordPress у Local WP + WP-CLI і мінімальний набір плагінів: лише необхідне, по одному на потребу |
| `wp-edits` | правки наявного сайту (класична тема чи Elementor) на копії в Playground, порівняння «до/після» на 8 ширинах, перенесення правок на живий сайт плагіном із перевіркою конфліктів і відкатом |
| `wp-deploy` | перенесення з Local WP на звичайний хостинг через SSH + WP-CLI, без паролів у чаті |

**Встановлення** (у терміналі):

```bash
claude plugin marketplace add roama-studio/wp-agency-skills
claude plugin install wp-agency-skills@roama
```

Або в сесії Claude Code: `/plugin marketplace add roama-studio/wp-agency-skills`, потім
`/plugin install wp-agency-skills@roama`.

Потрібно: Node 18+, Git Bash на Windows (для команди `qa-kit`). Перший запуск `qa-kit` сам
встановить Playwright і Chromium (~150 МБ). WordPress Playground завантажується через `npx` при першій
перевірці теми.

Навички викликаються самі, коли задача підходить, або явно: `/wp-agency-skills:wp-theme-qa`.
Приклад готової теми, зробленої за цими навичками: [ROAMA base](https://github.com/roama-studio/roama-wp-theme).

Ліцензія MIT (див. `LICENSE`). Тексти адмінки плагінів-мостів і гайд власника сайту — українською.

## English

A [Claude Code](https://code.claude.com) plugin with how the ROAMA web studio builds WordPress sites:
5 skills and the `qa-kit` checking tool, all used on real sites.

| Skill | What it does |
|---|---|
| `wp-classic-theme` | a classic theme from an approved static site: Secure Custom Fields (never ACF PRO) with character limits, Contact Form 7, leads to Telegram and a Google Sheet, a content importer, SEO that steps back for SEO plugins, security |
| `wp-theme-qa` | QA of a theme: `qa-kit wp` in WordPress Playground (PHP, every page at 360–1440, the admin, debug.log, a worst-case pass with every field at its limit) plus a manual checklist |
| `wp-local-install` | a local WordPress in Local WP + WP-CLI and a minimal plugin set: only what is necessary, one plugin per need |
| `wp-edits` | edits to an existing site (classic theme or Elementor) on a Playground copy, a before/after comparison at 8 widths, applying the edits to the live site with a plugin that checks conflicts and rolls back |
| `wp-deploy` | moving a site from Local WP to shared hosting over SSH + WP-CLI, with no passwords in the chat |

**Install** (in a terminal):

```bash
claude plugin marketplace add roama-studio/wp-agency-skills
claude plugin install wp-agency-skills@roama
```

Or in a Claude Code session: `/plugin marketplace add roama-studio/wp-agency-skills`, then
`/plugin install wp-agency-skills@roama`.

Requires Node 18+ and, on Windows, Git Bash (for the `qa-kit` command). The first `qa-kit` run
installs Playwright and Chromium itself (~150 MB). WordPress Playground is fetched by `npx` on the
first theme check.

Skills load on their own when a task fits, or explicitly: `/wp-agency-skills:wp-theme-qa`.
A theme built with these skills: [ROAMA base](https://github.com/roama-studio/roama-wp-theme).

MIT license (see `LICENSE`). The admin texts of the bridge plugins and the site owner's guide are in
Ukrainian.
