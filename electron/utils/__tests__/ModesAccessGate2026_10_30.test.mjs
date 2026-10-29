// The licence gate over the modes:* IPC surface, and the one channel that must
// stay outside it.
//
// History this pins: every mutating modes:* handler gated on isProOrTrialActive(),
// which on a source-available build can only pass through a live trial token (the
// LicenseManager it tries first lives in the absent premium/ submodule, so the
// require throws straight into the catch). The whole Modes backend ships here, but
// not one non-general mode could be activated. The gate now goes through
// denyUnlessModesMutation(), which additionally honours the default-OFF
// `localModesUnlocked` opt-in — and modes:set-local-unlock has to be reachable
// while everything else is still refused, or the panel could never unlock itself.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.resolve(repoRoot, p), 'utf8');

const ipc = read('electron/ipcHandlers.ts');
const preload = read('electron/preload.ts');

/** The modes:* handler region of ipcHandlers.ts. */
function modesRegion() {
  const start = ipc.indexOf("safeHandle('modes:get-all'");
  const end = ipc.indexOf('// Phone Mirror — stream live AI responses', start);
  assert.ok(start > 0 && end > start, 'could not locate the modes handler region');
  return ipc.slice(start, end);
}

/**
 * Source of one `safeHandle('channel', ...)` handler. Handlers are written both
 * as `safeHandle('x', ...)` and across lines as `safeHandle(\n  'x', ...)`, so
 * split on the call sites and take the chunk that names the channel.
 */
function handlerSource(region, channel) {
  const chunks = region.split(/(?=\n\s*safeHandle\()/);
  const chunk = chunks.find((c) => c.includes(`'${channel}'`));
  assert.ok(chunk, `handler not found: ${channel}`);
  return chunk;
}

const MUTATING = [
  'modes:create',
  'modes:generate-from-brief',
  'modes:update',
  'modes:delete',
  'modes:set-active',
  'modes:upload-reference-file',
  'modes:delete-reference-file',
  'modes:add-note-section',
  'modes:update-note-section',
  'modes:delete-note-section',
  'modes:apply-note-template',
  'modes:remove-all-note-sections',
  'modes:build-user-source-contract',
];

const READ_ONLY = [
  'modes:get-all',
  'modes:get-active',
  'modes:get-source-contract',
  'modes:get-reference-files',
  'modes:get-note-sections',
  'modes:get-default-note-sections',
  'modes:get-reference-file-status',
  'modes:get-template-catalog',
  'modes:list-note-templates',
  'modes:get-mutation-access',
];

describe('modes:* licence gate', () => {
  test('no modes handler still GATES on the raw licence predicate', () => {
    const region = modesRegion();
    // Reporting the licence state is fine (modes:get-mutation-access does);
    // refusing on it directly is what the helper replaced.
    assert.equal((region.match(/!isProOrTrialActive\(\)/g) ?? []).length, 0,
      'every modes gate must go through denyUnlessModesMutation()');
    assert.ok(region.includes('denyUnlessModesMutation('), 'the gate helper must be used');
  });

  test('every mutating channel consults the gate', () => {
    const region = modesRegion();
    for (const channel of MUTATING) {
      assert.ok(handlerSource(region, channel).includes('denyUnlessModesMutation('),
        `${channel} must be gated`);
    }
  });

  test('every read-only channel stays ungated (the panel must render on a locked build)', () => {
    const region = modesRegion();
    for (const channel of READ_ONLY) {
      assert.ok(!handlerSource(region, channel).includes('denyUnlessModesMutation('),
        `${channel} must stay readable so the panel can explain the state`);
    }
  });

  test('modes:set-local-unlock is itself ungated — or the panel could never unlock', () => {
    const region = modesRegion();
    const src = handlerSource(region, 'modes:set-local-unlock');
    assert.ok(!src.includes('denyUnlessModesMutation('), 'the opt-in channel must not require the opt-in');
    assert.ok(src.includes('isModesMutationAllowed()'), 'it reports the resulting access state');
  });

  test('the opt-in persists through SettingsManager and is logged loudly', () => {
    const region = modesRegion();
    const src = handlerSource(region, 'modes:set-local-unlock');
    assert.ok(src.includes('LOCAL_MODES_UNLOCK_SETTING'), 'uses the shared key constant');
    assert.ok(/console\.log\(`\[Modes\] localModesUnlocked = \$\{value\}/.test(src), 'writes a log line');
  });

  test('allowing a gated action through the opt-in is logged every time', () => {
    assert.ok(/\[Modes\] \$\{action\} allowed by localModesUnlocked/.test(ipc),
      'the local path must leave an audit line; a licence is silent');
  });

  test('the four panel-support channels are exposed through preload', () => {
    for (const method of ['modesGetTemplateCatalog', 'modesListNoteTemplates', 'modesGetMutationAccess', 'modesSetLocalUnlock']) {
      assert.ok(preload.includes(`${method}:`), `${method} missing from the preload types`);
      assert.ok(preload.includes(`${method}: (`) || preload.includes(`${method}: ()`), `${method} has no implementation`);
    }
    for (const channel of ['modes:get-template-catalog', 'modes:list-note-templates', 'modes:get-mutation-access', 'modes:set-local-unlock']) {
      assert.ok(preload.includes(`'${channel}'`), `${channel} is not invoked by preload`);
    }
  });

  test('the template catalog comes from the backend, not a second hand-written list', () => {
    const src = handlerSource(modesRegion(), 'modes:get-template-catalog');
    assert.ok(src.includes('BUILTIN_MODE_LABELS'), 'labels come from builtinModes.ts');
    assert.ok(src.includes('TEMPLATE_NOTE_SECTIONS'), 'seeded sections come from ModesManager.ts');
  });
});
