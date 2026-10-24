// what `qa-kit wp` measures on a page after the client's long texts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { TEXT_FACTS } from '../wp.mjs'

const HTML = `<!doctype html><meta charset="utf-8"><style>body{margin:0;overflow-x:hidden}</style>
<h2 id="long" style="white-space:nowrap">Дуже довгий заголовок, який клієнт вставив замість короткого і який не вміщується</h2>
<section class="hero" style="overflow:hidden;width:360px"><h1 id="hero" style="white-space:nowrap">Заголовок героя обрізаний секцією без жодного скролу</h1></section>
<a class="btn" style="display:inline-block;width:120px;height:20px;overflow:hidden">Кнопка з дуже довгим текстом від клієнта</a>
<div class="track" style="overflow-x:auto;white-space:nowrap;width:300px"><span>Картка за краєм каруселі — це нормально, вона прокручується</span></div>
<div class="slider" style="overflow:hidden;width:360px;white-space:nowrap"><div style="display:flex;width:1080px">
<p style="width:300px;flex:none;margin:0">Слайд 1</p><p class="peek" style="width:300px;flex:none;margin:0">Слайд 2 визирає з-за краю</p><p class="next" style="width:300px;flex:none;margin:0">Слайд 3 повністю за краєм</p></div></div>
<nav style="position:fixed;left:100%;top:0"><a>Меню поза екраном</a></nav>
<button style="position:absolute;right:0;top:40px">☰<span class="sr" style="position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap">Меню навігації сайту для телефонів</span></button>
<p>Короткий текст</p>`

test('text outside the screen or cut at the edge of its box is found; scrollers, peeking or off-slide cards, off-canvas menus and visually hidden labels are not', async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 800 } })
    await page.setContent(HTML)
    const f = await page.evaluate(TEXT_FACTS)
    assert.deepEqual(f.outside.map((x) => x.split(' ')[0]), ['h2#long', 'h1#hero'])
    assert.deepEqual(f.clipped.map((x) => x.split(' ')[0]), ['a.btn'])
  } finally {
    await browser.close()
  }
})
