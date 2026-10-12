/**
 * WSL + OpenFOAM bridge: run OpenFOAM commands inside WSL from any DSH session.
 *
 * Why a plugin is needed at all: the harness's own shell tools cannot reach WSL.
 * `ops_bash` resolves a Git-bash and explicitly rejects
 * `%SystemRoot%\System32\bash.exe` (that path is the WSL launcher, not a POSIX
 * shell), and both the bash and pwsh executors are wrapped by the Windows ACL
 * sandbox runner, which denies the named pipes `wsl.exe` needs — a plain
 * `wsl.exe` call from the pwsh tool fails with `Wsl/ACCESSDENIED`. Spawning
 * `wsl.exe` through the host `ctx.subprocess` service runs outside that
 * executor wrap, so it works in every session regardless of sandbox mode.
 *
 * Security: commands execute in WSL, NOT under the DSH file sandbox. The
 * Windows-side sandbox mode does not constrain this tool; treat it as full
 * access to the Linux side. That is the point of the plugin, but it is a real
 * trust boundary and the prompt section says so.
 */

/** Model-facing tool name. */
export const TOOL_NAME = 'wsl_openfoam'

/** Plugin id, also the loader row id used by the profile patch. */
export const name = 'wsl-openfoam'

const DEFAULT_DISTRO = 'Ubuntu-24.04'
const DEFAULT_VERSION = '5.x'
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 86_400_000
const DEFAULT_GRACE_MS = 3_000
const MAX_OUTPUT_BYTES = 64_000
const MAX_SPILL_BYTES = 64 * 1024 * 1024

/** The settings page's environment probe is bounded so a hung WSL cannot wedge it. */
const PROBE_TIMEOUT_MS = 60_000

/** The settings page's "test" button runs one short command. */
const TEST_TIMEOUT_MS = 60_000

/**
 * Where each OpenFOAM release keeps its `etc/bashrc`, keyed by the name the
 * tool's `version` argument uses. A leading `~` is expanded by bash, so these
 * stay valid if the WSL user is renamed. Override through the plugin config.
 */
export const DEFAULT_VERSIONS = Object.freeze({
  '5.x': '~/OpenFOAM/OpenFOAM-5.x/etc/bashrc',
  v2012: '~/OpenFOAM/OpenFOAM-v2012/etc/bashrc',
})

/**
 * Model-friendly environment overrides: no colors, no pagers. `WSL_UTF8` is the
 * load-bearing one — without it `wsl.exe` writes UTF-16LE to a pipe and every
 * captured byte is interleaved with NULs.
 */
export const ENV_OVERRIDES = Object.freeze({
  WSL_UTF8: '1',
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
})

/** Quote one value for bash single-quoted context. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Render a configured bashrc path as a bash word, expanding a leading `~` while
 * single-quoting the rest so spaces and quotes in a custom path stay literal.
 * @param {string} value - the configured path.
 * @returns {string} a bash word.
 */
export function bashPathWord(value) {
  if (value === '~') return '"$HOME"'
  if (value.startsWith('~/')) return `"$HOME"/${shellQuote(value.slice(2))}`
  return shellQuote(value)
}

/**
 * Map a Windows path to its WSL form. Linux paths pass through untouched, so a
 * caller may pass either spelling. Only drive-letter paths are translated;
 * `\\wsl$\...` UNC paths are not, and are reported as-is by bash.
 * @param {string|undefined} value - the caller's path.
 * @returns {string|undefined} the WSL path, or undefined when there is none.
 */
