import { test } from 'node:test'
import assert from 'node:assert/strict'
import { npxCommand, PLAYGROUND } from '../lib/wp.mjs'

const args = ['-y', PLAYGROUND, 'server', '--port=9400', '--mount-dir', 'C:/cp/my theme', '/wordpress/wp-content/themes/x']

test('npx on Windows runs through node and npm\'s own npx-cli.js, never a shell or a .cmd shim', () => {
  const exists = (p) => p.replace(/\\/g, '/') === 'C:/Program Files/nodejs/node_modules/npm/bin/npx-cli.js'
  const cmd = npxCommand(args, { platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe', exists, env: {} })
  assert.equal(cmd.file, 'C:\\Program Files\\nodejs\\node.exe')
  assert.equal(cmd.args[0].replace(/\\/g, '/'), 'C:/Program Files/nodejs/node_modules/npm/bin/npx-cli.js')
  assert.deepEqual(cmd.args.slice(1), args)
  assert.equal(cmd.shell, false)
})

test('npx on Windows without npm next to node: the npm prefix from the environment, else a clear error', () => {
  const exists = (p) => p.replace(/\\/g, '/') === 'D:/npm/node_modules/npm/bin/npx-cli.js'
  const cmd = npxCommand(args, { platform: 'win32', execPath: 'C:\\nodejs\\node.exe', exists, env: { NPM_CLI_JS: 'D:\\npm\\node_modules\\npm\\bin\\npm-cli.js' } })
  assert.equal(cmd.args[0].replace(/\\/g, '/'), 'D:/npm/node_modules/npm/bin/npx-cli.js')
  assert.throws(() => npxCommand(args, { platform: 'win32', execPath: 'C:\\nodejs\\node.exe', exists: () => false, env: {} }),
    /npx-cli\.js/)
})

test('npx elsewhere is spawned directly with the argument array', () => {
  const cmd = npxCommand(args, { platform: 'linux', execPath: '/usr/bin/node', exists: () => false, env: {} })
  assert.deepEqual(cmd, { file: 'npx', args, shell: false })
})

test('QA_KIT_NPX names the npx to run, on every platform', () => {
  const cmd = npxCommand(args, { platform: 'win32', execPath: 'C:\\nodejs\\node.exe', exists: () => false, env: { QA_KIT_NPX: '/opt/npx' } })
  assert.deepEqual(cmd, { file: '/opt/npx', args, shell: false })
})
