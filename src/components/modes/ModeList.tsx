// The Modes Manager list: every mode, built-ins first in template order, with
// the active one marked. Selecting a row opens it in the detail pane; it does
// NOT activate it — activation is a separate, deliberate press in the detail
// header, because switching mode changes what every answer is grounded in and
// should not happen by browsing a list.
import React from 'react';
import { Check, Plus } from 'lucide-react';
import { useT } from '../../i18n';
import type { ModeRow, TemplateCatalogEntry } from './modesTypes';
import { orderModes } from './modesCatalog';

interface Props {
    modes: ModeRow[];
    selectedId: string | null;
    catalog: TemplateCatalogEntry[];
    onSelect: (id: string) => void;
    onNew: () => void;
    /** False while the build may not create modes — the button still shows why. */
    canMutate: boolean;
}

const labelFor = (catalog: TemplateCatalogEntry[], type: string): string =>
    catalog.find((t) => t.type === type)?.label ?? type;

export const ModeList: React.FC<Props> = ({ modes, selectedId, catalog, onSelect, onNew, canMutate }) => {
    const t = useT();
    const ordered = orderModes(modes);

    return (
        <div className="flex h-full min-h-0 flex-col" data-testid="modes-list">
            <div className="flex items-center justify-between px-1 pb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
                    {t('Modes')}
                </span>
                <button
                    type="button"
                    data-testid="modes-new"
                    onClick={onNew}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-component hover:text-text-primary"
                    title={canMutate ? t('New mode') : t('New mode')}
                >
                    <Plus className="h-3.5 w-3.5" />
                    {t('New mode')}
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1" role="listbox" aria-label={t('Modes')}>
                {ordered.map((mode) => {
                    const selected = mode.id === selectedId;
                    return (
                        <button
                            key={mode.id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            data-testid={`modes-row-${mode.id}`}
                            onClick={() => onSelect(mode.id)}
                            className={`mb-1 flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
                                selected
                                    ? 'border-border-subtle bg-bg-elevated'
                                    : 'border-transparent hover:bg-bg-component'
                            }`}
                        >
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="flex items-center gap-1.5">
                                    <span className="truncate text-sm font-medium text-text-primary">{mode.name}</span>
                                    {mode.isActive && (
                                        <Check
                                            className="h-3.5 w-3.5 shrink-0 text-emerald-500"
                                            aria-label={t('Active')}
                                            data-testid={`modes-active-${mode.id}`}
                                        />
                                    )}
                                </span>
                                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-tertiary">
                                    <span className="truncate">{labelFor(catalog, mode.templateType)}</span>
                                    {mode.referenceFileCount > 0 && (
                                        <>
                                            <span aria-hidden>·</span>
                                            <span className="shrink-0">
                                                {mode.referenceFileCount === 1
                                                    ? t('1 file')
                                                    : `${mode.referenceFileCount} ${t('files')}`}
                                            </span>
                                        </>
                                    )}
                                </span>
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
};
