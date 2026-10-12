/**
 * Self-check for the settings API routes.
 *
 * The browser cannot be driven from here (the connection fence needs a
 * per-process token), so this mounts `apply` against a mock host context and
 * invokes the registered route handler directly with mock req/res objects. It
 * exercises the real validation, the real `configEditor` call shape, and the
 * real probe/test plumbing.
 *
 * Run: node test-api.mjs
 */
import assert from 'node:assert/strict'
import { apply, API_PREFIX } from '../index.js'

let checks = 0
const check = async (label, fn) => { await fn(); checks += 1; console.log(`  ok  ${label}`) }

/** A mock res that records the status and parsed body. */
function mockRes() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; return this },
    end(body) { if (body !== undefined) this.body = String(body); return this },
    json() { return this.body === '' ? undefined : JSON.parse(this.body) },
  }
}

/** A mock req; `body` is exposed as an async-iterable like a real stream. */
function mockReq({ method = 'GET', url = API_PREFIX, body } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() {
      if (text !== '') yield Buffer.from(text, 'utf8')
    },
  }
}

/** Capture the route handler `apply` registers on the mock webServer. */
function mount({ spawn, editor, entries }) {
  let handler
  const ctx = {
    inject: (deps, fn) => {
      const scope = {
        get: name => (name === 'subprocess' ? { spawn } : name === 'configEditor' ? editor : undefined),
        effect: fn2 => fn2(),
        // The tool and prompt registrations are incidental to the API checks;
        // they only need to not throw while `apply` runs.
        tools: { register: () => () => {} },
        systemPrompt: { section: () => () => {} },
        subprocess: { spawn },
        webServer: {
          register: route => { handler = route.handler; return () => {} },
        },
      }
      fn(scope)
    },
    effect: fn => fn(),
  }
  apply(ctx, { defaultVersion: '5.x' })
  assert.ok(handler, 'no route handler was registered')
  return handler
}

