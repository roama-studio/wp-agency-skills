// The legal minimum of a client site, judged from measured facts.
// EU/EEA clients: fail; others (Ukraine) or an unknown country: warn. A technical
// minimum for the QA agent, not legal advice.

const isEu = (country, legal) => legal.eu_countries.includes(country)
const level = (country, legal) => (isEu(country, legal) ? 'fail' : 'warn')
const forWhom = (country) => (country ? `the client is in ${country}` : 'the client country unknown')

// Requests the page made before the visitor consented to anything.
export function consentFindings({ page, origin, requests }, country, legal) {
  const own = new URL(origin).host
  const hosts = new Set()
  for (const url of requests) {
    if (!/^https?:/i.test(url)) continue
    const host = new URL(url).host
    if (host !== own) hosts.add(host)
  }
  const fonts = [...hosts].filter((h) => legal.google_fonts_hosts.includes(h))
  const other = [...hosts].filter((h) => !legal.google_fonts_hosts.includes(h))
  const where = { page, width: 1440, browser: 'chromium', screenshot: null, level: level(country, legal) }
  const found = []
  if (fonts.length) {
    found.push({ check: 'google_fonts', ...where,
      message: `Google Fonts load before consent (${fonts.join(', ')}); self-host the fonts (${forWhom(country)})` })
  }
  if (other.length) {
    found.push({ check: 'third_party_before_consent', ...where,
      message: `requests to other servers before consent: ${other.join(', ')} (${forWhom(country)})` })
  }
  return found
}

export function linkKind({ text, href }, legal) {
  const both = `${text ?? ''} ${href ?? ''}`
  if (new RegExp(legal.impressum_link, 'i').test(both)) return 'impressum'
  if (new RegExp(legal.privacy_link, 'i').test(both)) return 'privacy'
  return null
}

// Facts of one page: its links, pre-ticked checkboxes in forms, placeholders left.
// The links to the privacy policy and the Impressum are asked of the start page only.
export function legalFindings({ page, links, prechecked, placeholders }, country, legal, { start }) {
  const where = { page, width: 1440, browser: 'chromium', screenshot: null }
  const kinds = new Set(links.map((l) => linkKind(l, legal)))
  const found = []
  if (start && !kinds.has('privacy')) {
    found.push({ check: 'privacy_policy_link', ...where, level: level(country, legal),
      message: `no link to a privacy policy on the start page (${forWhom(country)})` })
  }
  if (start && legal.impressum_countries.includes(country) && !kinds.has('impressum')) {
    found.push({ check: 'impressum_link', ...where, level: 'fail',
      message: `no link to an Impressum on the start page (${forWhom(country)})` })
  }
  if (prechecked.length) {
    found.push({ check: 'prechecked_consent', ...where, level: level(country, legal),
      message: `a form checkbox is ticked before the visitor ticks it: ${prechecked.join(', ')}` })
  }
  if (placeholders) {
    found.push({ check: 'legal_placeholder', ...where, level: 'info',
      message: `${placeholders} "${legal.placeholder} ...]" placeholder(s) still on the page: the client's texts are missing` })
  }
  return found
}
