// The right-hand pane of the Modes Manager: everything about one mode.
//
// Layout mirrors how a mode actually works, in the order it affects an answer:
//   identity (name + template + whether it is the one in use)
//   → custom context (the instruction every answer reads)
//   → notes template (what the meeting summary is shaped into)
//   → reference files (what it may cite)
//   → answer policy (what the backend enforces, read-only)
//
// Two rules this pane follows:
//
// 1. The template is fixed after creation. ModesManager locks a built-in's
//    template on purpose (see builtinModes.ts: a mode named "Technical
//    Interview" that ran as `general` is the defect that motivated it), and for
//    a custom mode the source contract is derived from the template — changing
//    it after the fact would need buildUserSourceContract() to be re-run or the
//    mode would keep a contract for a template it no longer has. So it is shown,
//    never edited.
//
// 2. Text fields save on blur, and say so. There is no Save button anywhere in
//    this panel: a mode is edited in place, the way the rest of Settings works.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, FileText, Plus, Trash2, Upload } from 'lucide-react';
import { useT } from '../../i18n';
import { SETTINGS_BTN, SETTINGS_INPUT, SETTINGS_WELL } from '../settings/SettingsRow';
// In-window menu and dialog, never a native <select>/confirm(): those are OS
// windows outside the content protection this app's windows carry, so they show
// up in screen shares (see src/lib/__tests__/NoNativePopups2026_09_27.test.mjs).
import { AipSelect } from '../settings/AIProvidersSettings';
import { useConfirmDialog } from '../ui/ConfirmDialog';
import type {
    ModeRow,
    NoteSection,
    NoteTemplateEntry,
    RefFile,
    RefFileStatus,
    MutationAccess,
    SourceContractView,
    TemplateCatalogEntry,
} from './modesTypes';
import { contextPlaceholder } from './modesCatalog';

interface Props {
    mode: ModeRow;
    catalog: TemplateCatalogEntry[];
    noteTemplates: NoteTemplateEntry[];
    access: MutationAccess;
    onChanged: () => void;
    onDeleted: (id: string) => void;
    onNotice: (message: string, tone?: 'error' | 'ok') => void;
}

const templateLabel = (catalog: TemplateCatalogEntry[], type: string): string =>
    catalog.find((t) => t.type === type)?.label ?? type;

