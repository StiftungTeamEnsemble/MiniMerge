import * as mupdf from "mupdf";
import type { PdfPageNode, SourceFile, SupportedFileMimeType } from "./types";

const PDF_MIME_TYPE = "application/pdf";
const JPEG_MIME_TYPE = "image/jpeg";
const PNG_MIME_TYPE = "image/png";
const PDF_GENERATOR_URL = "https://minimerge.signalwerk.ch/";
const SRGB_PROFILE_URL = "/color-profiles/sRGB-IEC61966-2.1.icc";
const SRGB_PROFILE_NAME = "sRGB IEC61966-2.1";

export type ImageExportFormat = "png" | "jpeg";
export type ImageExportColorSpace = "gray" | "srgb";
export type ImageExportSizeMode = "dpi" | "width" | "height";

export interface ImageExportOptions {
  format: ImageExportFormat;
  colorSpace: ImageExportColorSpace;
  sizeMode: ImageExportSizeMode;
  value: number;
  jpegQuality?: number;
}

export interface ExportedPageImage {
  pageId: string;
  fileName: string;
  mimeType: SupportedFileMimeType;
  width: number;
  height: number;
  buffer: Uint8Array<ArrayBuffer>;
}

interface ResolvedExportColorSpace {
  colorSpace: mupdf.ColorSpace;
  needsDestroy: boolean;
}

export const FILE_INPUT_ACCEPT =
  ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";

function toBrowserUint8Array(
  data: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(data.byteLength));
  copy.set(data);
  return copy;
}

function getFileExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex === -1) {
    return "";
  }

  return name.slice(dotIndex).toLowerCase();
}

function getFileBaseName(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex === -1) {
    return name;
  }

  return name.slice(0, dotIndex);
}

export function getSupportedMimeType(
  file: Pick<File, "name" | "type">,
): SupportedFileMimeType | null {
  const normalizedType = file.type.toLowerCase();

  if (normalizedType === PDF_MIME_TYPE) {
    return PDF_MIME_TYPE;
  }

  if (normalizedType === PNG_MIME_TYPE) {
    return PNG_MIME_TYPE;
  }

  if (normalizedType === JPEG_MIME_TYPE || normalizedType === "image/jpg") {
    return JPEG_MIME_TYPE;
  }

  switch (getFileExtension(file.name)) {
    case ".pdf":
      return PDF_MIME_TYPE;
    case ".png":
      return PNG_MIME_TYPE;
    case ".jpg":
    case ".jpeg":
      return JPEG_MIME_TYPE;
    default:
      return null;
  }
}

export function isSupportedInputFile(
  file: Pick<File, "name" | "type">,
): boolean {
  return getSupportedMimeType(file) !== null;
}

function createBlobUrl(
  buffer: Uint8Array,
  mimeType: SupportedFileMimeType,
): string {
  return URL.createObjectURL(
    new Blob([toBrowserUint8Array(buffer)], { type: mimeType }),
  );
}

function sanitizeFilePart(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function getExportFileExtension(format: ImageExportFormat): "png" | "jpg" {
  switch (format) {
    case "jpeg":
      return "jpg";
    case "png":
    default:
      return "png";
  }
}

function getExportMimeType(format: ImageExportFormat): SupportedFileMimeType {
  switch (format) {
    case "jpeg":
      return JPEG_MIME_TYPE;
    case "png":
    default:
      return PNG_MIME_TYPE;
  }
}

export function getImageExportFormatsForColorSpace(
  colorSpace: ImageExportColorSpace,
): ImageExportFormat[] {
  void colorSpace;
  return ["png", "jpeg"];
}

export function getImageExportColorSpaceStatus(
  colorSpace: ImageExportColorSpace,
): { message: string | null } {
  switch (colorSpace) {
    case "srgb":
      return {
        message: "Rendered in the sRGB IEC61966-2.1 profile.",
      };
    case "gray":
    default:
      return {
        message: "Rendered as grayscale.",
      };
  }
}

const colorProfileCache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

async function loadColorProfile(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const existingProfile = colorProfileCache.get(url);
  if (existingProfile) {
    return existingProfile;
  }

  const profilePromise = fetch(url)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to load ICC profile: ${url}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    })
    .catch((error) => {
      colorProfileCache.delete(url);
      throw error;
    });

  colorProfileCache.set(url, profilePromise);
  return profilePromise;
}

