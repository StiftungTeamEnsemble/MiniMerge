export type SupportedFileMimeType =
  | "application/pdf"
  | "image/jpeg"
  | "image/png";

export interface SourceFile {
  id: string;
  name: string;
  buffer: Uint8Array;
  mimeType: SupportedFileMimeType;
}

export interface PdfPageNode {
  id: string;
  fileId: string;
  pageIndex: number; // 0-based
  thumbnailUrl: string | null; // generated lazily for grid view
  width: number;
  height: number;
  label?: string; // from getLabel()
}