export function toLinuxPath(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('/')) return trimmed
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(trimmed)
  if (drive === null) return undefined
  return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`
}

/**
 * Build the script handed to `bash -s` over stdin.
 *
 * The script is passed on stdin rather than as an argv element on purpose:
 * `wsl.exe` receives argv through the Windows command line, where backslashes,
 * quotes and newlines in a user command are re-parsed and corrupted. stdin is
 * byte-exact.
 * @param {object} options - script inputs.
 * @param {string|undefined} options.bashrc - bashrc to source before the command.
 * @param {string|undefined} options.workdir - WSL directory to run in.
 * @param {string} options.command - the caller's shell command.
 * @returns {string} the complete script.
 */
export function buildScript({ bashrc, workdir, command }) {
  const lines = []
  if (bashrc !== undefined) {
    // Assign, then check: a missing bashrc must fail loudly instead of silently
    // running the command against whatever OpenFOAM the login environment had.
    lines.push(`__dsh_rc=${bashPathWord(bashrc)}`)
    lines.push('if [ ! -r "$__dsh_rc" ]; then echo "wsl-openfoam: bashrc not found: $__dsh_rc" >&2; exit 127; fi')
    lines.push('. "$__dsh_rc"')
  }
  if (workdir !== undefined) {
    lines.push(`cd ${bashPathWord(workdir)} || { echo "wsl-openfoam: cannot enter workdir: ${workdir}" >&2; exit 1; }`)
  }
  lines.push(command)
  return `${lines.join('\n')}\n`
}

/** The absolute `wsl.exe` this deployment should use. */
function wslExecutable() {
  const root = process.env.SystemRoot ?? process.env.WINDIR
  return root === undefined ? 'wsl.exe' : `${root}\\System32\\wsl.exe`
}

/** Resolve the effective configuration, tolerating an absent or partial one. */
export function resolveConfig(raw) {
  const config = raw ?? {}
  const versions = { ...DEFAULT_VERSIONS, ...(config.versions ?? {}) }
  const defaultVersion = typeof config.defaultVersion === 'string' && config.defaultVersion !== ''
    ? config.defaultVersion
    : DEFAULT_VERSION
  if (!(defaultVersion in versions)) {
    throw new Error(`wsl-openfoam: defaultVersion ${JSON.stringify(defaultVersion)} is not one of ${Object.keys(versions).join(', ')}`)
  }
  return {
    distro: typeof config.distro === 'string' && config.distro !== '' ? config.distro : DEFAULT_DISTRO,
    defaultVersion,
    versions,
    // Optional: a case root the tool uses when a call passes no `workdir`.
    workdir: typeof config.workdir === 'string' && config.workdir.trim() !== '' ? config.workdir.trim() : undefined,
  }
}

/**
 * Build the environment probe script.
 *
 * Each release is sourced inside its own subshell so a broken one cannot poison
 * the next, and `source`'s own chatter is discarded — only the machine-readable
 * `key=value` lines below reach stdout.
 * @param {object} config - the resolved config.
 * @returns {string} the script for `bash -s`.
 */
export function buildProbeScript(config) {
  const lines = [
    'echo "__DSH_PROBE_BEGIN__"',
    'echo "distro=$(. /etc/os-release 2>/dev/null; echo ${PRETTY_NAME:-unknown})"',
    'echo "kernel=$(uname -r 2>/dev/null)"',
    'echo "user=$(id -un 2>/dev/null)"',
  ]
  for (const [name, bashrc] of Object.entries(config.versions)) {
    lines.push(`echo "__DSH_VERSION__ ${name}"`)
    lines.push(`__rc=${bashPathWord(bashrc)}`)
    lines.push('echo "rc_path=$__rc"')
    lines.push('if [ -r "$__rc" ]; then')
    lines.push('  echo "rc_exists=yes"')
    lines.push('  (')
    lines.push('    . "$__rc" >/dev/null 2>&1')
    lines.push('    echo "wm_version=${WM_PROJECT_VERSION:-unknown}"')
    lines.push('    echo "bin_dir=${FOAM_APPBIN:-unknown}"')
    lines.push('    __found=""')
    lines.push('    for __s in blockMesh checkMesh simpleFoam foamDictionary; do')
    lines.push('      command -v "$__s" >/dev/null 2>&1 && __found="$__found $__s"')
    lines.push('    done')
    lines.push('    echo "solvers=${__found# }"')
    lines.push('  ) 2>/dev/null')
    lines.push('else')
    lines.push('  echo "rc_exists=no"')
    lines.push('fi')
  }
  lines.push('echo "__DSH_PROBE_END__"')
  return `${lines.join('\n')}\n`
}

/**
 * Parse the probe's stdout into one record per release.
 * @param {string} text - the probe script's stdout.
 * @returns {{distro: string, kernel: string, user: string, versions: object[]}} the probe result.
 */
export function parseProbe(text) {
  const result = { distro: '', kernel: '', user: '', versions: [] }
  let current
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line === '__DSH_PROBE_BEGIN__' || line === '__DSH_PROBE_END__') continue
    if (line.startsWith('__DSH_VERSION__ ')) {
      current = { name: line.slice('__DSH_VERSION__ '.length).trim(), rcExists: false, wmVersion: '', binDir: '', solvers: [] }
      result.versions.push(current)
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (current === undefined) {
      if (key === 'distro') result.distro = value
      else if (key === 'kernel') result.kernel = value
      else if (key === 'user') result.user = value
      continue
    }
    if (key === 'rc_path') current.rcPath = value
    else if (key === 'rc_exists') current.rcExists = value === 'yes'
    else if (key === 'wm_version') current.wmVersion = value === 'unknown' ? '' : value
    else if (key === 'bin_dir') current.binDir = value === 'unknown' ? '' : value
    else if (key === 'solvers') current.solvers = value === '' ? [] : value.split(/\s+/)
  }
  return result
}

/** Reject arguments this tool does not declare (the registry does not validate them). */
function assertKnownArguments(args, known) {
  if (args === undefined || args === null) return
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`invalid arguments: expected an object, got ${JSON.stringify(args)}`)
  }
  const unknown = Object.keys(args).filter(key => !known.includes(key))
  if (unknown.length === 0) return
  throw new Error(`invalid arguments: unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.map(k => JSON.stringify(k)).join(', ')}; this tool accepts ${known.join(', ')}`)
}

const ARGUMENTS = Object.freeze(['command', 'version', 'workdir', 'timeoutMs', 'graceMs'])

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['timedOut', 'timeoutMs', 'stdout', 'stderr'],
  properties: {
    exitCode: { type: 'integer' },
    signal: { type: 'string' },
    error: { type: 'string' },
    version: { type: 'string' },
    workdir: { type: 'string' },
    timedOut: { type: 'boolean' },
    timeoutMs: { type: 'number' },
    stdout: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'truncated'],
      properties: { text: { type: 'string' }, truncated: { type: 'boolean' }, spillPath: { type: 'string' } },
    },
    stderr: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'truncated'],
      properties: { text: { type: 'string' }, truncated: { type: 'boolean' }, spillPath: { type: 'string' } },
    },
  },
})

/** Read one settled collect-mode stream as its complete retained output. */
function settledStream(reader) {
  if (reader === undefined || typeof reader.readFrom !== 'function') return { text: '', truncated: false }
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy === true,
    ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
  }
}

/** Render one settled run the way the harness's own bash tool does. */
export function renderResult(value) {
  const stream = output => (output.truncated
    ? `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
    : output.text)
  const out = stream(value.stdout)
  const err = stream(value.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (value.error !== undefined) markers.push(`[error: ${value.error}]`)
  if (value.timedOut === true) markers.push(`[timed out after ${value.timeoutMs}ms]`)
  if (value.signal !== undefined) markers.push(`[signal: ${value.signal}]`)
  if (value.exitCode !== undefined && value.exitCode !== 0) markers.push(`[exit code: ${value.exitCode}]`)
  return [body, ...markers].join('\n')
}

