// qa-kit opens a tab of a one-page app by clicking its button.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { openPage } from '../check.mjs'

const HTML = `<!doctype html><meta charset="utf-8"><title>tabs</title>
<nav><button onclick="show('a')">Огляд</button><button aria-label="Агенти, 2 нові" onclick="show('b')">Агенти</button>
<button onclick="show('c')">Баги<span class="badge">9<span class="sr">, 9 чекають на вас</span></span></button><button onclick="show('d')">Баги і звіти</button></nav>
<main id="out">first tab</main>
<script>setTimeout(() => { const b = document.createElement('button'); b.textContent = 'Пізня'; b.onclick = () => show('e'); document.querySelector('nav').append(b) }, 1500)
function show(t) { setTimeout(() => { document.getElementById('out').textContent = 'tab ' + t }, 300) }</script>`

test('a tab opens by its exact text or aria-label; a missing one is named', async () => {
  const server = createServer((_, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(HTML) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/`
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    let opened = await openPage(page, url, '/>Пізня') // an app that draws its menu after the load
    assert.deepEqual(opened.missing, [])
    assert.equal(await page.textContent('#out'), 'tab e')
    opened = await openPage(page, url, '/>Агенти, 2 нові')
    assert.equal(opened.status, 200)
    assert.deepEqual(opened.missing, [])
    assert.equal(await page.textContent('#out'), 'tab b')
    opened = await openPage(page, url, '/>Огляд')
    assert.equal(await page.textContent('#out'), 'tab a')
    opened = await openPage(page, url, '/>Баги') // a tab with a count badge: «Баги9, 9 чекають на вас»
    assert.deepEqual(opened.missing, [])
    assert.equal(await page.textContent('#out'), 'tab c')
    opened = await openPage(page, url, '/>Звіт')
    assert.deepEqual(opened.missing, ['Звіт'])
  } finally {
    await browser.close()
    server.close()
  }
})
