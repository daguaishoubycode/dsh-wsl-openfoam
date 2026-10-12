/**
 * Host-half self-check.
 *
 * Two layers:
 *
 * 1. **Pure logic** — path translation, script assembly, config resolution,
 *    result rendering. No WSL needed; always runs.
 * 2. **WSL end-to-end** — drives the real `wsl.exe` with the same argv/stdin
 *    shape the tool uses. To stay portable this builds a *synthetic* OpenFOAM
 *    release in a temp directory (a bashrc that exports a marker plus a fake
 *    `blockMesh`), so it needs WSL but no OpenFOAM install. Any configured real
 *    release that is actually present is verified too, and skipped otherwise.
 *
 * Run: node test/host.test.mjs
 * Env: WSL_OPENFOAM_DISTRO  override the distribution (default Ubuntu-24.04)
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  DEFAULT_VERSIONS,
  bashPathWord,
  buildScript,
  renderResult,
  resolveConfig,
  toLinuxPath,
} from '../index.js'

let checks = 0
const check = (label, fn) => {
  fn()
  checks += 1
  console.log(`  ok  ${label}`)
}

// ── pure logic ──────────────────────────────────────────────────────────────
console.log('pure logic')

check('toLinuxPath maps a drive path', () => {
  assert.equal(toLinuxPath('C:\\Users\\me\\case'), '/mnt/c/Users/me/case')
  assert.equal(toLinuxPath('d:/cases/foo'), '/mnt/d/cases/foo')
  assert.equal(toLinuxPath('C:\\a b\\c'), '/mnt/c/a b/c')
})

check('toLinuxPath leaves Linux paths and rejects non-paths', () => {
  assert.equal(toLinuxPath('/home/me/run'), '/home/me/run')
  assert.equal(toLinuxPath('relative/dir'), undefined)
  assert.equal(toLinuxPath(''), undefined)
  assert.equal(toLinuxPath('   '), undefined)
  assert.equal(toLinuxPath(undefined), undefined)
  assert.equal(toLinuxPath(42), undefined)
})

check('bashPathWord expands ~ and quotes the rest', () => {
  assert.equal(bashPathWord('~/OpenFOAM/OpenFOAM-5.x/etc/bashrc'), '"$HOME"/\'OpenFOAM/OpenFOAM-5.x/etc/bashrc\'')
  assert.equal(bashPathWord('/opt/my foam/etc/bashrc'), "'/opt/my foam/etc/bashrc'")
  assert.equal(bashPathWord('~'), '"$HOME"')
})

check('bashPathWord survives a quote in the path', () => {
  // A single quote must be closed, escaped, and reopened — never emitted raw.
  assert.equal(bashPathWord("/opt/it's here/etc/bashrc"), `'/opt/it'\\''s here/etc/bashrc'`)
})

check('buildScript sources, then cd, then runs the command', () => {
  const script = buildScript({ bashrc: '~/of/etc/bashrc', workdir: '/mnt/c/case', command: 'blockMesh' })
  const lines = script.trimEnd().split('\n')
  assert.match(lines[0], /^__dsh_rc=/)
  assert.match(lines[1], /if \[ ! -r "\$__dsh_rc" \]/)
  assert.equal(lines[2], '. "$__dsh_rc"')
  assert.match(lines[3], /^cd /)
  assert.equal(lines[4], 'blockMesh')
})

check('buildScript omits cd when no workdir is given', () => {
  assert.equal(buildScript({ bashrc: undefined, workdir: undefined, command: 'ls' }), 'ls\n')
})

check('buildScript omits sourcing when no bashrc is given', () => {
  const first = buildScript({ bashrc: undefined, workdir: '/tmp', command: 'pwd' }).split('\n')[0]
  assert.match(first, /^cd /)
  assert.doesNotMatch(first, /__dsh_rc/)
})

check('resolveConfig defaults are stable and overridable', () => {
  const base = resolveConfig(undefined)
  assert.equal(base.defaultVersion, '5.x')
  assert.equal(base.distro, 'Ubuntu-24.04')
  assert.equal(base.workdir, undefined)
  assert.deepEqual(Object.keys(base.versions).sort(), ['5.x', 'v2012'])

  assert.equal(resolveConfig({ defaultVersion: 'v2012' }).defaultVersion, 'v2012')
  assert.equal(resolveConfig({ distro: 'Debian' }).distro, 'Debian')
  assert.equal(resolveConfig({ workdir: '  D:\\cases  ' }).workdir, 'D:\\cases')
  assert.equal(resolveConfig({ workdir: '   ' }).workdir, undefined)
  // A custom release map adds keys and keeps the defaults it does not name.
  const custom = resolveConfig({ versions: { v2312: '/opt/of/etc/bashrc' } })
  assert.equal(custom.versions.v2312, '/opt/of/etc/bashrc')
  assert.equal(custom.versions['5.x'], DEFAULT_VERSIONS['5.x'])
})

check('resolveConfig rejects an unknown defaultVersion', () => {
  assert.throws(() => resolveConfig({ defaultVersion: 'nope' }), /not one of/)
})

check('renderResult marks a non-zero exit and stderr', () => {
  const text = renderResult({
    exitCode: 1,
    timedOut: false,
    timeoutMs: 1000,
    stdout: { text: 'out', truncated: false },
    stderr: { text: 'boom', truncated: false },
  })
  assert.equal(text, 'out\n[stderr]\nboom\n[exit code: 1]')
})

check('renderResult reports a timeout and truncation', () => {
  const text = renderResult({
    exitCode: undefined,
    timedOut: true,
    timeoutMs: 4000,
    stdout: { text: 'partial', truncated: true, spillPath: '/tmp/spill' },
    stderr: { text: '', truncated: false },
  })
  assert.match(text, /\[output truncated; full output: \/tmp\/spill\]/)
  assert.match(text, /\[timed out after 4000ms\]/)
})

check('renderResult says so when there is no output', () => {
  const text = renderResult({
    timedOut: false,
    timeoutMs: 1000,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
  })
  assert.equal(text, '(no output)')
})

// ── WSL end-to-end ──────────────────────────────────────────────────────────
console.log('\nWSL end-to-end')

const wsl = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\wsl.exe`
const distro = process.env.WSL_OPENFOAM_DISTRO ?? resolveConfig(undefined).distro

/** Run one script in WSL exactly the way the tool does. */
function runInWsl(script) {
  return spawnSync(wsl, ['-d', distro, '--', 'bash', '-s'], {
    input: script,
    encoding: 'utf8',
    env: { ...process.env, WSL_UTF8: '1' },
  })
}

