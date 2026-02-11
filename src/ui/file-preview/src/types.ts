/**
 * Type definitions for File Preview structured content, rendering modes, and host message contracts. These types keep render decisions and RPC payload handling explicit.
 */
import type { PreviewFileType } from '../shared/preview-file-types.js';

export interface PreviewStructuredContent {
    fileName: string;
    filePath: string;
    fileType: PreviewFileType;
    content: string;
}

export type HtmlPreviewMode = 'rendered' | 'source';
