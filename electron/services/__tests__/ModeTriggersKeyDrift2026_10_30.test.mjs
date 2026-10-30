// ModeTriggersKeyDrift2026_10_30.test.mjs
//
// The floating action bar is a MODE-DRIVEN surface: the overlay asks the engine
// for `MODE_TRIGGERS[activeMode.templateType]`, so a table keyed by anything
// other than a real template id is config that no mode can reach, and this
// surface fails silently — no error, no log, just a bar that only ever offers
// drawing cards.
//
// That is what happened. `interview` and `technical_interview` (underscore)
// held four candidate presets each, `team_meeting` held the meeting pack, and
// `negotiation` held three negotiation presets. None of those is a template id
// (see MODE_IDS), so 4 of the 9 modes lost their action bar while the tests that
// covered them used the same wrong keys and agreed with the bug
// (DynamicActionEngine.test.mjs "expanded trigger packs … across modes").
//
// These tests pin the key space and the candidate packs, so the next re-keying
// mistake fails here instead of in a meeting.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dist = (...parts) => join(here, '..', '..', '..', 'dist-electron', 'electron', ...parts);

const detectorPath = dist('services', 'dynamic-actions', 'DynamicActionDetector.js');
const registryPath = dist('context-intelligence', 'policies', 'mode-policy-registry.js');
const loadable = [detectorPath, registryPath].every((p) => existsSync(p));

const load = async (p) => await import(pathToFileURL(p).href);

describe('MODE_TRIGGERS key space', { skip: loadable ? false : 'dist-electron not built' }, () => {
  test('every key is a real template id — no unreachable table', async () => {
    const { MODE_TRIGGERS } = await load(detectorPath);
    const { MODE_IDS } = await load(registryPath);
    const unknown = Object.keys(MODE_TRIGGERS).filter((k) => !MODE_IDS.includes(k));
    assert.deepEqual(
      unknown,
      [],
      `MODE_TRIGGERS has keys no mode can pass (activeMode.templateType is one of ${MODE_IDS.join(', ')}): ${unknown.join(', ')}`,
    );
  });

  test('every mode has an action bar, and every bar has a drawing offer', async () => {
    const { MODE_TRIGGERS } = await load(detectorPath);
    const { MODE_IDS } = await load(registryPath);
    for (const id of MODE_IDS) {
      const triggers = MODE_TRIGGERS[id];
      assert.ok(Array.isArray(triggers) && triggers.length > 0, `${id} has no action bar`);
      // The visual catalog test (VisualCatalogWiring) requires the drawing
      // offers; assert it here too, because a mode whose ONLY entry is a
      // drawing card is how the candidate modes were quietly emptied.
      assert.ok(
        triggers.some((t) => t.type.startsWith('visual_') || t.type === 'system_design_prompt'),
        `${id} has only drawing offers or none — its action bar is empty`,
      );
    }
  });

  test('no mode lists the same action type twice', async () => {
    // DynamicActionStore.deduplicate() suppresses a second action of the same
    // type within 120s, so a duplicate entry is dead config: the pattern that
    // matches second can never produce a card.
    const { MODE_TRIGGERS } = await load(detectorPath);
    for (const [mode, triggers] of Object.entries(MODE_TRIGGERS)) {
      const types = triggers.map((t) => t.type);
      const dupes = types.filter((t, i) => types.indexOf(t) !== i);
      assert.deepEqual(dupes, [], `${mode} lists a duplicate action type: ${dupes.join(', ')}`);
    }
  });
});

describe('the candidate packs reach the candidate modes', () => {
  const CANDIDATE_BEHAVIOURAL = ['behavioral_question', 'intro_pitch', 'company_motivation', 'weakness_question'];
  const CANDIDATE_TECHNICAL = ['coding_problem', 'screen_coding_problem', 'complexity_analysis', 'system_design_prompt'];

  test('"Looking for work" offers the behavioural presets', async () => {
    const { MODE_TRIGGERS } = await load(detectorPath);
    const types = MODE_TRIGGERS['looking-for-work'].map((t) => t.type);
    for (const type of CANDIDATE_BEHAVIOURAL) {
      assert.ok(types.includes(type), `looking-for-work is missing ${type}`);
    }
  });

  test('"Technical Interview" offers the coding presets', async () => {
    const { MODE_TRIGGERS } = await load(detectorPath);
    const types = MODE_TRIGGERS['technical-interview'].map((t) => t.type);
    for (const type of CANDIDATE_TECHNICAL) {
      assert.ok(types.includes(type), `technical-interview is missing ${type}`);
    }
  });

  test('"Team Meet" offers the meeting presets', async () => {
    const { MODE_TRIGGERS } = await load(detectorPath);
    const types = MODE_TRIGGERS['team-meet'].map((t) => t.type);
    for (const type of ['action_item', 'decision_point', 'blocker_check']) {
      assert.ok(types.includes(type), `team-meet is missing ${type}`);
    }
  });

  test('the dead keys are gone', async () => {
    const { MODE_TRIGGERS } = await load(detectorPath);
    for (const dead of ['interview', 'technical_interview', 'team_meeting', 'negotiation']) {
      assert.equal(MODE_TRIGGERS[dead], undefined, `MODE_TRIGGERS.${dead} is back — no mode passes that key`);
    }
  });
});

describe('presets do not restate the mode', () => {
  test('no promptInstruction names a mode — <active_mode> owns the role', async () => {
    // The candidate presets said "You are in Interview mode.", which contradicts
    // the mode they are attached to ('looking-for-work') and duplicates the
    // <active_mode> block promptSystemV2 already injects for that request.
    const { MODE_TRIGGERS, NEGOTIATION_TRIGGERS } = await load(detectorPath);
    const all = [...Object.values(MODE_TRIGGERS).flat(), ...NEGOTIATION_TRIGGERS];
    const offenders = all
      .filter((t) => /^You are in .*mode\./i.test(String(t.promptInstruction || '')))
      .map((t) => t.type);
    assert.deepEqual(offenders, [], `presets still restate the mode: ${offenders.join(', ')}`);
  });

  test('every trigger keeps a usable label, preset and style', async () => {
    const { MODE_TRIGGERS } = await load(detectorPath);
    for (const [mode, triggers] of Object.entries(MODE_TRIGGERS)) {
      for (const t of triggers) {
        assert.ok(typeof t.type === 'string' && t.type.length > 0, `${mode}: trigger without a type`);
        assert.ok(typeof t.label === 'string' && t.label.length > 2, `${mode}/${t.type}: no label`);
        assert.ok(typeof t.promptInstruction === 'string' && t.promptInstruction.length > 10, `${mode}/${t.type}: no preset`);
        assert.ok(Array.isArray(t.patterns) && t.patterns.length > 0, `${mode}/${t.type}: no patterns`);
      }
    }
  });
});
