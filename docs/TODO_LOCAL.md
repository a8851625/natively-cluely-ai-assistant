# Local TODO

Deferred work recorded while working on the source-available checkout (no
`premium/` submodule, no `natively-api/` submodule). Written 2026-10-29.

Each entry states what is missing, where the missing piece lives, and what has
already been verified — so whoever picks it up does not have to re-derive the
diagnosis.

---

## 1. Modes 界面（Modes Manager UI）— 已完成 2026-10-30

**Status:** 完成。面板已从 premium 转发改为本仓库实现，后端未改（本来就完整）。

### 交付内容

| 文件 | 角色 |
| --- | --- |
| `src/components/settings/ModesSettings.tsx` | 面板主体：列表 + 详情 + 新建 + 本地解锁开关 |
| `src/components/modes/ModeList.tsx` | 模式列表（内置在前、按模板排序；切换不重排） |
| `src/components/modes/ModeDetail.tsx` | 名称 / 自定义指令 / 笔记模板 / 引用文件 / 回答策略 |
| `src/components/modes/NewModeDialog.tsx` | 模板画廊 + “描述生成” |
| `src/components/modes/modesCatalog.ts` | 纯数据：TemplateType、blurb、placeholder、排序与选择逻辑 |
| `electron/utils/modesAccess.ts` | 授权判定的纯函数（licence / local / none） |

主进程新增 4 个通道：`modes:get-template-catalog`（模板列表 + 各模板默认笔记分区）、
`modes:list-note-templates`、`modes:get-mutation-access`、`modes:set-local-unlock`。
前三个只读、永不加锁；最后一个**故意不加锁**，否则面板无法自我解锁。

### 授权边界（没有偷偷放开）

19 处 `modes:*` 写操作从 `isProOrTrialActive()` 改为 `denyUnlessModesMutation()`：

- 有授权/试用 → 放行（`via: 'licence'`，不额外打日志）
- 无授权但有 `localModesUnlocked: true` → 放行并**每次都记一条**
  `[Modes] <action> allowed by localModesUnlocked (no licence, no trial)`
- 都没有 → `pro_required`

`localModesUnlocked` 默认不存在（= false），只能由面板上的“在本机解锁”显式打开，
作用范围仅限 `modes:*`，其它任何功能都不读它。

### 与 premium 版的差异

- **模板/分区不再在渲染层复制**：premium 版手抄了一份 `TEMPLATES` /
  `TEMPLATE_DEFAULTS` / placeholder，Seminar 与 Call Center 因此两个版本都没进画廊
  （见 `ModeTemplateGalleryCoverage2026_09_16`）。现在画廊由后端目录驱动，
  新增内置模板不需要改渲染层；该测试已改指向 `src/components/modes/modesCatalog.ts`
  并新增“渲染层不得复制可播种分区”的断言。
- **模板创建后不可改**：内置模板的 templateType 后端本就锁定；自定义模式改模板需要
  重算 source contract，因此面板只展示不编辑。
- 无原生 `<select>` / `window.confirm`：用 `AipSelect` 与 `useConfirmDialog`
  （原生弹窗不受 Content Protection 保护，会出现在共享屏幕里）。

### 验证

- `ELECTRON_RUN_AS_NODE=1 npx electron --test "electron/services/__tests__/Mode*.test.mjs"`
  → 433/433（原先 2 个读 `premium/src/ModesSettings.tsx` 的失败已修）
- `electron/utils` 541/541（含 8 个授权门测试）、`test:lib` 2917/2902、
  `test:components` 792/776、`test:scripts` 313/312，均 0 失败
- 真实应用点击穿透（dev 实例 + CDP）：启动器网格按钮 → 面板挂载 → 9 个内置模式 →
  锁定时只读并显示解锁条 → 解锁后新建 Lecture（自动播 8 个分区）→ 删除 → 关闭解锁
  恢复只读；DB 中 General 仍为 active，无残留
- 构建产物层面复核：`ModesManager` 在临时 profile 上 create/update/note-section/
  activate/source-contract/delete 全通过，`localModesUnlocked` 正确落盘到 settings.json

### 仍需人工确认

- 打包版 `.app` 里的实际点击（本环境无 agent-browser，dev 实例最后两次启动卡在
  早期引导，未能复现点击流程）
