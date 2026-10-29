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

/** The settings key that holds the opt-in. One spelling, used by main and by docs. */
export const LOCAL_MODES_UNLOCK_SETTING = 'localModesUnlocked';
