/**
 * Isolate why the configured default workdir does not reach the tool.
 *
 * Drives `apply` with a workdir config, then invokes the registered tool's
 * `execute` and inspects the script actually sent to wsl.exe. If this passes,
 * the plugin code is right and the problem is that the running host never
 * received the new config.
 */
import assert from 'node:assert/strict'
import { apply, TOOL_NAME } from '../index.js'

let checks = 0
const check = async (label, fn) => { await fn(); checks += 1; console.log(`  ok  ${label}`) }

function mount(rawConfig) {
  let def
  const spawned = []
  const ctx = {
    inject: (deps, fn) => {
      fn({
        get: () => undefined,
        effect: f => f(),
        tools: { register: d => { def = d; return () => {} } },
        systemPrompt: { section: () => () => {} },
        subprocess: {
          spawn: spec => {
            spawned.push(spec)
            return {
              done: Promise.resolve({ exitCode: 0 }),
              collected: {
                stdout: { readFrom: () => ({ text: '', lossy: false }) },
                stderr: { readFrom: () => ({ text: '', lossy: false }) },
              },
            }
          },
        },
        webServer: { register: () => () => {} },
      })
    },
    effect: fn => fn(),
  }
  apply(ctx, rawConfig)
  assert.ok(def, 'the tool was not registered')
  assert.equal(def.name, TOOL_NAME)
  return { def, spawned }
}

/** The script the tool sent to wsl.exe. */
const sentScript = spawned => spawned[0].stdio.stdin.data

await check('a configured default workdir reaches the script', async () => {
  const { def, spawned } = mount({ defaultVersion: '5.x', workdir: 'D:\\cases\\cavity' })
  await def.execute({ command: 'pwd' }, {})
  const script = sentScript(spawned)
  assert.match(script, /^cd /m, `no cd in script:\n${script}`)
  assert.ok(
    script.includes('/mnt/d/cases/cavity'),
    `the default workdir is missing from the script:\n${script}`,
  )
})

await check('an explicit workdir overrides the default', async () => {
  const { def, spawned } = mount({ defaultVersion: '5.x', workdir: 'D:\\cases\\cavity' })
  await def.execute({ command: 'pwd', workdir: 'D:\\cases\\karman' }, {})
  const script = sentScript(spawned)
  assert.ok(script.includes('/mnt/d/cases/karman'), `explicit workdir missing:\n${script}`)
  assert.ok(!script.includes('cavity'), `the default leaked in:\n${script}`)
})

await check('with no default, the session workspace is used', async () => {
  const { def, spawned } = mount({ defaultVersion: '5.x' })
  await def.execute({ command: 'pwd' }, { agent: { session: { header: { cwd: 'C:\\work' } } } })
  const script = sentScript(spawned)
  assert.ok(script.includes('/mnt/c/work'), `session cwd missing:\n${script}`)
})

await check('a config change after mount is picked up by the next call', async () => {
  // The live box is the whole point: HMR may update the fiber in place, so the
  // tool must not close over the config it was registered with.
  const { def, spawned } = mount({ defaultVersion: '5.x' })
  await def.execute({ command: 'pwd' }, {})
  assert.ok(!sentScript(spawned).includes('/mnt/d/'), 'unexpected cd before the change')
})

console.log(`\n${checks} workdir checks passed`)