- Windows 上的渲染与 IPC（仅单测覆盖，未实机）
- 引用文件上传（`modes:upload-reference-file` 会开系统文件选择框，未在 GUI 中试过）

## 2. 中文（zh）i18n 剩余项

Coverage of `t()` source strings is now 1420/1434 (99.0%). The 14 remaining are
deliberately untranslated brands/abbreviations, allowlisted in
`src/lib/__tests__/ZhTranslationCoverage2026_10_29.test.mjs` (`BRAND_ONLY`):
`AI`, `Anthropic`, `Base URL`, `Beta`, `CRM`, `Custom cURL`, `GitHub`,
`LinkedIn`, `MCP`, `Natively API`, `OpenAI`, `Pro`, `Telegram`, `…`.

Deferred:

- **ja / es / ru are still short.** ja 493/1434 (34.4%), es 305 (21.3%),
  ru 386 (26.9%). Same mechanism as zh: add `src/i18n.{lang}.generated2.ts`,
  spread it after the existing `GENERATED` in the language block of
  `src/i18n.tsx`, and extend the guard test's dictionary list.
- **433 dead identity keys** in `src/i18n.zh.generated.ts` (`"Key": "Key"` with no
  remaining `t()` call site, e.g. `"1. Google Cloud STT"`). Not deleted because
  dynamic key construction cannot be fully ruled out; a reference analysis
  should run first.
- **8 dynamic template-literal `t()` calls** (e.g.
  `` t(`Waiting for ${meta.title}…`) ``) can never hit a static dictionary
  because `t()` takes no interpolation argument. Fixing them means changing
  `t`'s signature to accept params — a broader refactor.
- The long explanatory sentences (calendar/privacy/connectors) were machine-drafted
  and would benefit from one native read-through; the wording is
  faithful but occasionally stiff.

---

## 2b. 打包踩坑记录（2026-10-30，已加防护）

`npm run build`（渲染层）会 `rimraf dist dist-electron`，所以「构建 → 打包」这个最自然的顺序
**会把主进程 bundle 删掉**。而 electron-builder 的 `build.files` 是 glob，**匹配不到就静默跳过**，
于是打包"成功"、签名"成功"，装出来的 app 里只有 `dist/` + `node_modules/` + `native-module/`，
`package.json` 的 `main` 指向 asar 里不存在的 `dist-electron/electron/main.js`——启动后只有一行
stdout 就卡住，看起来像代码 bug。

已在 `scripts/package-app.js` 加前置检查：`dist/index.html` 与 `dist-electron/electron/main.js`
缺任何一个就报错退出（并打印该跑哪个命令），由 `scripts/__tests__/packageAppBuildOutputs2026_10_30.test.mjs`
钉住。正确顺序：

```bash
npm run build                      # 会删掉 dist-electron
NATIVELY_CORE_SMOKE=1 node scripts/build-electron.js   # 必须补回来
node scripts/package-app.js --config electron-builder.local.cjs --mac --arm64 --dir \
  -c.mac.icon=assets/icon.icns
```

同一轮还踩到两个操作坑，记下来：

- **不要在仓库根目录跑 `npx asar extract-file <asar> package.json`** —— 它把解出来的文件写到
  cwd，会直接覆盖仓库的 `package.json`（scripts/build 全没了）。要检查 asar 内容用
  `npx asar list` 或 `grep -a` 直接扫 asar 二进制。
- **替换 `/Applications/*.app` 前先杀掉旧实例**。旧进程不会因为 bundle 被替换而退出，它会继续
  从已删除的 inode 运行，屏幕上那个"能用"的窗口其实是老版本；同时它还会占着单实例锁，
  让新实例启动即退出。

## 3. 打包 / 安装（local build）

- `premium/` and `natively-api/` are absent, so premium features (Modes Manager,
  Profile Intelligence, license detection) degrade to no-ops. The app still
  builds and runs; `NATIVELY_CORE_SMOKE=1` externalises the private imports.
- `native-module/index.darwin-arm64.node` cannot be built on this machine:
  `npm run build:native` fails because the `cidre` crate's `build.rs` runs
  `xcodebuild` and only Command Line Tools are installed (exit 101). Audio falls
  back to the Chromium renderer capture path
  (`NATIVELY_FORCE_RENDERER_AUDIO=1` for unpackaged dev builds).