async function resolveExportColorSpace(
  exportColorSpace: ImageExportColorSpace,
): Promise<ResolvedExportColorSpace> {
  switch (exportColorSpace) {
    case "gray":
      return {
        colorSpace: mupdf.ColorSpace.DeviceGray,
        needsDestroy: false,
      };
    case "srgb": {
      const profile = await loadColorProfile(SRGB_PROFILE_URL);
      return {
        colorSpace: new mupdf.ColorSpace(profile, SRGB_PROFILE_NAME),
        needsDestroy: true,
      };
    }
    default:
      return {
        colorSpace: mupdf.ColorSpace.DeviceRGB,
        needsDestroy: false,
      };
  }
}

function getRasterScale(
  sizeMode: ImageExportSizeMode,
  value: number,
  pageWidth: number,
  pageHeight: number,
): number {
  switch (sizeMode) {
    case "dpi":
      return value / 72;
    case "width":
      return value / pageWidth;
    case "height":
      return value / pageHeight;
    default:
      return 1;
  }
}

function getEffectiveResolution(
  sizeMode: ImageExportSizeMode,
  value: number,
  scale: number,
): number {
  if (sizeMode === "dpi") {
    return value;
  }

  return Math.max(1, Math.round(scale * 72));
}

function getExportFileName(
  page: PdfPageNode,
  pageIndex: number,
  sourceFile: SourceFile,
  format: ImageExportFormat,
): string {
  const fileBaseName = sanitizeFilePart(getFileBaseName(sourceFile.name));
  const pageLabel = sanitizeFilePart(
    page.label || `page-${page.pageIndex + 1}`,
  );
  const extension = getExportFileExtension(format);
  return `${String(pageIndex + 1).padStart(3, "0")}-${fileBaseName}-${pageLabel}.${extension}`;
}

function getPageLabel(page: mupdf.Page): string {
  try {
    return page.getLabel();
  } catch {
    return "";
  }
}

function renderPdfPageThumbnail(page: mupdf.Page): string {
  return renderPdfPageImage(page, 0.5);
}

function renderPdfPageImage(page: mupdf.Page, scale: number): string {
  const matrix = mupdf.Matrix.scale(scale, scale);
  const colorSpace = mupdf.ColorSpace.DeviceRGB;
  const pixmap = page.toPixmap(matrix, colorSpace, false);

  try {
    const pngData = toBrowserUint8Array(pixmap.asPNG());
    return createBlobUrl(pngData, PNG_MIME_TYPE);
  } finally {
    pixmap.destroy();
  }
}

function formatPdfNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(4).replace(/\.?0+$/, "");
}

