import {
  startTransition,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import type {
  ChangeEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  Command,
  Upload,
  Grid as GridIcon,
  List as ListIcon,
  Download,
  ImageDown,
  Trash2,
  FileText,
  X,
} from "lucide-react";
import {
  FILE_INPUT_ACCEPT,
  exportPagesAsImages,
  generateMergedPdf,
  getImageExportColorSpaceStatus,
  getImageExportFormatsForColorSpace,
  generatePagePreview,
  generatePageThumbnails,
  isSupportedInputFile,
  parseInputFile,
} from "./pdfService";
import type {
  ImageExportColorSpace,
  ImageExportFormat,
  ImageExportOptions,
  ImageExportSizeMode,
} from "./pdfService";
import type { PdfPageNode, SourceFile } from "./types";
import { buildZipArchive } from "./zipService";
import "./App.css";

function clampInsertionIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}

function isFileDrag(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer
    ? Array.from(dataTransfer.types).includes("Files")
    : false;
}

function getSupportedDraggedFiles(dataTransfer: DataTransfer): File[] {
  return Array.from(dataTransfer.files).filter(isSupportedInputFile);
}

function getDropInsertionIndex(
  container: HTMLElement | null,
  viewMode: "grid" | "list",
  clientX: number,
  clientY: number,
): number | null {
  if (!container) {
    return null;
  }

  const pageElements = Array.from(
    container.querySelectorAll<HTMLElement>(".page-card"),
  );
  if (pageElements.length === 0) {
    return 0;
  }

  if (viewMode === "list") {
    for (const [index, element] of pageElements.entries()) {
      const rect = element.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return index;
      }
    }

    return pageElements.length;
  }

  const rows: Array<{
    top: number;
    bottom: number;
    items: Array<{ element: HTMLElement; index: number }>;
  }> = [];
  const rowTolerance = 8;

  pageElements.forEach((element, index) => {
    const rect = element.getBoundingClientRect();
    const lastRow = rows[rows.length - 1];

    if (!lastRow || Math.abs(rect.top - lastRow.top) > rowTolerance) {
      rows.push({
        top: rect.top,
        bottom: rect.bottom,
        items: [{ element, index }],
      });
      return;
    }

    lastRow.bottom = Math.max(lastRow.bottom, rect.bottom);
    lastRow.items.push({ element, index });
  });

  const targetRow =
    rows.find((row, index) => {
      const nextRow = rows[index + 1];
      const rowBoundary = nextRow
        ? row.bottom + (nextRow.top - row.bottom) / 2
        : Number.POSITIVE_INFINITY;
      return clientY < rowBoundary;
    }) ?? rows[rows.length - 1];

  for (const { element, index } of targetRow.items) {
    const rect = element.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      return index;
    }
  }

  return targetRow.items[targetRow.items.length - 1].index + 1;
}

function moveSelectedPages(
  currentPages: PdfPageNode[],
  selectedPageIds: Set<string>,
  insertionIndex: number,
): PdfPageNode[] {
  const pagesToMove = currentPages.filter((page) =>
    selectedPageIds.has(page.id),
  );
  if (pagesToMove.length === 0) {
    return currentPages;
  }

  const remainingPages = currentPages.filter(
    (page) => !selectedPageIds.has(page.id),
  );
  const selectedPagesBeforeInsertion = currentPages
    .slice(0, insertionIndex)
    .filter((page) => selectedPageIds.has(page.id)).length;
  const adjustedInsertionIndex = clampInsertionIndex(
    insertionIndex - selectedPagesBeforeInsertion,
    remainingPages.length,
  );
  const reorderedPages = [...remainingPages];
  reorderedPages.splice(adjustedInsertionIndex, 0, ...pagesToMove);
  return reorderedPages;
}

const THUMBNAIL_FLUSH_INTERVAL_MS = 500;
const THUMBNAIL_RENDER_BATCH_SIZE = 8;
const TOUCH_DRAG_THRESHOLD_PX = 10;
const AUTO_SCROLL_EDGE_PX = 96;
const AUTO_SCROLL_MAX_SPEED_PX = 24;
const DOWNLOAD_SELECTED_PAGES_COMMAND = "download-selected-pages-as-images";

interface ImageExportFormState {
  colorSpace: ImageExportColorSpace;
  format: ImageExportFormat;
  sizeMode: ImageExportSizeMode;
  value: string;
  jpegQualityPreset: "low" | "medium" | "high" | "custom";
  jpegQualityCustomValue: string;
}

const DEFAULT_IMAGE_EXPORT_FORM: ImageExportFormState = {
  colorSpace: "srgb",
  format: "png",
  sizeMode: "dpi",
  value: "150",
  jpegQualityPreset: "medium",
  jpegQualityCustomValue: "82",
};

function parsePositiveNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function getImageExportArchiveName(format: ImageExportFormat): string {
  return `selected-pages-${format}-export.zip`;
}

function getImageExportFormatLabel(format: ImageExportFormat): string {
  switch (format) {
    case "jpeg":
      return "JPEG";
    case "png":
    default:
      return "PNG";
  }
}

function getImageExportColorSpaceLabel(
  colorSpace: ImageExportColorSpace,
): string {
  switch (colorSpace) {
    case "gray":
      return "Gray";
    case "srgb":
    default:
      return "sRGB";
  }
}

function getJpegQualityPresetValue(
  preset: ImageExportFormState["jpegQualityPreset"],
): number | null {
  switch (preset) {
    case "low":
      return 60;
    case "medium":
      return 82;
    case "high":
      return 92;
    case "custom":
    default:
      return null;
  }
}

function getSizeModeLabel(sizeMode: ImageExportSizeMode): string {
  switch (sizeMode) {
    case "width":
      return "Target width (px)";
    case "height":
      return "Target height (px)";
    case "dpi":
    default:
      return "Resolution (dpi)";
  }
}

