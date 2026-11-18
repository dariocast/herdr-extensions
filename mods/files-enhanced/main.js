// Enhanced file browser for Herdr with support for docx, pdf, pptx, binary files, editing/saving, native actions and context menus.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, run } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileCategory(filename) {
  const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
  if (["pdf"].includes(ext)) return { type: "pdf", label: "PDF Document", canExtract: true, badge: "PDF", color: "#e11d48" };
  if (["docx", "doc", "rtf", "odt"].includes(ext)) return { type: "doc", label: "Word Document", canExtract: true, badge: "DOC", color: "#2563eb" };
  if (["pptx", "ppt", "odp"].includes(ext)) return { type: "presentation", label: "PowerPoint Presentation", canExtract: true, badge: "PPT", color: "#ea580c" };
  if (["xlsx", "xls", "ods"].includes(ext)) return { type: "spreadsheet", label: "Excel Spreadsheet", canExtract: false, badge: "XLS", color: "#16a34a" };
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tiff", "heic"].includes(ext)) return { type: "image", label: "Image File", canExtract: false, badge: "IMG", color: "#9333ea" };
  if (["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "pkg"].includes(ext)) return { type: "archive", label: "Archive / Package", canExtract: false, badge: "ZIP", color: "#d97706" };
  if (["mp4", "mov", "avi", "mkv", "webm", "mp3", "wav", "flac", "m4a", "ogg"].includes(ext)) return { type: "media", label: "Media Audio/Video", canExtract: false, badge: "MEDIA", color: "#0891b2" };
  if (["app", "exe", "bin", "dylib", "so", "dll", "o"].includes(ext)) return { type: "binary", label: "Binary Executable", canExtract: false, badge: "BIN", color: "#64748b" };
  return null;
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class FilesEnhanced extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.copied = false;
    this.contextMenu = null;
    this.toastNotice = null;
    this.size = { width: 360, height: 600 };
    this.handle = cx.focus_handle();

    // Editor & Saving state
    this.savedValue = null;
    this.isDirty = false;
    this.saving = false;
    this.saveError = null;

    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root && this.current(context)) this.refresh(cx);
        }
      } catch {
        if (this.current(context)) this.watched = null;
      }
    });
  }

  current(context) {
    return this.context === context && key() === context?.key;
  }

  async loadFolder(path, context) {
    const root = this.root, on = this.on;
    const full = path ? `${root}/${path}` : root;
    const items = await directory(full, on);
    if (!this.current(context)) return;
    items.sort((a, b) => a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1);
    this.entries.set(path, items);
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on, space } = location(), k = key();
    if (k !== this.context?.key) {
      if (this.context?.space) this.saved.set(this.context.space, { folders: this.folders, file: this.file });
      const prev = space ? this.saved.get(space) : null;
      this.context = { key: k, space };
      this.root = cwd; this.on = on; this.watched = null;
      this.entries.clear(); this.pending.clear();
      this.folders = new Set(prev?.folders ?? []);
      this.file = prev?.file ?? null;
      this.code?.release(); this.code = null; this.isBinary = false; this.fileSize = null; this.category = null;
      this.contextMenu = null;
      this.savedValue = null; this.isDirty = false; this.saving = false; this.saveError = null;
      if (this.file) this.show(this.file, cx);
    }
    if (!cwd) { this.root = null; cx.notify(); return; }
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  async extractText(fullPath, ext, on) {
    try {
      if (ext === "pdf") {
        const r = await exec("pdftotext", ["-layout", "-nopgbrk", "-l", "50", fullPath, "-"], { on }).catch(() => null);
        if (r?.code === 0 && r.stdout?.trim()) return { text: r.stdout, label: "PDF Document (Extracted Text)" };
      } else if (["docx", "doc", "rtf", "odt"].includes(ext)) {
        const r = await exec("textutil", ["-convert", "txt", "-stdout", fullPath], { on }).catch(() => null);
        if (r?.code === 0 && r.stdout?.trim()) return { text: r.stdout, label: "Word Document (Extracted Text)" };
        const pyScript = "import zipfile, xml.etree.ElementTree as ET, sys\ntry:\n  with zipfile.ZipFile(sys.argv[1]) as z:\n    tree = ET.fromstring(z.read('word/document.xml'))\n    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}\n    p = [''.join(t.text for t in node.findall('.//w:t', ns) if t.text) for node in tree.findall('.//w:p', ns)]\n    print('\\n\\n'.join(x for x in p if x))\nexcept: sys.exit(1)";
        const py = await exec("python3", ["-c", pyScript, fullPath], { on }).catch(() => null);
        if (py?.code === 0 && py.stdout?.trim()) return { text: py.stdout, label: "Word Document (Extracted Text)" };
      } else if (["pptx", "ppt"].includes(ext)) {
        const pyScript = "import zipfile, xml.etree.ElementTree as ET, sys\ntry:\n  with zipfile.ZipFile(sys.argv[1]) as z:\n    slides = sorted([n for n in z.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml')], key=lambda x: int(''.join(c for c in x if c.isdigit()) or 0))\n    ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}\n    out = []\n    for idx, s in enumerate(slides, 1):\n      tree = ET.fromstring(z.read(s))\n      texts = [t.text for t in tree.findall('.//a:t', ns) if t.text]\n      if texts:\n        out.append(f'--- Slide {idx} ---\\n' + '\\n'.join(texts))\n    print('\\n\\n'.join(out))\nexcept: sys.exit(1)";
        const py = await exec("python3", ["-c", pyScript, fullPath], { on }).catch(() => null);
        if (py?.code === 0 && py.stdout?.trim()) return { text: py.stdout, label: "PowerPoint Presentation (Extracted Text)" };
      }
    } catch {}
    return null;
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    this.isBinary = false; this.fileSize = null; this.category = null; this.isExtracted = false; this.extractedLabel = null;
    this.savedValue = null; this.isDirty = false; this.saving = false; this.saveError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    const fullPath = `${root}/${path}`;
    const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "";
    const category = getFileCategory(path);

    cx.spawn(async cx => {
      try {
        if (category?.canExtract) {
          const extracted = await this.extractText(fullPath, ext, on);
          if (this.file !== path || !this.current(context)) return;
          if (extracted?.text) {
            const t = theme();
            this.isExtracted = true;
            this.extractedLabel = extracted.label;
            this.category = category;
            this.code = EditorState.new({
              language: "markdown",
              readonly: true,
              value: extracted.text.length > 400000 ? extracted.text.slice(0, 400000) + "\n… (truncated)" : extracted.text,
              font_family: settings().font_family,
              font_size: 12,
              syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 }
            });
            cx.notify();
            return;
          }
        }

        let text = null;
        try {
          text = await readTextFile(fullPath, { on });
        } catch {
          text = null;
        }

        if (this.file !== path || !this.current(context)) return;

        if (text !== null && !text.includes("\0")) {
          const t = theme(), lang = LANG[ext] ?? ext;
          this.savedValue = text;
          this.isDirty = false;
          this.code = EditorState.new({
            language: lang,
            readonly: false, // Editable text file!
            value: text,
            font_family: settings().font_family,
            font_size: 12,
            line_numbers: true,
            folding: true,
            syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 }
          });

          // Track modifications (dirty state)
          this.code.on("change", (_e, cx) => {
            const dirty = this.code ? this.code.value() !== this.savedValue : false;
            if (dirty !== this.isDirty) {
              this.isDirty = dirty;
              cx.notify();
            }
          });
        } else {
          this.isBinary = true;
          this.category = category ?? { type: "binary", label: "Binary File", badge: "BIN", color: "#64748b" };
          const statFlag = window()?.platform === "linux" ? "-c%s" : "-f%z";
          const statRes = await exec("stat", [statFlag, fullPath], { on }).catch(() => null);
          if (statRes?.code === 0) {
            const bytes = parseInt(statRes.stdout.trim(), 10);
            this.fileSize = formatBytes(bytes);
          }
        }
      } catch (err) {
        if (this.file === path && this.current(context)) {
          this.isBinary = true;
          this.category = category ?? { type: "binary", label: "Binary File", badge: "BIN", color: "#64748b" };
        }
      } finally {
        cx.notify();
      }
    });
  }

  // Save changes to current text file
  save(cx) {
    if (!this.file || !this.code || this.saving || this.isExtracted || this.isBinary) return;
    const fullPath = `${this.root}/${this.file}`;
    const newContent = this.code.value();
    const original = this.savedValue;
    const on = this.on;
    this.saving = true;
    this.saveError = null;
    cx.notify();

    cx.spawn(async cx => {
      try {
        let written = false;
        // 1. Try Herdr native atomic writeTextFile
        if (!on) {
          try {
            await writeTextFile(fullPath, newContent, original);
            written = true;
          } catch {
            try {
              await writeTextFile(fullPath, newContent, null);
              written = true;
            } catch {}
          }
        }

        // 2. Reliable fallback via Python / base64
        if (!written) {
          const b64 = btoa(unescape(encodeURIComponent(newContent)));
          const plat = window()?.platform;
          if (plat === "windows") {
            const r = await exec("powershell", ["-NoProfile", "-Command", `[System.IO.File]::WriteAllBytes('${fullPath.replace(/'/g, "''")}', [System.Convert]::FromBase64String('${b64}'))`], { on });
            if (r.code !== 0) throw new Error(r.stderr || "Save failed");
          } else {
            const pyScript = "import sys, base64\nwith open(sys.argv[2], 'wb') as f: f.write(base64.b64decode(sys.argv[1]))";
            const r = await exec("python3", ["-c", pyScript, b64, fullPath], { on });
            if (r.code !== 0) {
              const shCmd = `printf "%s" "$1" | base64 -d 2>/dev/null || printf "%s" "$1" | base64 -D 2>/dev/null > "$2"`;
              const shR = await exec("sh", ["-c", shCmd, "write", b64, fullPath], { on });
              if (shR.code !== 0) throw new Error(r.stderr || shR.stderr || "Save failed");
            }
          }
        }

        this.savedValue = newContent;
        this.isDirty = false;
        this.toastNotice = "✓ File saved!";
        cx.notify();
        cx.timer.after(2000, cx => {
          if (this.toastNotice === "✓ File saved!") {
            this.toastNotice = null;
            cx.notify();
          }
        });
      } catch (err) {
        this.saveError = String(err);
        this.toastNotice = "Save failed!";
        cx.notify();
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  openWithDefaultApp(targetPath, cx) {
    const fullPath = targetPath ? (targetPath.startsWith("/") ? targetPath : `${this.root}/${targetPath}`) : `${this.root}/${this.file}`;
    if (!fullPath) return;
    const on = this.on;
    cx.spawn(async () => {
      const plat = window()?.platform;
      if (plat === "windows") {
        await exec("powershell", ["-NoProfile", "-Command", `Start-Process -LiteralPath '${fullPath.replace(/'/g, "''")}'`], { on }).catch(() => null);
      } else if (plat === "linux") {
        await exec("xdg-open", [fullPath], { on }).catch(() => null);
      } else {
        await exec("open", [fullPath], { on }).catch(() => null);
      }
    });
  }

  quickLook(targetPath, cx) {
    const fullPath = targetPath ? (targetPath.startsWith("/") ? targetPath : `${this.root}/${targetPath}`) : `${this.root}/${this.file}`;
    if (!fullPath) return;
    const on = this.on;
    cx.spawn(async () => {
      const plat = window()?.platform;
      if (plat === "windows" || plat === "linux") {
        this.openWithDefaultApp(targetPath, cx);
      } else {
        await exec("sh", ["-c", 'qlmanage -p "$1" >/dev/null 2>&1 &', "ql", fullPath], { on }).catch(() => null);
      }
    });
  }

  revealInFinder(targetPath, cx) {
    const fullPath = targetPath ? (targetPath.startsWith("/") ? targetPath : `${this.root}/${targetPath}`) : `${this.root}/${this.file}`;
    if (!fullPath) return;
    const on = this.on;
    cx.spawn(async () => {
      const plat = window()?.platform;
      if (plat === "windows") {
        await exec("explorer.exe", [`/select,${fullPath}`], { on }).catch(() => null);
      } else if (plat === "linux") {
        const folder = fullPath.substring(0, fullPath.lastIndexOf("/"));
        await exec("xdg-open", [folder], { on }).catch(() => null);
      } else {
        await exec("open", ["-R", fullPath], { on }).catch(() => null);
      }
    });
  }

  copyToClipboard(text, label, cx) {
    if (!text) return;
    const on = this.on;
    cx.spawn(async cx => {
      const plat = window()?.platform;
      if (plat === "macos") {
        await exec("sh", ["-c", 'printf "%s" "$1" | pbcopy', "copy", text], { on }).catch(() => null);
      } else if (plat === "windows") {
        await exec("powershell", ["-NoProfile", "-Command", `Set-Clipboard -Value '${text.replace(/'/g, "''")}'`], { on }).catch(() => null);
      } else {
        await exec("sh", ["-c", 'printf "%s" "$1" | xclip -selection clipboard 2>/dev/null || printf "%s" "$1" | xsel -b', "copy", text], { on }).catch(() => null);
      }
      this.toastNotice = label || "Copied to clipboard!";
      this.copied = true;
      cx.notify();
      cx.timer.after(2000, cx => {
        this.toastNotice = null;
        this.copied = false;
        cx.notify();
      });
    });
  }

  openContextMenu(entry, path, pos, cx) {
    const panelWidth = this.size?.width ?? 340;
    const panelHeight = this.size?.height ?? 600;
    const menuWidth = 230;
    const menuHeight = entry.dir ? 220 : 280;

    let x = Math.max(8, Math.min(pos.x ?? 80, panelWidth - menuWidth - 12));
    let y = Math.max(36, Math.min(pos.y ?? 120, panelHeight - menuHeight - 12));

    this.contextMenu = {
      path,
      fullPath: `${this.root}/${path}`,
      isDir: entry.dir,
      name: entry.name,
      category: !entry.dir ? getFileCategory(entry.name) : null,
      x,
      y
    };
    cx.notify();
  }

  closeContextMenu(cx) {
    if (this.contextMenu) {
      this.contextMenu = null;
      cx.notify();
    }
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const category = !entry.dir ? getFileCategory(entry.name) : null;
      const isSelected = this.file === path || this.contextMenu?.path === path;

      out.push(
        h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 16).pr(6).gap(6).items_center().rounded(6).cursor_pointer()
          .when(isSelected, s => s.bg(t.selected))
          .when(!isSelected, s => s.hover(h => h.bg(t.hover)))
          // Left click: toggle folder or preview file
          .on_click((_e, cx) => {
            this.closeContextMenu(cx);
            entry.dir ? this.toggle(path, cx) : this.show(path, cx);
          })
          // Right click: open context menu!
          .on_mouse_down("right", (e, cx) => {
            cx.stop_propagation();
            const pos = e.position ?? { x: 100, y: 150 };
            this.openContextMenu(entry, path, pos, cx);
          })
          .child(entry.dir ? svg(`mods/files-enhanced/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
          .child(svg(`mods/files-enhanced/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(entry.dir ? t.muted : (category ? category.color : t.muted)))
          .child(div().flex_1().min_w(0).text_size(12.5).truncate().child(entry.name))
          .when(Boolean(category), el => el.child(div().text_size(9).px(4).py(0.5).rounded(3).bg(t.raised).text_color(category.color).child(category.badge)))
          .when(Boolean(mark), el => el.child(div().text_size(10.5).font_semibold().text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)))
          // Dedicated "···" Context Menu button (visible on hover)
          .child(
            div().id(`btn-dots-${path}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
              .hover(s => s.bg(t.raised))
              .on_mouse_down("left", (e, cx) => {
                cx.stop_propagation();
                const pos = e.position ?? { x: 120, y: 150 };
                this.openContextMenu(entry, path, pos, cx);
              })
              .child(svg("mods/files-enhanced/dots.svg").size(12).text_color(t.dim))
          )
      );
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  // Render Context Menu Dropover
  renderContextMenu(t, plat) {
    const ctx = this.contextMenu;
    if (!ctx) return div();

    const menuItem = (id, iconSvg, label, action, isDanger = false) =>
      h_flex().id(id).h(27).px(8).gap(7).items_center().rounded(5).cursor_pointer()
        .hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          this.closeContextMenu(cx);
          action(cx);
        })
        .child(svg(iconSvg).size(13).flex_none().text_color(isDanger ? t.ansi1 : t.muted))
        .child(div().text_size(11.5).text_color(isDanger ? t.ansi1 : t.foreground).truncate().child(label));

    const divider = () => div().h(1).my(3).bg(t.border);

    return div().id("ctx-layer").absolute().inset_0()
      // Transparent backdrop click catcher
      .child(
        div().id("ctx-backdrop").absolute().inset_0().cursor_default()
          .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.closeContextMenu(cx); })
          .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); this.closeContextMenu(cx); })
      )
      // Popover Menu Frame
      .child(
        v_flex().id("ctx-popover").absolute().top(ctx.y).left(ctx.x).w(226).p(5).gap(1).rounded(8)
          .bg(t.popover ?? t.surface).border_1().border_color(t.border).shadow_lg().text_color(t.foreground)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          // Header: Entry Name & Type
          .child(
            h_flex().px(8).py(5).gap(6).items_center().rounded(4).bg(t.raised)
              .child(svg(`mods/files-enhanced/${ctx.isDir ? "folder" : "file"}.svg`).size(13).text_color(ctx.category ? ctx.category.color : t.muted))
              .child(div().flex_1().min_w(0).font_semibold().text_size(11.5).truncate().child(ctx.name))
              .when(Boolean(ctx.category), el => el.child(div().text_size(9).px(3).py(0.5).rounded(3).bg(t.surface).text_color(ctx.category.color).child(ctx.category.badge)))
          )
          .child(divider())

          // Context Actions for FILES
          .when(!ctx.isDir, el => el
            .child(menuItem("ctx-preview", "mods/files-enhanced/file.svg", "Edit / View in Panel", (cx) => this.show(ctx.path, cx)))
            .child(menuItem("ctx-default-app", "mods/files-enhanced/external.svg", "Open with Default App ↗", (cx) => this.openWithDefaultApp(ctx.fullPath, cx)))
            .when(plat === "macos", el2 => el2.child(menuItem("ctx-quicklook", "mods/files-enhanced/file.svg", "Quick Look 👁", (cx) => this.quickLook(ctx.fullPath, cx))))
            .child(menuItem("ctx-finder", "mods/files-enhanced/folder.svg", plat === "macos" ? "Reveal in Finder 📂" : "Reveal in File Manager 📂", (cx) => this.revealInFinder(ctx.fullPath, cx)))
            .child(divider())
            .child(menuItem("ctx-term-folder", "mods/files-enhanced/terminal.svg", "Open Folder in Terminal Tab", (cx) => {
              const folder = ctx.fullPath.substring(0, ctx.fullPath.lastIndexOf("/"));
              run("tab.new", { folder });
            }))
            .child(menuItem("ctx-split-right", "mods/files-enhanced/terminal.svg", "Split Terminal Right Here", (cx) => {
              const folder = ctx.fullPath.substring(0, ctx.fullPath.lastIndexOf("/"));
              run("pane.split", { direction: "right", folder });
            }))
            .child(divider())
            .child(menuItem("ctx-copy-rel", "mods/files-enhanced/copy.svg", "Copy Relative Path", (cx) => this.copyToClipboard(ctx.path, "Copied relative path!", cx)))
            .child(menuItem("ctx-copy-abs", "mods/files-enhanced/copy.svg", "Copy Full Absolute Path", (cx) => this.copyToClipboard(ctx.fullPath, "Copied full path!", cx)))
          )

          // Context Actions for FOLDERS
          .when(ctx.isDir, el => el
            .child(menuItem("ctx-term-tab", "mods/files-enhanced/terminal.svg", "Open in New Terminal Tab", (_cx) => run("tab.new", { folder: ctx.fullPath })))
            .child(menuItem("ctx-term-right", "mods/files-enhanced/terminal.svg", "Split Terminal Right Here", (_cx) => run("pane.split", { direction: "right", folder: ctx.fullPath })))
            .child(menuItem("ctx-term-down", "mods/files-enhanced/terminal.svg", "Split Terminal Down Here", (_cx) => run("pane.split", { direction: "down", folder: ctx.fullPath })))
            .child(divider())
            .child(menuItem("ctx-open-folder", "mods/files-enhanced/external.svg", plat === "macos" ? "Open in Finder 📂" : "Open in File Manager 📂", (cx) => this.openWithDefaultApp(ctx.fullPath, cx)))
            .child(menuItem("ctx-copy-rel-dir", "mods/files-enhanced/copy.svg", "Copy Relative Path", (cx) => this.copyToClipboard(ctx.path, "Copied relative folder path!", cx)))
            .child(menuItem("ctx-copy-abs-dir", "mods/files-enhanced/copy.svg", "Copy Full Absolute Path", (cx) => this.copyToClipboard(ctx.fullPath, "Copied full folder path!", cx)))
            .child(divider())
            .child(menuItem("ctx-toggle-dir", `mods/files-enhanced/chevron-${this.folders.has(ctx.path) ? "down" : "right"}.svg`, this.folders.has(ctx.path) ? "Collapse Folder" : "Expand Folder", (cx) => this.toggle(ctx.path, cx)))
          )
      );
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), plat = window()?.platform ?? "macos";
    const fullPath = this.file ? `${this.root}/${this.file}` : "";

    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).relative().track_focus(this.handle)
      .on_size_change((size, cx) => {
        this.size = size;
        cx.notify();
      })
      .on_key_down((e, cx) => {
        // Cmd+S or Ctrl+S: Save file!
        if ((e.modifiers.cmd || e.modifiers.ctrl) && e.key === "s") {
          cx.stop_propagation();
          this.save(cx);
          return;
        }
        if (e.key === "escape") {
          if (this.contextMenu) {
            this.closeContextMenu(cx);
            cx.stop_propagation();
          } else if (this.file) {
            this.show(null, cx);
            cx.stop_propagation();
          }
        }
      })

      // Top Toolbar Header
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .when(Boolean(this.file), el => el.child(div().id("files-back").size(22).rounded(4).cursor_pointer().hover(s => s.bg(t.hover)).flex().items_center().justify_center().text_color(t.muted).on_click((_e, cx) => { this.show(null, cx); }).child("←")))
        .child(div().font_semibold().text_size(13).child("Files"))
        .when(Boolean(this.isExtracted), el => el.child(div().text_size(10).px(5).py(1).rounded(4).bg(t.raised).text_color(t.accent).child("Extracted Text")))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(11.5).text_color(this.isDirty ? t.foreground : t.dim)
          .child(this.isDirty ? `● ${this.file}` : (this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
        .when(Boolean(this.toastNotice), el => el.child(div().text_size(10.5).px(6).py(1).rounded(4).bg(t.raised).text_color(this.saveError ? t.ansi1 : t.ansi2).child(this.toastNotice)))
        .when(Boolean(this.file), el => el
          .child(h_flex().gap(4).flex_none()
            // Save button for editable text files
            .when(Boolean(this.code && !this.isExtracted), elSave => elSave.child(
              h_flex().id("btn-save-file").h(26).px(8).gap(5).rounded(5).items_center().cursor_pointer()
                .when(this.isDirty, s => s.bg(t.solid).text_color(t.solid_foreground))
                .when(!this.isDirty, s => s.bg(t.raised).text_color(t.muted).hover(h => h.bg(t.hover).text_color(t.foreground)))
                .on_click((_e, cx) => this.save(cx))
                .child(svg("mods/files-enhanced/save.svg").size(12).text_color(this.isDirty ? t.solid_foreground : t.muted))
                .child(div().text_size(11).font_medium().child(this.saving ? "Saving…" : this.isDirty ? "Save ●" : "Save"))
            ))
            .child(div().id("btn-open-top").px(6).py(1.5).rounded(4).bg(t.raised).hover(s => s.bg(t.hover)).cursor_pointer().text_size(11).on_click((_e, cx) => this.openWithDefaultApp(this.file, cx)).child("Open ↗"))
            .when(plat === "macos", el2 => el2.child(div().id("btn-ql-top").px(6).py(1.5).rounded(4).bg(t.raised).hover(s => s.bg(t.hover)).cursor_pointer().text_size(11).on_click((_e, cx) => this.quickLook(this.file, cx)).child("Quick Look 👁")))
          )))

      // File Tree List View
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(5).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))

      // File Preview / Editor (Text Editor)
      .when(Boolean(this.file && this.code), el => el.child(
        v_flex().size_full().min_h(0)
          .when(Boolean(this.isExtracted), el2 => el2.child(
            h_flex().px(12).py(6).bg(t.raised).border_b(1).border_color(t.border).items_center().justify_between().gap(8)
              .child(div().text_size(11).text_color(t.muted).child("Previewing text extracted from " + (this.category?.label ?? "document")))
              .child(h_flex().gap(6)
                .child(div().px(6).py(1).rounded(4).bg(t.solid).text_color(t.solid_foreground).cursor_pointer().text_size(10).hover(s => s.bg(t.accent)).on_click((_e, cx) => this.openWithDefaultApp(this.file, cx)).child("Open Original ↗"))
                .when(plat === "macos", el3 => el3.child(div().px(6).py(1).rounded(4).bg(t.hover).cursor_pointer().text_size(10).on_click((_e, cx) => this.quickLook(this.file, cx)).child("Quick Look 👁")))
              )
          ))
          .child(Editor.new(this.code).flex_1().min_h(0))
      ))

      // Binary Document Card
      .when(Boolean(this.file && this.isBinary && !this.code), el => el.child(
        v_flex().size_full().min_h(0).p(16).items_center().justify_center().gap(14)
          .child(
            v_flex().w_full().max_w(340).p(20).rounded(12).bg(t.surface).border_1().border_color(t.border).gap(14).items_center()
              .child(
                h_flex().w(52).h(52).rounded(10).bg(this.category?.color ?? t.accent).items_center().justify_center()
                  .child(div().text_size(16).font_semibold().text_color("#ffffff").child(this.category?.badge ?? "FILE"))
              )
              .child(
                v_flex().items_center().gap(4)
                  .child(div().font_semibold().text_size(14).truncate().child(this.file.split("/").pop() ?? ""))
                  .child(div().text_size(12).text_color(t.muted).child(this.category?.label ?? "Binary Document"))
                  .when(Boolean(this.fileSize), el2 => el2.child(div().text_size(11).text_color(t.dim).child(`Size: ${this.fileSize}`)))
              )
              .child(
                v_flex().w_full().gap(8).pt(4)
                  .child(
                    h_flex().id("btn-open-primary").h(34).w_full().rounded(7).bg(t.solid).text_color(t.solid_foreground).items_center().justify_center().gap(6).cursor_pointer().hover(s => s.bg(t.accent))
                      .on_click((_e, cx) => this.openWithDefaultApp(this.file, cx))
                      .child(div().font_semibold().text_size(12).child("Open with Default Application ↗"))
                  )
                  .when(plat === "macos", el2 => el2.child(
                    h_flex().id("btn-quicklook").h(32).w_full().rounded(7).bg(t.raised).text_color(t.foreground).border_1().border_color(t.border).items_center().justify_center().gap(6).cursor_pointer().hover(s => s.bg(t.hover))
                      .on_click((_e, cx) => this.quickLook(this.file, cx))
                      .child(div().text_size(12).child("Quick Look Preview 👁"))
                  ))
                  .child(
                    h_flex().id("btn-finder").h(32).w_full().rounded(7).bg(t.raised).text_color(t.foreground).border_1().border_color(t.border).items_center().justify_center().gap(6).cursor_pointer().hover(s => s.bg(t.hover))
                      .on_click((_e, cx) => this.revealInFinder(this.file, cx))
                      .child(div().text_size(12).child(plat === "macos" ? "Reveal in Finder 📂" : "Reveal in Folder 📂"))
                  )
                  .child(
                    h_flex().id("btn-copy-path").h(28).w_full().rounded(7).items_center().justify_center().cursor_pointer().hover(s => s.bg(t.hover))
                      .on_click((_e, cx) => this.copyToClipboard(fullPath, "Copied full path!", cx))
                      .child(div().text_size(11).text_color(this.copied ? t.ansi2 : t.muted).child(this.copied ? "✓ Path copied to clipboard!" : "Copy Full Path 📋"))
                  )
              )
          )
      ))
      .when(Boolean(this.file && !this.code && !this.isBinary), el => el.child(
        div().p(16).text_color(t.dim).child(this.fileError || "Loading file…")
      ))

      // Context Menu Overlay Layer
      .when(Boolean(this.contextMenu), _el => this.renderContextMenu(t, plat));
  }
}
