// Guard for the Simplified Chinese dictionary.
//
// The i18n layer keys its dictionaries by the English source string, so a new
// `t('Some label')` call site that nobody translated fails SILENTLY: the UI just
// renders English inside an otherwise Chinese screen. That is exactly how the
// dictionary drifted to 34% coverage before this test existed — 620 entries in
// i18n.zh.generated.ts were `"Key": "Key"` placeholders that no check ever
// looked at.
//
// This test walks every `t('…')` literal in src/ and asserts each one has a
// real Chinese value, plus that placeholders survive translation. It reads the
// dictionary files as text instead of importing them because they are .ts
// modules and this suite also runs under plain `node --test`
// (npm run test:lib uses --experimental-strip-types, but the Electron runner
// does not, and reading is version-independent).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

// ── Dictionary loading ──────────────────────────────────────────────────────
// The generated files are `export const X: Record<string, string> = { … };`.
// Rewriting the declaration into `return` and evaluating the object literal is
// enough: they contain no imports, no functions, and no interpolation.
function loadDict(relPath) {
    const src = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    const body = src.replace(/export const \w+[^=]*=\s*/, 'return ');
    // eslint-disable-next-line no-new-func
    return new Function(body)();
}

const ZH = {
    ...loadDict('src/i18n.zh.generated.ts'),
    ...loadDict('src/i18n.zh.generated2.ts'),
    ...loadDict('src/i18n.zh.generated3.ts'),
    ...loadDict('src/i18n.zh.generated4.ts'),
};