/** A spawn stub that answers one canned script run. */
function spawnStub(scriptOut) {
  const seen = []
  const spawn = spec => {
    seen.push(spec)
    const data = spec.stdio?.stdin?.data ?? ''
    const out = scriptOut(data)
    return {
      done: Promise.resolve({ exitCode: 0 }),
      collected: {
        stdout: { readFrom: () => ({ text: out, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', lossy: false }) },
      },
    }
  }
  return { spawn, seen }
}

console.log('settings API')

await check('GET /config returns the page payload', async () => {
  const handler = mount({ spawn: spawnStub(() => '').spawn })
  const res = mockRes()
  await handler(mockReq({ url: `${API_PREFIX}/config` }), res)
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.defaultVersion, '5.x')
  assert.deepEqual(Object.keys(body.versions).sort(), ['5.x', 'v2012'])
  assert.equal(body.workdir, '')
  assert.equal(body.workdirLinux, '')
})

await check('POST /config rejects an unknown version', async () => {
  const handler = mount({ spawn: spawnStub(() => '').spawn })
  const res = mockRes()
  await handler(mockReq({ method: 'POST', url: `${API_PREFIX}/config`, body: { defaultVersion: 'nope' } }), res)
  assert.equal(res.status, 400)
  assert.match(res.json().error, /defaultVersion must be one of/)
})

await check('POST /config rejects a relative workdir', async () => {
  const handler = mount({ spawn: spawnStub(() => '').spawn })
  const res = mockRes()
  await handler(mockReq({ method: 'POST', url: `${API_PREFIX}/config`, body: { workdir: 'relative/dir' } }), res)
  assert.equal(res.status, 400)
  assert.match(res.json().error, /absolute Linux path/)
})

await check('POST /config saves a version through the config editor', async () => {
  const calls = []
  const entry = { options: { id: 'wsl-openfoam' } }
  const editor = {
    entries: () => [entry],
    edit: async (target, change) => { calls.push({ target, next: change({ defaultVersion: '5.x' }, {}) }) },
  }
  const handler = mount({ spawn: spawnStub(() => '').spawn, editor })
  const res = mockRes()
  await handler(mockReq({ method: 'POST', url: `${API_PREFIX}/config`, body: { defaultVersion: 'v2012' } }), res)
  assert.equal(res.status, 200)
  assert.equal(calls.length, 1, 'the editor was not called exactly once')
  assert.equal(calls[0].target, entry)
  assert.equal(calls[0].next.defaultVersion, 'v2012')
  assert.equal(res.json().defaultVersion, 'v2012')
})

await check('POST /config saves a workdir and reports its Linux form', async () => {
  const calls = []
  const entry = { options: { id: 'wsl-openfoam' } }
  const editor = { entries: () => [entry], edit: async (t, change) => { calls.push(change({}, {})) } }
  const handler = mount({ spawn: spawnStub(() => '').spawn, editor })
  const res = mockRes()
  await handler(mockReq({ method: 'POST', url: `${API_PREFIX}/config`, body: { workdir: 'D:\\cases' } }), res)
  assert.equal(res.status, 200)
  assert.equal(calls[0].workdir, 'D:\\cases')
  assert.equal(res.json().workdirLinux, '/mnt/d/cases')
})

await check('POST /config treats an empty workdir as "unset"', async () => {
  const calls = []
  const entry = { options: { id: 'wsl-openfoam' } }
  const editor = { entries: () => [entry], edit: async (t, change) => { calls.push(change({ workdir: 'D:\\old' }, {})) } }
  const handler = mount({ spawn: spawnStub(() => '').spawn, editor })
  const res = mockRes()
  await handler(mockReq({ method: 'POST', url: `${API_PREFIX}/config`, body: { workdir: '  ' } }), res)
  assert.equal(res.status, 200)
  assert.ok(!('workdir' in calls[0]), `workdir should be removed, got ${JSON.stringify(calls[0])}`)
  assert.equal(res.json().workdir, '')
})

await check('POST /config reports 503 when no config editor is mounted', async () => {
  const handler = mount({ spawn: spawnStub(() => '').spawn })
  const res = mockRes()
  await handler(mockReq({ method: 'POST', url: `${API_PREFIX}/config`, body: { defaultVersion: 'v2012' } }), res)
  assert.equal(res.status, 503)
  assert.match(res.json().error, /config editor is unavailable/)
})

await check('GET /probe runs the probe script and parses its output', async () => {
  const { spawn, seen } = spawnStub(script => {
    assert.match(script, /__DSH_PROBE_BEGIN__/, 'the probe script was not sent')
    return [
      '__DSH_PROBE_BEGIN__',
      'distro=Ubuntu 24.04.3 LTS',
      'kernel=6.6.87.2',
      'user=me',
      '__DSH_VERSION__ 5.x',
      'rc_path=/home/w/5.x/etc/bashrc',
      'rc_exists=yes',
      'wm_version=5.x',
      'solvers=blockMesh simpleFoam',
      '__DSH_VERSION__ v2012',
      'rc_path=/home/w/v2012/etc/bashrc',
      'rc_exists=no',
      '__DSH_PROBE_END__',
      '',
    ].join('\n')
  })
  const handler = mount({ spawn })
  const res = mockRes()
  await handler(mockReq({ url: `${API_PREFIX}/probe` }), res)
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.distro, 'Ubuntu 24.04.3 LTS')
  assert.equal(body.versions.length, 2)
  assert.equal(body.versions[0].wmVersion, '5.x')
  assert.deepEqual(body.versions[0].solvers, ['blockMesh', 'simpleFoam'])
  assert.equal(body.versions[1].rcExists, false)
  // The probe must run through wsl.exe with the configured distro.
  assert.equal(seen.length, 1)
  assert.match(seen[0].argv.join(' '), /wsl\.exe -d Ubuntu-24\.04 -- bash -s/)
})

await check('POST /test reports success and names the release it used', async () => {
  const { spawn } = spawnStub(script => {
    assert.match(script, /OpenFOAM-5\.x\/etc\/bashrc/, 'the default release was not sourced')
    return 'WM_PROJECT_VERSION=5.x\n/opt/bin/blockMesh\n'
  })
  const handler = mount({ spawn })
  const res = mockRes()
  await handler(mockReq({ method: 'POST', url: `${API_PREFIX}/test`, body: {} }), res)
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.version, '5.x')
  assert.match(body.stdout, /WM_PROJECT_VERSION=5\.x/)
})

await check('an unknown route returns 404', async () => {
  const handler = mount({ spawn: spawnStub(() => '').spawn })
  const res = mockRes()
  await handler(mockReq({ url: `${API_PREFIX}/nope` }), res)
  assert.equal(res.status, 404)
})

await check('a non-loopback Host is refused by the trust fence', async () => {
  const handler = mount({ spawn: spawnStub(() => '').spawn })
  const res = mockRes()
  const req = mockReq({ url: `${API_PREFIX}/config` })
  req.headers.host = 'evil.example.com'
  await handler(req, res)
  assert.equal(res.status, 403, 'a non-loopback Host must be refused')
})

await check('a cross-site fetch is refused by the trust fence', async () => {
  const handler = mount({ spawn: spawnStub(() => '').spawn })
  const res = mockRes()
  const req = mockReq({ url: `${API_PREFIX}/config` })
  req.headers['sec-fetch-site'] = 'cross-site'
  await handler(req, res)
  assert.equal(res.status, 403)
})

await check('a mismatched Origin is refused by the trust fence', async () => {
  const handler = mount({ spawn: spawnStub(() => '').spawn })
  const res = mockRes()
  const req = mockReq({ url: `${API_PREFIX}/config` })
  req.headers.origin = 'http://127.0.0.1:9999'
  await handler(req, res)
  assert.equal(res.status, 403)
})

console.log(`\n${checks} API checks passed`)
