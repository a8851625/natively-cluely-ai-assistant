// electron/services/__tests__/ModeTemplateGalleryCoverage2026_09_16.test.mjs
//
// Bug (2026-09-16): the Modes Manager "Templates" gallery offered six
// templates while the app ships nine built-ins. Seminar (8th, 2026-07-19) and
// Call Center (9th, 2026-08-23) were added to the backend — BUILTIN_MODE_LABELS,
// TEMPLATE_NOTE_SECTIONS, the prompts, the source contract — but never to the
// renderer's hand-maintained copies in premium/src/ModesSettings.tsx, so a user
// could not create either mode from the gallery, and a custom mode's template
// <select> could not display or pick them.
//
// 2026-10-30 — the duplication is gone, and so is the class of bug that caused
// this. The Modes Manager panel now lives in src/components/settings/
// ModesSettings.tsx (the premium forward is gone on a source-available build),
// and it reads the template list, the labels and each template's seeded note
// sections from the backend over IPC (`modes:get-template-catalog`). Nothing in
// the renderer states which templates exist any more, so a new built-in appears
// in the gallery with no renderer change.
//
// What remains renderer-side is only presentation — a blurb and a context
// placeholder per template — and one list that has to exist at build time: the
// TemplateType union. This test pins both to the backend's BUILTIN_MODE_LABELS,
// plus the gallery's structural absence of General (offered separately as
// "Start from empty mode"), so the renderer cannot quietly fall behind again.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.resolve(repoRoot, p), 'utf8');

const builtinSrc = read('electron/services/builtinModes.ts');
const rendererSrc = read('src/components/modes/modesCatalog.ts');
const panelSrc = read('src/components/settings/ModesSettings.tsx');
const dialogSrc = read('src/components/modes/NewModeDialog.tsx');

/** The text between `startMarker` and the first `endMarker` after it. */
function block(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.ok(end >= 0, `end marker not found after: ${startMarker}`);
  return src.slice(start + startMarker.length, end);
}

/** Top-level keys of an object literal whose values are `[ ... ]` or strings. */
function keysOf(body) {
  return [...body.matchAll(/^\s+'?([a-z-]+)'?\s*:/gm)].map((m) => m[1]);
}