/** A titled block with an optional action on the right. */
const Block: React.FC<{
    title: string;
    hint?: string;
    action?: React.ReactNode;
    children: React.ReactNode;
    testId?: string;
}> = ({ title, hint, action, children, testId }) => (
    <section className="border-t border-border-subtle px-1 pt-4 first:border-t-0 first:pt-0" data-testid={testId}>
        <div className="mb-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
                <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
                {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-text-tertiary">{hint}</p>}
            </div>
            {action && <div className="shrink-0">{action}</div>}
        </div>
        {children}
    </section>
);

export const ModeDetail: React.FC<Props> = ({ mode, catalog, noteTemplates, access, onChanged, onDeleted, onNotice }) => {
    const t = useT();
    const canEdit = access.allowed;
    // Renamed on purpose: the popup scanner in NoNativePopups2026_09_27 flags a bare
    // `confirm(` so that the global cannot creep back in. `askConfirm` is its
    // allowlisted shape for the hook's own promise-shaped confirm.
    const { confirm: askConfirm, dialog: confirmDialog } = useConfirmDialog();

    // ── name / context ────────────────────────────────────────────────────
    const [name, setName] = useState(mode.name);
    const [context, setContext] = useState(mode.customContext);
    const [savedField, setSavedField] = useState<'name' | 'context' | null>(null);
    const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        setName(mode.name);
        setContext(mode.customContext);
        setSavedField(null);
    }, [mode.id, mode.name, mode.customContext]);
    useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

    const flashSaved = (field: 'name' | 'context') => {
        setSavedField(field);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSavedField(null), 1600);
    };

    const save = useCallback(
        async (updates: { name?: string; customContext?: string }, field: 'name' | 'context') => {
            if (!canEdit) return;
            const res = await window.electronAPI?.modesUpdate?.(mode.id, updates);
            if (res?.success) {
                flashSaved(field);
                onChanged();
            } else {
                onNotice(res?.error === 'pro_required' ? t('Modes are read-only on this build.') : String(res?.error ?? t('Could not save.')), 'error');
            }
        },
        [canEdit, mode.id, onChanged, onNotice, t],
    );

    // ── activation / deletion ─────────────────────────────────────────────
    const [busy, setBusy] = useState(false);
    const activate = async () => {
        if (!canEdit || busy) return;
        setBusy(true);
        const res = await window.electronAPI?.modesSetActive?.(mode.id);
        setBusy(false);
        if (res?.success) onChanged();
        else onNotice(String(res?.error ?? t('Could not switch mode.')), 'error');
    };
    const remove = async () => {
        if (!canEdit || busy) return;
        if (!(await askConfirm({
            title: t('Delete mode'),
            description: t('Delete this mode? Its notes template and reference files go with it.'),
            confirmLabel: t('Delete'),
            destructive: true,
        }))) return;
        setBusy(true);
        const res = await window.electronAPI?.modesDelete?.(mode.id);
        setBusy(false);
        if (res?.success) onDeleted(mode.id);
        else onNotice(String(res?.error ?? t('Could not delete this mode.')), 'error');
    };

    // ── notes template ────────────────────────────────────────────────────
    const [sections, setSections] = useState<NoteSection[]>([]);
    const [loadingSections, setLoadingSections] = useState(true);
    const reloadSections = useCallback(async () => {
        const rows = await window.electronAPI?.modesGetNoteSections?.(mode.id);
        setSections(Array.isArray(rows) ? rows : []);
        setLoadingSections(false);
    }, [mode.id]);
    useEffect(() => { setLoadingSections(true); void reloadSections(); }, [reloadSections]);

    const addSection = async () => {
        const res = await window.electronAPI?.modesAddNoteSection?.(mode.id, t('New section'), '');
        if (res?.success) void reloadSections();
        else onNotice(String(res?.error ?? t('Could not add a section.')), 'error');
    };
    const patchSection = async (id: string, updates: { title?: string; description?: string }) => {
        const res = await window.electronAPI?.modesUpdateNoteSection?.(id, updates);
        if (res?.success) void reloadSections();
        else onNotice(String(res?.error ?? t('Could not save the section.')), 'error');
    };
    const dropSection = async (id: string) => {
        const res = await window.electronAPI?.modesDeleteNoteSection?.(id);
        if (res?.success) void reloadSections();
        else onNotice(String(res?.error ?? t('Could not delete the section.')), 'error');
    };
    const applyTemplate = async (templateId: string) => {
        const res = await window.electronAPI?.modesApplyNoteTemplate?.(mode.id, templateId);
        if (res?.success) {
            void reloadSections();
            onChanged();
        } else {
            onNotice(String(res?.error ?? t('Could not apply that template.')), 'error');
        }
    };
    const clearSections = async () => {
        if (!(await askConfirm({
            title: t('Remove all sections'),
            description: t('Remove every section from this notes template?'),
            confirmLabel: t('Remove'),
            destructive: true,
        }))) return;
        const res = await window.electronAPI?.modesRemoveAllNoteSections?.(mode.id);
        if (res?.success) void reloadSections();
        else onNotice(String(res?.error ?? t('Could not clear the template.')), 'error');
    };

    // ── reference files ───────────────────────────────────────────────────
    const [files, setFiles] = useState<RefFile[]>([]);
    const [statuses, setStatuses] = useState<Record<string, RefFileStatus>>({});
    const reloadFiles = useCallback(async () => {
        const [rows, status] = await Promise.all([
            window.electronAPI?.modesGetReferenceFiles?.(mode.id),
            window.electronAPI?.modesGetReferenceFileStatus?.(mode.id),
        ]);
        setFiles(Array.isArray(rows) ? rows : []);
        const map: Record<string, RefFileStatus> = {};
        for (const s of status?.statuses ?? []) map[s.fileId] = s;
        setStatuses(map);
    }, [mode.id]);
    useEffect(() => { void reloadFiles(); }, [reloadFiles]);

    // Live index status while a file is being ingested (main → renderer event).
    useEffect(() => {
        const off = window.electronAPI?.onModeFileIndexStatus?.((data) => {
            if (data?.modeId === mode.id) void reloadFiles();
        });
        return () => off?.();
    }, [mode.id, reloadFiles]);

    const upload = async () => {
        const res = await window.electronAPI?.modesUploadReferenceFile?.(mode.id);
        if (res?.success) {
            void reloadFiles();
            onChanged();
        } else if (!res?.cancelled) {
            onNotice(String(res?.error ?? t('Could not read that file.')), 'error');
        }
    };
    const dropFile = async (id: string) => {
        const res = await window.electronAPI?.modesDeleteReferenceFile?.(id);
        if (res?.success) {
            void reloadFiles();
            onChanged();
        } else {
            onNotice(String(res?.error ?? t('Could not delete that file.')), 'error');
        }
    };

    // ── answer policy (read-only) ─────────────────────────────────────────
    const [contract, setContract] = useState<SourceContractView | null>(null);
    useEffect(() => {
        let live = true;
        setContract(null);
        void window.electronAPI?.modesGetSourceContract?.(mode.id).then((c) => {
            if (live) setContract(c ?? null);
        }).catch(() => { /* the section simply stays empty */ });
        return () => { live = false; };
    }, [mode.id]);

    const statusBadge = (fileId: string) => {
        const status = statuses[fileId]?.status;
        if (!status) return null;
        const map: Record<string, { text: string; className: string }> = {
            ready: { text: t('Indexed'), className: 'text-emerald-500' },
            indexing: { text: t('Indexing…'), className: 'text-amber-500' },
            lexical_only: { text: t('Keyword search only'), className: 'text-amber-500' },
            failed: { text: t('Not indexed'), className: 'text-red-500' },
        };
        const entry = map[status] ?? { text: status, className: 'text-text-tertiary' };
        const chunks = statuses[fileId]?.chunkCount ?? 0;
        return (
            <span className={`text-[11px] ${entry.className}`}>
                {entry.text}
                {chunks > 0 ? ` · ${chunks} ${t('chunks')}` : ''}
            </span>
        );
    };

    return (
        <div className="flex h-full min-h-0 flex-col" data-testid="mode-detail">
            {confirmDialog}
            {/* Identity */}
            <div className="flex items-start justify-between gap-3 pb-3">
                <div className="min-w-0 flex-1">
                    <input
                        value={name}
                        disabled={!canEdit}
                        onChange={(e) => setName(e.target.value)}
                        onBlur={() => { if (name.trim() && name !== mode.name) void save({ name: name.trim() }, 'name'); }}
                        data-testid="mode-name"
                        aria-label={t('Mode name')}
                        className="w-full border-none bg-transparent p-0 text-lg font-semibold text-text-primary outline-none disabled:opacity-70"
                    />
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-text-tertiary">
                        <span data-testid="mode-template">{templateLabel(catalog, mode.templateType)}</span>
                        <span aria-hidden>·</span>
                        <span>{mode.isBuiltin ? t('Built-in template') : t('Custom mode')}</span>
                        {savedField === 'name' && <span className="text-emerald-500">{t('Saved')}</span>}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {mode.isActive ? (
                        <span
                            data-testid="mode-active-badge"
                            className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-600"
                        >
                            <Check className="h-3 w-3" />
                            {t('In use')}
                        </span>
                    ) : (
                        <button
                            type="button"
                            onClick={() => void activate()}
                            disabled={!canEdit || busy}
                            data-testid="mode-activate"
                            className={`${SETTINGS_BTN} px-3 py-1.5 text-xs`}
                        >
                            {t('Use this mode')}
                        </button>
                    )}
                    {!mode.isBuiltin && (
                        <button
                            type="button"
                            onClick={() => void remove()}
                            disabled={!canEdit || busy}
                            data-testid="mode-delete"
                            title={t('Delete mode')}
                            aria-label={t('Delete mode')}
                            className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-bg-component hover:text-red-500 disabled:opacity-40"
                        >
                            <Trash2 className="h-4 w-4" />
                        </button>
                    )}
                </div>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 pb-2">
                {/* Custom context */}
                <Block
                    title={t('Custom instructions')}
                    hint={t('Read before every answer in this mode. Leave empty to use the template defaults.')}
                    testId="mode-context-block"
                    action={savedField === 'context' ? <span className="text-[11px] text-emerald-500">{t('Saved')}</span> : null}
                >
                    <textarea
                        value={context}
                        disabled={!canEdit}
                        onChange={(e) => setContext(e.target.value)}
                        onBlur={() => { if (context !== mode.customContext) void save({ customContext: context }, 'context'); }}
                        rows={5}
                        placeholder={contextPlaceholder(mode.templateType)}
                        data-testid="mode-context"
                        className={`${SETTINGS_WELL} w-full resize-y bg-bg-component p-3 text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-tertiary disabled:opacity-70`}
                    />
                </Block>

                {/* Notes template */}
                <Block
                    title={t('Notes template')}
                    hint={t('The sections this mode shapes meeting notes into.')}
                    testId="mode-notes-block"
                    action={
                        <div className="flex items-center gap-1.5">
                            {noteTemplates.length > 0 && (
                                // Acts as a menu: picking one replaces the sections and
                                // the trigger goes back to its placeholder.
                                <AipSelect
                                    value=""
                                    label={t('Use a template')}
                                    placeholder={t('Use a template')}
                                    disabled={!canEdit}
                                    options={noteTemplates.map((tpl) => ({ id: tpl.id, name: tpl.name }))}
                                    onChange={(id) => { if (id) void applyTemplate(id); }}
                                    className="text-xs"
                                />
                            )}
                            <button
                                type="button"
                                onClick={() => void addSection()}
                                disabled={!canEdit}
                                data-testid="mode-add-section"
                                className={`${SETTINGS_BTN} px-2 py-1 text-xs`}
                            >
                                <Plus className="mr-1 inline h-3 w-3" />
                                {t('Add section')}
                            </button>
                        </div>
                    }
                >
                    {loadingSections ? (
                        <p className="text-xs text-text-tertiary">{t('Loading…')}</p>
                    ) : sections.length === 0 ? (
                        <p className="text-xs text-text-tertiary" data-testid="mode-notes-empty">
                            {t('No sections. Notes for this mode use the generic summary shape.')}
                        </p>
                    ) : (
                        <div className="space-y-1.5">
                            {sections.map((section) => (
                                <div key={section.id} className={`${SETTINGS_WELL} bg-bg-component px-3 py-2`} data-testid={`mode-section-${section.id}`}>
                                    <div className="flex items-center gap-2">
                                        <input
                                            defaultValue={section.title}
                                            disabled={!canEdit}
                                            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== section.title) void patchSection(section.id, { title: v }); }}
                                            aria-label={t('Section title')}
                                            className="min-w-0 flex-1 border-none bg-transparent p-0 text-sm font-medium text-text-primary outline-none disabled:opacity-70"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => void dropSection(section.id)}
                                            disabled={!canEdit}
                                            title={t('Delete section')}
                                            aria-label={t('Delete section')}
                                            className="rounded p-1 text-text-tertiary transition-colors hover:text-red-500 disabled:opacity-40"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                    <input
                                        defaultValue={section.description}
                                        disabled={!canEdit}
                                        onBlur={(e) => { if (e.target.value !== section.description) void patchSection(section.id, { description: e.target.value }); }}
                                        placeholder={t('What belongs in this section')}
                                        aria-label={t('Section description')}
                                        className="mt-0.5 w-full border-none bg-transparent p-0 text-[11px] leading-relaxed text-text-secondary outline-none placeholder:text-text-tertiary disabled:opacity-70"
                                    />
                                </div>
                            ))}
                            <button
                                type="button"
                                onClick={() => void clearSections()}
                                disabled={!canEdit}
                                className="mt-1 text-[11px] text-text-tertiary underline decoration-dotted hover:text-red-500 disabled:opacity-40"
                            >
                                {t('Remove all sections')}
                            </button>
                        </div>
                    )}
                </Block>

                {/* Reference files */}
                <Block
                    title={t('Reference files')}
                    hint={t('Documents this mode may quote. Indexed locally; nothing is uploaded.')}
                    testId="mode-files-block"
                    action={
                        <button
                            type="button"
                            onClick={() => void upload()}
                            disabled={!canEdit}
                            data-testid="mode-upload-file"
                            className={`${SETTINGS_BTN} px-2 py-1 text-xs`}
                        >
                            <Upload className="mr-1 inline h-3 w-3" />
                            {t('Add file')}
                        </button>
                    }
                >
                    {files.length === 0 ? (
                        <p className="text-xs text-text-tertiary" data-testid="mode-files-empty">
                            {t('No files. This mode answers from the conversation only.')}
                        </p>
                    ) : (
                        <div className="space-y-1">
                            {files.map((file) => (
                                <div key={file.id} className="flex items-center gap-2 rounded-lg px-1 py-1" data-testid={`mode-file-${file.id}`}>
                                    <FileText className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                                    <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{file.fileName}</span>
                                    {statusBadge(file.id)}
                                    <button
                                        type="button"
                                        onClick={() => void dropFile(file.id)}
                                        disabled={!canEdit}
                                        title={t('Remove file')}
                                        aria-label={t('Remove file')}
                                        className="rounded p-1 text-text-tertiary transition-colors hover:text-red-500 disabled:opacity-40"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </Block>

                {/* Answer policy */}
                <Block
                    title={t('Answer policy')}
                    hint={t('Enforced by the backend for this mode. Read-only — it follows from the template.')}
                    testId="mode-policy-block"
                >
                    {!contract ? (
                        <p className="text-xs text-text-tertiary">{t('Loading…')}</p>
                    ) : (
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                            <dt className="text-text-tertiary">{t('Authority')}</dt>
                            <dd className="text-text-primary" data-testid="mode-policy-authority">{contract.sourceAuthority ?? t('Template default')}</dd>
                            <dt className="text-text-tertiary">{t('Owns the answer')}</dt>
                            <dd className="text-text-primary">{contract.defaultOwner ?? t('Template default')}</dd>
                            <dt className="text-text-tertiary">{t('Evidence required')}</dt>
                            <dd className="text-text-primary">{contract.evidenceRequired ? t('Yes') : t('No')}</dd>
                            {contract.groundingProfile?.evidencePreference && (
                                <>
                                    <dt className="text-text-tertiary">{t('Grounding')}</dt>
                                    <dd className="text-text-primary">
                                        {contract.groundingProfile.evidencePreference}
                                        {contract.groundingProfile.onNoEvidence ? ` · ${contract.groundingProfile.onNoEvidence}` : ''}
                                    </dd>
                                </>
                            )}
                        </dl>
                    )}
                    {!access.allowed && (
                        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-600">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                            {t('Read-only until modes are unlocked on this build.')}
                        </p>
                    )}
                </Block>
            </div>
        </div>
    );
};
