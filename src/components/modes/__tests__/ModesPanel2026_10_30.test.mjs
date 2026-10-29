// The Modes Manager panel: pure logic + the wiring that cannot be unit-tested
// through the DOM in this environment.
//
// The panel replaced a four-line forward to the (absent) premium/ submodule, so
// what is pinned here is:
//   * the access matrix — a licence, the local opt-in, or nothing;
//   * list ordering and post-delete selection (a list that reorders itself when
//     you switch modes moves the row you just clicked away from the cursor);
//   * the gallery's description fallbacks for a template the renderer has never
//     seen (the backend is the source of truth for which templates exist);
//   * that the panel reads the authoritative access state over IPC instead of
//     trusting the isPremium prop it is handed, and that a locked build renders
//     read-only without offering a way past its own gate,
//   * and that every mutating call goes through preload (no direct ipc).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const read = (p) => fs.readFileSync(path.resolve(repoRoot, p), 'utf8');

const load = async (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);

const { modesMutationAccess, resolveLocalModesUnlock, LOCAL_MODES_UNLOCK_SETTING } =
    await load('electron/utils/modesAccess.ts');
const catalog = await load('src/components/modes/modesCatalog.ts');

describe('modesMutationAccess: licence, local opt-in, or nothing', () => {
    test('a licence allows it, and says so', () => {
        assert.deepEqual(
            modesMutationAccess({ licenceActive: true, localUnlocked: false }),
            { allowed: true, via: 'licence' },
        );
    });

    test('the licence wins over the local opt-in (the log line stays honest)', () => {
        assert.deepEqual(
            modesMutationAccess({ licenceActive: true, localUnlocked: true }),
            { allowed: true, via: 'licence' },
        );
    });

    test('the local opt-in allows it on a build with no licence', () => {
        assert.deepEqual(
            modesMutationAccess({ licenceActive: false, localUnlocked: true }),
            { allowed: true, via: 'local' },
        );
    });

    test('neither → refused, and nothing is unlocked by accident', () => {
        assert.deepEqual(
            modesMutationAccess({ licenceActive: false, localUnlocked: false }),
            { allowed: false, via: 'none' },
        );
    });

    // The default matters more than the matrix. A build with no premium module has
    // no licence to obtain and no LicenseManager to ask, so the pro_required branch
    // can never be satisfied there: gating would leave a feature that is already on
    // disk permanently unreachable. A build that DOES ship premium keeps the rule,
    // otherwise every real user would get the feature for free.
    test('no premium module in the build → always editable', () => {
        assert.equal(resolveLocalModesUnlock({ stored: undefined, premiumAvailable: false }), true);
        // A stored `false` must NOT re-lock it: with no premium module there is no
        // licence to obtain, so "off" would only recreate a permanently dead
        // feature — the exact complaint that produced this rule.
        assert.equal(resolveLocalModesUnlock({ stored: false, premiumAvailable: false }), true);
    });

    test('premium shipped but unlicensed → locked, exactly as before', () => {
        assert.equal(resolveLocalModesUnlock({ stored: undefined, premiumAvailable: true }), false);
        // Junk in the file must not silently unlock anything either.
        assert.equal(resolveLocalModesUnlock({ stored: 'yes', premiumAvailable: true }), false);
        assert.equal(resolveLocalModesUnlock({ stored: null, premiumAvailable: true }), false);
    });

    test('the stored opt-in is the escape hatch for a self-built premium copy', () => {
        assert.equal(resolveLocalModesUnlock({ stored: true, premiumAvailable: true }), true);
    });

    test('the setting key is spelled once', () => {
        assert.equal(LOCAL_MODES_UNLOCK_SETTING, 'localModesUnlocked');
        const ipc = read('electron/ipcHandlers.ts');
        // Any other spelling of the key in the main process would be a second
        // source of truth for the opt-in.
        const keyLiterals = (ipc.match(/'localModesUnlocked'/g) ?? []).length;
        assert.ok(keyLiterals <= 1, `expected at most one literal (the constant's import), found ${keyLiterals}`);
        assert.ok(ipc.includes('LOCAL_MODES_UNLOCK_SETTING'), 'ipcHandlers must use the shared constant');
    });
});

