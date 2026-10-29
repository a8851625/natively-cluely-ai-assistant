/**
 * ModesSettings — the Modes Manager panel.
 *
 * A mode is the lens every answer goes through: which sources it may use, what
 * shape the notes take, and what standing instructions the model reads. The
 * backend for all of that already ships (electron/services/ModesManager.ts and
 * ~22 `modes:*` IPC channels); this panel is the surface for it.
 *
 * This file used to be a four-line forward to the private premium/ submodule, so
 * on a source-available build the launcher's grid button opened a correctly sized
 * but empty card. It is now the real panel. The mount contract in src/App.tsx is
 * unchanged (onClose / isPremium / isLoaded / isTrialActive / onOpenNativelyAPI).
 *
 * Licensing: every mutating `modes:*` channel is gated in the main process on
 * isModesMutationAllowed() — a licence or a live trial, and additionally the
 * default-OFF `localModesUnlocked` opt-in for a self-built copy. This panel never
 * decides that itself: it reads modesGetMutationAccess() and renders read-only
 * when the answer is no, with the opt-in strip that explains how to change it.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, X } from 'lucide-react';
import { useT } from '../../i18n';
// AipSelect (the note-template menu) is styled by AIP_CSS, which every consumer
// has to mount: without it the reveal has no `grid-template-rows: 0fr` /
// `visibility: hidden` and the option list renders fully expanded. This panel is
// its own subtree (the settings overlay is a different window), so it needs its
// own copy — same pattern as EmbeddingSettings.
import { AIP_CSS } from './AIProvidersSettings';
import { ModeList } from '../modes/ModeList';
import { ModeDetail } from '../modes/ModeDetail';
import { NewModeDialog } from '../modes/NewModeDialog';
import { accessKind, orderModes, selectionAfterDelete } from '../modes/modesCatalog';
import { EMPTY_ACCESS, type ModeRow, type MutationAccess, type NoteTemplateEntry, type TemplateCatalogEntry } from '../modes/modesTypes';

interface ModesSettingsProps {
    onClose?: () => void;
    /** Kept for the existing mount contract; the panel reads the authoritative state from IPC. */
    isPremium?: boolean;
    isLoaded?: boolean;
    isTrialActive?: boolean;
    onOpenNativelyAPI?: () => void;
}

interface Notice {
    message: string;
    tone: 'error' | 'ok';
}

