// Pure judgements of measured values against rules.json: no browser, no files.
// A finding: { check, level: fail|warn|info, page, width, browser, message, screenshot }.

export function grade(value, { warn, fail }) {
  if (value >= fail) return 'fail'
  if (value >= warn) return 'warn'
  return 'ok'
}

function finding(check, level, where, message, extra = {}) {
  return {
    check, level, page: where.page ?? null, width: where.width ?? null,
    browser: where.browser ?? 'chromium', message, screenshot: where.screenshot ?? null, ...extra,
  }
}

export function overflowFinding({ page, width, scrollWidth, browser, screenshot }) {
  if (scrollWidth <= width) return null
  return finding('horizontal_overflow', 'fail', { page, width, browser, screenshot },
    `the page is ${scrollWidth} px wide in a ${width} px viewport (horizontal scroll)`)
}

export function axeFindings(violations, where, rules) {
  const out = []
  for (const v of violations) {
    const level = rules.axe.fail_impacts.includes(v.impact) ? 'fail'
      : rules.axe.warn_impacts.includes(v.impact) ? 'warn' : null
    if (!level) continue
    const targets = v.nodes.slice(0, 5).map((n) => n.target.join(' ')).join(', ')
    out.push(finding(`axe:${v.id}`, level, where,
      `${v.help} (${v.impact}): ${v.nodes.length} element(s), e.g. ${targets}`))
  }
  return out
}

const PERF = [
  ['lcp_ms', 'Largest Contentful Paint', 'ms'],
  ['cls', 'Cumulative Layout Shift', ''],
  ['long_tasks_ms', 'main thread blocked by long tasks (lab stand-in for INP)', 'ms'],
  ['page_kb', 'page weight', 'KB'],
  ['js_kb', 'JavaScript weight', 'KB'],
]

export function perfFindings(metrics, where, perf) {
  const out = []
  for (const [key, name, unit] of PERF) {
    const value = metrics[key]
    if (value === null || value === undefined) {
      out.push(finding(`performance:${key}`, 'info', where, `${name} was not measured`))
      continue
    }
    const level = grade(value, perf[key])
    if (level !== 'ok') {
      out.push(finding(`performance:${key}`, level, where,
        `${name} ${value}${unit} (warn at ${perf[key].warn}${unit}, fail at ${perf[key].fail}${unit})`))
    }
  }
  return out
}

export function imageFindings(images, where, perf) {
  const out = []
  for (const img of images) {
    const level = grade(img.kb, perf.image_kb)
    if (level !== 'ok') {
      out.push(finding('image_weight', level, where, `${img.src} weighs ${img.kb} KB`))
    } else if (img.shown_width > 0 && img.natural_width / img.shown_width > perf.image_oversize_ratio) {
      out.push(finding('image_oversize', 'warn', where,
        `${img.src} is ${img.natural_width} px wide but shown at ${img.shown_width} px`))
    }
  }
  return out
}

export function regressionFinding({ page, width, ratio, diff, size_changed }, tol) {
  if (size_changed) {
    return finding('regression', 'warn', { page, width, screenshot: diff },
      'the page height changed since the last round (sections added, removed or resized)')
  }
  if (ratio <= tol.changed_ratio) return null
  return finding('regression', 'warn', { page, width, screenshot: diff },
    `${(ratio * 100).toFixed(1)}% of the page changed since the last round (red in the diff picture)`)
}

const NOT_PAGES = /\.(pdf|jpe?g|png|webp|avif|gif|svg|mp4|webm|zip|docx?|xlsx?|json|xml|txt|ico)$/i

export function pagesFrom(start, hrefs) {
  const origin = new URL(start).origin
  const seen = new Set()
  const out = []
  for (const href of hrefs) {
    let url
    try { url = new URL(href, start) } catch { continue }
    if (url.origin !== origin || NOT_PAGES.test(url.pathname)) continue
    const path = url.pathname + url.search
    if (path === new URL(start).pathname || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

// One finding per problem: the same check, page, browser and message at several widths.
export function merge(findings) {
  const out = new Map()
  for (const f of findings) {
    const key = [f.check, f.page, f.browser, f.message].join('\u0000')
    const seen = out.get(key)
    if (!seen) { out.set(key, { ...f, widths: f.width === null || f.width === undefined ? [] : [f.width] }); continue }
    if (f.width !== null && f.width !== undefined && !seen.widths.includes(f.width)) seen.widths.push(f.width)
    seen.screenshot ??= f.screenshot
  }
  return [...out.values()]
}

export function summarize(findings) {
  const count = (level) => findings.filter((f) => f.level === level).length
  return {
    fail: count('fail'), warn: count('warn'), info: count('info'),
    failed_checks: [...new Set(findings.filter((f) => f.level === 'fail').map((f) => f.check))],
  }
}