describe('orderModes', () => {
    const mk = (id, templateType, createdAt, name = id) => ({
        id, name, templateType, createdAt, referenceFileCount: 0,
    });

    test('built-ins come first, in template order, then custom modes oldest-first', () => {
        const modes = [
            mk('c2', 'custom', '2026-03-01'),
            mk('b-lecture', 'lecture', '2026-01-09'),
            mk('c1', 'custom', '2026-01-01'),
            mk('b-general', 'general', '2026-01-01'),
            mk('b-sales', 'sales', '2026-01-02'),
        ];
        assert.deepEqual(
            catalog.orderModes(modes).map((m) => m.id),
            ['b-general', 'b-sales', 'b-lecture', 'c1', 'c2'],
        );
    });

    test('the active mode is NOT hoisted — switching must not move the list under the cursor', () => {
        const modes = [mk('a', 'general', '2026-01-01'), mk('b', 'sales', '2026-01-02')];
        const before = catalog.orderModes(modes).map((m) => m.id);
        modes[1].isActive = true;
        assert.deepEqual(catalog.orderModes(modes).map((m) => m.id), before);
    });

    test('an unknown template type sorts last instead of throwing', () => {
        const modes = [mk('x', 'brand-new-template', '2026-01-01'), mk('g', 'general', '2026-01-02')];
        assert.deepEqual(catalog.orderModes(modes).map((m) => m.id), ['g', 'x']);
    });
});

describe('selectionAfterDelete', () => {
    const modes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    test('selects the next row when the middle one goes', () => {
        assert.equal(catalog.selectionAfterDelete(modes, 'b', 'a'), 'c');
    });

    test('falls back to the previous row at the end of the list', () => {
        assert.equal(catalog.selectionAfterDelete(modes, 'c', 'a'), 'b');
    });

    test('falls back to the active mode when the list is otherwise empty', () => {
        assert.equal(catalog.selectionAfterDelete([{ id: 'a' }], 'a', 'a'), null);
    });
});

describe('accessKind', () => {
    test('maps the access state to what the header shows', () => {
        assert.equal(catalog.accessKind({ licenceActive: true, localUnlocked: false }), 'licence');
        assert.equal(catalog.accessKind({ licenceActive: false, localUnlocked: true }), 'local');
        assert.equal(catalog.accessKind({ licenceActive: false, localUnlocked: false }), 'locked');
        assert.equal(catalog.accessKind(null), 'locked');
    });
});

describe('template descriptions', () => {
    test('a known template keeps its hand-written blurb', () => {
        assert.equal(catalog.templateBlurb('sales', [{ title: 'Pain points' }]), catalog.TEMPLATES.find((t) => t.type === 'sales').blurb);
    });

    test('a template the renderer has never seen is described from its own sections', () => {
        // This is the case that matters: the backend can add a template and the
        // gallery still renders something meaningful.
        assert.equal(
            catalog.templateBlurb('brand-new-template', [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }]),
            'One · Two · Three',
        );
    });

    test('a template with no sections at all degrades to an empty string, not "undefined"', () => {
        assert.equal(catalog.templateBlurb('brand-new-template', []), '');
    });

    test('every known template has a context placeholder, and the fallback is usable', () => {
        for (const type of catalog.TEMPLATE_ORDER) {
            assert.ok(catalog.contextPlaceholder(type).length > 20, type);
        }
        assert.ok(catalog.contextPlaceholder('brand-new-template').length > 20);
    });

    test('TEMPLATE_ORDER covers every TemplateType', () => {
        const declared = read('src/components/modes/modesCatalog.ts')
            .match(/export type TemplateType =([\s\S]*?);/)[1];
        const union = [...declared.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
        assert.deepEqual([...union].sort(), [...catalog.TEMPLATE_ORDER].sort());
    });
});

