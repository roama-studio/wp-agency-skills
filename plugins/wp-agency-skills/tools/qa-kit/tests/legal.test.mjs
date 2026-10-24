import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { consentFindings, legalFindings, linkKind } from '../lib/legal.mjs'
import { checkOptions } from '../check.mjs'

const legal = JSON.parse(readFileSync(new URL('../rules.json', import.meta.url))).legal
const ORIGIN = 'http://127.0.0.1:5173'

test('the country comes as a two-letter code', () => {
  assert.equal(checkOptions(['C:/cp/1', '--url', `${ORIGIN}/`, '--country', 'de']).country, 'DE')
  assert.equal(checkOptions(['C:/cp/1', '--url', `${ORIGIN}/`]).country, null)
  assert.throws(() => checkOptions(['C:/cp/1', '--url', `${ORIGIN}/`, '--country', 'Germany']), /two-letter/)
})

test('requests to other servers before consent fail for the EU and warn for Ukraine', () => {
  const requests = [
    `${ORIGIN}/`, `${ORIGIN}/fonts/inter.woff2`, 'data:image/png;base64,AA',
    'https://fonts.googleapis.com/css2?family=Inter', 'https://fonts.gstatic.com/s/inter/v1.woff2',
    'https://www.googletagmanager.com/gtag/js?id=G-1', 'https://www.googletagmanager.com/gtag/js?id=G-1',
  ]
  const eu = consentFindings({ page: '/', origin: ORIGIN, requests }, 'DE', legal)
  assert.deepEqual(eu.map((f) => [f.check, f.level]), [['google_fonts', 'fail'], ['third_party_before_consent', 'fail']])
  assert.match(eu[0].message, /fonts\.googleapis\.com, fonts\.gstatic\.com/)
  assert.match(eu[1].message, /www\.googletagmanager\.com/)
  assert.equal(eu[0].page, '/')

  const ua = consentFindings({ page: '/', origin: ORIGIN, requests }, 'UA', legal)
  assert.deepEqual(ua.map((f) => f.level), ['warn', 'warn'])
  const unknown = consentFindings({ page: '/', origin: ORIGIN, requests }, null, legal)
  assert.match(unknown[0].message, /country unknown/)
})

test('a site that only talks to itself has no consent finding', () => {
  assert.deepEqual(consentFindings({ page: '/', origin: ORIGIN, requests: [`${ORIGIN}/a.js`, 'blob:x'] }, 'DE', legal), [])
})

test('legal links are found by their text or address', () => {
  assert.equal(linkKind({ text: 'Політика конфіденційності', href: '/privacy.html' }, legal), 'privacy')
  assert.equal(linkKind({ text: 'Datenschutz', href: '/ds' }, legal), 'privacy')
  assert.equal(linkKind({ text: 'Impressum', href: '/impressum' }, legal), 'impressum')
  assert.equal(linkKind({ text: 'Rooms', href: '/rooms.html' }, legal), null)
})

test('the start page needs the privacy link; Germany and Austria an Impressum too', () => {
  const none = { page: '/', links: [], prechecked: [], placeholders: 0 }
  const de = legalFindings(none, 'DE', legal, { start: true })
  assert.deepEqual(de.map((f) => [f.check, f.level]), [['privacy_policy_link', 'fail'], ['impressum_link', 'fail']])
  assert.deepEqual(legalFindings(none, 'PL', legal, { start: true }).map((f) => f.check), ['privacy_policy_link'])
  assert.deepEqual(legalFindings(none, 'UA', legal, { start: true }).map((f) => [f.check, f.level]),
    [['privacy_policy_link', 'warn']])
  // Other pages are not asked for the links again.
  assert.deepEqual(legalFindings(none, 'DE', legal, { start: false }), [])

  const both = { ...none, links: [{ text: 'Datenschutz', href: '/ds' }, { text: 'Impressum', href: '/impressum' }] }
  assert.deepEqual(legalFindings(both, 'DE', legal, { start: true }), [])
})

test('a pre-ticked consent box and the placeholders are reported', () => {
  const facts = { page: '/contact.html', links: [], prechecked: ['newsletter'], placeholders: 2 }
  const found = legalFindings(facts, 'AT', legal, { start: false })
  assert.deepEqual(found.map((f) => [f.check, f.level]), [['prechecked_consent', 'fail'], ['legal_placeholder', 'info']])
  assert.match(found[0].message, /newsletter/)
  assert.match(found[1].message, /2 /)
  assert.equal(legalFindings(facts, 'UA', legal, { start: false })[0].level, 'warn')
})
