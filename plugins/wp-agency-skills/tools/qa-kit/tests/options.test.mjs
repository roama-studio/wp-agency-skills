import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkOptions, pageTarget, slug } from '../check.mjs'

test('pages are paths on the site, written with or without the leading slash', () => {
  const opt = checkOptions(['C:/cp/1-hotel', '--url', 'http://127.0.0.1:5173/', '--pages', 'rooms.html,/about/,./'])
  assert.deepEqual(opt.pages, ['/rooms.html', '/about/', '/'])
})

test('a page Git Bash turned into a Windows path is refused with the reason', () => {
  assert.throws(
    () => checkOptions(['C:/cp/1-hotel', '--url', 'http://127.0.0.1:5173/', '--pages', 'C:/Program Files/Git/rooms.html']),
    /without the leading slash/,
  )
})

test('round N compares with round N-1 when it exists, and writes into round-N', () => {
  const opt = checkOptions(['C:/cp/1-hotel', '--url', 'http://127.0.0.1:5173/', '--round', '2'])
  assert.equal(opt.round, 2)
  assert.match(opt.out.replace(/\\/g, '/'), /test-results\/qa-kit\/round-2$/)
  assert.equal(opt.baseline, null) // no round-1 folder there
})

test('screenshot names come from the page path', () => {
  assert.equal(slug('/'), 'home')
  assert.equal(slug('/rooms.html'), 'rooms-html')
  assert.equal(slug('/about/team/'), 'about-team')
})

// a tab of a one-page app is a page too: the path, then the button to click.
test('a page can name the tabs to click after it opens', () => {
  const opt = checkOptions(['C:/cp/1-hotel', '--url', 'http://127.0.0.1:5173/', '--pages', '>Агенти і баги,rooms.html>Book>Step 2'])
  assert.deepEqual(opt.pages, ['/>Агенти і баги', '/rooms.html>Book>Step 2'])
  assert.deepEqual(pageTarget('/rooms.html>Book>Step 2'), { path: '/rooms.html', clicks: ['Book', 'Step 2'] })
  assert.deepEqual(pageTarget('/about/'), { path: '/about/', clicks: [] })
})

test('a tab gets its own screenshot name, letters of any language kept', () => {
  assert.equal(slug('/>Агенти і баги'), 'home--Агенти-і-баги')
  assert.equal(slug('/rooms.html>Book'), 'rooms-html--Book')
})

test('--webkit asks to try WebKit again even when it was blocked before', () => {
  assert.equal(checkOptions(['C:/cp/1', '--url', 'http://127.0.0.1:5173/']).retryWebkit, false)
  assert.equal(checkOptions(['C:/cp/1', '--url', 'http://127.0.0.1:5173/', '--webkit']).retryWebkit, true)
})
