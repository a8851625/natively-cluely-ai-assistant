/**
 * LOCAL-ONLY packaging config (not part of the app, safe to delete).
 *
 * The stock afterPack hook (scripts/after-pack.cjs) compiles two Swift helpers
 * into the .app — the Apple Speech bridge and the Parakeet ANE helper — and both
 * need a full Xcode 26 toolchain (`actool`, macOS 26 SDK). This machine has only
 * Command Line Tools 15.2, so those helpers cannot be built.
 *
 * Everything else in the package is unchanged: same files, same asarUnpack, same
 * ad-hoc signing. The cost is that Apple Speech STT and the Parakeet CoreML/ANE
 * backend are absent from this build; the local ONNX/sherpa models are
 * unaffected. See docs/TODO_LOCAL.md §3.
 */
const base = require('./package.json').build;
const adHocSign = require('./scripts/ad-hoc-sign.js');

module.exports = {
    ...base,
    afterPack: async (context) => {
        await (adHocSign.default || adHocSign)(context);
    },
};
