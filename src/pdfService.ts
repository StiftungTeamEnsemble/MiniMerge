import * as mupdf from "mupdf";
import type { PdfFile, PdfPageNode } from "./types";

function toBrowserUint8Array(
  data: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(data.byteLength));
  copy.set(data);
  return copy;
}

export async function parsePdfFile(
  file: File,
  fileId: string,
): Promise<{ pdfFile: PdfFile; pages: PdfPageNode[] }> {
  const arrayBuffer = await file.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);

  const doc = mupdf.Document.openDocument(buffer, file.type);
  const pages: PdfPageNode[] = [];
  const numPages = doc.countPages();
  const scale = 0.5; // thumbnail scale
  // Try scaling based on 72 dpi defaults. scale=0.5 -> 36dpi.
  const matrix = mupdf.Matrix.scale(scale, scale);
  const cs = mupdf.ColorSpace.DeviceRGB;

  for (let i = 0; i < numPages; i++) {
    const page = doc.loadPage(i);
    // get width, height bounds
    const bounds = page.getBounds();
    const width = bounds[2] - bounds[0];
    const height = bounds[3] - bounds[1];

    // Convert to pixmap
    const pixmap = page.toPixmap(matrix, cs, false);
    const pngData = toBrowserUint8Array(pixmap.asPNG());

    // Create Blob URL
    const blob = new Blob([pngData], { type: "image/png" });
    const url = URL.createObjectURL(blob);

    let label = "";
    try {
      label = page.getLabel(); // some pdfs have page labels (i, iv, 1, 2)
    } catch (e) {}

    pages.push({
      id: `${fileId}-p${i}`,
      fileId,
      pageIndex: i,
      thumbnailUrl: url,
      width,
      height,
      label,
    });
  }

  const pdfFile: PdfFile = {
    id: fileId,
    name: file.name,
    buffer,
  };

  return { pdfFile, pages };
}

export async function generateMergedPdf(
  pages: PdfPageNode[],
  pdfFiles: Record<string, PdfFile>,
): Promise<Uint8Array<ArrayBuffer>> {
  // We need to keep a map of opened documents to graft from
  const openedDocs: Record<string, mupdf.Document> = {};

  try {
    const finalPdf = new mupdf.PDFDocument();

    for (const pageNode of pages) {
      if (!openedDocs[pageNode.fileId]) {
        const f = pdfFiles[pageNode.fileId];
        openedDocs[pageNode.fileId] = mupdf.Document.openDocument(
          f.buffer,
          "application/pdf",
        );
      }

      const sourceDoc = openedDocs[pageNode.fileId];
      // Only PDF documents can be grafted.
      const sourcePdf = sourceDoc.asPDF(); // ensure it's PDF
      if (sourcePdf) {
        finalPdf.graftPage(-1, sourcePdf, pageNode.pageIndex);
      }
    }

    const outBuffer = finalPdf.saveToBuffer("");
    return toBrowserUint8Array(outBuffer.asUint8Array());
  } finally {
    // We don't really have to close since Wasm garbage collects or process ends
    // But better to free up if we had explicit cleanup.
  }
}
