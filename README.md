# MiniMerge

MiniMerge is a browser-based page arranger for PDFs and images. You can drop in PDF, JPG, JPEG, and PNG files, inspect every page as a thumbnail, reorder or remove pages, and then export the result as one clean PDF.

It is built for a simple job: take pages from different files, put them in the right order, and create a new output without the overhead of a full PDF editor.

## Core workflow

1. Add one or more PDF or image files.
2. Review the imported pages as thumbnails.
3. Reorder pages with drag and drop.
4. Select pages to remove, inspect, or export.
5. Download either a merged PDF or selected pages as images.

## Features

- Accepts PDF, JPG, JPEG, and PNG files.
- Splits source files into page-level items you can rearrange freely.
- Supports grid and list views for page browsing.
- Supports single, multi, range, and select-all page selection.
- Lets you preview individual pages.
- Exports the current page order as a merged PDF.
- Exports selected pages as PNG or JPEG images.
- Bundles multi-page image exports into a ZIP archive.
- Runs in the browser, so source files stay on your machine during processing.

## Shortcuts

- `Shift` + click: select a range
- `Cmd`/`Ctrl` + click: toggle a page
- `Cmd`/`Ctrl` + `A`: select all pages
- `Cmd`/`Ctrl` + `K`: open the command palette
- `Backspace` or `Delete`: remove selected pages

## Run locally

```bash
npm install
npm run dev
```

## License

The MiniMerge source code is [MIT](LICENSE). PDF handling uses [MuPDF](https://mupdf.readthedocs.io/), which is AGPL-3.0-or-later, so the built app is covered by the AGPL.
