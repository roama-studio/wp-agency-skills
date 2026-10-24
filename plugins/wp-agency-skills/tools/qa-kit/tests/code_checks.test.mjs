import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  auditFindings, consoleLogs, externalLinkProblems, formProblems, secretFindings, trackedEnvFiles,
  unreferencedFiles, unusedDependencies,
} from '../lib/code_checks.mjs'

test('secrets: API keys and private keys are found, placeholders are not', () => {
  const found = secretFindings([
    { path: 'src/main.js', text: 'const key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"' },
    { path: 'src/maps.js', text: 'apiKey: "AIzaSyA1234567890abcdefghijklmnopqrstuv"' },
    { path: 'deploy/key.pem', text: '-----BEGIN RSA PRIVATE KEY-----\nabc' },
    { path: 'README.md', text: 'Set API_KEY=your-key-here in .env' },
  ])
  assert.deepEqual(found.map((f) => f.file), ['src/main.js', 'src/maps.js', 'deploy/key.pem'])
  assert.ok(found.every((f) => f.level === 'fail' && f.check === 'secret'))
  assert.ok(!found[0].message.includes('AbCdEfGhIjKlMnOp'), 'the secret itself is never repeated')
})

test('tracked .env files fail, .env.example is fine', () => {
  const found = trackedEnvFiles(['.env', 'src/.env.local', '.env.example', 'src/env.js'])
  assert.deepEqual(found.map((f) => f.file), ['.env', 'src/.env.local'])
})

test('unused dependencies: a dependency no source imports is named', () => {
  const pkg = { dependencies: { gsap: '^3', lenis: '^1', lodash: '^4' }, devDependencies: { vite: '^7', playwright: '1' } }
  const sources = [
    { path: 'src/main.js', text: "import gsap from 'gsap'\nimport { ScrollTrigger } from 'gsap/ScrollTrigger'" },
    { path: 'src/scroll.js', text: "import Lenis from 'lenis'\nimport 'lenis/dist/lenis.css'" },
  ]
  const found = unusedDependencies(pkg, [...sources,
    { path: 'package.json', text: JSON.stringify(pkg) }, { path: 'package-lock.json', text: '"lodash"' }])
  assert.deepEqual(found.map((f) => f.message.split(' ')[0]), ['lodash'])
  assert.equal(found[0].level, 'warn')
})

test('unreferenced files: a source file nothing points to is dead code', () => {
  const files = ['index.html', 'src/main.js', 'src/old-slider.js', 'src/style.css', 'public/img/hero.webp',
    'public/img/unused.png', 'vite.config.js', 'package.json']
  const texts = [
    { path: 'index.html', text: '<script type="module" src="/src/main.js"></script><img src="/img/hero.webp">' },
    { path: 'src/main.js', text: "import './style.css'" },
    { path: 'src/old-slider.js', text: 'export const x = 1' },
    { path: 'src/style.css', text: 'body{}' },
  ]
  const found = unreferencedFiles(files, texts)
  assert.deepEqual(found.map((f) => f.file), ['src/old-slider.js', 'public/img/unused.png'])
})

test('console.log left in shipped code warns; console.error does not', () => {
  const found = consoleLogs([
    { path: 'src/a.js', text: 'console.log("debug")\nconsole.error("x")' },
    { path: 'tests/a.spec.js', text: 'console.log(1)' },
  ])
  assert.deepEqual(found.map((f) => [f.file, f.line]), [['src/a.js', 1]])
})

test('external links opening a new tab need rel noopener', () => {
  const found = externalLinkProblems([{ path: 'index.html', text:
    '<a href="https://ig.com/x" target="_blank">ig</a>\n'
    + '<a href="https://fb.com/x" target="_blank" rel="noopener noreferrer">fb</a>\n'
    + '<a href="/rooms.html" target="_blank">rooms</a>' }])
  assert.equal(found.length, 1)
  assert.match(found[0].message, /ig\.com/)
})

test('forms: no required fields and no honeypot are named', () => {
  const found = formProblems([{ path: 'contacts.html', text:
    '<form action="/send"><input name="name"><input name="phone"><button>Send</button></form>' }])
  assert.deepEqual(found.map((f) => f.check).sort(), ['form_honeypot', 'form_validation'])
  const fine = formProblems([{ path: 'c.html', text:
    '<form><input name="name" required><input name="website" class="hp" tabindex="-1" autocomplete="off"></form>' }])
  assert.deepEqual(fine, [])
})

test('npm audit: high and critical fail, moderate warns, a failed audit is info', () => {
  const found = auditFindings({ metadata: { vulnerabilities: { critical: 0, high: 2, moderate: 1, low: 3 } } })
  assert.deepEqual(found.map((f) => f.level), ['fail', 'warn'])
  assert.equal(auditFindings(null)[0].level, 'info')
  assert.deepEqual(auditFindings({ metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 1 } } }), [])
})