describe('ModesSettings panel wiring', () => {
    const panel = read('src/components/settings/ModesSettings.tsx');
    const detail = read('src/components/modes/ModeDetail.tsx');
    const list = read('src/components/modes/ModeList.tsx');
    const dialog = read('src/components/modes/NewModeDialog.tsx');
    const all = [panel, detail, list, dialog].join('\n');

    test('the premium forward is gone — the panel is real code now', () => {
        assert.ok(!panel.includes("from '../../premium'"), 'ModesSettings must not forward to premium/ any more');
        assert.ok(panel.includes('export default ModesSettings'), 'the panel keeps the default export the mount point imports');
    });

    test('the mount contract in App.tsx is unchanged', () => {
        const app = read('src/App.tsx');
        const mount = app.slice(app.indexOf('<ModesSettings'), app.indexOf('/>', app.indexOf('<ModesSettings')));
        for (const prop of ['onClose', 'isPremium', 'isLoaded', 'isTrialActive', 'onOpenNativelyAPI']) {
            assert.ok(mount.includes(prop), `App.tsx must still pass ${prop}`);
        }
    });

    test('access comes from IPC, not from the isPremium prop', () => {
        assert.ok(panel.includes('modesGetMutationAccess'), 'the panel must read the authoritative access state');
        assert.ok(!/const\s+canEdit\s*=\s*isPremium/.test(panel), 'a licence prop must not be the edit gate');
    });

    test('a locked build renders read-only and does not offer a way past its own gate', () => {
        assert.ok(panel.includes("kind === 'locked'"), 'the locked state must be rendered, not hidden');
        assert.ok(panel.includes('modes-open-plans'), 'the licence path is offered');
        assert.ok(detail.includes('disabled={!canEdit}'), 'every mutating control must be disabled when locked');
        assert.ok(detail.includes('Read-only until modes are unlocked on this build.'));
        // A build that ships the premium module must not hand out a free unlock
        // button; the opt-in lives in settings.json for a self-built copy only.
        assert.ok(!panel.includes('modesSetLocalUnlock'), 'no local-unlock button in a premium build');
        assert.ok(!panel.includes('modes-enable-local'), 'no local-unlock button in a premium build');
    });

    test('a build with no premium module shows no licence chrome at all', () => {
        // The whole complaint this fixes: a locally built copy said "editing modes
        // is a Pro feature and no licence or trial is active here" about a feature
        // that is compiled into the same binary, with no way to ever satisfy it.
        assert.ok(!panel.includes('modes-local-strip'), 'no "unlocked" banner either — nothing to announce');
        assert.ok(!panel.includes('modes-disable-local'), 'and nothing to switch off');
        assert.ok(panel.includes("kind === 'locked'"), 'the locked branch still exists for premium builds');
    });

    test('every mutation goes through preload, and the list is refreshed after one', () => {
        for (const call of [
            'modesCreate', 'modesUpdate', 'modesDelete', 'modesSetActive',
            'modesAddNoteSection', 'modesUpdateNoteSection', 'modesDeleteNoteSection',
            'modesApplyNoteTemplate', 'modesRemoveAllNoteSections',
            'modesUploadReferenceFile', 'modesDeleteReferenceFile',
            'modesGenerateFromBrief',
        ]) {
            assert.ok(all.includes(`window.electronAPI?.${call}`), `${call} must be called through preload`);
        }
        assert.ok(panel.includes('onModeChanged'), 'a mode change elsewhere must refresh the list');
    });

    test('the gallery is built from the backend catalog, and General is the empty starting point', () => {
        assert.ok(panel.includes('modesGetTemplateCatalog'));
        assert.ok(dialog.includes("entry.type !== 'general'"), 'General must not be a gallery card');
        assert.ok(dialog.includes('Start from empty mode'));
    });

    test('nothing in the panel re-implements licensing decisions', () => {
        // The gate lives in the main process; the panel may only display it.
        assert.ok(!all.includes('isProOrTrialActive'), 'the renderer must not re-derive licensing');
        assert.ok(!all.includes("error === 'pro_required'") || all.includes('read-only'), 'a pro_required reply must surface as a readable message');
    });
});
