# Local TODO

Deferred work recorded while working on the source-available checkout (no
`premium/` submodule, no `natively-api/` submodule). Written 2026-10-29.

Each entry states what is missing, where the missing piece lives, and what has
already been verified — so whoever picks it up does not have to re-derive the
diagnosis.

---

## 1. Modes 切换界面（Modes Manager UI）

**Status:** blocked on the private `premium/` submodule. Backend is complete.

### What exists (source-available, working today)

| File | Role |
| --- | --- |
| `electron/services/ModesManager.ts` (2033 lines) | CRUD, activation, built-in seeding, `<active_mode_custom_instructions>` prompt assembly (~line 1959/1988) |
| `electron/services/builtinModes.ts` | 9 built-in templates + the adoption rule (`planBuiltinAdoption`) |
| `electron/services/modeSourceContract.ts` (812) | per-mode source contract (what a mode may cite) |
| `electron/services/modes/ModeHybridRetriever.ts` (172 KB) | per-mode hybrid retrieval |
| `electron/services/modes/semanticChunker.ts`, `DocumentMap.ts`, `rerankPool.ts` | retrieval support |
| `electron/services/ModeGenerator.ts` (378), `ModeReferenceFileIngestion.ts`, `ModeContextRetriever.ts` | generate-from-brief, reference-file ingestion |
| `electron/llm/modeProfiles.ts` (188) | mode as a **routing prior** for ambiguous answer types |
| `electron/llm/customModeExecutionContract.ts` (849), `modeHybridEligibility.ts` | custom-mode execution |
| `electron/ipcHandlers.ts:18998-19960` | 20+ `modes:*` IPC channels |

Built-in templates: `general`, `sales`, `recruiting`, `team-meet`,
`looking-for-work`, `technical-interview`, `lecture`, `seminar`,
`call-center`.

Verified against the local profile database (`~/Library/Application Support/natively/natively.db`,
`modes` table): all 9 built-ins are already seeded, `mode_general_default` is the
active row, plus one reserved `__profile_okf__` row for Profile Intelligence.

### What is missing

1. **The UI.** `src/components/settings/ModesSettings.tsx` is an 11-line
   forwarding stub:

   ```ts
   export { ModesSettings as default } from '../../premium';
   ```

   The real component is `premium/src/ModesSettings.tsx`, which does not exist in
   this checkout. `src/premium/index.tsx:91` therefore falls back to
   `NullComponent`.

   Consequence: the launcher's grid button
   (`src/components/Launcher.tsx:788`, `data-testid="open-modes-manager"`) opens
   the 820×600 manager shell (`src/App.tsx:1466-1512`, `GenomeModal`,
   `data-testid="manager-panel-modes"`) and renders an **empty card**. The user
   has already dismissed the onboarding pill (`seenModesOnboarding: true` in
   `settings.json`), so this is the state they hit.

2. **The licence predicate.** `isProOrTrialActive()` (`electron/ipcHandlers.ts:1044`)
   starts with `require('../premium/electron/services/LicenseManager')`, which
   resolves to the absent `premium/` directory, throws, and is swallowed by the
   `catch`. Only the free-trial token path can return true. So in a
   source-available build:

   - `modes:set-active` refuses every non-`general` mode with `pro_required`
     (`electron/ipcHandlers.ts:19314`).
   - `modes:create`, `modes:delete`, `modes:update`,
     `modes:upload-reference-file`, `modes:apply-note-template`,
     `modes:add/update/delete-note-section`, `modes:remove-all-note-sections`
     are all gated the same way.

   `modes:get-all`, `modes:get-active`, `modes:get-source-contract`,
   `modes:get-reference-files`, `modes:get-note-sections` are **not** gated.

### Decision needed before implementing

Do not silently weaken the licence gate — it is a commercial boundary, not a bug.
Pick one:

- **A.** Restore the submodule and ship the premium panel (correct, needs repo
  access; `git submodule update --init` currently fails with *repository not
  found* for both `natively-premium.git` and `natively-api.git`).
- **B.** Write a source-available Modes panel against the existing IPC, plus an
  explicit local unlock (e.g. `localModesUnlocked` in `settings.json`) that a
  developer opts into. The gate stays in place for everyone else.
- **C.** Ship switching only (no management): a dropdown of the 9 built-ins on
  the launcher button. Non-Pro entries render locked, pointing at the plans tab
  — the same pattern `notesTemplateGate.ts` already uses for "Regenerate as".

**Recommended:** C + the opt-in local unlock from B. Smallest surface, keeps the
gate honest, immediately testable.

### Where to wire it

- `src/components/settings/ModesSettings.tsx` — replace the premium forward with
  the real component, or keep the forward and add a source-available fallback.
- `src/App.tsx:1504` — the `activeManagerPanel === 'modes'` branch is the mount
  point; it already passes `isPremium`, `isLoaded`, `isTrialActive`,
  `onOpenNativelyAPI`.
- `src/types/electron.d.ts:503-540` — the full typed IPC surface already exists
  (`modesGetAll`, `modesSetActive`, `modesCreate`, `modesUpdate`,
  `modesGetSourceContract`, `modesGetNoteSections`, …). No preload work needed.
- `NativelyInterface.tsx:2245` already renders the **active mode name badge** and
  subscribes to `onModeChanged` (which also cancels in-flight chat streams on a
  switch). So the read side of a switcher is already in place.

### Testing notes

- `npm run test:modes` / `test:modes:no-build` run
  `electron/services/__tests__/Mode*.test.mjs`,
  `ProfileIntelligenceGate.test.mjs`, `NativelyApiE2E.test.mjs`.
- `electron/intelligence/__tests__/baseline/ModeBoundaryBaseline.test.mjs` pins
  the mode→answer-type boundary.
- `electron/llm/__tests__/ModeProfiles.test.mjs` and
  `ModePolicyShadowDivergence2026_07_26.test.mjs` cover the routing prior.
- GUI click-through requires the launcher window; `agent-browser` is not
  installed in this environment, so verification was programmatic only.

---

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
