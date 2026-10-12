# dsh-wsl-openfoam

Run OpenFOAM inside WSL from any [DeepSeek Harness](https://github.com/deepseek-ai) session — plus a settings page to switch releases, check the environment, and set a default case directory.

[中文说明](#中文说明) · [Install](#install) · [Usage](#usage) · [How it works](#how-it-works)

---

## Why this plugin exists

The harness's own shell tools cannot reach WSL:

- `ops_bash` resolves a Git-bash and **explicitly rejects** `%SystemRoot%\System32\bash.exe` — that path is the WSL launcher, not a POSIX shell.
- Both the bash and pwsh executors run inside the Windows ACL sandbox runner, which denies the named pipes `wsl.exe` needs. A plain `wsl.exe` call from the pwsh tool fails with `Wsl/ACCESSDENIED`.

This plugin spawns `wsl.exe` through the host `ctx.subprocess` service, which runs outside that executor wrap — so it works in **every session, under every sandbox mode**.

## Features

| | |
| --- | --- |
| **`wsl_openfoam` tool** | Sources the requested OpenFOAM release, then runs your command. `blockMesh`, solvers, utilities, `foamDictionary`, post-processing — anything. |
| **Two releases, one switch** | `5.x` and `v2012` out of the box; add your own by mapping a name to an `etc/bashrc`. |
| **Environment probe** | Reports the WSL distro, kernel and user, and per release: is `etc/bashrc` readable, what is `WM_PROJECT_VERSION`, and which of `blockMesh` / `checkMesh` / `simpleFoam` / `foamDictionary` actually resolve. |
| **Test button** | Runs one real command through the same path the tool uses, so a broken environment is visible without starting a chat. |
| **Default case directory** | Set it once; calls that omit `workdir` use it. Leave it empty to fall back to the session workspace. |
| **Windows path translation** | Pass `D:\cases\cavity` or `/mnt/d/cases/cavity` — both work, everywhere. |
| **Byte-exact scripts** | Commands are piped to `bash -s` over **stdin**, so quotes, newlines, backslashes and heredocs are never re-parsed by the Windows command line. |

## Requirements

- Windows with WSL2 and at least one distribution (default: `Ubuntu-24.04`)
- OpenFOAM installed **inside** WSL — e.g. `~/OpenFOAM/OpenFOAM-5.x` and `~/OpenFOAM/OpenFOAM-v2012`
- DeepSeek Harness with the Web surface (the settings page needs it; the tool itself does not)

## Install

### From the plugin market

Search for **dsh-wsl-openfoam** in *Settings → Plugins → Market*.

### Manually

```powershell
# 1. Put the package in your profile
cd $env:USERPROFILE\.dsh\profiles\desktop
npm install <this-repo-or-tarball>      # or copy the folder into node_modules\

# 2. Register it — append to cordis.patch.yml
@'

- insert:
    - id: wsl-openfoam
      name: dsh-wsl-openfoam
- id: wsl-openfoam
  config:
    defaultVersion: 5.x
'@ | Add-Content cordis.patch.yml
```

Then **toggle the row off and on** once (see [Reloading](#reloading)) and refresh the page.

> **Why two rows?** The `insert` row mounts the plugin. The second, top-level row holds its config. The settings page saves through the official `configEditor`, which rewrites a row by matching a top-level `id` that carries no `insert` — an insert-carried config would be invisible to it and **every save would append a duplicate row**.

## Usage

Just ask, or call the tool directly:

```jsonc
{
  "command": "blockMesh && checkMesh",
  "version": "5.x",              // optional, default from config
  "workdir": "D:\\cases\\cavity" // optional, default from config, else session workspace
}
```

For a long solver run, background it yourself and poll the log — a foreground call is killed at `timeoutMs` (default 300 s):

```bash
nohup simpleFoam > log.simpleFoam 2>&1 &
```

### Configuration

All of it is editable from **Settings → WSL OpenFOAM**, or by hand in `cordis.patch.yml`:

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultVersion` | `5.x` | Release used when a call omits `version`. |
| `workdir` | *(unset)* | Directory used when a call omits `workdir`. Empty = session workspace. |
| `distro` | `Ubuntu-24.04` | WSL distribution to enter. |
| `versions` | `{ "5.x": "~/OpenFOAM/OpenFOAM-5.x/etc/bashrc", "v2012": "~/OpenFOAM/OpenFOAM-v2012/etc/bashrc" }` | Name → `etc/bashrc`. Add your own releases here. |

Example with a custom release:

```yaml
- id: wsl-openfoam
  config:
    defaultVersion: v2312
    workdir: D:\cases
    versions:
      v2312: ~/OpenFOAM/OpenFOAM-v2312/etc/bashrc
```

### Reloading

Config **values** hot-reload in about a second. **Code** does not: the host caches ES modules by URL, so HMR re-runs `apply` from the *old* module — you would see config changes apply while new code does nothing.

After editing `index.js` or `client.js`, toggle the insert row to force a fresh fiber:

```yaml
- insert:
    - id: wsl-openfoam
      name: dsh-wsl-openfoam
      disabled: true     # save, wait a moment…
```

then remove `disabled: true`, save, and refresh the page.

## How it works

```
┌─ DSH host ──────────────────────────────────────────────┐
│  index.js                                               │
│    ├── wsl_openfoam tool  ──┐                           │
│    ├── prompt section       │  ctx.subprocess           │
│    └── /api/wsl-openfoam/*  │  (outside the ACL wrap)   │
│         /config /probe /test│                           │
└─────────────────────────────┼───────────────────────────┘
                              ▼
                     wsl.exe -d <distro> -- bash -s
                              │  script on stdin
                              ▼
                     . <etc/bashrc> && cd <workdir> && <command>
```

The browser half (`client.js`) is a hand-written `window.__ModuleLoader__` bundle — no build step, no dependency beyond the `react` the shell already provides. It talks to the host half over the plugin's own same-origin routes, which run behind the same trust fence as the kernel's `/api` routes (loopback-only, no cross-site, `Origin`/`Referer` must match `Host`).

### Design notes worth knowing

- **stdin, not argv.** `wsl.exe` receives argv through the Windows command line, where a user command's backslashes and quotes get re-parsed. stdin is byte-exact.
- **`WSL_UTF8=1` is load-bearing.** Without it `wsl.exe` writes UTF-16LE to a pipe and every captured byte is interleaved with NULs.
- **A missing `bashrc` exits 127 loudly** rather than silently running against whatever OpenFOAM the login environment happened to have.
- **Each probe release is sourced in its own subshell**, so a broken one cannot poison the next.
- **The tool reads config from a live box**, not from a value captured at registration — otherwise a settings change would not reach an already-registered tool.

## Security

Commands run **inside WSL and are not constrained by the DSH file sandbox**. The Windows-side sandbox mode does not apply to this tool. That is the point of the plugin, but it is a real trust boundary: the tool has full access to the Linux side. Do not use it to bypass a denial the user has not approved.

The settings API is behind the kernel's trust fence: it prefers the composition's `connection` service for admission, and falls back to a structural check (loopback `Host` only, cross-site refused, `Origin`/`Referer` authority must match).

## Tests

```powershell
npm test
```

Four suites, 42 checks:

| Suite | Checks | Covers |
| --- | --- | --- |
| `test/host.test.mjs` | 20 | Path translation, script assembly, config resolution, rendering — plus real WSL end-to-end against a **synthetic** OpenFOAM release (portable: no OpenFOAM install needed), and against your real releases when present. |
| `test/api.test.mjs` | 13 | Config read/write validation, empty-workdir semantics, 503 without a config editor, probe script + parsing, test endpoint, 404, and three trust-fence rejections. |
| `test/workdir.test.mjs` | 4 | Default workdir reaches the script; explicit argument overrides it; session workspace fallback. |
| `test/client.test.mjs` | 5 | Bundle registration, export contract, slot + style registration, and headless render of both the loading and loaded states. |

The WSL suites skip themselves when `wsl.exe` is unreachable, and skip the real-release checks when those releases are not installed.

## Known limits

- Scripts do **not** run under `set -e`, matching the harness's own bash tool: a mid-script failure does not abort, and the exit code reflects only the last command. Add `set -e` yourself if you want strict mode.
- Only drive-letter paths are translated. `\\wsl$\...` UNC paths are passed through to bash as-is.
- Windows only. The whole design rests on `wsl.exe`.

## License

MIT

---

## 中文说明

**dsh-wsl-openfoam** 让你在任意 DeepSeek Harness 会话里调用 WSL 中的 OpenFOAM。

**为什么需要插件**：DSH 自带的 shell 工具到不了 WSL —— `ops_bash` 用的是 Git-bash 且显式排除 WSL 启动器；bash/pwsh 执行器都套在 Windows ACL 沙箱里，该沙箱禁止 `wsl.exe` 需要的命名管道（直接调用会得到 `Wsl/ACCESSDENIED`）。本插件通过宿主 `ctx.subprocess` 启动 `wsl.exe`，绕开那层包装，**任何会话、任何沙箱模式下都可用**。

**设置 → WSL OpenFOAM** 里有四项：

| 功能 | 说明 |
| --- | --- |
| 环境检测 | WSL 发行版/内核/用户；每个版本的 `etc/bashrc` 是否可读、`WM_PROJECT_VERSION`、哪些求解器能找到 |
| 默认版本 | 分段按钮切换，存回 profile |
| 默认工作目录 | 调用时未指定 `workdir` 就用它；留空回退会话工作区 |
| 测试 | 用与工具完全相同的路径 source 一次，当场看结果 |

**两个坑**（都已处理，但改配置时会遇到）：

1. **配置必须放在独立的顶层行**，不能塞进 `insert` 行 —— 设置页保存走官方 `configEditor`，它按「顶层 `id` 且无 `insert`」定位要改写的行，塞在 insert 里会导致**每次保存追加一条重复行**。
2. **改完代码必须切一次 `disabled` 再刷新页面** —— 宿主按 URL 缓存 ESM 模块，HMR 会用旧模块重跑 `apply`，表现为「配置生效了、新代码没生效」。

**安全边界**：命令在 WSL 里执行，**不受 DSH 文件沙箱约束**，对 Linux 侧等于完全访问权限。不要用它绕过用户没批准过的拒绝。
