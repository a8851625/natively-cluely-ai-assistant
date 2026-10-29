// Renderer-side presentation data for the Modes Manager (the panel at
// ./settings/ModesSettings.tsx). Pure: no React, no Electron, no imports from
// electron/** — the renderer may not import main-process modules, which is why
// this file exists at all.
//
// What lives HERE: only how a template is *described* — a one-line blurb, the
// placeholder for a mode's custom-context box, and the display order. Every
// factual list (which built-in templates exist, their labels, the note sections
// each one seeds, the meeting note-template gallery) is read from the backend
// over IPC (`modesGetTemplateCatalog`, `modesListNoteTemplates`).
//
// That split is deliberate. The premium panel this replaces kept its own copies
// of those factual lists, and the copies silently fell behind the backend:
// Seminar (2026-07-19) and Call Center (2026-08-23) shipped in
// BUILTIN_MODE_LABELS but never reached the renderer, so neither could be
// created from the gallery for two releases (see
// electron/services/__tests__/ModeTemplateGalleryCoverage2026_09_16.test.mjs).
// A copy of the *wording* can only be stale in a cosmetic way; a copy of the
// *list* can be functionally wrong.
//
// TemplateType is the one list still duplicated, because it is a TypeScript
// type: the compiler needs it at build time. The coverage test pins it against
// BUILTIN_MODE_LABELS so it cannot drift either.

export type TemplateType =
    | 'general'
    | 'sales'
    | 'recruiting'
    | 'team-meet'
    | 'looking-for-work'
    | 'technical-interview'
    | 'lecture'
    | 'seminar'
    | 'call-center';

/** Display order of the built-ins (the gallery hides `general`, see TEMPLATES). */
export const TEMPLATE_ORDER: readonly TemplateType[] = [
    'general',
    'sales',
    'recruiting',
    'team-meet',
    'looking-for-work',
    'technical-interview',
    'lecture',
    'seminar',
    'call-center',
];

export interface TemplateCard {
    type: TemplateType;
    /** One line, shown under the label on the gallery card. */
    blurb: string;
}

/**
 * The "start a new mode" gallery: every built-in except General, which the
 * gallery offers separately as "Start from empty mode" (it is the template with
 * no sources, so it is the empty starting point rather than a card).
 */
export const TEMPLATES: Array<TemplateCard> = [
    { type: 'sales', blurb: 'Account context, pain points, buying signals, objections, next steps' },
    { type: 'recruiting', blurb: 'Candidate profile, role fit, strengths, concerns, compensation' },
    { type: 'team-meet', blurb: 'Progress since last sync, decisions, owners, blockers' },
    { type: 'looking-for-work', blurb: 'Opportunity summary, company details, fit signals, questions to ask' },
    { type: 'technical-interview', blurb: 'Problem, approach, correctness, complexity, hiring signal' },
    { type: 'lecture', blurb: 'Core concepts, definitions, examples, things to memorize' },
    { type: 'seminar', blurb: 'Grounded in your reference files; says so when the answer is not there' },
    { type: 'call-center', blurb: 'Caller intent, resolution steps, commitments, follow-up' },
];

/**
 * Placeholder for a mode's custom-context box. It is the single most useful
 * piece of guidance in this panel: the box steers every answer, and an empty
 * box shows no example of what belongs in it.
 */
export const CONTEXT_PLACEHOLDERS: Record<TemplateType, string> = {
    general: 'Anything that should apply to every meeting: how I like answers, terms I use, people I work with.',
    sales: 'e.g. I sell to mid-market SaaS ops teams. Lead with the customer\'s pain, never with features. Always end with the next step I should propose.',
    recruiting: 'e.g. I am hiring a senior backend engineer. Flag evidence of ownership and scale; call out anything I should probe further.',
    'team-meet': 'e.g. Our team ships weekly. Keep it short and concrete; name owners when they are stated.',
    'looking-for-work': 'e.g. I am a staff engineer moving into platform roles. Help me ask questions that reveal scope and ownership.',
    'technical-interview': 'e.g. I am the candidate: give me the approach and complexity first, then the code. Assume I know the language.',
    lecture: 'e.g. First-year statistics course. Prefer plain-language definitions and one worked example per concept.',
    seminar: 'e.g. My reference files are the reading list. Quote them, and say explicitly when something is not in them.',
    'call-center': 'e.g. Support line for a billing product. Confirm the caller\'s problem in one sentence before proposing a fix.',
};

/** The blurb for a template the renderer does not know about (backend-only). */
export function fallbackBlurb(sections: Array<{ title: string }>): string {
    const titles = sections.slice(0, 3).map((s) => s.title);
    return titles.length > 0 ? titles.join(' · ') : '';
}

export function templateBlurb(type: string, sections: Array<{ title: string }>): string {
    const known = TEMPLATES.find((t) => t.type === type);
    return known ? known.blurb : fallbackBlurb(sections);
}

export function contextPlaceholder(type: string): string {
    return CONTEXT_PLACEHOLDERS[type as TemplateType] ?? 'How this mode should answer, in your own words.';
}

export function isTemplateType(value: unknown): value is TemplateType {
    return typeof value === 'string' && (TEMPLATE_ORDER as readonly string[]).includes(value);
}

/** Display order for a template type; unknown types sort last. */
export function templateRank(type: string): number {
    const i = (TEMPLATE_ORDER as readonly string[]).indexOf(type);
    return i === -1 ? TEMPLATE_ORDER.length : i;
}

export interface OrderableMode {
    id: string;
    name: string;
    templateType: string;
    createdAt: string;
    isBuiltin?: boolean;
}

/**
 * Built-ins first in template order (General at the top), then custom modes
 * oldest-first. The active mode is NOT hoisted — a list that reorders itself
 * when you switch makes the row you just clicked jump away from the cursor.
 */
export function orderModes<T extends OrderableMode>(modes: readonly T[]): T[] {
    return [...modes].sort((a, b) => {
        const byTemplate = templateRank(a.templateType) - templateRank(b.templateType);
        if (byTemplate !== 0) return byTemplate;
        const byTime = String(a.createdAt).localeCompare(String(b.createdAt));
        if (byTime !== 0) return byTime;
        return a.name.localeCompare(b.name);
    });
}

/** 'licence' | 'local' | 'locked' — what the panel header should say. */
export function accessKind(access: { licenceActive?: boolean; localUnlocked?: boolean } | null | undefined): 'licence' | 'local' | 'locked' {
    if (access?.licenceActive) return 'licence';
    if (access?.localUnlocked) return 'local';
    return 'locked';
}

/**
 * Which mode to select after the selected one is deleted: the neighbour below,
 * else the one above, else the active mode, else nothing.
 */
export function selectionAfterDelete<T extends { id: string }>(
    modes: readonly T[],
    deletedId: string,
    activeId: string | null,
): string | null {
    const index = modes.findIndex((m) => m.id === deletedId);
    if (index === -1) return modes.find((m) => m.id === activeId)?.id ?? modes[0]?.id ?? null;
    const next = modes[index + 1] ?? modes[index - 1];
    if (next) return next.id;
    return modes.find((m) => m.id === activeId && m.id !== deletedId)?.id ?? null;
}
