// a machine where WebKit cannot start (Windows Smart App Control) is
// remembered, so the blocked-file pop-up does not come back on every QA run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blockedWebkit, forgetWebkit, rememberWebkit } from '../lib/webkit.mjs'

test('nothing remembered: WebKit is tried', () => {
  assert.equal(blockedWebkit(join(mkdtempSync(join(tmpdir(), 'wk-')), 'memo.json')), null)
})

test('a blocked WebKit is remembered with its reason and the day, and can be forgotten', () => {
  const memo = join(mkdtempSync(join(tmpdir(), 'wk-')), 'memo.json')
  rememberWebkit(memo, 'WebKit cannot start on this machine')
  const known = blockedWebkit(memo)
  assert.equal(known.reason, 'WebKit cannot start on this machine')
  assert.match(known.since, /^\d{4}-\d{2}-\d{2}/)
  forgetWebkit(memo)
  assert.equal(blockedWebkit(memo), null)
})
