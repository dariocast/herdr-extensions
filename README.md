# Herdr Extensions & Customizations

Root workspace repository for custom Herdr mods, layouts, and integrations.

## Repository Structure

```
herdr-extensions/
├── layouts/
│   └── worklog.json                # Custom layout incorporating worklog & files-enhanced
└── mods/
    └── files-enhanced/             # Enhanced file explorer panel
        ├── main.js                 # Mod entry point with text extraction & native actions
        ├── mod.json                # Placement configuration
        ├── *.svg                   # UI Icons & chevrons
        ├── jsconfig.json           # JS/TS Editor configuration
        └── gpui-kit.d.ts           # GPUI type definitions
```

## Installed Mods

### `files-enhanced`
An enhanced replacement for Herdr's built-in `files` mod:
- **Text Extraction**: Automatically extracts and previews readable text from `.docx`, `.pdf`, `.pptx`, `.rtf`, `.odt` without crashing or showing binary error blocks.
  - PDF: Uses `pdftotext` (layout-aware, fast text extraction).
  - DOCX / DOC / RTF: Uses macOS `textutil` with a Python `zipfile` fallback.
  - PPTX: Uses a lightweight slide extractor using standard Python XML parsing.
- **Native System Actions**:
  - **Open with Default App**: Opens Word, Preview, Acrobat, PowerPoint, etc. (`open` / `Start-Process` / `xdg-open`).
  - **Quick Look (macOS)**: Native floating macOS Quick Look preview (`qlmanage -p`).
  - **Reveal in Finder / File Manager**: Reveals the file in Finder (`open -R`).
  - **Copy Path**: Copies the absolute path to clipboard.
- **Rich Document / Binary Cards**:
  - Displays formatted badge, file size, full path, and prominent action buttons for binary files (images, archives, executables, spreadsheets).
- **File Type Badges in Tree**:
  - Color-coded badges for PDF, DOC, PPT, XLS, IMG, ZIP, BIN in the file list.

## Linking into Herdr

Each mod developed here is symlinked into `~/.config/herdr-app/mods/<name>`:
```sh
ln -sfn /Users/dariocastellano/Workspaces/Others/herdr-extensions/mods/files-enhanced ~/.config/herdr-app/mods/files-enhanced
```
And referenced in layout files under `~/.config/herdr-app/layouts/`.