function getSizeModeHint(sizeMode: ImageExportSizeMode): string {
  switch (sizeMode) {
    case "width":
      return "Each page gets this width. Height is calculated automatically.";
    case "height":
      return "Each page gets this height. Width is calculated automatically.";
    case "dpi":
    default:
      return "Pixel dimensions are calculated from each page size at this DPI.";
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export default function App() {
  const [pages, setPages] = useState<PdfPageNode[]>([]);
  const [sourceFiles, setSourceFiles] = useState<Record<string, SourceFile>>(
    {},
  );
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedPageIds, setSelectedPageIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(
    null,
  );
  const [selectionAnchorSnapshotIds, setSelectionAnchorSnapshotIds] = useState<
    Set<string>
  >(new Set());
  const [processingTask, setProcessingTask] = useState<
    "files" | "merge-pdf" | "export-images" | null
  >(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [draggedPageId, setDraggedPageId] = useState<string | null>(null);
  const [dropInsertionIndex, setDropInsertionIndex] = useState<number | null>(
    null,
  );
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [isImageExportDialogOpen, setIsImageExportDialogOpen] = useState(false);
  const [imageExportForm, setImageExportForm] = useState<ImageExportFormState>(
    DEFAULT_IMAGE_EXPORT_FORM,
  );
  const [imageExportError, setImageExportError] = useState<string | null>(null);
  const emptyFileInputRef = useRef<HTMLInputElement>(null);
  const commandPaletteInputRef = useRef<HTMLInputElement>(null);
  const imageExportValueInputRef = useRef<HTMLInputElement>(null);
  const pageCollectionRef = useRef<HTMLDivElement>(null);
  const pendingThumbnailPageIdsRef = useRef<Set<string>>(new Set());
  const isThumbnailGenerationActiveRef = useRef(false);
  const pagesRef = useRef<PdfPageNode[]>([]);
  const viewModeRef = useRef<"grid" | "list">("grid");
  const previewImageUrlsRef = useRef<Record<string, string>>({});
  const suppressClickUntilRef = useRef(0);
  const activeTouchPointersRef = useRef<Map<number, string>>(new Map());
  const touchDragStateRef = useRef<{
    pointerId: number;
    pageId: string;
    startX: number;
    startY: number;
    isDragging: boolean;
  } | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const dragPointerRef = useRef<{ clientX: number; clientY: number } | null>(
    null,
  );
  const autoScrollDragModeRef = useRef<"page" | "file" | null>(null);

  pagesRef.current = pages;
  viewModeRef.current = viewMode;

  const selectedSinglePageId =
    selectedPageIds.size === 1
      ? (selectedPageIds.values().next().value ?? null)
      : null;
  const selectedSinglePage =
    selectedSinglePageId !== null
      ? (pages.find((page) => page.id === selectedSinglePageId) ?? null)
      : null;
  const selectedPages = pages.filter((page) => selectedPageIds.has(page.id));
  const isProcessing = processingTask !== null;
  const availableImageExportFormats = getImageExportFormatsForColorSpace(
    imageExportForm.colorSpace,
  );
  const imageExportColorSpaceStatus = getImageExportColorSpaceStatus(
    imageExportForm.colorSpace,
  );

  const selectSinglePage = useCallback((pageId: string) => {
    const nextSelectedIds = new Set([pageId]);
    setSelectedPageIds(nextSelectedIds);
    setSelectionAnchorId(pageId);
    setSelectionAnchorSnapshotIds(nextSelectedIds);
  }, []);

  const suppressUpcomingClick = useCallback((durationMs = 400) => {
    suppressClickUntilRef.current =
      durationMs === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Date.now() + durationMs;
  }, []);

  const selectRangeBetween = useCallback(
    (anchorId: string, pageId: string, baseSelectionIds?: Set<string>) => {
      const anchorIndex = pages.findIndex((page) => page.id === anchorId);
      const currentIndex = pages.findIndex((page) => page.id === pageId);
      if (anchorIndex === -1 || currentIndex === -1) {
        return false;
      }

      const start = Math.min(anchorIndex, currentIndex);
      const end = Math.max(anchorIndex, currentIndex);
      const nextSelectedIds = baseSelectionIds
        ? new Set(baseSelectionIds)
        : new Set<string>();

      for (let i = start; i <= end; i += 1) {
        nextSelectedIds.add(pages[i].id);
      }

      setSelectedPageIds(nextSelectedIds);
      setSelectionAnchorId(anchorId);
      setSelectionAnchorSnapshotIds(
        baseSelectionIds ? new Set(baseSelectionIds) : new Set([anchorId]),
      );
      return true;
    },
    [pages],
  );

  const closePreview = useCallback(() => {
    setIsPreviewOpen(false);
    setIsPreviewLoading(false);
  }, []);

  const openPreview = useCallback(() => {
    if (!selectedSinglePageId) {
      return;
    }

    setIsPreviewOpen(true);
  }, [selectedSinglePageId]);

  const openPreviewForPage = useCallback(
    (pageId: string) => {
      selectSinglePage(pageId);
      setIsPreviewOpen(true);
    },
    [selectSinglePage],
  );

  const closeCommandPalette = useCallback(() => {
    setIsCommandPaletteOpen(false);
    setCommandPaletteQuery("");
  }, []);

  const closeImageExportDialog = useCallback(() => {
    setIsImageExportDialogOpen(false);
    setImageExportError(null);
  }, []);

  const openCommandPalette = useCallback(() => {
    setImageExportError(null);
    setIsImageExportDialogOpen(false);
    setIsCommandPaletteOpen(true);
  }, []);

  const openImageExportDialog = useCallback(() => {
    if (selectedPages.length === 0) {
      return;
    }

    setImageExportError(null);
    setIsCommandPaletteOpen(false);
    setCommandPaletteQuery("");
    setIsImageExportDialogOpen(true);
  }, [selectedPages.length]);

  const commandPaletteCommands = [
    {
      id: DOWNLOAD_SELECTED_PAGES_COMMAND,
      title: "Download selected pages as images",
      description:
        selectedPages.length > 0
          ? `Export ${selectedPages.length} selected page${selectedPages.length === 1 ? "" : "s"} with format, profile and resolution controls.`
          : "Select one or more pages to enable this export command.",
      disabled: selectedPages.length === 0,
    },
  ];

  const filteredCommandPaletteCommands = commandPaletteCommands.filter(
    (command) => {
      const query = commandPaletteQuery.trim().toLowerCase();
      if (!query) {
        return true;
      }

      return `${command.title} ${command.description}`
        .toLowerCase()
        .includes(query);
    },
  );

  const handleRunCommand = useCallback(
    (commandId: string) => {
      if (commandId === DOWNLOAD_SELECTED_PAGES_COMMAND) {
        openImageExportDialog();
      }
    },
    [openImageExportDialog],
  );

  const navigateSingleSelection = useCallback(
    (offset: number) => {
      if (!selectedSinglePageId) {
        return false;
      }

      const currentIndex = pages.findIndex(
        (page) => page.id === selectedSinglePageId,
      );
      if (currentIndex === -1) {
        return false;
      }

      const nextIndex = currentIndex + offset;
      if (nextIndex < 0 || nextIndex >= pages.length) {
        return false;
      }

      selectSinglePage(pages[nextIndex].id);
      return true;
    },
    [pages, selectSinglePage, selectedSinglePageId],
  );

  const clearSelection = useCallback(() => {
    setSelectedPageIds(new Set());
    setSelectionAnchorId(null);
    setSelectionAnchorSnapshotIds(new Set());
  }, []);

  const updateDropInsertionFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const insertionIndex = getDropInsertionIndex(
        pageCollectionRef.current,
        viewModeRef.current,
        clientX,
        clientY,
      );
      setDropInsertionIndex(insertionIndex ?? pagesRef.current.length);
    },
    [],
  );

  const stopAutoScroll = useCallback(() => {
    autoScrollDragModeRef.current = null;
    dragPointerRef.current = null;

    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  }, []);

  const runAutoScroll = useCallback(() => {
    autoScrollFrameRef.current = null;

    if (!autoScrollDragModeRef.current || !dragPointerRef.current) {
      return;
    }

    const { clientX, clientY } = dragPointerRef.current;
    const viewportHeight = window.innerHeight;
    let scrollDelta = 0;

    if (clientY < AUTO_SCROLL_EDGE_PX) {
      const intensity = (AUTO_SCROLL_EDGE_PX - clientY) / AUTO_SCROLL_EDGE_PX;
      scrollDelta = -Math.ceil(intensity * AUTO_SCROLL_MAX_SPEED_PX);
    } else if (viewportHeight - clientY < AUTO_SCROLL_EDGE_PX) {
      const intensity =
        (AUTO_SCROLL_EDGE_PX - (viewportHeight - clientY)) /
        AUTO_SCROLL_EDGE_PX;
      scrollDelta = Math.ceil(intensity * AUTO_SCROLL_MAX_SPEED_PX);
    }

    if (scrollDelta !== 0) {
      const previousScrollY = window.scrollY;
      window.scrollBy(0, scrollDelta);
      if (window.scrollY !== previousScrollY) {
        updateDropInsertionFromPointer(clientX, clientY);
      }
    }

    autoScrollFrameRef.current = window.requestAnimationFrame(runAutoScroll);
  }, [updateDropInsertionFromPointer]);

  const updateAutoScrollPointer = useCallback(
    (mode: "page" | "file", clientX: number, clientY: number) => {
      autoScrollDragModeRef.current = mode;
      dragPointerRef.current = { clientX, clientY };

      if (autoScrollFrameRef.current === null) {
        autoScrollFrameRef.current =
          window.requestAnimationFrame(runAutoScroll);
      }
    },
    [runAutoScroll],
  );

  const resetDragState = useCallback(() => {
    stopAutoScroll();
    setDraggedPageId(null);
    setDropInsertionIndex(null);
    setIsDraggingFile(false);
  }, [stopAutoScroll]);

  const processIncomingFiles = useCallback(
    async (files: File[], insertionIndex?: number | null) => {
      if (files.length === 0) {
        return;
      }

      setProcessingTask("files");
      try {
        const newFiles: Record<string, SourceFile> = {};
        const newPages: PdfPageNode[] = [];

        for (const file of files) {
          const fileId = crypto.randomUUID();
          const result = await parseInputFile(file, fileId);
          newFiles[fileId] = result.sourceFile;
          newPages.push(...result.pages);
        }

        setSourceFiles((prev) => ({ ...prev, ...newFiles }));
        setPages((prev) => {
          const insertAt =
            insertionIndex == null
              ? prev.length
              : clampInsertionIndex(insertionIndex, prev.length);
          const nextPages = [...prev];
          nextPages.splice(insertAt, 0, ...newPages);
          return nextPages;
        });
      } catch (err) {
        console.error("Error processing files:", err);
        alert("Error parsing PDF/image files. Check console for details.");
      } finally {
        setProcessingTask(null);
      }
    },
    [],
  );

  const handleRemoveSelected = useCallback(() => {
    setPages((prev) => prev.filter((page) => !selectedPageIds.has(page.id)));
    clearSelection();
  }, [clearSelection, selectedPageIds]);

  const selectAllPages = useCallback(() => {
    if (pages.length === 0) {
      return;
    }

    setSelectedPageIds(new Set(pages.map((page) => page.id)));
    setSelectionAnchorId(pages[pages.length - 1]?.id ?? null);
    setSelectionAnchorSnapshotIds(new Set(pages.map((page) => page.id)));
  }, [pages]);

  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      const isCommandShortcut =
        (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k";

      if (isCommandShortcut) {
        e.preventDefault();
        if (isCommandPaletteOpen) {
          closeCommandPalette();
        } else {
          openCommandPalette();
        }
        return;
      }

      if (e.key === "Escape") {
        if (isImageExportDialogOpen) {
          e.preventDefault();
          closeImageExportDialog();
          return;
        }

        if (isCommandPaletteOpen) {
          e.preventDefault();
          closeCommandPalette();
          return;
        }

        if (isPreviewOpen) {
          e.preventDefault();
          closePreview();
          return;
        }
      }

      if (isImageExportDialogOpen || isCommandPaletteOpen) {
        return;
      }

      if (isEditableTarget(e.target)) {
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        if (pages.length > 0) {
          e.preventDefault();
          selectAllPages();
        }
        return;
      }

      if (
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowUp")
      ) {
        if (navigateSingleSelection(-1)) {
          e.preventDefault();
        }
        return;
      }

      if (
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (e.key === "ArrowRight" || e.key === "ArrowDown")
      ) {
        if (navigateSingleSelection(1)) {
          e.preventDefault();
        }
        return;
      }

      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === " ") {
        if (isPreviewOpen) {
          e.preventDefault();
          closePreview();
          return;
        }

        if (selectedSinglePageId) {
          e.preventDefault();
          openPreview();
        }
        return;
      }

      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === "Enter") {
        if (selectedSinglePageId) {
          e.preventDefault();
          openPreview();
        }
        return;
      }

      if (
        (e.key === "Backspace" || e.key === "Delete") &&
        selectedPageIds.size > 0
      ) {
        handleRemoveSelected();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    closeCommandPalette,
    closeImageExportDialog,
    closePreview,
    handleRemoveSelected,
    isCommandPaletteOpen,
    isImageExportDialogOpen,
    isPreviewOpen,
    navigateSingleSelection,
    openCommandPalette,
    openPreview,
    pages.length,
    selectAllPages,
    selectedPageIds,
    selectedSinglePageId,
  ]);

  useEffect(() => {
    if (!isCommandPaletteOpen) {
      return;
    }

    commandPaletteInputRef.current?.focus();
    commandPaletteInputRef.current?.select();
  }, [isCommandPaletteOpen]);

  useEffect(() => {
    if (!isImageExportDialogOpen) {
      return;
    }

    imageExportValueInputRef.current?.focus();
    imageExportValueInputRef.current?.select();
  }, [isImageExportDialogOpen]);

  useEffect(() => {
    if (isPreviewOpen && !selectedSinglePage) {
      closePreview();
    }
  }, [closePreview, isPreviewOpen, selectedSinglePage]);

  useEffect(() => {
    if (!isPreviewOpen || !selectedSinglePage) {
      return;
    }

    const cachedPreviewImageUrl =
      previewImageUrlsRef.current[selectedSinglePage.id];
    if (cachedPreviewImageUrl) {
      setPreviewImageUrl(cachedPreviewImageUrl);
      setIsPreviewLoading(false);
      return;
    }

    let isCancelled = false;
    setPreviewImageUrl(selectedSinglePage.thumbnailUrl);
    setIsPreviewLoading(true);

    void generatePagePreview(selectedSinglePage, sourceFiles)
      .then((generatedPreviewImageUrl) => {
        if (!generatedPreviewImageUrl) {
          return;
        }

        if (isCancelled) {
          URL.revokeObjectURL(generatedPreviewImageUrl);
          return;
        }

        previewImageUrlsRef.current[selectedSinglePage.id] =
          generatedPreviewImageUrl;
        setPreviewImageUrl(generatedPreviewImageUrl);
      })
      .catch((err) => {
        console.error("Error generating page preview:", err);
      })
      .finally(() => {
        if (!isCancelled) {
          setIsPreviewLoading(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [isPreviewOpen, selectedSinglePage, sourceFiles]);

  useEffect(() => {
    const previewImageUrls = previewImageUrlsRef.current;

    return () => {
      Object.values(previewImageUrls).forEach((previewUrl) => {
        URL.revokeObjectURL(previewUrl);
      });
    };
  }, []);

  useEffect(() => {
    if (viewMode !== "grid") {
      return;
    }

    if (isThumbnailGenerationActiveRef.current) {
      return;
    }

    const pagesNeedingThumbnails = pagesRef.current.filter(
      (page) =>
        !page.thumbnailUrl &&
        sourceFiles[page.fileId] &&
        !pendingThumbnailPageIdsRef.current.has(page.id),
    );
    if (pagesNeedingThumbnails.length === 0) {
      return;
    }

    isThumbnailGenerationActiveRef.current = true;
    let isCancelled = false;
    let processTimerId: number | null = null;
    let flushIntervalId: number | null = null;
    const stagedThumbnailUrlsByPageId: Record<string, string> = {};

    pagesNeedingThumbnails.forEach((page) => {
      pendingThumbnailPageIdsRef.current.add(page.id);
    });

    const clearPendingPages = (targetPages: PdfPageNode[]) => {
      targetPages.forEach((page) => {
        pendingThumbnailPageIdsRef.current.delete(page.id);
      });
    };

    const stopThumbnailGeneration = () => {
      if (processTimerId !== null) {
        window.clearTimeout(processTimerId);
        processTimerId = null;
      }

      if (flushIntervalId !== null) {
        window.clearInterval(flushIntervalId);
        flushIntervalId = null;
      }

      isThumbnailGenerationActiveRef.current = false;
    };

    const revokeStagedThumbnails = () => {
      Object.values(stagedThumbnailUrlsByPageId).forEach((thumbnailUrl) => {
        URL.revokeObjectURL(thumbnailUrl);
      });
    };

    const flushStagedThumbnails = () => {
      const thumbnailUrlsByPageId = { ...stagedThumbnailUrlsByPageId };
      const pageIds = Object.keys(thumbnailUrlsByPageId);
      if (pageIds.length === 0) {
        return;
      }

      pageIds.forEach((pageId) => {
        delete stagedThumbnailUrlsByPageId[pageId];
        pendingThumbnailPageIdsRef.current.delete(pageId);
      });

      startTransition(() => {
        setPages((prev) =>
          prev.map((page) => ({
            ...page,
            thumbnailUrl: thumbnailUrlsByPageId[page.id] ?? page.thumbnailUrl,
          })),
        );
      });
    };

    const processNextBatch = async (
      remainingPages: PdfPageNode[],
    ): Promise<void> => {
      if (isCancelled) {
        revokeStagedThumbnails();
        clearPendingPages(remainingPages);
        stopThumbnailGeneration();
        return;
      }

      if (remainingPages.length === 0) {
        flushStagedThumbnails();
        stopThumbnailGeneration();
        return;
      }

      const batch = remainingPages.slice(0, THUMBNAIL_RENDER_BATCH_SIZE);
      const nextRemainingPages = remainingPages.slice(
        THUMBNAIL_RENDER_BATCH_SIZE,
      );
      const thumbnailUrlsByPageId = await generatePageThumbnails(
        batch,
        sourceFiles,
      );

      if (isCancelled) {
        Object.values(thumbnailUrlsByPageId).forEach((thumbnailUrl) => {
          URL.revokeObjectURL(thumbnailUrl);
        });
        revokeStagedThumbnails();
        clearPendingPages(remainingPages);
        stopThumbnailGeneration();
        return;
      }

      Object.assign(stagedThumbnailUrlsByPageId, thumbnailUrlsByPageId);

      processTimerId = window.setTimeout(() => {
        void processNextBatch(nextRemainingPages);
      }, 0);
    };

    flushIntervalId = window.setInterval(() => {
      flushStagedThumbnails();
    }, THUMBNAIL_FLUSH_INTERVAL_MS);

    processTimerId = window.setTimeout(() => {
      void processNextBatch(pagesNeedingThumbnails);
    }, 0);

    return () => {
      isCancelled = true;
    };
  }, [pages.length, sourceFiles, viewMode]);

  const openEmptyFilePicker = useCallback(() => {
    if (!isProcessing) {
      emptyFileInputRef.current?.click();
    }
  }, [isProcessing]);

  const handleEmptyDropzoneKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openEmptyFilePicker();
      }
    },
    [openEmptyFilePicker],
  );

  const handleDragOverFile = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (draggedPageId || !isFileDrag(e.dataTransfer)) {
        return;
      }

      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setIsDraggingFile(true);
      updateDropInsertionFromPointer(e.clientX, e.clientY);
      updateAutoScrollPointer("file", e.clientX, e.clientY);
    },
    [draggedPageId, updateAutoScrollPointer, updateDropInsertionFromPointer],
  );

  const handleDragLeaveFile = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      const nextTarget = e.relatedTarget;
      if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) {
        return;
      }

      if (!draggedPageId) {
        stopAutoScroll();
        setIsDraggingFile(false);
        setDropInsertionIndex(null);
      }
    },
    [draggedPageId, stopAutoScroll],
  );

  const handleRootDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();

      if (draggedPageId) {
        resetDragState();
        return;
      }

      const files = getSupportedDraggedFiles(e.dataTransfer);
      if (files.length === 0) {
        resetDragState();
        return;
      }

      await processIncomingFiles(files, dropInsertionIndex ?? pages.length);
      resetDragState();
    },
    [
      draggedPageId,
      dropInsertionIndex,
      pages.length,
      processIncomingFiles,
      resetDragState,
    ],
  );

  const handleFileInput = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(isSupportedInputFile);
    await processIncomingFiles(files);
    e.target.value = "";
  };

  const handlePageClick = (e: MouseEvent, pageId: string) => {
    if (Date.now() < suppressClickUntilRef.current) {
      e.preventDefault();
      return;
    }

    e.preventDefault();
    const nextSelectedIds = new Set(selectedPageIds);
    const isToggleSelection = e.metaKey || e.ctrlKey;
    const isRangeSelection = e.shiftKey;

    if (isRangeSelection) {
      const anchorId = selectionAnchorId ?? pageId;
      const anchorIndex = pages.findIndex((page) => page.id === anchorId);
      const currentIndex = pages.findIndex((page) => page.id === pageId);

      if (anchorIndex === -1 || currentIndex === -1) {
        return;
      }

      const start = Math.min(anchorIndex, currentIndex);
      const end = Math.max(anchorIndex, currentIndex);
      const rangeIds = new Set<string>();
      const baseSelectionIds =
        selectionAnchorId === null
          ? new Set<string>()
          : new Set(selectionAnchorSnapshotIds);

      for (let i = start; i <= end; i += 1) {
        rangeIds.add(pages[i].id);
      }

      const nextRangeSelection = new Set(baseSelectionIds);
      for (const id of rangeIds) {
        nextRangeSelection.add(id);
      }

      setSelectedPageIds(nextRangeSelection);
      if (!selectionAnchorId) {
        setSelectionAnchorId(anchorId);
        setSelectionAnchorSnapshotIds(new Set([anchorId]));
      }
      return;
    }

    if (isToggleSelection) {
      if (nextSelectedIds.has(pageId)) {
        nextSelectedIds.delete(pageId);
      } else {
        nextSelectedIds.add(pageId);
      }
      setSelectionAnchorId(pageId);
      setSelectionAnchorSnapshotIds(new Set(nextSelectedIds));
    } else {
      nextSelectedIds.clear();
      nextSelectedIds.add(pageId);
      setSelectionAnchorId(pageId);
      setSelectionAnchorSnapshotIds(new Set(nextSelectedIds));
    }

    setSelectedPageIds(nextSelectedIds);
  };

  const handleCommandPaletteInputKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") {
        return;
      }

      const firstEnabledCommand = filteredCommandPaletteCommands.find(
        (command) => !command.disabled,
      );
      if (!firstEnabledCommand) {
        return;
      }

      e.preventDefault();
      handleRunCommand(firstEnabledCommand.id);
    },
    [filteredCommandPaletteCommands, handleRunCommand],
  );

  const handleImageExportFieldChange = useCallback(
    <K extends keyof ImageExportFormState>(
      key: K,
      value: ImageExportFormState[K],
    ) => {
      setImageExportError(null);
      setImageExportForm((prev) => {
        if (key === "colorSpace") {
          const nextColorSpace = value as ImageExportColorSpace;
          const nextFormats =
            getImageExportFormatsForColorSpace(nextColorSpace);
          return {
            ...prev,
            colorSpace: nextColorSpace,
            format: nextFormats.includes(prev.format)
              ? prev.format
              : nextFormats[0],
          };
        }

        if (key === "format") {
          return {
            ...prev,
            format: value as ImageExportFormat,
          };
        }

        return {
          ...prev,
          [key]: value,
        };
      });
    },
    [],
  );

  const handleImageExportSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();

      const exportValue = parsePositiveNumber(imageExportForm.value);
      if (!exportValue) {
        setImageExportError("Enter a value greater than 0.");
        return;
      }

      if (selectedPages.length === 0) {
        setImageExportError("Select one or more pages before exporting.");
        return;
      }

      let jpegQuality: number | undefined;
      if (imageExportForm.format === "jpeg") {
        const presetQuality = getJpegQualityPresetValue(
          imageExportForm.jpegQualityPreset,
        );
        const resolvedQuality =
          presetQuality ??
          parsePositiveNumber(imageExportForm.jpegQualityCustomValue);

        if (
          !resolvedQuality ||
          !Number.isFinite(resolvedQuality) ||
          resolvedQuality < 1 ||
          resolvedQuality > 100
        ) {
          setImageExportError("JPEG custom quality must be between 1 and 100.");
          return;
        }

        jpegQuality = Math.round(resolvedQuality);
      }

      const exportOptions: ImageExportOptions = {
        colorSpace: imageExportForm.colorSpace,
        format: imageExportForm.format,
        sizeMode: imageExportForm.sizeMode,
        value: exportValue,
        jpegQuality,
      };

      setProcessingTask("export-images");
      try {
        const exportedImages = await exportPagesAsImages(
          selectedPages,
          sourceFiles,
          exportOptions,
        );

        if (exportedImages.length === 0) {
          throw new Error("No images were exported.");
        }

        if (exportedImages.length === 1) {
          const [singleImage] = exportedImages;
          downloadBlob(
            new Blob([singleImage.buffer], { type: singleImage.mimeType }),
            singleImage.fileName,
          );
        } else {
          const zipBuffer = buildZipArchive(
            exportedImages.map((image) => ({
              name: image.fileName,
              data: image.buffer,
            })),
          );

          downloadBlob(
            new Blob([zipBuffer], { type: "application/zip" }),
            getImageExportArchiveName(imageExportForm.format),
          );
        }

        closeImageExportDialog();
      } catch (err) {
        console.error("Error exporting selected pages:", err);
        setImageExportError(
          err instanceof Error
            ? err.message
            : "Error exporting selected pages as images.",
        );
      } finally {
        setProcessingTask(null);
      }
    },
    [closeImageExportDialog, imageExportForm, selectedPages, sourceFiles],
  );

  const handlePagePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, pageId: string) => {
      if (e.pointerType !== "touch") {
        return;
      }

      if (selectedPageIds.has(pageId)) {
        e.preventDefault();
      }

      activeTouchPointersRef.current.set(e.pointerId, pageId);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Safari may refuse pointer capture in some touch cases.
      }

      const otherActiveTouch = Array.from(
        activeTouchPointersRef.current.entries(),
      ).find(([pointerId]) => pointerId !== e.pointerId);

      if (otherActiveTouch) {
        const [, anchorPageId] = otherActiveTouch;
        const didSelectRange = selectRangeBetween(
          anchorPageId,
          pageId,
          new Set(selectedPageIds),
        );
        if (didSelectRange) {
          suppressUpcomingClick(Number.POSITIVE_INFINITY);
        }
        touchDragStateRef.current = null;
        return;
      }

      touchDragStateRef.current = {
        pointerId: e.pointerId,
        pageId,
        startX: e.clientX,
        startY: e.clientY,
        isDragging: false,
      };
    },
    [selectRangeBetween, selectedPageIds, suppressUpcomingClick],
  );

  const handlePagePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, pageId: string) => {
      if (e.pointerType !== "touch") {
        return;
      }

      const touchDragState = touchDragStateRef.current;
      if (
        !touchDragState ||
        touchDragState.pointerId !== e.pointerId ||
        touchDragState.pageId !== pageId
      ) {
        return;
      }

      const deltaX = e.clientX - touchDragState.startX;
      const deltaY = e.clientY - touchDragState.startY;
      const dragDistance = Math.hypot(deltaX, deltaY);

      if (!touchDragState.isDragging) {
        if (dragDistance < TOUCH_DRAG_THRESHOLD_PX) {
          return;
        }

        touchDragState.isDragging = true;
        suppressUpcomingClick();
        if (!selectedPageIds.has(pageId)) {
          selectSinglePage(pageId);
        }
        setDraggedPageId(pageId);
      }

      e.preventDefault();
      updateDropInsertionFromPointer(e.clientX, e.clientY);
      updateAutoScrollPointer("page", e.clientX, e.clientY);
    },
    [
      selectSinglePage,
      selectedPageIds,
      suppressUpcomingClick,
      updateAutoScrollPointer,
      updateDropInsertionFromPointer,
    ],
  );

  const handlePagePointerEnd = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== "touch") {
        return;
      }

      activeTouchPointersRef.current.delete(e.pointerId);
      if (
        activeTouchPointersRef.current.size === 0 &&
        suppressClickUntilRef.current === Number.POSITIVE_INFINITY
      ) {
        suppressUpcomingClick(100);
      }

      const touchDragState = touchDragStateRef.current;
      if (touchDragState && touchDragState.pointerId === e.pointerId) {
        if (touchDragState.isDragging) {
          e.preventDefault();
          if (dropInsertionIndex !== null) {
            setPages((prev) =>
              moveSelectedPages(prev, selectedPageIds, dropInsertionIndex),
            );
          }
          resetDragState();
        }

        touchDragStateRef.current = null;
      }

      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore missing capture on browsers with partial support.
      }
    },
    [
      dropInsertionIndex,
      resetDragState,
      selectedPageIds,
      suppressUpcomingClick,
    ],
  );

  const handleContentMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) {
        return;
      }

      const target = e.target as HTMLElement;
      if (target.closest(".page-card") || target.closest(".app__fab")) {
        return;
      }

      clearSelection();
    },
    [clearSelection],
  );

  const handleDownload = async () => {
    if (pages.length === 0) {
      return;
    }

    setProcessingTask("merge-pdf");
    try {
      const mergedPdfUint8Array = await generateMergedPdf(pages, sourceFiles);
      downloadBlob(
        new Blob([mergedPdfUint8Array], { type: "application/pdf" }),
        "merged.pdf",
      );
    } catch (err) {
      console.error("Error merging PDF:", err);
      alert("Error generating merged PDF.");
    } finally {
      setProcessingTask(null);
    }
  };

  const handlePageDragStart = (
    e: DragEvent<HTMLDivElement>,
    pageId: string,
  ) => {
    setDraggedPageId(pageId);
    if (!selectedPageIds.has(pageId)) {
      selectSinglePage(pageId);
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", pageId);
  };

  const handlePageDragOver = (
    e: DragEvent<HTMLDivElement>,
    pageIndex: number,
  ) => {
    const hasPageDrag = draggedPageId !== null;
    const hasFileDrag = !hasPageDrag && isFileDrag(e.dataTransfer);
    if (!hasPageDrag && !hasFileDrag) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    if (hasFileDrag) {
      e.dataTransfer.dropEffect = "copy";
      setIsDraggingFile(true);
      updateDropInsertionFromPointer(e.clientX, e.clientY);
      updateAutoScrollPointer("file", e.clientX, e.clientY);
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const insertBefore =
      viewMode === "list"
        ? e.clientY < rect.top + rect.height / 2
        : e.clientX < rect.left + rect.width / 2;

    setDropInsertionIndex(insertBefore ? pageIndex : pageIndex + 1);
    updateAutoScrollPointer("page", e.clientX, e.clientY);
  };

  const handlePageCollectionDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      const hasPageDrag = draggedPageId !== null;
      const hasFileDrag = !hasPageDrag && isFileDrag(e.dataTransfer);
      if (!hasPageDrag && !hasFileDrag) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      if (hasPageDrag) {
        e.dataTransfer.dropEffect = "move";
      } else {
        e.dataTransfer.dropEffect = "copy";
        setIsDraggingFile(true);
      }

      updateDropInsertionFromPointer(e.clientX, e.clientY);
      updateAutoScrollPointer(
        hasPageDrag ? "page" : "file",
        e.clientX,
        e.clientY,
      );
    },
    [draggedPageId, updateAutoScrollPointer, updateDropInsertionFromPointer],
  );

  const handlePageDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();

      if (draggedPageId) {
        if (dropInsertionIndex !== null) {
          setPages((prev) =>
            moveSelectedPages(prev, selectedPageIds, dropInsertionIndex),
          );
        }
        resetDragState();
        return;
      }

      const files = getSupportedDraggedFiles(e.dataTransfer);
      if (files.length === 0) {
        resetDragState();
        return;
      }

      await processIncomingFiles(files, dropInsertionIndex ?? pages.length);
      resetDragState();
    },
    [
      draggedPageId,
      dropInsertionIndex,
      pages.length,
      processIncomingFiles,
      resetDragState,
      selectedPageIds,
    ],
  );

  const pageCollectionClassName = `app__pages app__pages--${viewMode}`;

  return (
    <div
      className="app"
      onDragOver={handleDragOverFile}
      onDragLeave={handleDragLeaveFile}
      onDrop={handleRootDrop}
    >
      <header className="app__header">
        <h1 className="app__brand">
          <FileText className="app__brand-icon" />
          <span className="app__brand-name">MiniMerge</span>
          <span className="app__brand-tagline">Process PDF pages</span>
        </h1>
        <div className="app__toolbar">
          <div className="app__view-toggle">
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              className={`app__view-button ${viewMode === "grid" ? "app__view-button--active" : ""}`}
              title="Grid View"
              aria-pressed={viewMode === "grid"}
            >
              <GridIcon className="app__view-icon" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={`app__view-button ${viewMode === "list" ? "app__view-button--active" : ""}`}
              title="List View"
              aria-pressed={viewMode === "list"}
            >
              <ListIcon className="app__view-icon" />
            </button>
          </div>
          <div className="app__divider" />
          {/* <button
            type="button"
            onClick={openCommandPalette}
            disabled={isProcessing}
            className="app__action app__action--subtle"
            title="Open command palette (Cmd/Ctrl+K)"
          >
            <Command className="app__action-icon" />
            Commands
            <span className="app__action-shortcut">Cmd/Ctrl+K</span>
          </button> */}
          <button
            type="button"
            onClick={handleRemoveSelected}
            disabled={selectedPageIds.size === 0}
            className="app__action app__action--remove"
          >
            <Trash2 className="app__action-icon" />
            Remove
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={pages.length === 0 || isProcessing}
            className="app__action app__action--primary"
          >
            <Download className="app__action-icon" />
            {processingTask === "merge-pdf" ? "Merging..." : "Merge PDF"}
          </button>
        </div>
      </header>

      <main className="app__main">
        {pages.length === 0 ? (
          <div
            className={`dropzone ${isDraggingFile ? "dropzone--active" : ""}`}
            onClick={openEmptyFilePicker}
            onKeyDown={handleEmptyDropzoneKeyDown}
            role="button"
            tabIndex={0}
          >
            {processingTask === "files" ? (
              <div className="dropzone__processing">Processing files...</div>
            ) : (
              <>
                <Upload
                  className={`dropzone__icon ${isDraggingFile ? "dropzone__icon--active" : ""}`}
                />
                <h2 className="dropzone__title">
                  Drag and drop PDFs, JPEGs or PNGs here
                </h2>
                <p className="dropzone__description">
                  Or select files from your computer (Multiple allowed)
                </p>
                <div className="dropzone__button">Browse Files</div>
                <input
                  ref={emptyFileInputRef}
                  type="file"
                  multiple
                  accept={FILE_INPUT_ACCEPT}
                  className="app__file-input"
                  onChange={handleFileInput}
                />
              </>
            )}
          </div>
        ) : (
          <div className="app__content" onMouseDown={handleContentMouseDown}>
            <div
              ref={pageCollectionRef}
              className={pageCollectionClassName}
              onDragOver={handlePageCollectionDragOver}
              onDrop={handlePageDrop}
            >
              {pages.map((page, index) => {
                const isSelected = selectedPageIds.has(page.id);
                const sourceFile = sourceFiles[page.fileId];
                const showIndicatorBefore = dropInsertionIndex === index;
                const showIndicatorAfter =
                  index === pages.length - 1 &&
                  dropInsertionIndex === pages.length;
                const pageCardClassName = [
                  "page-card",
                  `page-card--${viewMode}`,
                  isSelected ? "page-card--selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                const previewClassName = [
                  "page-card__preview",
                  isSelected ? "page-card__preview--selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ");

                return (
                  <div
                    key={page.id}
                    draggable
                    onDragStart={(e) => handlePageDragStart(e, page.id)}
                    onDragOver={(e) => handlePageDragOver(e, index)}
                    onDrop={handlePageDrop}
                    onDragEnd={resetDragState}
                    onClick={(e) => handlePageClick(e, page.id)}
                    onDoubleClick={() => openPreviewForPage(page.id)}
                    onPointerDown={(e) => handlePagePointerDown(e, page.id)}
                    onPointerMove={(e) => handlePagePointerMove(e, page.id)}
                    onPointerUp={handlePagePointerEnd}
                    onPointerCancel={handlePagePointerEnd}
                    className={pageCardClassName}
                  >
                    {showIndicatorBefore && (
                      <div
                        className={`page-card__drop-indicator page-card__drop-indicator--before page-card__drop-indicator--${viewMode}`}
                      >
                        <div className="page-card__drop-indicator-line" />
                        {isDraggingFile && (
                          <div className="page-card__drop-indicator-label">
                            Insert files here
                          </div>
                        )}
                      </div>
                    )}
                    {showIndicatorAfter && (
                      <div
                        className={`page-card__drop-indicator page-card__drop-indicator--after page-card__drop-indicator--${viewMode}`}
                      >
                        <div className="page-card__drop-indicator-line" />
                        {isDraggingFile && (
                          <div className="page-card__drop-indicator-label">
                            Insert files here
                          </div>
                        )}
                      </div>
                    )}

                    {viewMode === "grid" ? (
                      <>
                        <div
                          className={previewClassName}
                          style={{
                            aspectRatio: `${page.width} / ${page.height}`,
                          }}
                        >
                          {page.thumbnailUrl ? (
                            <img
                              src={page.thumbnailUrl}
                              alt={`Page ${page.pageIndex + 1}`}
                              className="page-card__preview-image"
                              draggable={false}
                            />
                          ) : (
                            <div className="page-card__preview-placeholder">
                              Loading preview...
                            </div>
                          )}
                          <div className="page-card__preview-hover" />
                        </div>
                        <div className="page-card__label">
                          {page.label
                            ? page.label
                            : `Page ${page.pageIndex + 1}`}
                        </div>
                        <div
                          className="page-card__filename"
                          title={sourceFile?.name}
                        >
                          {sourceFile?.name}
                        </div>
                      </>
                    ) : (
                      <div className="page-card__meta">
                        <div className="page-card__meta-title">
                          {sourceFile?.name}
                        </div>
                        <div className="page-card__meta-subtitle">
                          Page {page.label ? page.label : page.pageIndex + 1}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <label className="app__fab" title="Add files">
              <Upload className="app__fab-icon" />
              <input
                type="file"
                multiple
                accept={FILE_INPUT_ACCEPT}
                className="app__file-input"
                onChange={handleFileInput}
              />
            </label>
          </div>
        )}
      </main>

      {isCommandPaletteOpen && (
        <div
          className="overlay-shell"
          role="presentation"
          onClick={closeCommandPalette}
        >
          <div
            className="command-palette"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="command-palette__search">
              <Command className="command-palette__search-icon" />
              <input
                ref={commandPaletteInputRef}
                type="text"
                value={commandPaletteQuery}
                onChange={(e) => setCommandPaletteQuery(e.target.value)}
                onKeyDown={handleCommandPaletteInputKeyDown}
                className="command-palette__input"
                placeholder="Type a command"
              />
            </div>
            <div className="command-palette__results">
              {filteredCommandPaletteCommands.length > 0 ? (
                filteredCommandPaletteCommands.map((command) => (
                  <button
                    key={command.id}
                    type="button"
                    disabled={command.disabled}
                    className="command-palette__item"
                    onClick={() => handleRunCommand(command.id)}
                  >
                    <div className="command-palette__item-icon">
                      <ImageDown className="command-palette__item-icon-svg" />
                    </div>
                    <div className="command-palette__item-copy">
                      <div className="command-palette__item-title">
                        {command.title}
                      </div>
                      <div className="command-palette__item-description">
                        {command.description}
                      </div>
                    </div>
                  </button>
                ))
              ) : (
                <div className="command-palette__empty">
                  No commands match “{commandPaletteQuery}”.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {isImageExportDialogOpen && (
        <div
          className="overlay-shell"
          role="presentation"
          onClick={closeImageExportDialog}
        >
          <div
            className="export-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="export-dialog__header">
              <div>
                <h2 id="export-dialog-title" className="export-dialog__title">
                  Export selected pages
                </h2>
                <p className="export-dialog__subtitle">
                  {selectedPages.length} selected page
                  {selectedPages.length === 1 ? "" : "s"}. Aspect ratio is
                  always preserved.
                </p>
              </div>
              <button
                type="button"
                className="preview-modal__close"
                onClick={closeImageExportDialog}
                aria-label="Close export dialog"
              >
                <X className="preview-modal__close-icon" />
              </button>
            </div>

            <form
              className="export-dialog__form"
              onSubmit={handleImageExportSubmit}
            >
              <div className="export-dialog__grid">
                <label className="export-field">
                  <span className="export-field__label">Colour output</span>
                  <select
                    value={imageExportForm.colorSpace}
                    onChange={(e) =>
                      handleImageExportFieldChange(
                        "colorSpace",
                        e.target.value as ImageExportColorSpace,
                      )
                    }
                    className="export-field__control"
                  >
                    <option value="gray">Gray</option>
                    <option value="srgb">sRGB</option>
                  </select>
                </label>

                <label className="export-field">
                  <span className="export-field__label">File format</span>
                  <select
                    value={imageExportForm.format}
                    onChange={(e) =>
                      handleImageExportFieldChange(
                        "format",
                        e.target.value as ImageExportFormat,
                      )
                    }
                    className="export-field__control"
                  >
                    {availableImageExportFormats.map((format) => (
                      <option key={format} value={format}>
                        {getImageExportFormatLabel(format)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {imageExportColorSpaceStatus.message && (
                <div className="export-dialog__meta">
                  <strong>
                    {getImageExportColorSpaceLabel(imageExportForm.colorSpace)}:
                  </strong>{" "}
                  {imageExportColorSpaceStatus.message}
                </div>
              )}

              <div className="export-field">
                <span className="export-field__label">Resolution mode</span>
                <div
                  className="export-mode-group"
                  role="group"
                  aria-label="Resolution mode"
                >
                  {(["dpi", "width", "height"] as const).map((sizeMode) => (
                    <button
                      key={sizeMode}
                      type="button"
                      className={`export-mode-group__button ${imageExportForm.sizeMode === sizeMode ? "export-mode-group__button--active" : ""}`}
                      onClick={() =>
                        handleImageExportFieldChange("sizeMode", sizeMode)
                      }
                    >
                      {sizeMode === "dpi"
                        ? "DPI"
                        : sizeMode === "width"
                          ? "Width"
                          : "Height"}
                    </button>
                  ))}
                </div>
              </div>

              <label className="export-field">
                <span className="export-field__label">
                  {getSizeModeLabel(imageExportForm.sizeMode)}
                </span>
                <input
                  ref={imageExportValueInputRef}
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={imageExportForm.value}
                  onChange={(e) =>
                    handleImageExportFieldChange("value", e.target.value)
                  }
                  className="export-field__control"
                />
                <span className="export-field__hint">
                  {getSizeModeHint(imageExportForm.sizeMode)}
                </span>
              </label>

              {imageExportForm.format === "jpeg" && (
                <>
                  <div className="export-field">
                    <span className="export-field__label">JPEG quality</span>
                    <div
                      className="export-mode-group"
                      role="group"
                      aria-label="JPEG quality"
                    >
                      {(
                        [
                          ["low", "Low"],
                          ["medium", "Medium"],
                          ["high", "High"],
                          ["custom", "Custom"],
                        ] as const
                      ).map(([qualityPreset, label]) => (
                        <button
                          key={qualityPreset}
                          type="button"
                          className={`export-mode-group__button ${imageExportForm.jpegQualityPreset === qualityPreset ? "export-mode-group__button--active" : ""}`}
                          onClick={() =>
                            handleImageExportFieldChange(
                              "jpegQualityPreset",
                              qualityPreset,
                            )
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <span className="export-field__hint">
                      Low = 60, Medium = 82, High = 92.
                    </span>
                  </div>

                  {imageExportForm.jpegQualityPreset === "custom" && (
                    <label className="export-field">
                      <span className="export-field__label">
                        Custom JPEG quality
                      </span>
                      <input
                        type="number"
                        min="1"
                        max="100"
                        step="1"
                        inputMode="numeric"
                        value={imageExportForm.jpegQualityCustomValue}
                        onChange={(e) =>
                          handleImageExportFieldChange(
                            "jpegQualityCustomValue",
                            e.target.value,
                          )
                        }
                        className="export-field__control"
                      />
                      <span className="export-field__hint">
                        Enter a value from 1 to 100.
                      </span>
                    </label>
                  )}
                </>
              )}

              <div className="export-dialog__meta">
                {selectedPages.length === 1
                  ? `One ${getImageExportFormatLabel(imageExportForm.format)} file will be downloaded.`
                  : `Multiple pages will be bundled into one ZIP archive of ${getImageExportFormatLabel(imageExportForm.format)} files.`}
              </div>

              {imageExportError && (
                <div className="export-dialog__error">{imageExportError}</div>
              )}

              <div className="export-dialog__actions">
                <button
                  type="button"
                  className="app__action app__action--subtle"
                  onClick={closeImageExportDialog}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="app__action app__action--primary"
                  disabled={isProcessing}
                >
                  <ImageDown className="app__action-icon" />
                  {processingTask === "export-images"
                    ? "Exporting..."
                    : "Download images"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isPreviewOpen && selectedSinglePage && (
        <div className="preview-modal" role="dialog" aria-modal="true">
          <div className="preview-modal__backdrop" onClick={closePreview} />
          <div className="preview-modal__panel">
            <button
              type="button"
              className="preview-modal__close"
              onClick={closePreview}
              aria-label="Close preview"
            >
              <X className="preview-modal__close-icon" />
            </button>
            <div className="preview-modal__meta">
              <div className="preview-modal__title">
                {sourceFiles[selectedSinglePage.fileId]?.name}
              </div>
              <div className="preview-modal__subtitle">
                Page{" "}
                {selectedSinglePage.label
                  ? selectedSinglePage.label
                  : selectedSinglePage.pageIndex + 1}
              </div>
            </div>
            <div className="preview-modal__viewport">
              {previewImageUrl ? (
                <img
                  src={previewImageUrl}
                  alt={`Preview of page ${selectedSinglePage.pageIndex + 1}`}
                  className="preview-modal__image"
                />
              ) : (
                <div className="preview-modal__loading">Loading preview...</div>
              )}
              {isPreviewLoading && (
                <div className="preview-modal__status">
                  Rendering preview...
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
