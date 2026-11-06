// "New mode": pick a template, or describe the mode and let the backend draft it.
//
// The template list is the backend's (modesGetTemplateCatalog), so a template
// added on the main-process side shows up here with no renderer change — the
// failure mode this replaces is documented in modesCatalog.ts.
//
// General is offered as its own card rather than as part of the gallery: it is
// the template with no sources, i.e. the empty starting point.
import React, { useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useT } from '../../i18n';
import { SETTINGS_BTN, SETTINGS_INPUT } from '../settings/SettingsRow';
import { templateBlurb } from './modesCatalog';
import type { TemplateCatalogEntry } from './modesTypes';

interface Props {
    catalog: TemplateCatalogEntry[];
    onCancel: () => void;
    /**
     * Creates the mode and resolves with the new id, or with an error message.
     * The panel owns the IPC call so this dialog stays presentational.
     */
    onCreate: (params: { name: string; templateType: string }) => Promise<{ ok: boolean; id?: string; error?: string }>;
    onGenerate: (brief: string) => Promise<{ ok: boolean; id?: string; error?: string }>;
}

export const NewModeDialog: React.FC<Props> = ({ catalog, onCancel, onCreate, onGenerate }) => {
    const t = useT();
    const [busy, setBusy] = useState<string | null>(null);
    const [brief, setBrief] = useState('');
    const [error, setError] = useState('');

    const templates = useMemo(
        () => catalog.filter((entry) => entry.type !== 'general'),
        [catalog],
    );
    const general = catalog.find((entry) => entry.type === 'general');

    const create = async (type: string, name: string) => {
        setBusy(type);
        setError('');
        const res = await onCreate({ name, templateType: type });
        setBusy(null);
        if (!res.ok) setError(res.error ?? t('Could not create the mode.'));
    };

    const generate = async () => {
        if (brief.trim().length < 8) {
            setError(t('Describe the mode in a sentence or two.'));
            return;
        }
        setBusy('__brief');
        setError('');
        const res = await onGenerate(brief.trim());
        setBusy(null);
        if (!res.ok) setError(res.error ?? t('Could not draft that mode.'));
    };

    return (
        <div className="absolute inset-0 z-20 flex flex-col bg-bg-elevated/95 backdrop-blur-sm" data-testid="modes-new-dialog">
            <div className="flex items-start justify-between gap-3 px-5 pt-5">
                <div>
                    <h2 className="text-base font-semibold text-text-primary">{t('New mode')}</h2>
                    <p className="mt-1 text-[11px] leading-relaxed text-text-tertiary">
                        {t('A mode decides what an answer may use and how it is shaped. The template is fixed once the mode exists.')}
                    </p>
                </div>
                <button type="button" onClick={onCancel} className={`${SETTINGS_BTN} px-3 py-1.5 text-xs`} data-testid="modes-new-cancel">
                    {t('Cancel')}
                </button>
            </div>

            <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-5">
                <div className="grid grid-cols-2 gap-2" data-testid="modes-template-gallery">
                    {general && (
                        <button
                            type="button"
                            data-testid={`modes-template-${general.type}`}
                            disabled={busy !== null}
                            onClick={() => void create(general.type, t('New mode'))}
                            className={`col-span-2 rounded-xl bg-bg-component p-3 text-left transition-colors hover:bg-bg-elevated disabled:opacity-60`}
                        >
                            <div className="text-sm font-medium text-text-primary">{t('Start from empty mode')}</div>
                            <div className="mt-0.5 text-[11px] leading-relaxed text-text-tertiary">
                                {t('No sources, generic summary. Everything is set by hand.')}
                            </div>
                        </button>
                    )}
                    {templates.map((entry) => (
                        <button
                            key={entry.type}
                            type="button"
                            data-testid={`modes-template-${entry.type}`}
                            disabled={busy !== null}
                            onClick={() => void create(entry.type, entry.label)}
                            className={`rounded-xl bg-bg-component p-3 text-left transition-colors hover:bg-bg-elevated disabled:opacity-60`}
                        >
                            <div className="text-sm font-medium text-text-primary">{entry.label}</div>
                            <div className="mt-0.5 text-[11px] leading-relaxed text-text-tertiary">
                                {templateBlurb(entry.type, entry.sections)}
                            </div>
                        </button>
                    ))}
                </div>

                <div className="mt-5 border-t border-border-subtle pt-4">
                    <h3 className="text-sm font-semibold text-text-primary">{t('Or describe it')}</h3>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-text-tertiary">
                        {t('One or two sentences about the situation and how the answers should read. You review the result before using it.')}
                    </p>
                    <div className="mt-2 flex items-start gap-2">
                        <input
                            value={brief}
                            onChange={(e) => setBrief(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') void generate(); }}
                            placeholder={t('e.g. Senior backend interview — concise expert answers with tradeoffs')}
                            data-testid="modes-brief"
                            className={`${SETTINGS_INPUT} min-w-0 flex-1 px-3 py-2 text-sm`}
                        />
                        <button
                            type="button"
                            onClick={() => void generate()}
                            disabled={busy !== null}
                            data-testid="modes-generate"
                            className={`${SETTINGS_BTN} shrink-0 px-3 py-2 text-xs`}
                        >
                            <Sparkles className="mr-1 inline h-3.5 w-3.5" />
                            {busy === '__brief' ? t('Drafting…') : t('Draft it')}
                        </button>
                    </div>
                </div>

                {error && (
                    <p className="mt-3 text-xs text-red-500" data-testid="modes-new-error">{error}</p>
                )}
            </div>
        </div>
    );
};