/**
 * One tool definition bound to the live configuration.
 * @param {{config: object}} state - the mutable config box `apply` owns.
 * @param {object} subprocess - the harness subprocess service.
 */
function toolDefinition(state, subprocess) {
  const config = state.config
  return {
    name: TOOL_NAME,
    description:
      'Run OpenFOAM commands inside WSL (Linux). Use this for blockMesh, solvers, utilities, '
      + 'paraFoam-related post-processing, and any shell work that needs the Linux OpenFOAM install. '
      + `Sourced release: the \`version\` argument, default ${JSON.stringify(config.defaultVersion)}; `
      + `available: ${Object.keys(config.versions).join(', ')}. `
      + 'Pass Windows paths (C:\\...) or Linux paths (/home/...) for workdir and inside the command; '
      + 'Windows drive paths are translated to /mnt/<drive>/... automatically. '
      + 'The command runs as a bash script over stdin, so quotes, newlines and heredocs survive intact. '
      + 'For a long solver run, background it yourself with output to a log '
      + '(e.g. `nohup simpleFoam > log.simpleFoam 2>&1 &`) and poll the log in later calls; '
      + 'a foreground call is killed at timeoutMs.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Bash command or multi-line script to run in WSL after the OpenFOAM environment is sourced.',
        },
        version: {
          type: 'string',
          description: `OpenFOAM release to source; one of ${Object.keys(config.versions).join(', ')}. Defaults to ${JSON.stringify(config.defaultVersion)}.`,
        },
        workdir: {
          type: 'string',
          description: 'Directory to run in; Windows (C:\\...) or Linux (/home/...) path. Defaults to the configured default directory, then the session workspace.',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds; the process tree is killed on expiry. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
        },
        graceMs: {
          type: 'number',
          description: `Grace period in milliseconds between termination and a forced kill. Defaults to ${DEFAULT_GRACE_MS}.`,
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args, exec) {
      assertKnownArguments(args, ARGUMENTS)
      // Read the config box now, not at registration: a settings change must
      // take effect on the very next call.
      const config = state.config
      const command = args?.command
      if (typeof command !== 'string' || command.trim() === '') {
        throw new Error('invalid command: expected a non-empty string')
      }
      const version = args?.version ?? config.defaultVersion
      if (typeof version !== 'string' || !(version in config.versions)) {
        throw new Error(`invalid version: expected one of ${Object.keys(config.versions).join(', ')}, got ${JSON.stringify(args?.version)}`)
      }
      const timeoutMs = args?.timeoutMs ?? DEFAULT_TIMEOUT_MS
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
        throw new Error(`invalid timeoutMs: expected a positive number no greater than ${MAX_TIMEOUT_MS}`)
      }
      const graceMs = args?.graceMs ?? DEFAULT_GRACE_MS
      if (!Number.isFinite(graceMs) || graceMs <= 0) {
        throw new Error(`invalid graceMs: expected a positive finite number, got ${JSON.stringify(args?.graceMs)}`)
      }
      const requestedWorkdir = toLinuxPath(args?.workdir)
        ?? toLinuxPath(config.workdir)
        ?? toLinuxPath(exec?.agent?.session?.header?.cwd)
      const script = buildScript({
        bashrc: config.versions[version],
        workdir: requestedWorkdir,
        command,
      })

      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error(`command timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      const callerSignal = exec?.signal
      const onCallerAbort = () => controller.abort(callerSignal?.reason)
      if (callerSignal !== undefined) {
        if (callerSignal.aborted) onCallerAbort()
        else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
      }

      // wsl.exe needs a cwd it can translate; the session workspace is a Windows
      // path, and process.cwd() is the fallback for an agentless call.
      const spawnCwd = typeof exec?.agent?.session?.header?.cwd === 'string'
        ? exec.agent.session.header.cwd
        : process.cwd()

      try {
        let handle
        try {
          handle = subprocess.spawn({
            argv: [wslExecutable(), '-d', config.distro, '--', 'bash', '-s'],
            cwd: spawnCwd,
            stdio: {
              stdin: { data: script },
              stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
              stderr: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
            },
            graceMs,
            signal: controller.signal,
            env: { ...ENV_OVERRIDES },
          })
          const outcome = await handle.done
          return {
            ...outcome?.exitCode !== undefined && outcome?.exitCode !== null ? { exitCode: outcome.exitCode } : {},
            ...outcome?.signal !== undefined && outcome?.signal !== null ? { signal: outcome.signal } : {},
            version,
            ...requestedWorkdir === undefined ? {} : { workdir: requestedWorkdir },
            timedOut,
            timeoutMs,
            stdout: settledStream(handle.collected?.stdout),
            stderr: settledStream(handle.collected?.stderr),
          }
        } catch (error) {
          return {
            error: `wsl.exe could not be started: ${String(error?.message ?? error)}`,
            version,
            timedOut,
            timeoutMs,
            stdout: { text: '', truncated: false },
            stderr: { text: '', truncated: false },
          }
        }
      } finally {
        clearTimeout(timer)
        callerSignal?.removeEventListener('abort', onCallerAbort)
      }
    },
  }
}

/** The prompt section that makes the tool discoverable in every conversation. */
export function promptSection(config) {
  const versions = Object.entries(config.versions)
    .map(([label, path]) => `${label} (${path})`)
    .join(', ')
  return [
    `WSL OpenFOAM access is available through the \`${TOOL_NAME}\` tool (Linux side of this Windows machine, WSL distribution ${config.distro}).`,
    `It sources the requested OpenFOAM release before running the command. Configured releases: ${versions}.`,
    `Default release: ${config.defaultVersion}.`,
    'Use it for any OpenFOAM work: blockMesh, solvers, mesh utilities, foamDictionary, post-processing.',
    'Windows drive paths passed to it (C:\\...) are translated to /mnt/<drive>/... automatically.',
    'The command runs in WSL and is not constrained by the DSH file sandbox; do not use it to bypass a denial the user has not approved.',
    'Do not try to reach WSL with the pwsh tool: `wsl.exe` is blocked there by the Windows sandbox runner.',
  ].join(' ')
}

