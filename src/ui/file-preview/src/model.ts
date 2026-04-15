import type { DocumentOutlineItem } from './document-outline.js';
import type { FilePreviewStructuredContent } from '../../../types.js';
import type { MarkdownEditorView } from './markdown/editor.js';

export type RenderPayload = FilePreviewStructuredContent & { content: string };

export interface MarkdownWorkspaceState {
    filePath: string;
    sourceContent: string;
    fullDocumentContent: string;
    draftContent: string;
    outline: DocumentOutlineItem[];
    pendingExternalPayload: RenderPayload | null;
    mode: 'edit';
    dirty: boolean;
    activeHeadingId: string | null;
    pendingAnchor: string | null;
    notice: string | null;
    error: string | null;
    saving: boolean;
    loadingDocument: boolean;
    editorView: MarkdownEditorView;
    editorScrollTop: number;
    saveIndicator: 'idle' | 'saving' | 'saved';
    fileDeleted: boolean;
}

export interface RenderBodyResult {
    html: string;
    notice?: string;
}

export interface FileTypeCapabilities {
    supportsPreview: boolean;
    canCopy: boolean;
    canOpenInFolder: boolean;
}
