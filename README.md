# Herdr Extensions & Customizations

Root workspace repository for custom Herdr mods, layouts, and integrations.

## Repository Structure

```
herdr-extensions/
├── layouts/
│   └── worklog.json                # Custom layout incorporating worklog, files-enhanced & changes-enhanced
└── mods/
    ├── files-enhanced/             # Enhanced file explorer panel
    │   ├── main.js                 # Mod entry point with text extraction & native actions
    │   ├── mod.json                # Placement configuration
    │   ├── *.svg                   # UI Icons & chevrons
    │   ├── jsconfig.json           # JS/TS Editor configuration
    │   └── gpui-kit.d.ts           # GPUI type definitions
    └── changes-enhanced/           # Enhanced Changes panel with SourceTree-style git commit graph
        ├── main.js                 # Mod entry point with uncommitted changes & branch tree
        ├── mod.json                # Placement configuration
        ├── *.svg                   # Branch, tag, copy, refresh icons
        ├── jsconfig.json           # JS/TS Editor configuration
        └── gpui-kit.d.ts           # GPUI type definitions
```

## Installed Mod

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
- **In-Place Code / Text Editing & Saving**:
  - Open any plain text or code file (`.js`, `.ts`, `.json`, `.md`, `.py`, `.yaml`, etc.) to edit directly in the panel.
  - Full syntax highlighting, line numbers, code folding, and cursor selection.
  - Real-time modification tracking with dirty state dot indicator (`●`).
  - **Save Button**: Active state and feedback in the top toolbar.
  - **Keyboard Shortcut**: Press `Cmd+S` (macOS) or `Ctrl+S` (Linux/Windows) to save changes atomically to disk.
- **Context Menus for Files & Folders**:
  - Triggered via **Right-Click** or the dedicated **`···` menu button** on each row.
  - **File Actions**: Preview in Panel, Open with Default App, Quick Look (macOS), Reveal in Finder / File Manager, Open Containing Folder in Terminal Tab, Split Terminal Right, Copy Relative Path, Copy Full Absolute Path.
  - **Folder Actions**: Open in New Terminal Tab, Split Terminal Right, Split Terminal Down, Open in Finder / File Manager, Copy Relative Path, Copy Full Absolute Path, Expand/Collapse Folder.

### `changes-enhanced`
An enhanced replacement for Herdr's built-in `changes` mod:
- **Dual Working Tree & Git Tree View**:
  - View modes: **Split** (both), **Changes only**, or **Tree only** with collapsible sections.
  - Full working tree changes (status, file list, syntax diff preview, commit message, commit button).
- **SourceTree-style Git Graph & Branch History**:
  - Colorful multi-lane commit tree (SourceTree color palette: blue, orange, green, purple, cyan, etc.).
  - Distinguishes **HEAD** commit (outer ring + center dot), normal branch commits, and merge commits.
  - Multi-parent merge branch connectors.
  - **Ref Badges**:
    - Local branches (blue pills with branch icon)
    - Remote branches (orange/tan pills)
    - Tags (green pills with tag icon)
    - HEAD indicator
  - SourceTree-compatible table columns:
    - **Graph**: Vector lane lines and commit markers
    - **Description**: Ref badges + commit message
    - **Commit**: Short commit SHA with 1-click copy
    - **Author**: Author name
    - **Date**: Formatted timestamp (`YYYY-MM-DD HH:mm`)
- **Interactive Commit Inspector**:
  - Click any commit in the tree to expand full commit details, full 40-char SHA copy, author, relative date, and stat breakdown.

## Linking into Herdr

Each mod developed here is symlinked into `~/.config/herdr-app/mods/<name>`:
```sh
ln -sfn /Users/dariocastellano/Workspaces/Others/herdr-extensions/mods/files-enhanced ~/.config/herdr-app/mods/files-enhanced
```
And referenced in layout files under `~/.config/herdr-app/layouts/`.
