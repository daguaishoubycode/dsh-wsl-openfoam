/**
 * Headless check for the client half: stub the browser surface the shell
 * provides (`window.__ModuleLoader__`, `react`, `document`), load the bundle,
 * then drive `apply` against a fake ctx and render the page through a tiny
 * React stub. Catches a malformed slot registration or a crash in the
 * component before the real page ever loads.
 *
 * Run: node test-client.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
let checks = 0
const check = async (label, fn) => { await fn(); checks += 1; console.log(`  ok  ${label}`) }

// ── minimal React stub: records the element tree, supports the hooks used ──
let hookStates = []
let hookIndex = 0
/** Effects registered by the render currently in progress. */
let pendingEffects = []
const React = {
  createElement: (type, props, ...children) => ({
    $$element: true,
    type,
    props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
  }),
  useState: initial => {
    const i = hookIndex++
    if (!(i in hookStates)) hookStates[i] = typeof initial === 'function' ? initial() : initial
    return [hookStates[i], next => { hookStates[i] = typeof next === 'function' ? next(hookStates[i]) : next }]
  },
  // Record the effect so the harness can run it after the tree is built; a real
  // renderer runs effects post-commit, which is what the page's data loading
  // depends on.
  useEffect: effect => { hookIndex++; pendingEffects.push(effect) },
  useCallback: fn => { hookIndex++; return fn },
  useRef: initial => {
    const i = hookIndex++
    if (!(i in hookStates)) hookStates[i] = { current: initial }
    return hookStates[i]
  },
}

// ── stub the globals the bundle expects ────────────────────────────────────
const styleTags = []
const document = {
  baseURI: 'http://127.0.0.1:3080/',
  head: { appendChild: node => styleTags.push(node) },
  createElement: tag => ({ tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, remove() {} }),
}
let loaded = null
const window = {
  __ModuleLoader__: { load: spec => { loaded = spec } },
}

globalThis.window = window
globalThis.document = document
globalThis.fetch = async () => { throw new Error('fetch must not run during the load check') }

const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
// The bundle is a plain script that calls window.__ModuleLoader__.load.
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'require', source)(window, document, spec => {
  if (spec === 'react') return React
  throw new Error(`unexpected require(${spec})`)
})

await check('the bundle registers itself with the module loader', () => {
  assert.ok(loaded, 'window.__ModuleLoader__.load was never called')
  assert.equal(loaded.id, 'dsh-wsl-openfoam')
  assert.equal(typeof loaded.factory, 'function')
})

const exports = loaded.factory(spec => {
  if (spec === 'react') return React
  throw new Error(`unexpected require(${spec})`)
})

await check('the client half exports the apply/inject/name contract', () => {
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(exports.name, 'wsl-openfoam')
})

// ── drive apply against a fake ctx ─────────────────────────────────────────
const registered = []
const effects = []
const ctx = {
  effect: (fn, label) => { effects.push(label); return fn() },
  slots: {
    inject: (slot, fn) => { assert.equal(slot, 'settings.section'); fn() },
    register: (row, render) => { registered.push({ row, render }); return () => {} },
  },
}

await check('apply() registers one settings section and injects its styles', () => {
  exports.apply(ctx)
  assert.equal(registered.length, 1, 'expected exactly one settings.section registration')
  assert.equal(registered[0].row.name, 'settings.section')
  assert.equal(registered[0].row.id, 'wsl-openfoam')
  assert.equal(typeof registered[0].row.label, 'string')
  assert.ok(effects.some(l => String(l).includes('styles')), 'no styles effect was registered')
  assert.equal(styleTags.length, 1, 'no style tag was injected')
  assert.ok(styleTags[0].attrs['data-plugin'] === 'dsh-wsl-openfoam')
})

// ── a renderable, re-renderable harness ────────────────────────────────────
const Page = registered[0].render

/**
 * Walk an element tree, invoking function components the way React does, and
 * collect every rendered string. Without this the tree is just one element
 * whose `type` is the component — the page's own markup would never be seen.
 * Hooks are reset per component so each one gets a fresh state slot range.
 */
function renderToText(node, depth = 0) {
  if (depth > 60) throw new Error('render did not terminate')
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(child => renderToText(child, depth + 1)).join(' ')
  if (typeof node === 'function') {
    const saved = hookIndex
    hookIndex = 0
    try { return renderToText(node({}), depth + 1) } finally { hookIndex = saved }
  }
  if (node.$$element) {
    if (typeof node.type === 'function') {
      const saved = hookIndex
      hookIndex = 0
      try { return renderToText(node.type(node.props), depth + 1) } finally { hookIndex = saved }
    }
    return renderToText(node.props?.children, depth + 1)
  }
  return ''
}

