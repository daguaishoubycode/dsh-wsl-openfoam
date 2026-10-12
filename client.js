/**
 * WSL + OpenFOAM bridge — browser half.
 *
 * Contributes one settings section (`settings.section`, id `wsl-openfoam`):
 *   1. the default OpenFOAM release, switched with a click;
 *   2. a live environment report — the WSL distro, and per release whether its
 *      `etc/bashrc` is readable and which binaries actually resolve;
 *   3. a default working directory, used when a call passes no `workdir`;
 *   4. a "test" button that runs one real command through the same path the
 *      tool uses, so a broken environment is visible without starting a chat.
 *
 * The browser half talks to the host half over the plugin's own same-origin
 * `/api/wsl-openfoam/*` routes. That is the established route for a *static*
 * client half: `host.call` belongs to the dynamic `cordis_run` runtime and is
 * not available to a package-owned bundle like this one.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. Every colour is a theme variable, so the
 * page survives a light/dark switch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-wsl-openfoam',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useRef } = React

    /** Document-relative so the desktop app's mount prefix is preserved. */
    const API = (() => {
      try { return new URL('api/wsl-openfoam', document.baseURI).pathname } catch { return '/api/wsl-openfoam' }
    })()

    const CSS = `
.wof_page { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 8px; }
.wof_head { display: flex; flex-direction: column; gap: 6px; }
.wof_title { font-size: 20px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.wof_sub { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.wof_card {
  display: flex; flex-direction: column; gap: 12px;
  padding: 16px 18px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
}
.wof_cardTitle { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.wof_hint { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.wof_seg {
  display: inline-flex; gap: 4px; padding: 4px; align-self: flex-start;
  border-radius: 10px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
}
.wof_segBtn {
  min-width: 88px; padding: 7px 16px; border: 0; border-radius: 7px; cursor: pointer;
  font-size: 13px; font-weight: 500; font-family: inherit;
  background: transparent; color: var(--dsw-alias-label-secondary);
  transition: background .12s ease, color .12s ease;
}
.wof_segBtn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.wof_segBtn:disabled { cursor: default; opacity: .6; }
.wof_segBtnOn { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 2px rgba(0,0,0,.10); }
.wof_meta { display: flex; flex-direction: column; gap: 5px; }
.wof_metaRow { display: flex; gap: 10px; align-items: baseline; font-size: 12px; }
.wof_metaKey { flex: 0 0 74px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.wof_metaVal { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.wof_status { font-size: 12px; min-height: 16px; }
.wof_ok { color: var(--dsw-alias-state-success-primary); }
.wof_err { color: var(--dsw-alias-state-error-primary); }
.wof_warn { color: var(--dsw-alias-state-warn-primary); }
.wof_idle { color: var(--dsw-alias-state-idle-primary); }
.wof_skeleton { height: 44px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.wof_inputRow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.wof_input {
  flex: 1 1 320px; min-width: 200px; padding: 8px 10px; border-radius: 8px;
  font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
}
.wof_input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.wof_btn {
  padding: 7px 14px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500;
  font-family: inherit; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
}
.wof_btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.wof_btn:disabled { cursor: default; opacity: .6; }
.wof_btnPrimary { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); border-color: transparent; }
.wof_vcard {
  display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
}
.wof_vhead { display: flex; gap: 8px; align-items: center; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.wof_dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; }
.wof_dotOk { background: var(--dsw-alias-state-success-primary); }
.wof_dotBad { background: var(--dsw-alias-state-error-primary); }
.wof_dotIdle { background: var(--dsw-alias-state-idle-primary); }
.wof_chips { display: flex; gap: 6px; flex-wrap: wrap; }
.wof_chip {
  padding: 3px 9px; border-radius: 999px; font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1);
}
.wof_chipOn { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.wof_chipOff { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.wof_pre {
  margin: 0; padding: 10px 12px; border-radius: 8px; overflow-x: auto;
  font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1);
}
`

    /** One JSON request with a bounded timeout, so a hung route cannot wedge the page. */
    async function request(path, options) {
      const controller = new AbortController()
      // The probe and the test both shell out to WSL, so they get a longer budget.
      const slow = path === '/probe' || path === '/test'
      const timer = setTimeout(() => controller.abort(), slow ? 75_000 : 10_000)
      try {
        const response = await fetch(API + path, {
          ...options,
          signal: controller.signal,
          headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
        })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    /** A one-line status message under a control. */
    function Status({ state }) {
      if (state === undefined || state === null) return h('div', { className: 'wof_status wof_idle' }, '')
      return h('div', { className: `wof_status wof_${state.tone ?? 'idle'}` }, state.text)
    }

    /** One release's live report card. */
    function VersionCard({ version, isDefault, onMakeDefault, busy }) {
      const usable = version.rcExists === true && (version.solvers ?? []).length > 0
      return h('div', { className: 'wof_vcard' },
        h('div', { className: 'wof_vhead' },
          h('span', { className: `wof_dot ${version.rcExists === undefined ? 'wof_dotIdle' : usable ? 'wof_dotOk' : 'wof_dotBad'}` }),
          h('span', null, version.name),
          isDefault ? h('span', { className: 'wof_chip wof_chipOn' }, '默认') : null,
          !isDefault && usable ? h('button', {
            className: 'wof_btn', disabled: busy, type: 'button',
            onClick: () => onMakeDefault(version.name),
          }, '设为默认') : null),
        h('div', { className: 'wof_meta' },
          h('div', { className: 'wof_metaRow' },
            h('span', { className: 'wof_metaKey' }, 'bashrc'),
            h('span', { className: 'wof_metaVal' },
              version.rcExists === undefined
                ? '检测中…'
                : version.rcExists ? version.rcPath : `${version.rcPath ?? '?'}  (不存在)`))),
        (version.solvers ?? []).length > 0 || version.rcExists === false ? null : h('div', { className: 'wof_hint' }, '未发现可执行文件。'),
        h('div', { className: 'wof_chips' },
          (version.solvers ?? []).length === 0
            ? h('span', { className: `wof_chip ${version.rcExists === false ? 'wof_chipOff' : ''}` }, version.rcExists === false ? '不可用' : '…')
            : version.solvers.map(name => h('span', { key: name, className: 'wof_chip wof_chipOn' }, name))),
        version.wmVersion !== '' && version.wmVersion !== undefined
          ? h('div', { className: 'wof_metaRow' },
            h('span', { className: 'wof_metaKey' }, 'WM_VERSION'),
            h('span', { className: 'wof_metaVal' }, version.wmVersion))
          : null)
    }

    function SettingsPage() {
      const [config, setConfig] = useState(undefined)
      const [failed, setFailed] = useState(false)
      const [busy, setBusy] = useState(false)
      const [status, setStatus] = useState(undefined)

      const [probe, setProbe] = useState(undefined)
      const [probing, setProbing] = useState(false)
      const [probeError, setProbeError] = useState(undefined)

      const [workdirDraft, setWorkdirDraft] = useState(undefined)
      const [workdirStatus, setWorkdirStatus] = useState(undefined)

      const [test, setTest] = useState(undefined)
      const [testing, setTesting] = useState(false)

      const load = useCallback(() => {
        setFailed(false)
        request('/config')
          .then(next => { setConfig(next); setWorkdirDraft(next.workdir ?? '') })
          .catch(() => setFailed(true))
      }, [])

      useEffect(() => { load() }, [load])

      const runProbe = useCallback(() => {
        setProbing(true)
        setProbeError(undefined)
        request('/probe')
          .then(setProbe)
          .catch(error => setProbeError(String(error?.message ?? error)))
          .finally(() => setProbing(false))
      }, [])

      // Probe on mount: the page's whole point is showing real state.
      const probedOnce = useRef(false)
      useEffect(() => {
        if (probedOnce.current) return
        probedOnce.current = true
        runProbe()
      }, [runProbe])

      const save = useCallback(async patch => {
        setBusy(true)
        setStatus(undefined)
        try {
          const next = await request('/config', { method: 'POST', body: JSON.stringify(patch) })
          setConfig(next)
          return next
        } finally {
          setBusy(false)
        }
      }, [])

      const choose = useCallback(async version => {
        if (busy || config === undefined || version === config.defaultVersion) return
        const previous = config.defaultVersion
        setConfig({ ...config, defaultVersion: version })
        try {
          await save({ defaultVersion: version })
          setStatus({ tone: 'ok', text: `默认版本已切换为 ${version}，已保存。` })
        } catch (error) {
          setConfig(current => ({ ...current, defaultVersion: previous }))
          setStatus({ tone: 'err', text: `保存失败：${String(error?.message ?? error)}` })
        }
      }, [busy, config, save])

      const saveWorkdir = useCallback(async () => {
        if (config === undefined) return
        const next = (workdirDraft ?? '').trim()
        setWorkdirStatus(undefined)
        try {
          const saved = await save({ workdir: next })
          setWorkdirDraft(saved.workdir ?? '')
          setWorkdirStatus({ tone: 'ok', text: next === '' ? '已清空：将回退到会话工作区。' : `已保存：${saved.workdir}` })
        } catch (error) {
          setWorkdirStatus({ tone: 'err', text: `保存失败：${String(error?.message ?? error)}` })
        }
      }, [config, save, workdirDraft])

      const runTest = useCallback(() => {
        setTesting(true)
        setTest(undefined)
        request('/test', { method: 'POST', body: JSON.stringify({}) })
          .then(setTest)
          .catch(error => setTest({ ok: false, stdout: '', stderr: String(error?.message ?? error) }))
          .finally(() => setTesting(false))
      }, [])

      if (failed) {
        return h('div', { className: 'wof_page' },
          h('div', { className: 'wof_head' },
            h('div', { className: 'wof_title' }, 'WSL OpenFOAM'),
            h('div', { className: 'wof_sub' }, '无法连接插件后端。')),
          h('div', { className: 'wof_card' },
            h('button', { className: 'wof_btn wof_btnPrimary', onClick: load }, '重试')))
      }

      if (config === undefined) {
        return h('div', { className: 'wof_page' },
          h('div', { className: 'wof_head' },
            h('div', { className: 'wof_title' }, 'WSL OpenFOAM'),
            h('div', { className: 'wof_sub' }, '正在加载…')),
          h('div', { className: 'wof_skeleton' }))
      }

      const versions = Object.entries(config.versions ?? {})
      const probed = probe?.versions ?? []
      const byName = new Map(probed.map(v => [v.name, v]))
      const rows = versions.map(([name, rc]) => byName.get(name) ?? { name, rcPath: rc, rcExists: undefined, solvers: [] })
      const allOk = probed.length > 0 && probed.every(v => v.rcExists && (v.solvers ?? []).length > 0)

      return h('div', { className: 'wof_page' },
        h('div', { className: 'wof_head' },
          h('div', { className: 'wof_title' }, 'WSL OpenFOAM'),
          h('div', { className: 'wof_sub' },
            '在 WSL 里运行 OpenFOAM。改完立即生效，无需重启；会话中也可以用 '
            + 'wsl_openfoam 的 version 参数临时指定另一个版本。')),

        // ── environment ───────────────────────────────────────────────────
        h('div', { className: 'wof_card' },
          h('div', { className: 'wof_inputRow' },
            h('span', { className: 'wof_cardTitle' }, '环境检测'),
            h('button', {
              className: 'wof_btn', type: 'button', disabled: probing, onClick: runProbe,
            }, probing ? '检测中…' : '重新检测')),
          probe === undefined && probing
            ? h('div', { className: 'wof_skeleton' })
            : probeError !== undefined
              ? h('div', { className: 'wof_hint wof_err' }, `检测失败：${probeError}`)
              : probe === undefined
                ? h('div', { className: 'wof_hint' }, '尚未检测。')
                : h('div', { className: 'wof_meta' },
                  h('div', { className: 'wof_metaRow' },
                    h('span', { className: 'wof_metaKey' }, '发行版'),
                    h('span', { className: 'wof_metaVal' }, `${probe.distro || config.distro}`)),
                  probe.kernel ? h('div', { className: 'wof_metaRow' },
                    h('span', { className: 'wof_metaKey' }, '内核'),
                    h('span', { className: 'wof_metaVal' }, probe.kernel)) : null,
                  probe.user ? h('div', { className: 'wof_metaRow' },
                    h('span', { className: 'wof_metaKey' }, '用户'),
                    h('span', { className: 'wof_metaVal' }, probe.user)) : null),
          probe === undefined ? null : h('div', { className: 'wof_chips' },
            h('span', { className: `wof_chip ${allOk ? 'wof_chipOn' : 'wof_chipOff'}` },
              allOk ? '全部可用' : '存在问题')),
          probe?.timedOut ? h('div', { className: 'wof_hint wof_warn' }, '检测超时，结果可能不完整。') : null,
          probe?.stderr ? h('pre', { className: 'wof_pre' }, probe.stderr) : null),

        // ── versions ──────────────────────────────────────────────────────
        h('div', { className: 'wof_card' },
          h('div', { className: 'wof_cardTitle' }, '默认版本'),
          h('div', { className: 'wof_seg' },
            versions.map(([name]) => h('button', {
              key: name,
              type: 'button',
              disabled: busy,
              'aria-pressed': name === config.defaultVersion,
              className: 'wof_segBtn' + (name === config.defaultVersion ? ' wof_segBtnOn' : ''),
              onClick: () => { void choose(name) },
            }, name))),
          h('div', { className: 'wof_hint' },
            `省略 version 参数时使用 ${config.defaultVersion}。`),
          h('div', { className: 'wof_meta' },
            rows.map(v => h(VersionCard, {
              key: v.name,
              version: v,
              isDefault: v.name === config.defaultVersion,
              busy,
              onMakeDefault: name => { void choose(name) },
            }))),
          h(Status, { state: status })),

        // ── default workdir ───────────────────────────────────────────────
        h('div', { className: 'wof_card' },
          h('div', { className: 'wof_cardTitle' }, '默认工作目录'),
          h('div', { className: 'wof_hint' },
            '调用 wsl_openfoam 时若未指定 workdir，就用这里。留空则回退到会话工作区。'),
          h('div', { className: 'wof_inputRow' },
            h('input', {
              className: 'wof_input',
              type: 'text',
              value: workdirDraft ?? '',
              spellCheck: false,
              placeholder: 'D:\\cases\\cavity  或  /home/me/OpenFOAM/run',
              onChange: event => { setWorkdirDraft(event.target.value); setWorkdirStatus(undefined) },
              onKeyDown: event => { if (event.key === 'Enter') { void saveWorkdir() } },
            }),
            h('button', {
              className: 'wof_btn wof_btnPrimary', type: 'button', disabled: busy,
              onClick: () => { void saveWorkdir() },
            }, busy ? '保存中…' : '保存')),
          config.workdir
            ? h('div', { className: 'wof_metaRow' },
              h('span', { className: 'wof_metaKey' }, '当前'),
              h('span', { className: 'wof_metaVal' },
                config.workdirLinux && config.workdirLinux !== config.workdir
                  ? `${config.workdir}  →  ${config.workdirLinux}`
                  : config.workdir))
            : h('div', { className: 'wof_hint' }, '当前：未设置（回退到会话工作区）'),
          h(Status, { state: workdirStatus })),

        // ── test ──────────────────────────────────────────────────────────
        h('div', { className: 'wof_card' },
          h('div', { className: 'wof_inputRow' },
            h('span', { className: 'wof_cardTitle' }, '测试'),
            h('button', {
              className: 'wof_btn wof_btnPrimary', type: 'button', disabled: testing, onClick: runTest,
            }, testing ? '测试中…' : `测试 ${config.defaultVersion}`)),
          h('div', { className: 'wof_hint' },
            '走与工具完全相同的路径 source 一次并查找 blockMesh / simpleFoam。'),
          test === undefined ? null : h('div', null,
            h('div', { className: `wof_status wof_${test.ok ? 'ok' : 'err'}` },
              test.ok ? `成功（exit 0）` : `失败${test.timedOut ? '：超时' : test.exitCode === undefined ? '' : `（exit ${test.exitCode}）`}`),
            test.stdout ? h('pre', { className: 'wof_pre' }, test.stdout.trim()) : null,
            test.stderr ? h('pre', { className: 'wof_pre' }, test.stderr.trim()) : null)))
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-wsl-openfoam')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'wsl-openfoam: styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'wsl-openfoam',
        order: 36,
        label: 'WSL OpenFOAM',
      }, () => h(SettingsPage)))
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.name = 'wsl-openfoam'
    return module.exports
  },
})
