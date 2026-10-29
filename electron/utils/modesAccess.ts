// Whether this build may MUTATE modes, and why. Pure, so both branches are
// testable without a licence, a trial token or an Electron runtime.
//
// Two things can allow it:
//   'licence' — a premium licence or a live trial (the shipped rule).
//   'local'   — the default-OFF `localModesUnlocked` opt-in, for a copy you
//               built yourself. See electron/ipcHandlers.ts › isLocalModesUnlocked.
//
// The distinction is kept (rather than collapsing to a boolean) because the
// panel tells the user which one is in force, and the main process logs the
// 'local' path every time it lets a gated action through. A build that was never
// meant to allow mode editing should be diagnosable from the log alone.
//
// Scope: this gates the modes:* surface only. Nothing else in the app consults
// localModesUnlocked.

export type ModesAccessVia = 'licence' | 'local' | 'none';

export interface ModesAccess {
    allowed: boolean;
    via: ModesAccessVia;
}

export function modesMutationAccess(input: {
    licenceActive: boolean;
    localUnlocked: boolean;
}): ModesAccess {
    if (input.licenceActive) return { allowed: true, via: 'licence' };
    if (input.localUnlocked) return { allowed: true, via: 'local' };
    return { allowed: false, via: 'none' };
}

/**
 * Whether mode editing is unlocked on this copy, given what is persisted and
 * whether the build contains the premium module at all.
 *
 * The whole point is the build with NO premium module. There is no licence to
 * buy and no LicenseManager to ask, so the `pro_required` branch can never be
 * satisfied: the Modes engine, the nine templates and the reference-file indexer
 * all ship in the binary and are then permanently unreachable behind a gate that
 * nothing can open. Those builds are unlocked, always — a stored `false` does not
 * lock them either, because "turn it off" would just recreate the dead feature.
 *
 * A build that DOES ship the premium module keeps the shipped rule: locked unless
 * a licence or trial is active, with `localModesUnlocked` as the documented
 * escape hatch for a self-built premium copy. Defaulting that on would hand the
 * feature to every user of the real app, which is not this file's decision to
 * make.
 */
export function resolveLocalModesUnlock(input: {
    stored: unknown;
    premiumAvailable: boolean;
}): boolean {
    if (!input.premiumAvailable) return true;
    return input.stored === true;
}

/** The settings key that holds the opt-in. One spelling, used by main and by docs. */
export const LOCAL_MODES_UNLOCK_SETTING = 'localModesUnlocked';