// ── Call-site extraction ────────────────────────────────────────────────────
// Handles both quote styles (an English label may contain an apostrophe, e.g.
// t("Follow the meeting app's mute")) and decodes \uXXXX / \n so the key matches
// what t() actually receives at runtime.
function unescapeLiteral(s) {
    return s
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (/__tests__|node_modules/.test(full)) continue;
            walk(full, out);
        } else if (/\.(tsx?|jsx?|mjs)$/.test(entry.name) && !/\.d\.(m|t)s$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

const T_CALL = /\bt\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;

function collectCallSites() {
    const byKey = new Map(); // key -> first file that uses it
    for (const file of walk(path.join(repoRoot, 'src'))) {
        const src = fs.readFileSync(file, 'utf8');
        T_CALL.lastIndex = 0;
        let m;
        while ((m = T_CALL.exec(src))) {
            const key = unescapeLiteral(m[1] ?? m[2]);
            // Skip CSS-ish single-word ids (`t('sm')`) and empty literals.
            if (!key.trim() || /^[a-z-]+$/.test(key)) continue;
            if (!byKey.has(key)) byKey.set(key, path.relative(repoRoot, file));
        }
    }
    return byKey;
}

// Strings that must stay in English in every interface language. Brands,
// protocol names, plan names and pure punctuation — translating any of these
// would be wrong, so they are exempt from the coverage assertion rather than
// carrying a fake identity translation that looks translated but is not.
// Product names, vendor names, OS names, URLs, a shell snippet, and the
// `label=` props the dev harnesses use as test ids. All of these read the same
// in every language, so leaving them to fall back to English is correct.
const BRAND_ONLY = new Set([
    '1Password', '9Router', 'AI', 'Anthropic', 'Apple Silicon', 'Base URL', 'Beta',
    'BrowserExtensionToaster', 'CRM', 'Chrome Web Store', 'Custom cURL', 'Evin John',
    'FreeTrialModal', 'Gemini 3 Flash', 'GitHub', 'Gmail', 'Google Antigravity',
    'Google Chrome', 'HindsightStatusBanner', 'LinkedIn', 'LiteLLM Proxy', 'MCP',
    'ManagerPanel', 'MeetingOfferToast', 'Natively', 'Natively AI', 'Natively API',
    'Natively Companion', 'NativelyQuotaBanner', 'OpenAI', 'OpenAI Codex', 'PlansToaster',
    'PermissionsToaster', 'Pro', 'ReviewModal', 'SettingsOverlay', 'Slack', 'SupportToaster',
    'Telegram', 'TrialMeterToaster', 'UpdateCornerToast', 'UpdateModal', 'Windows', 'Zoom',
    'app.tavily.com', 'hindsight.vectorize.io', 'ollama.com',
    'curl http://localhost:11434/api/generate -d \'',
    '~/Documents/natively_debug.log',
    '…',
]);

const PLACEHOLDER = /\{\{?\w+\}?\}/g;

function placeholders(text) {
    return (text.match(PLACEHOLDER) ?? []).sort();
}

// ── Tests ───────────────────────────────────────────────────────────────────

const callSites = collectCallSites();

test('every t() literal in src has a Chinese translation', () => {
    const missing = [];
    const stillEnglish = [];
    for (const [key, file] of callSites) {
        if (BRAND_ONLY.has(key)) continue;
        if (!(key in ZH)) missing.push(`${JSON.stringify(key)}  (${file})`);
        else if (ZH[key] === key) stillEnglish.push(`${JSON.stringify(key)}  (${file})`);
    }
    assert.deepEqual(
        missing,
        [],
        `Untranslated t() strings — add them to src/i18n.zh.generated2.ts (or generated3.ts):\n  ${missing.join('\n  ')}`,
    );
    assert.deepEqual(
        stillEnglish,
        [],
        `These keys map to themselves, so the UI still shows English:\n  ${stillEnglish.join('\n  ')}`,
    );
});

test('translations keep every placeholder the English source has', () => {
    const broken = [];
    for (const [key] of callSites) {
        const zh = ZH[key];
        if (!zh) continue;
        const want = placeholders(key);
        if (!want.length) continue;
        const got = placeholders(zh);
        if (want.join() !== got.join()) {
            broken.push(`${JSON.stringify(key)} → ${JSON.stringify(zh)}  (expected ${want.join(' ') || 'none'}, got ${got.join(' ') || 'none'})`);
        }
    }
    assert.deepEqual(broken, [], `Placeholder mismatch:\n  ${broken.join('\n  ')}`);
});

test('permission banner titles from the main process are translated', () => {
    // electron/main.ts returns these as i18n KEYS so the renderer can call
    // t(titleKey). They are not t() literals in src/, so the sweep above cannot
    // see them, and they were entirely untranslated until they were added here.
    const mainSrc = fs.readFileSync(path.join(repoRoot, 'electron/main.ts'), 'utf8');
    const start = mainSrc.indexOf('function permissionTitleKey');
    assert.ok(start > 0, 'permissionTitleKey not found — update this test');
    const body = mainSrc.slice(start, mainSrc.indexOf('\n}', start));
    const keys = [...body.matchAll(/return '([^']+)'/g)]
        .map((m) => m[1])
        .filter((k) => !k.startsWith('permissionTitleKey'));
    assert.ok(keys.length >= 8, `expected the full title set, found ${keys.length}`);
    const missing = [...new Set(keys)].filter((k) => !ZH[k] || ZH[k] === k);
    assert.deepEqual(missing, [], `Permission titles with no Chinese: ${missing.join(', ')}`);
});

test('dictionary has no duplicate keys with conflicting values', () => {
    // Wave 2 deliberately overrides wave 1 on collisions, so the assertion is
    // about the merged view: whatever the last spread wins must not be an
    // English identity where wave 1 already had Chinese.
    const first = loadDict('src/i18n.zh.generated.ts');
    const second = loadDict('src/i18n.zh.generated2.ts');
    const regressions = Object.keys(second).filter(
        (k) => k in first && first[k] !== k && second[k] === k,
    );
    assert.deepEqual(regressions, [], `Wave 2 reverted translated keys to English: ${regressions.join(', ')}`);
});

test('the Chinese dictionary is actually wired into the language context', () => {
    // A dictionary nobody spreads is dead weight; i18n.tsx is the single place
    // that decides which files a language reads.
    const i18nSrc = fs.readFileSync(path.join(repoRoot, 'src/i18n.tsx'), 'utf8');
    assert.match(i18nSrc, /import \{ ZH_GENERATED2 \} from '\.\/i18n\.zh\.generated2'/, 'ZH_GENERATED2 is not imported');
    const zhBlock = i18nSrc.slice(i18nSrc.indexOf('const ZH: Record<string, string>'), i18nSrc.indexOf('const JA: Record<string, string>'));
    assert.match(zhBlock, /\.\.\.ZH_GENERATED2/, 'ZH_GENERATED2 is imported but not spread into the ZH dictionary');
});