function normalizeResolution(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function pixelsToPoints(pixels: number, resolution: number | null): number {
  if (!resolution) {
    return pixels;
  }

  return (pixels / resolution) * 72;
}

function buildImagePageContents(pageWidth: number, pageHeight: number): string {
  return `q\n${formatPdfNumber(pageWidth)} 0 0 ${formatPdfNumber(pageHeight)} 0 0 cm\n/Im0 Do\nQ`;
}

function appendImagePage(
  finalPdf: mupdf.PDFDocument,
  imageRef: mupdf.PDFObject,
  width: number,
  height: number,
  xResolution: number | null,
  yResolution: number | null,
): void {
  const pageWidth = pixelsToPoints(width, xResolution);
  const pageHeight = pixelsToPoints(height, yResolution);
  const resources = {
    XObject: {
      Im0: imageRef,
    },
  };
  const page = finalPdf.addPage(
    [0, 0, pageWidth, pageHeight],
    0,
    resources,
    buildImagePageContents(pageWidth, pageHeight),
  );

  finalPdf.insertPage(-1, page);
}

function appendImageSource(
  finalPdf: mupdf.PDFDocument,
  sourceFile: SourceFile,
): void {
  const image = new mupdf.Image(sourceFile.buffer);
  try {
    const imageRef = finalPdf.addImage(image);
    appendImagePage(
      finalPdf,
      imageRef,
      image.getWidth(),
      image.getHeight(),
      normalizeResolution(image.getXResolution()),
      normalizeResolution(image.getYResolution()),
    );
  } finally {
    image.destroy();
  }
}

function parsePdfDocument(buffer: Uint8Array, fileId: string): PdfPageNode[] {
  const doc = mupdf.Document.openDocument(buffer, PDF_MIME_TYPE);
  try {
    const pages: PdfPageNode[] = [];
    const numPages = doc.countPages();

    for (let i = 0; i < numPages; i += 1) {
      const page = doc.loadPage(i);
      try {
        const bounds = page.getBounds();
        const width = bounds[2] - bounds[0];
        const height = bounds[3] - bounds[1];
        pages.push({
          id: `${fileId}-p${i}`,
          fileId,
          pageIndex: i,
          thumbnailUrl: null,
          width,
          height,
          label: getPageLabel(page),
        });
      } finally {
        page.destroy();
      }
    }

    return pages;
  } finally {
    doc.destroy();
  }
}

function parseImageDocument(buffer: Uint8Array, fileId: string): PdfPageNode[] {
  const image = new mupdf.Image(buffer);

  try {
    return [
      {
        id: `${fileId}-p0`,
        fileId,
        pageIndex: 0,
        thumbnailUrl: null,
        width: image.getWidth(),
        height: image.getHeight(),
        label: "1",
      },
    ];
  } finally {
    image.destroy();
  }
}

export async function parseInputFile(
  file: File,
  fileId: string,
): Promise<{ sourceFile: SourceFile; pages: PdfPageNode[] }> {
  const mimeType = getSupportedMimeType(file);

  if (!mimeType) {
    throw new Error(`Unsupported file type: ${file.name}`);
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);
  const pages =
    mimeType === PDF_MIME_TYPE
      ? parsePdfDocument(buffer, fileId)
      : parseImageDocument(buffer, fileId);

  const sourceFile: SourceFile = {
    id: fileId,
    name: file.name,
    buffer,
    mimeType,
  };

  return { sourceFile, pages };
}

export async function generatePageThumbnails(
  pages: PdfPageNode[],
  sourceFiles: Record<string, SourceFile>,
): Promise<Record<string, string>> {
  const openedDocs: Record<string, mupdf.Document> = {};

  try {
    const thumbnailUrlsByPageId: Record<string, string> = {};

    for (const page of pages) {
      if (page.thumbnailUrl) {
        continue;
      }

      const sourceFile = sourceFiles[page.fileId];
      if (!sourceFile) {
        continue;
      }

      if (sourceFile.mimeType === PDF_MIME_TYPE) {
        if (!openedDocs[page.fileId]) {
          openedDocs[page.fileId] = mupdf.Document.openDocument(
            sourceFile.buffer,
            PDF_MIME_TYPE,
          );
        }

        const pdfPage = openedDocs[page.fileId].loadPage(page.pageIndex);
        try {
          thumbnailUrlsByPageId[page.id] = renderPdfPageThumbnail(pdfPage);
        } finally {
          pdfPage.destroy();
        }
        continue;
      }

      thumbnailUrlsByPageId[page.id] = createBlobUrl(
        sourceFile.buffer,
        sourceFile.mimeType,
      );
    }

    return thumbnailUrlsByPageId;
  } finally {
    for (const doc of Object.values(openedDocs)) {
      doc.destroy();
    }
  }
}

export async function generatePagePreview(
  page: PdfPageNode,
  sourceFiles: Record<string, SourceFile>,
): Promise<string | null> {
  const sourceFile = sourceFiles[page.fileId];
  if (!sourceFile) {
    return null;
  }

  if (sourceFile.mimeType !== PDF_MIME_TYPE) {
    return createBlobUrl(sourceFile.buffer, sourceFile.mimeType);
  }

  const doc = mupdf.Document.openDocument(sourceFile.buffer, PDF_MIME_TYPE);
  try {
    const pdfPage = doc.loadPage(page.pageIndex);
    try {
      return renderPdfPageImage(pdfPage, 1.5);
    } finally {
      pdfPage.destroy();
    }
  } finally {
    doc.destroy();
  }
}

export async function generateMergedPdf(
  pages: PdfPageNode[],
  sourceFiles: Record<string, SourceFile>,
): Promise<Uint8Array<ArrayBuffer>> {
  const openedDocs: Record<string, mupdf.Document> = {};

  try {
    const finalPdf = new mupdf.PDFDocument();
    finalPdf.setMetaData(
      mupdf.Document.META_INFO_CREATOR,
      `MiniMerge ${PDF_GENERATOR_URL}`,
    );
    finalPdf.setMetaData(
      mupdf.Document.META_INFO_PRODUCER,
      `MiniMerge ${PDF_GENERATOR_URL}`,
    );

    for (const pageNode of pages) {
      const sourceFile = sourceFiles[pageNode.fileId];
      if (!sourceFile) {
        continue;
      }

      if (sourceFile.mimeType === PDF_MIME_TYPE) {
        if (!openedDocs[pageNode.fileId]) {
          openedDocs[pageNode.fileId] = mupdf.Document.openDocument(
            sourceFile.buffer,
            PDF_MIME_TYPE,
          );
        }

        const sourcePdf = openedDocs[pageNode.fileId].asPDF();
        if (sourcePdf) {
          finalPdf.graftPage(-1, sourcePdf, pageNode.pageIndex);
        }
        continue;
      }

      appendImageSource(finalPdf, sourceFile);
    }

    const outBuffer = finalPdf.saveToBuffer("");
    return toBrowserUint8Array(outBuffer.asUint8Array());
  } finally {
    for (const doc of Object.values(openedDocs)) {
      doc.destroy();
    }
  }
}

export async function exportPagesAsImages(
  pages: PdfPageNode[],
  sourceFiles: Record<string, SourceFile>,
  options: ImageExportOptions,
): Promise<ExportedPageImage[]> {
  const openedDocs: Record<string, mupdf.Document> = {};
  const availableFormats = getImageExportFormatsForColorSpace(
    options.colorSpace,
  );

  if (!availableFormats.includes(options.format)) {
    throw new Error(
      `The ${options.colorSpace} export mode only supports ${availableFormats.join(", ")}.`,
    );
  }

  const resolvedColorSpace = await resolveExportColorSpace(options.colorSpace);

  try {
    const exportedImages: ExportedPageImage[] = [];

    for (const [index, pageNode] of pages.entries()) {
      const sourceFile = sourceFiles[pageNode.fileId];
      if (!sourceFile) {
        continue;
      }

      if (!openedDocs[pageNode.fileId]) {
        openedDocs[pageNode.fileId] = mupdf.Document.openDocument(
          sourceFile.buffer,
          sourceFile.mimeType,
        );
      }

      const sourcePage = openedDocs[pageNode.fileId].loadPage(
        pageNode.pageIndex,
      );
      try {
        const bounds = sourcePage.getBounds();
        const pageWidth = bounds[2] - bounds[0];
        const pageHeight = bounds[3] - bounds[1];
        const scale = getRasterScale(
          options.sizeMode,
          options.value,
          pageWidth,
          pageHeight,
        );
        const renderMatrix = mupdf.Matrix.scale(scale, scale);
        const pixmap = sourcePage.toPixmap(
          renderMatrix,
          resolvedColorSpace.colorSpace,
          false,
        );

        try {
          const effectiveResolution = getEffectiveResolution(
            options.sizeMode,
            options.value,
            scale,
          );
          pixmap.setResolution(effectiveResolution, effectiveResolution);

          const imageBuffer =
            options.format === "png"
              ? toBrowserUint8Array(pixmap.asPNG())
              : toBrowserUint8Array(pixmap.asJPEG(options.jpegQuality ?? 82));

          exportedImages.push({
            pageId: pageNode.id,
            fileName: getExportFileName(
              pageNode,
              index,
              sourceFile,
              options.format,
            ),
            mimeType: getExportMimeType(options.format),
            width: pixmap.getWidth(),
            height: pixmap.getHeight(),
            buffer: imageBuffer,
          });
        } finally {
          pixmap.destroy();
        }
      } finally {
        sourcePage.destroy();
      }
    }

    return exportedImages;
  } finally {
    if (resolvedColorSpace.needsDestroy) {
      resolvedColorSpace.colorSpace.destroy();
    }

    for (const doc of Object.values(openedDocs)) {
      doc.destroy();
    }
  }
}