/** The same-origin route prefix the browser half reads and writes. */
export const API_PREFIX = '/api/wsl-openfoam'

/** Hostnames a same-machine browser page can legitimately use. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/** Split a Host/Origin/Referer value into {scheme, hostname, port}. */
function authorityOf(value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

/**
 * Decide one request, mirroring the kernel's own trust fence.
 *
 * The composition's `connection` service is preferred when present — it is the
 * exact admission decision the app applies to its own `/api` routes, so this
 * plugin is never weaker than the shell. Without it, a structural replica:
 * loopback Host (DNS-rebinding defence), no cross-site fetch, and an
 * Origin/Referer whose authority matches Host.
 * @param {object} req - the HTTP request.
 * @param {object|undefined} connection - the harness `connection` service.
 * @returns {number|undefined} an HTTP status to reject with, or undefined to proceed.
 */
export function rejectionFor(req, connection) {
  try {
    const admit = connection?.admit
    if (typeof admit === 'function') {
      const admission = admit.call(connection, req)
      const status = admission && typeof admission === 'object' ? admission.rejection : undefined
      if (status === undefined) return undefined
      return status
    }
    const reject = connection?.requestRejection
    if (typeof reject === 'function') {
      const status = reject.call(connection, req)
      if (status === undefined) return undefined
      return status
    }
  } catch {
    // A mounted Host service that fails must never silently disable authentication.
    return 503
  }
  const host = authorityOf(req.headers.host, 'http')
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const authority = authorityOf(raw.trim())
    if (authority === null) return 403
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) return 403
  }
  return undefined
}