const reachable = spawnSync(wsl, ['-l', '-q'], { encoding: 'utf8' })
if (reachable.status !== 0) {
  console.log('  skipped: wsl.exe is not reachable from this process')
} else {
  // A synthetic release: portable, and it still exercises the real sourcing path.
  const stamp = Date.now().toString(36)
  const sandbox = `/tmp/dsh-wsl-openfoam-${stamp}`
  const syntheticRc = `${sandbox}/of/etc/bashrc`
  const marker = `synthetic-${stamp}`

  const setup = runInWsl([
    'set -e',
    `mkdir -p ${sandbox}/of/etc ${sandbox}/of/bin`,
    `cat > ${syntheticRc} <<'DSH_RC'`,
    `export WM_PROJECT_VERSION='${marker}'`,
    `export FOAM_APPBIN='${sandbox}/of/bin'`,
    `PATH="${sandbox}/of/bin:$PATH"`,
    `DSH_RC`,
    `printf '#!/bin/sh\\necho blockMesh-from-${marker}\\n' > ${sandbox}/of/bin/blockMesh`,
    `chmod +x ${sandbox}/of/bin/blockMesh`,
    `test -r ${syntheticRc}`,
    'echo ready',
  ].join('\n') + '\n')
  assert.equal(setup.status, 0, `synthetic release setup failed: ${setup.stderr}`)

  try {
    check('a synthetic release sources and exposes its binary', () => {
      const run = runInWsl(buildScript({
        bashrc: syntheticRc,
        workdir: undefined,
        command: 'echo "VER=$WM_PROJECT_VERSION"; blockMesh',
      }))
      assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr}`)
      assert.match(run.stdout, new RegExp(`VER=${marker}`), `wrong WM_PROJECT_VERSION in ${run.stdout}`)
      assert.match(run.stdout, /blockMesh-from-/, 'the sourced PATH did not reach the command')
    })

    check('quotes, newlines and heredocs survive stdin transport', () => {
      const run = runInWsl(buildScript({
        bashrc: undefined,
        workdir: undefined,
        command: [
          'echo "double \\"quoted\\" and \'single\'"',
          'cat <<EOF',
          'heredoc line 1',
          'heredoc line 2',
          'EOF',
        ].join('\n'),
      }))
      assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr}`)
      assert.match(run.stdout, /double "quoted" and 'single'/, `quoting corrupted: ${run.stdout}`)
      assert.match(run.stdout, /heredoc line 1\nheredoc line 2/, `heredoc corrupted: ${run.stdout}`)
    })

    check('a missing bashrc fails loudly instead of running the command', () => {
      const run = runInWsl(buildScript({
        bashrc: `${sandbox}/nope/etc/bashrc`,
        workdir: undefined,
        command: 'echo SHOULD_NOT_RUN',
      }))
      assert.equal(run.status, 127, 'a missing bashrc must exit 127')
      assert.doesNotMatch(run.stdout, /SHOULD_NOT_RUN/, 'the command ran despite the missing bashrc')
      assert.match(run.stderr, /bashrc not found/, 'the missing bashrc was not reported')
    })

    check('a workdir containing a space is entered correctly', () => {
      // The directory does not exist yet, so the cd must fail loudly.
      const missing = runInWsl(buildScript({
        bashrc: undefined,
        workdir: `${sandbox}/dir with space`,
        command: 'pwd',
      }))
      assert.equal(missing.status, 1, 'cd into a missing workdir must fail')
      assert.match(missing.stderr, /cannot enter workdir/)

      const made = runInWsl(`mkdir -p '${sandbox}/dir with space' && echo ok\n`)
      assert.equal(made.status, 0, `setup failed: ${made.stderr}`)
      const ok = runInWsl(buildScript({ bashrc: undefined, workdir: `${sandbox}/dir with space`, command: 'pwd' }))
      assert.equal(ok.status, 0, `cd failed: ${ok.stderr}`)
      assert.equal(ok.stdout.trim(), `${sandbox}/dir with space`)
    })

    check('a Windows drive path is translated and entered', () => {
      const drive = (process.env.SystemDrive ?? 'C:')[0]
      const run = runInWsl(buildScript({
        bashrc: undefined,
        workdir: toLinuxPath(`${drive}:\\`),
        command: 'pwd',
      }))
      assert.equal(run.status, 0, `cd failed: ${run.stderr}`)
      assert.equal(run.stdout.trim(), `/mnt/${drive.toLowerCase()}`)
    })

    check('the exit code reflects the last command', () => {
      assert.equal(runInWsl(buildScript({ bashrc: undefined, workdir: undefined, command: 'false' })).status, 1)
    })

    // Real releases: verified only when actually installed.
    const config = resolveConfig(undefined)
    for (const [version, bashrc] of Object.entries(DEFAULT_VERSIONS)) {
      const present = runInWsl(`[ -r ${bashPathWord(bashrc)} ] && echo yes || echo no\n`)
      if (present.stdout.trim() !== 'yes') {
        console.log(`  skip  ${version}: no OpenFOAM install at ${bashrc}`)
        continue
      }
      check(`${version} sources and exposes blockMesh`, () => {
        const run = runInWsl(buildScript({
          bashrc: config.versions[version],
          workdir: undefined,
          command: 'echo "VER=$WM_PROJECT_VERSION"; command -v blockMesh',
        }))
        assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr}`)
        assert.match(run.stdout, new RegExp(`VER=${version.replace('.', '\\.')}`), `wrong version in ${run.stdout}`)
        assert.match(run.stdout, /blockMesh/, `${version}: blockMesh not on PATH`)
      })
    }
  } finally {
    runInWsl(`rm -rf ${sandbox}\n`)
  }
}

console.log(`\n${checks} host checks passed`)