await check('the page renders its loading state without throwing', () => {
  hookStates = []
  hookIndex = 0
  const text = renderToText(Page({}))
  assert.ok(text.includes('WSL OpenFOAM'), `the page title is missing from: ${text.slice(0, 200)}`)
  assert.ok(text.includes('正在加载'), `the loading state is missing from: ${text.slice(0, 200)}`)
})

// ── drive the page through a full load with stubbed host responses ──────────
// The stub records effects so a re-render after the fetch resolves observes the
// loaded state, and answers each route the page calls.
const CONFIG = {
  distro: 'Ubuntu-24.04',
  defaultVersion: '5.x',
  versions: { '5.x': '~/OpenFOAM/OpenFOAM-5.x/etc/bashrc', v2012: '~/OpenFOAM/OpenFOAM-v2012/etc/bashrc' },
  workdir: '',
  workdirLinux: '',
}
const PROBE = {
  distro: 'Ubuntu 24.04.3 LTS',
  kernel: '6.6.87.2-microsoft-standard-WSL2',
  user: 'me',
  versions: [
    { name: '5.x', rcExists: true, rcPath: '/home/me/OpenFOAM/OpenFOAM-5.x/etc/bashrc', wmVersion: '5.x', solvers: ['blockMesh', 'checkMesh', 'simpleFoam'] },
    { name: 'v2012', rcExists: true, rcPath: '/home/me/OpenFOAM/OpenFOAM-v2012/etc/bashrc', wmVersion: 'v2012', solvers: ['blockMesh', 'simpleFoam'] },
  ],
}

let fetchCalls = []
globalThis.fetch = async (url, options) => {
  const route = String(url).replace(/^.*\/api\/wsl-openfoam/, '')
  fetchCalls.push({ route, method: options?.method ?? 'GET' })
  const body = route === '/probe' ? PROBE : CONFIG
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  }
}

/**
 * Collect one prop's values from every element in the tree, invoking function
 * components exactly as {@link renderToText} does — otherwise a prop owned by
 * the page component itself would never be reached.
 */
function collectProp(node, prop, out = [], depth = 0) {
  if (depth > 60 || node === null || node === undefined) return out
  if (typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) collectProp(child, prop, out, depth + 1); return out }
  if (!node.$$element) return out
  if (typeof node.type === 'function') {
    const saved = hookIndex
    hookIndex = 0
    try { collectProp(node.type(node.props), prop, out, depth + 1) } finally { hookIndex = saved }
    return out
  }
  if (node.props?.[prop] !== undefined) out.push(node.props[prop])
  collectProp(node.props?.children, prop, out, depth + 1)
  return out
}

/** Render the page, let its pending requests settle, and return the second tree. */
async function renderSettled() {
  hookStates = []
  hookIndex = 0
  pendingEffects = []
  renderToText(Page({}))
  // Run the effects the first render registered, then flush their promises.
  for (const effect of pendingEffects) { try { effect() } catch { /* observed elsewhere */ } }
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
  hookIndex = 0
  pendingEffects = []
  return Page({})
}

await check('the loaded page reports the environment, both releases, workdir and test', async () => {
  const tree = await renderSettled()
  const text = renderToText(tree)
  const need = [
    ['environment card', '环境检测'],
    ['probe distro', 'Ubuntu 24.04.3 LTS'],
    ['probe kernel', '6.6.87.2-microsoft-standard-WSL2'],
    ['probe user', 'me'],
    ['all-usable verdict', '全部可用'],
    ['both releases listed', 'v2012'],
    ['detected binary chip', 'checkMesh'],
    ['default version card', '默认版本'],
    ['workdir card', '默认工作目录'],
    ['test card', '测试'],
    ['test button names the release', '测试 5.x'],
    ['the default release is marked', '默认'],
    ['a switch-to-default action exists', '设为默认'],
  ]
  for (const [label, needle] of need) {
    assert.ok(text.includes(needle), `${label}: expected ${JSON.stringify(needle)} in:\n${text.slice(0, 900)}`)
  }
  // The workdir example lives in a prop, not in child text.
  const placeholders = collectProp(tree, 'placeholder')
  assert.ok(
    placeholders.some(p => String(p).includes('cases')),
    `the workdir field has no example placeholder; got ${JSON.stringify(placeholders)}`,
  )
  assert.ok(fetchCalls.some(c => c.route === '/config'), 'the page never read its config')
  assert.ok(fetchCalls.some(c => c.route === '/probe'), 'the page never probed the environment')
})

console.log(`\n${checks} client checks passed`)