/** Read a bounded JSON request body. */
async function readJson(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Send one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** The loader row whose config the settings page edits. */
function configEntry(ctx) {
  const editor = ctx.get('configEditor')
  if (editor === undefined || typeof editor.edit !== 'function') return { editor: undefined }
  const entry = editor.entries().find(candidate => candidate.options.id === name)
  return { editor, entry }
}

/** The config as the settings page reads it, with the resolved Linux workdir. */
function configPayload(config) {
  return {
    distro: config.distro,
    defaultVersion: config.defaultVersion,
    versions: { ...config.versions },
    workdir: config.workdir ?? '',
    workdirLinux: toLinuxPath(config.workdir) ?? '',
  }
}

/**
 * Mount the settings API.
 *
 * - `GET  /config` reads the live config.
 * - `POST /config` persists `defaultVersion` and/or `workdir` through the
 *   profile's own config editor (which writes the patch row and reconciles the
 *   Loader, so the change survives a restart).
 * - `GET  /probe`  sources every configured release in WSL and reports what it
 *   actually found, so the page can show real state instead of a guess.
 * - `POST /test`   runs one real command through the same path the tool uses.
 */
function mountApi(ctx, state) {
  ctx.inject(['webServer'], scope => {
    /** Run one script through wsl.exe and collect its output. */
    const runWsl = async (script, timeoutMs) => {
      const config = state.config
      const subprocess = scope.get('subprocess')
      if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
        throw new Error('the subprocess service is unavailable')
      }
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('timed out'))
      }, timeoutMs)
      timer.unref?.()
      try {
        const handle = subprocess.spawn({
          argv: [wslExecutable(), '-d', config.distro, '--', 'bash', '-s'],
          cwd: process.cwd(),
          stdio: {
            stdin: { data: script },
            stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
            stderr: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
          },
          graceMs: DEFAULT_GRACE_MS,
          signal: controller.signal,
          env: { ...ENV_OVERRIDES },
        })
        const outcome = await handle.done
        return {
          timedOut,
          exitCode: outcome?.exitCode ?? undefined,
          stdout: settledStream(handle.collected?.stdout).text,
          stderr: settledStream(handle.collected?.stderr).text,
        }
      } finally {
        clearTimeout(timer)
      }
    }

    const handle = async (req, res) => {
      const rejection = rejectionFor(req, scope.get('connection'))
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : rejection === 503 ? 'admission unavailable' : 'forbidden')
        return
      }
      const path = (req.url ?? '').split('?')[0].slice(API_PREFIX.length)
      try {
        const config = state.config
        if (path === '/config' && req.method === 'GET') {
          sendJson(res, 200, configPayload(config))
          return
        }

        if (path === '/config' && req.method === 'POST') {
          const body = await readJson(req)
          const patch = {}
          if (body?.defaultVersion !== undefined) {
            if (typeof body.defaultVersion !== 'string' || !(body.defaultVersion in config.versions)) {
              sendJson(res, 400, { error: `defaultVersion must be one of ${Object.keys(config.versions).join(', ')}` })
              return
            }
            patch.defaultVersion = body.defaultVersion
          }
          if (body?.workdir !== undefined) {
            if (typeof body.workdir !== 'string') {
              sendJson(res, 400, { error: 'workdir must be a string' })
              return
            }
            const trimmed = body.workdir.trim()
            // Accept either spelling and store the caller's own form.
            if (trimmed !== '' && toLinuxPath(trimmed) === undefined) {
              sendJson(res, 400, { error: 'workdir must be an absolute Linux path (/...) or a Windows drive path (C:\\...)' })
              return
            }
            patch.workdir = trimmed
          }
          if (Object.keys(patch).length === 0) {
            sendJson(res, 400, { error: 'nothing to save: expected defaultVersion and/or workdir' })
            return
          }
          const { editor, entry } = configEntry(scope)
          if (editor === undefined || entry === undefined) {
            sendJson(res, 503, { error: 'the profile config editor is unavailable; edit cordis.patch.yml by hand' })
            return
          }
          await editor.edit(entry, current => {
            const next = { ...current, ...patch }
            // An emptied workdir means "unset", not "empty string".
            if (next.workdir === '') delete next.workdir
            return next
          })
          // The edit triggers a reload, but that is asynchronous; update the box
          // now so the very next tool call already sees the new value.
          state.config = resolveConfig({
            ...config,
            ...patch,
            ...patch.workdir === '' ? { workdir: undefined } : {},
          })
          sendJson(res, 200, configPayload(state.config))
          return
        }

        if (path === '/probe' && req.method === 'GET') {
          const run = await runWsl(buildProbeScript(config), PROBE_TIMEOUT_MS)
          const parsed = parseProbe(run.stdout)
          sendJson(res, 200, {
            ...parsed,
            distroName: config.distro,
            timedOut: run.timedOut,
            ...run.exitCode === undefined || run.exitCode === 0 ? {} : { exitCode: run.exitCode },
            ...run.stderr.trim() === '' ? {} : { stderr: run.stderr.trim().slice(0, 2000) },
          })
          return
        }

        if (path === '/test' && req.method === 'POST') {
          const body = await readJson(req)
          const version = typeof body?.version === 'string' && body.version in config.versions
            ? body.version
            : config.defaultVersion
          const script = buildScript({
            bashrc: config.versions[version],
            workdir: toLinuxPath(config.workdir),
            command: 'echo "WM_PROJECT_VERSION=$WM_PROJECT_VERSION"; '
              + 'command -v blockMesh || echo "blockMesh: NOT FOUND"; '
              + 'command -v simpleFoam || echo "simpleFoam: NOT FOUND"; '
              + 'echo "cwd=$(pwd)"',
          })
          const run = await runWsl(script, TEST_TIMEOUT_MS)
          sendJson(res, 200, {
            version,
            ok: run.exitCode === 0 && !run.timedOut,
            timedOut: run.timedOut,
            ...run.exitCode === undefined ? {} : { exitCode: run.exitCode },
            stdout: run.stdout.slice(0, 4000),
            stderr: run.stderr.slice(0, 4000),
          })
          return
        }

        sendJson(res, 404, { error: 'not found' })
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    }
    scope.effect(
      // The route type is `(req, res) => void | Promise<void>`, so the async
      // handler is registered directly rather than wrapped.
      () => scope.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handle }),
      'wsl-openfoam: settings api',
    )
  })
}

/**
 * Mount the tool, its prompt section, and the settings API.
 * @param {object} ctx - host Cordis context.
 * @param {object} [rawConfig] - plugin config.
 */
export function apply(ctx, rawConfig) {
  // `apply` re-runs on HMR, but a fiber updated in place keeps the registrations
  // it already made — and those close over whatever config existed then. Hold the
  // config in one mutable box so the tool, the prompt section, and the API always
  // read the live value instead of a stale snapshot.
  const state = { config: resolveConfig(rawConfig) }

  ctx.inject(['tools', 'subprocess'], scope => {
    scope.effect(
      () => scope.tools.register(toolDefinition(state, scope.subprocess)),
      'wsl-openfoam: tool',
    )
  })

  ctx.inject(['systemPrompt'], scope => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'wsl-openfoam:environment',
      order: 1050,
      interpolate: false,
      text: () => promptSection(state.config),
    }), 'wsl-openfoam: prompt section')
  })

  mountApi(ctx, state)
}
