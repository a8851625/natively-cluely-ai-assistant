// Types shared by the Modes Manager panel and its parts. Mirrors what the
// preload surface returns (electron/preload.ts › Modes API); kept here as plain
// shapes so no component has to reach into the main process for a type.

export interface ModeRow {
    id: string;
    name: string;
    templateType: string;
    customContext: string;
    isActive: boolean;
    createdAt: string;
    isBuiltin?: boolean;
    referenceFileCount: number;
}

export interface TemplateCatalogEntry {
    type: string;
    label: string;
    sections: Array<{ title: string; description: string }>;
}

export interface NoteTemplateEntry {
    id: string;
    name: string;
    group: string;
    sections: Array<{ title: string; description: string }>;
}

export interface MutationAccess {
    licenceActive: boolean;
    localUnlocked: boolean;
    allowed: boolean;
    via: 'licence' | 'local' | 'none';
}

export interface NoteSection {
    id: string;
    modeId: string;
    title: string;
    description: string;
    sortOrder: number;
}

export interface RefFile {
    id: string;
    modeId: string;
    fileName: string;
    content: string;
    createdAt: string;
}

export interface RefFileStatus {
    fileId: string;
    fileName: string;
    /** ready | lexical_only | indexing | failed */
    status: string;
    chunkCount: number;
}

/** The parts of ModeSourceContract the panel shows. */
export interface SourceContractView {
    sourceAuthority?: string;
    defaultOwner?: string;
    evidenceRequired?: boolean;
    conflictPolicy?: string;
    memoryPolicy?: {
        allowPriorAssistantFacts?: boolean;
        allowPriorAssistantReferents?: boolean;
        allowHindsight?: boolean;
    };
    groundingProfile?: {
        evidencePreference?: string;
        onNoEvidence?: string;
    };
}

export const EMPTY_ACCESS: MutationAccess = {
    licenceActive: false,
    localUnlocked: false,
    allowed: false,
    via: 'none',
};