/** Template keys of a `Record<TemplateType, Array<...>>` body (4-space top level). */
function arrayKeysOf(body) {
  return [...body.matchAll(/^\s{4}'?([a-z-]+)'?\s*:\s*\[/gm)].map((m) => m[1]);
}

const builtins = [...block(builtinSrc, 'export const BUILTIN_MODE_LABELS = {', '} as const;')
  .matchAll(/^\s+'([a-z-]+)'\s*:/gm)].map((m) => m[1]);
const galleryExpected = builtins.filter((t) => t !== 'general');

describe('Modes Manager template gallery covers every built-in template', () => {
  test('backend list parsed (guards against a vacuous pass)', () => {
    assert.ok(builtins.includes('seminar') && builtins.includes('call-center') && builtins.length >= 9,
      `parsed built-ins: ${builtins.join(', ')}`);
  });

  test('renderer TemplateType union includes every built-in', () => {
    const union = [...block(rendererSrc, 'type TemplateType =', ';').matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...union].sort(), [...builtins].sort());
  });

  test('TEMPLATES offers every built-in except General', () => {
    const body = block(rendererSrc, 'const TEMPLATES: Array<TemplateCard>', '\n];');
    const types = [...body.matchAll(/type:\s*'([a-z-]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...types].sort(), [...galleryExpected].sort());
  });

  test('the gallery renders from the backend catalog, not a renderer copy', () => {
    // The point of the 2026-10-30 rewrite: the panel asks the backend which
    // templates exist and how each one is labelled, and iterates that answer.
    assert.ok(panelSrc.includes('modesGetTemplateCatalog'), 'the panel must read the backend template catalog');
    assert.ok(dialogSrc.includes('catalog.filter((entry) => entry.type !== \'general\')'),
      'the gallery must be the backend list minus General');
    assert.ok(dialogSrc.includes('entry.label'), 'the template label must come from the backend entry');
    for (const stale of ['TEMPLATE_DEFAULTS', "type: 'seminar'", "type: 'call-center'"]) {
      assert.ok(!dialogSrc.includes(stale), `the gallery must not hand-maintain ${stale}`);
    }
  });

  test('the renderer keeps no SEEDABLE copy of the note sections', () => {
    // A one-line blurb may of course mention the things a template covers. What
    // must not exist renderer-side is a copy of the sections themselves — an
    // array of { title, description } objects is exactly what a seeded template
    // is made of, and duplicating that is what drifted before.
    for (const [name, src] of [['modesCatalog', rendererSrc], ['NewModeDialog', dialogSrc]]) {
      assert.equal((src.match(/title:\s*'/g) ?? []).length, 0, `${name} must not define section titles`);
      assert.equal((src.match(/description:\s*'/g) ?? []).length, 0, `${name} must not define section descriptions`);
    }
    assert.ok(panelSrc.includes('modesListNoteTemplates'), 'note templates come from the backend');
  });

  // The notes Summary leads with a mode's defining section, looked up BY TITLE
  // (MeetingSummaryReducer MODE_HEADLINE_SECTIONS). Seminar shipped naming
  // 'Core concepts' / 'Open questions' — titles its seeded sections don't have —
  // so its Summary silently fell through to the generic shape.
  //
  // Scoped to the two templates this file is about: 'looking-for-work' also names
  // a 'Role fit' it doesn't seed (its 'Next steps' still matches), which predates
  // them and changes a shipped mode's Summary if fixed, so it is reported instead.
  test('Seminar and Call Center headline titles exist in their note sections', () => {
    const managerSrc = read('electron/services/ModesManager.ts');
    const reducerSrc = read('electron/services/meeting/MeetingSummaryReducer.ts');
    const sections = {};
    const body = block(managerSrc,
      'export const TEMPLATE_NOTE_SECTIONS: Record<ModeTemplateType, Array<{ title: string; description: string }>> = {', '\n};');
    for (const m of body.matchAll(/^\s{4}'?([a-z-]+)'?\s*:\s*\[([\s\S]*?)^\s{4}\],/gm)) {
      sections[m[1]] = [...m[2].matchAll(/title:\s*'([^']*)'/g)].map((t) => t[1]);
    }
    const headlines = block(reducerSrc, 'const MODE_HEADLINE_SECTIONS: Record<string, string[]> = {', '\n};');
    const pairs = [...headlines.matchAll(/^\s+'?([a-z-]+)'?\s*:\s*\[([^\]]*)\]/gm)];
    assert.ok(pairs.length >= 8, `parsed ${pairs.length} headline entries`);
    const checked = pairs.filter(([, t]) => t === 'seminar' || t === 'call-center');
    assert.equal(checked.length, 2, 'seminar and call-center headline entries present');
    for (const [, t, list] of checked) {
      for (const [, title] of list.matchAll(/'([^']*)'/g)) {
        assert.ok(sections[t]?.includes(title), `'${t}' headline '${title}' is not one of its note sections: ${JSON.stringify(sections[t])}`);
      }
    }
  });

  test('every built-in has a context placeholder', () => {
    const body = block(rendererSrc, 'const CONTEXT_PLACEHOLDERS: Record<TemplateType, string> = {', '\n};');
    assert.deepEqual(keysOf(body).sort(), [...builtins].sort());
  });

  test('the placeholder is an example, not the label repeated', () => {
    const body = block(rendererSrc, 'const CONTEXT_PLACEHOLDERS: Record<TemplateType, string> = {', '\n};');
    for (const m of body.matchAll(/^\s+'?([a-z-]+)'?\s*:\s*'((?:[^'\\]|\\.)*)'/gm)) {
      assert.ok(m[2].length > 20, `placeholder for ${m[1]} is too short to be an example`);
    }
  });
});