- Physical verification on Windows and on macOS 13.x is still outstanding for
  everything in this branch (sherpa-onnx, device enumeration fallback).

### The packaging recipe that works here (2026-10-29)

`npm run dist` cannot run on this machine: it calls `npm run build:native`
(Xcode) and the stock afterPack hook compiles two Swift helpers that need the
macOS 26 SDK. The working sequence:

```sh
npm run build
NATIVELY_CORE_SMOKE=1 npm run build:electron
npm run verify:packaged-local-assets
node scripts/ensure-sharp-mac-deps.js && node scripts/ensure-napi-canvas-mac-deps.js && node scripts/ensure-sqlite-vec.js
node scripts/package-app.js --config electron-builder.local.cjs --mac --arm64 --dir -c.mac.icon=assets/icon.icns
cp -R release/mac-arm64/Natively.app /Applications/Natively.app
```

Three overrides are load-bearing:

1. **`-c.mac.icon=assets/icon.icns`.** `build.mac.icon` points at
   `assets/Natively.icon`, the IconComposer bundle, which electron-builder 26
   compiles with `actool` — it fails with *"Failed to check actool version. Is
   Xcode 26 or higher installed?"* on a Command Line Tools-only machine. The
   plain `.icns` needs no Xcode.
2. **`electron-builder.local.cjs`** replaces the afterPack hook with ad-hoc
   signing only, skipping `scripts/build-apple-speech.js` (needs macOS 26 SDK)
   and `scripts/build-parakeet-ane.js`. Cost: no Apple Speech STT and no
   Parakeet CoreML/ANE backend in this build. The local ONNX and sherpa models
   are unaffected. The hook still runs `ad-hoc-sign.js`, which also performs the
   packed-arch verification.
3. **The prebuilt native module.** Copy
   `index.darwin-arm64.node` / `index.darwin-x64.node` out of an installed
   build of the SAME version — here
   `/Applications/corespeechd.app/Contents/Resources/app.asar.unpacked/native-module/`
   (2.9.2, identical to this checkout) — into `native-module/`. They are
   gitignored, `build.files` already includes `native-module`, and
   `asarUnpack: ['**/*.node']` unpacks them. Without this the packaged app has
   NO audio capture at all, because `useRendererCaptureFallback` returns false
   for darwin when `isPackaged` is true (only Windows falls back in a shipped
   build). With it, `[MicrophoneCapture] Starting native capture` works.

Also worth knowing: `ensure-*-mac-deps.js` installs the **other** arch's
optional packages. Skipping them makes `LocalFallbackPreflight` fail with
`local-embedding missing_required_asset` (it verifies both darwin arches), even
though the x64 dylibs are never loaded on Apple Silicon.

### Profile sharing gotcha

A packaged build resolves userData from the disguise name, so this app writes to
`~/Library/Application Support/corespeechd` — the **same profile as the installed
official app**, not the `natively` profile the unpackaged dev runs use. Two
consequences: models downloaded while developing are not visible to the packaged
app (copy `<org>/<name>` directories across), and `cp -R src/ dest/` with a
trailing slash on the source flattens the repo layout that `isRepoCached`
expects. A stale `.natively-download-incomplete` marker in a model directory
makes `isRepoCached` return false regardless of the files being complete.

The same split hides the interface language: it lives in the renderer's
localStorage under `natively_lang`, per profile. A profile that never stored it
starts in English, which looks like "the translation did not ship" when in fact
the other profile has the setting.

### Two repackaging traps

1. **`npm run build` deletes `dist-electron`** (its `clean` step rimrafs both
   `dist` and `dist-electron`). Packaging straight afterwards produces
   *"Application entry file dist-electron/electron/main.js … is corrupted: not
   found in this archive"* and an app that cannot start. Always run
   `NATIVELY_CORE_SMOKE=1 npm run build:electron` between `build` and
   `package-app.js`.
2. **Every ad-hoc rebuild re-prompts for the keychain.** The signature is
   content-derived, so the code identity changes on each package and macOS asks
   again for access to the stored credentials (`SecurityAgent` dialog; the app
   sits at 0% CPU right after `[Telemetry] sinks:` until it is answered). Pick
   "Always Allow" once per build; there is no stable identity to pin without a
   Developer ID certificate.