export const ModesSettings: React.FC<ModesSettingsProps> = ({ onClose, onOpenNativelyAPI }) => {
    const t = useT();

    const [modes, setModes] = useState<ModeRow[]>([]);
    const [catalog, setCatalog] = useState<TemplateCatalogEntry[]>([]);
    const [noteTemplates, setNoteTemplates] = useState<NoteTemplateEntry[]>([]);
    const [access, setAccess] = useState<MutationAccess>(EMPTY_ACCESS);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [notice, setNotice] = useState<Notice | null>(null);

    const pushNotice = useCallback((message: string, tone: 'error' | 'ok' = 'error') => {
        setNotice({ message, tone });
    }, []);
    useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(null), 5000);
        return () => clearTimeout(timer);
    }, [notice]);

    // ── load ──────────────────────────────────────────────────────────────
    const reload = useCallback(async () => {
        const api = window.electronAPI;
        const [rows, accessNow] = await Promise.all([
            api?.modesGetAll?.(),
            api?.modesGetMutationAccess?.(),
        ]);
        const list = Array.isArray(rows) ? (rows as ModeRow[]) : [];
        setModes(list);
        if (accessNow) setAccess(accessNow);
        setLoading(false);
        return list;
    }, []);

    useEffect(() => {
        void (async () => {
            const api = window.electronAPI;
            const [list, cat, notes] = await Promise.all([
                reload(),
                api?.modesGetTemplateCatalog?.(),
                api?.modesListNoteTemplates?.(),
            ]);
            if (cat?.success) setCatalog(cat.templates ?? []);
            if (notes?.success) setNoteTemplates(notes.templates ?? []);
            // Start on the mode in use, so the panel opens on what is actually
            // shaping answers rather than on an arbitrary first row.
            const initial = list.find((m) => m.isActive) ?? orderModes(list)[0];
            setSelectedId((current) => current ?? initial?.id ?? null);
        })();
    }, [reload]);

    // Another surface can change the active mode (the launcher's badge, a
    // licence loss clearing it). Follow it instead of showing a stale list.
    useEffect(() => {
        const off = window.electronAPI?.onModeChanged?.(() => { void reload(); });
        return () => off?.();
    }, [reload]);

    const selected = useMemo(
        () => modes.find((m) => m.id === selectedId) ?? null,
        [modes, selectedId],
    );

    // ── create / delete ───────────────────────────────────────────────────
    const createMode = useCallback(async (params: { name: string; templateType: string }) => {
        const res = await window.electronAPI?.modesCreate?.(params);
        if (!res?.success || !res.mode?.id) {
            return { ok: false, error: res?.error === 'pro_required' ? t('Modes are read-only on this build.') : String(res?.error ?? '') };
        }
        await reload();
        setSelectedId(res.mode.id);
        setCreating(false);
        return { ok: true, id: res.mode.id as string };
    }, [reload, t]);

    const generateMode = useCallback(async (brief: string) => {
        const res = await window.electronAPI?.modesGenerateFromBrief?.({ brief });
        if (!res?.success || !res.mode?.id) {
            return { ok: false, error: res?.error === 'pro_required' ? t('Modes are read-only on this build.') : String(res?.error ?? '') };
        }
        await reload();
        setSelectedId(res.mode.id);
        setCreating(false);
        return { ok: true, id: res.mode.id as string };
    }, [reload, t]);

    const handleDeleted = useCallback(async (deletedId: string) => {
        const remaining = modes.filter((m) => m.id !== deletedId);
        const activeId = remaining.find((m) => m.isActive)?.id ?? null;
        setSelectedId(selectionAfterDelete(modes, deletedId, activeId));
        await reload();
    }, [modes, reload]);

    const kind = accessKind(access);

    // `aip-root` on the tree below is required, not decoration: AIP_CSS scopes its
    // colour tokens (--aip-primary, --aip-accent…) to it and AipSelect reads them.
    // Without it the note-template menu renders with unset colours and no collapse.
    return (
        <div className="aip-root relative flex h-full flex-col px-5 pt-4 pb-4" data-testid="modes-panel">
            <style>{AIP_CSS}</style>
            {/* Header */}
            <div className="flex items-start justify-between gap-3 pb-3">
                <div className="min-w-0">
                    <h1 className="text-base font-semibold text-text-primary">{t('Modes')}</h1>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-text-tertiary">
                        {t('Each mode decides what an answer may use, how notes are shaped, and what the model is told to be.')}
                    </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {kind === 'licence' && (
                        <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-600" data-testid="modes-badge-licence">
                            {t('Pro')}
                        </span>
                    )}
                    {onClose && (
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label={t('Close')}
                            data-testid="modes-close"
                            className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-bg-component hover:text-text-primary"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    )}
                </div>
            </div>

            {/* The opt-in strip. Shown only when this build may not mutate modes,
                and it is the only way the panel can become editable. */}
            {kind === 'locked' && (
                <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2" data-testid="modes-locked-strip">
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                    <div className="min-w-0 flex-1">
                        <p className="text-[11px] leading-relaxed text-text-secondary">
                            {t('Modes are read-only on this build: editing them is a Pro feature and no licence or trial is active here.')}
                        </p>
                        {onOpenNativelyAPI && (
                            <div className="mt-1.5">
                                <button
                                    type="button"
                                    onClick={onOpenNativelyAPI}
                                    data-testid="modes-open-plans"
                                    className="text-[11px] text-text-tertiary underline decoration-dotted hover:text-text-primary"
                                >
                                    {t('See plans')}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}


            {/* Body */}
            <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr] gap-4">
                {loading ? (
                    <p className="col-span-2 text-xs text-text-tertiary">{t('Loading…')}</p>
                ) : (
                    <>
                        <ModeList
                            modes={modes}
                            selectedId={selectedId}
                            catalog={catalog}
                            onSelect={setSelectedId}
                            onNew={() => setCreating(true)}
                            canMutate={access.allowed}
                        />
                        <div className="min-h-0 border-l border-border-subtle pl-4">
                            {selected ? (
                                <ModeDetail
                                    key={selected.id}
                                    mode={selected}
                                    catalog={catalog}
                                    noteTemplates={noteTemplates}
                                    access={access}
                                    onChanged={() => { void reload(); }}
                                    onDeleted={(id) => { void handleDeleted(id); }}
                                    onNotice={pushNotice}
                                />
                            ) : (
                                <p className="text-xs text-text-tertiary" data-testid="modes-empty">
                                    {t('No mode selected.')}
                                </p>
                            )}
                        </div>
                    </>
                )}
            </div>

            {creating && (
                <NewModeDialog
                    catalog={catalog}
                    onCancel={() => setCreating(false)}
                    onCreate={createMode}
                    onGenerate={generateMode}
                />
            )}

            {notice && (
                <div
                    role="status"
                    data-testid="modes-notice"
                    className={`absolute bottom-3 left-5 right-5 rounded-xl px-3 py-2 text-xs ${
                        notice.tone === 'error'
                            ? 'border border-red-500/30 bg-red-500/10 text-red-600'
                            : 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
                    }`}
                >
                    {notice.message}
                </div>
            )}
        </div>
    );
};

export default ModesSettings;
