import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

// Vibrant Git Graph color palette (SourceTree style)
const LANE_COLORS = [
  "#3b82f6", // Blue
  "#f97316", // Orange
  "#10b981", // Emerald Green
  "#8b5cf6", // Purple
  "#06b6d4", // Cyan
  "#ec4899", // Pink
  "#eab308", // Amber
  "#6366f1", // Indigo
  "#14b8a6", // Teal
  "#f43f5e", // Rose
];

// Parses git log decorations e.g. "(HEAD -> develop, origin/develop, tag: 1.0.50+74)"
function parseDecorations(raw) {
  if (!raw || !raw.trim()) return [];
  const cleaned = raw.trim().replace(/^\(|\)$/g, "").trim();
  if (!cleaned) return [];
  const parts = cleaned.split(",").map(s => s.trim()).filter(Boolean);
  const refs = [];

  for (const part of parts) {
    if (part.startsWith("HEAD -> ")) {
      refs.push({ type: "head", isHead: true, name: part.slice(8).trim() });
    } else if (part === "HEAD") {
      refs.push({ type: "head", isHead: true, name: "HEAD" });
    } else if (part.startsWith("tag: ")) {
      refs.push({ type: "tag", isHead: false, name: part.slice(5).trim() });
    } else if (part.includes("/")) {
      refs.push({ type: "remote", isHead: false, name: part });
    } else {
      refs.push({ type: "branch", isHead: false, name: part });
    }
  }
  return refs;
}

// SourceTree-style Git Graph calculation
function calculateGraph(commits) {
  const activeLanes = [];
  const graphRows = [];

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    let lane = activeLanes.indexOf(c.hash);
    if (lane === -1) {
      lane = activeLanes.indexOf(null);
      if (lane === -1) {
        lane = activeLanes.length;
        activeLanes.push(c.hash);
      } else {
        activeLanes[lane] = c.hash;
      }
    }

    const lanesBefore = [...activeLanes];
    const isHead = c.refs.some(r => r.isHead) || (i === 0 && !commits.some(x => x.refs.some(r => r.isHead)));

    const parentLanes = [];
    if (c.parents.length === 0) {
      activeLanes[lane] = null;
    } else {
      // First parent continues on the current lane
      activeLanes[lane] = c.parents[0];
      parentLanes.push({ parent: c.parents[0], lane });

      // Merged parent branches
      for (let p = 1; p < c.parents.length; p++) {
        const parentHash = c.parents[p];
        let pLane = activeLanes.indexOf(parentHash);
        if (pLane === -1) {
          pLane = activeLanes.indexOf(null);
          if (pLane === -1) {
            pLane = activeLanes.length;
            activeLanes.push(parentHash);
          } else {
            activeLanes[pLane] = parentHash;
          }
        }
        parentLanes.push({ parent: parentHash, lane: pLane });
      }
    }

    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop();
    }
    const lanesAfter = [...activeLanes];

    graphRows.push({
      commit: c,
      lane,
      lanesBefore,
      lanesAfter,
      parentLanes,
      isHead,
      isMerge: c.parents.length > 1
    });
  }

  const maxLanes = Math.max(1, ...graphRows.map(r => Math.max(r.lane + 1, r.lanesBefore.length, r.lanesAfter.length)));
  return { rows: graphRows, maxLanes };
}

export default class ChangesEnhanced extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });

    // Section view states
    this.viewMode = "split"; // "split" | "changes" | "tree"
    this.changesCollapsed = false;
    this.currentBranch = "";
    this.branchAheadBehind = "";
    this.commits = [];
    this.graph = { rows: [], maxLanes: 1 };
    this.selectedCommit = null;
    this.selectedCommitDetails = null;
    this.loadingHistory = false;
    this.copiedNotice = false;

    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null;
      this.note = null; this.watched = null; this.closed = false; this.limited = false;
      this.commits = []; this.graph = { rows: [], maxLanes: 1 };
      this.selectedCommit = null; this.selectedCommitDetails = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) {
          this.root = null; this.files = []; this.setLines([]); this.open = null;
          this.commits = []; this.graph = { rows: [], maxLanes: 1 };
          this.error = "Not a git repository"; return;
        }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });

        // 1. Current Branch & Ahead/Behind Status
        const branchRes = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
        this.currentBranch = branchRes.code === 0 ? branchRes.stdout.trim() : "";

        const upstreamRes = await git(["rev-list", "--left-right", "--count", "HEAD...@{u}"]).catch(() => ({ code: 1, stdout: "" }));
        if (upstreamRes.code === 0 && upstreamRes.stdout.trim()) {
          const [ahead, behind] = upstreamRes.stdout.trim().split(/\s+/);
          const parts = [];
          if (Number(ahead) > 0) parts.push(`↑${ahead}`);
          if (Number(behind) > 0) parts.push(`↓${behind}`);
          this.branchAheadBehind = parts.join(" ");
        } else {
          this.branchAheadBehind = "";
        }

        // 2. Working Tree Changes Status
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0
          ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
          : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];

        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }

        // 3. Commit History & Graph (SourceTree style)
        if (head.code === 0) {
          const logRes = await git([
            "log",
            "-n", "75",
            "--date-order",
            "--format=%H%x00%h%x00%p%x00%an%x00%ad%x00%ar%x00%s%x00%d",
            "--date=format:%Y-%m-%d %H:%M"
          ]);
          if (logRes.code === 0 && logRes.stdout.trim()) {
            const commitLines = logRes.stdout.trim().split("\n");
            const parsedCommits = [];
            for (const line of commitLines) {
              const [hash, short, parentsStr, author, date, relativeDate, subject, rawDecorations] = line.split("\0");
              if (!hash) continue;
              const parents = parentsStr ? parentsStr.trim().split(/\s+/).filter(Boolean) : [];
              const refs = parseDecorations(rawDecorations || "");
              parsedCommits.push({
                hash,
                short: short || hash.slice(0, 7),
                parents,
                author: author || "Unknown",
                date: date || "",
                relativeDate: relativeDate || "",
                subject: subject || "(no commit message)",
                refs
              });
            }
            this.commits = parsedCommits;
            this.graph = calculateGraph(parsedCommits);
          }
        } else {
          this.commits = [];
          this.graph = { rows: [], maxLanes: 1 };
        }

        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files;
        this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);

        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  selectCommit(c, cx) {
    if (this.selectedCommit?.hash === c.hash) {
      this.selectedCommit = null;
      this.selectedCommitDetails = null;
      cx.notify();
      return;
    }
    this.selectedCommit = c;
    this.selectedCommitDetails = { loading: true, files: [] };
    const root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", [...READ, "show", "--stat=200", "--oneline", c.hash], { cwd: root, on });
        if (r.code === 0) {
          const lines = r.stdout.trim().split("\n");
          this.selectedCommitDetails = {
            loading: false,
            statSummary: lines[lines.length - 1] || "",
            files: lines.slice(1, -1).map(l => l.trim()).filter(Boolean)
          };
        } else {
          this.selectedCommitDetails = { loading: false, error: r.stderr, files: [] };
        }
      } catch (e) {
        this.selectedCommitDetails = { loading: false, error: String(e), files: [] };
      }
      cx.notify();
    });
    cx.notify();
  }

  copyHash(hash, cx) {
    cx.spawn(async (cx) => {
      await exec("sh", ["-c", 'printf "%s" "$1" | pbcopy 2>/dev/null || true', "copy", hash]);
      this.copiedNotice = true;
      cx.notify();
      cx.timer.after(2000, (cx) => {
        this.copiedNotice = false;
        cx.notify();
      });
    });
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // SourceTree-style vector Graph Cell (26px height)
  renderGraphCell(row, t, laneWidth = 14) {
    const lane = row.lane;
    const laneX = lane * laneWidth + 10;
    const laneColor = LANE_COLORS[lane % LANE_COLORS.length];
    const cellWidth = Math.max(50, (this.graph.maxLanes + 1) * laneWidth + 10);

    const elements = [];

    // 1. Vertical passing lines on other lanes
    for (let l = 0; l < this.graph.maxLanes; l++) {
      if (l === lane) continue;
      const activeBefore = row.lanesBefore[l] !== undefined && row.lanesBefore[l] !== null;
      const activeAfter = row.lanesAfter[l] !== undefined && row.lanesAfter[l] !== null;
      if (activeBefore && activeAfter) {
        const col = LANE_COLORS[l % LANE_COLORS.length];
        elements.push(
          div().key(`pass-${l}`).absolute().left(l * laneWidth + 9).top(0).bottom(0).w(2).bg(col)
        );
      }
    }

    // 2. Incoming vertical line to commit node (top: 0 to top: 13)
    if (row.lanesBefore[lane]) {
      elements.push(
        div().key("in-line").absolute().left(laneX - 1).top(0).h(13).w(2).bg(laneColor)
      );
    }

    // 3. Outgoing vertical line to direct parent (top: 13 to bottom: 0)
    if (row.lanesAfter[lane]) {
      elements.push(
        div().key("out-line").absolute().left(laneX - 1).top(13).bottom(0).w(2).bg(laneColor)
      );
    }

    // 4. Branching & Merging connectors (diagonal / horizontal steps)
    for (const p of row.parentLanes) {
      if (p.lane !== lane) {
        const pColor = LANE_COLORS[p.lane % LANE_COLORS.length];
        const pX = p.lane * laneWidth + 10;
        const left = Math.min(laneX, pX);
        const width = Math.abs(laneX - pX);
        // Horizontal connecting arm
        elements.push(
          div().key(`merge-arm-${p.lane}`).absolute().left(left).top(12).w(width).h(2).bg(pColor)
        );
        // Vertical step down to row bottom on parent lane
        elements.push(
          div().key(`merge-down-${p.lane}`).absolute().left(pX - 1).top(13).bottom(0).w(2).bg(pColor)
        );
      }
    }

    // 5. Commit Node Marker
    if (row.isHead) {
      // SourceTree HEAD style: Outer ring + center dot
      elements.push(
        div().key("node-head").absolute().left(laneX - 5).top(7).size(12).rounded(6)
          .border_2().border_color(laneColor).bg(t.background).flex().items_center().justify_center()
          .child(div().size(4).rounded(2).bg(laneColor))
      );
    } else if (row.isMerge) {
      // Merge commit marker
      elements.push(
        div().key("node-merge").absolute().left(laneX - 4).top(8).size(10).rounded(5)
          .bg(laneColor).border_1().border_color(t.background).flex().items_center().justify_center()
          .child(div().size(3).rounded(1.5).bg(t.background))
      );
    } else {
      // Standard commit dot
      elements.push(
        div().key("node-dot").absolute().left(laneX - 3.5).top(8.5).size(9).rounded(4.5).bg(laneColor)
      );
    }

    return div().relative().w(cellWidth).h(26).flex_none().children(elements);
  }

  // Ref badges (branches and tags)
  renderRefBadge(ref, t) {
    if (ref.type === "tag") {
      return h_flex().key(`tag-${ref.name}`).h(18).px(5).gap(3).items_center().rounded(4)
        .bg("#10b9811c").border_1().border_color("#10b98166").text_size(10.5).text_color("#10b981")
        .child(svg("mods/changes-enhanced/tag.svg").size(10))
        .child(div().truncate().max_w(130).child(ref.name));
    }
    if (ref.type === "remote") {
      return h_flex().key(`rem-${ref.name}`).h(18).px(5).gap(3).items_center().rounded(4)
        .bg("#f973161c").border_1().border_color("#f9731666").text_size(10.5).text_color("#f97316")
        .child(svg("mods/changes-enhanced/changes.svg").size(10))
        .child(div().truncate().max_w(150).child(ref.name));
    }
    // Local branch / HEAD
    return h_flex().key(`br-${ref.name}`).h(18).px(5).gap(3).items_center().rounded(4)
      .bg(ref.isHead ? "#3b82f62b" : "#3b82f61c").border_1().border_color(ref.isHead ? "#3b82f6aa" : "#3b82f666")
      .text_size(10.5).text_color("#3b82f6")
      .child(svg("mods/changes-enhanced/changes.svg").size(10))
      .child(div().truncate().max_w(150).child(ref.name));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const graphWidth = Math.max(56, (this.graph.maxLanes + 1) * 14 + 10);

    const showChanges = this.viewMode === "split" || this.viewMode === "changes";
    const showTree = this.viewMode === "split" || this.viewMode === "tree";

    return v_flex().id("changes-enhanced").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })

      // Top Master Header
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(div().font_semibold().text_size(13).child("Git Changes & Tree"))
        .when(Boolean(this.currentBranch), el =>
          el.child(h_flex().px(6).py(1).gap(4).rounded(4).bg(t.surface).border_1().border_color(t.border).items_center()
            .child(svg("mods/changes-enhanced/changes.svg").size(11).text_color(t.accent))
            .child(div().text_size(11).font_family(settings().font_family ?? "JetBrains Mono").text_color(t.foreground).child(this.currentBranch)))
        )
        .when(Boolean(this.branchAheadBehind), el =>
          el.child(div().text_size(10).px(4).py(1).rounded(3).bg(t.raised).text_color(t.dim).child(this.branchAheadBehind))
        )
        .child(div().flex_1())
        // View Mode Switcher: Changes / Split / Tree
        .child(h_flex().gap(2).p(2).rounded(6).bg(t.surface).border_1().border_color(t.border)
          .child(div().id("btn-mode-changes").px(6).py(1).rounded(4).text_size(10.5).cursor_pointer()
            .when(this.viewMode === "changes", e => e.bg(t.raised).font_semibold().text_color(t.foreground))
            .when(this.viewMode !== "changes", e => e.text_color(t.dim).hover(s => s.text_color(t.foreground)))
            .on_click((_e, cx) => { this.viewMode = "changes"; cx.notify(); }).child("Changes"))
          .child(div().id("btn-mode-split").px(6).py(1).rounded(4).text_size(10.5).cursor_pointer()
            .when(this.viewMode === "split", e => e.bg(t.raised).font_semibold().text_color(t.foreground))
            .when(this.viewMode !== "split", e => e.text_color(t.dim).hover(s => s.text_color(t.foreground)))
            .on_click((_e, cx) => { this.viewMode = "split"; cx.notify(); }).child("Split"))
          .child(div().id("btn-mode-tree").px(6).py(1).rounded(4).text_size(10.5).cursor_pointer()
            .when(this.viewMode === "tree", e => e.bg(t.raised).font_semibold().text_color(t.foreground))
            .when(this.viewMode !== "tree", e => e.text_color(t.dim).hover(s => s.text_color(t.foreground)))
            .on_click((_e, cx) => { this.viewMode = "tree"; cx.notify(); }).child("Tree")))
        .child(div().id("refresh-btn").size(24).flex().items_center().justify_center().rounded(5).cursor_pointer()
          .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.refresh(cx))
          .child(svg("mods/changes-enhanced/refresh.svg").size(13).text_color(t.muted)))
      )

      // ================= SECTION 1: WORKING TREE CHANGES =================
      .when(showChanges, el => el.child(
        v_flex().id("section-changes").flex_1().min_h(120).overflow_hidden()
          // Sub-header for changes
          .child(h_flex().h(30).flex_none().px(12).gap(6).items_center().bg(t.raised).border_b(1).border_color(t.border)
            .child(div().id("toggle-changes-btn").cursor_pointer().flex().items_center().gap(5)
              .on_click((_e, cx) => { this.changesCollapsed = !this.changesCollapsed; cx.notify(); })
              .child(svg(this.changesCollapsed ? "mods/changes-enhanced/chevron-right.svg" : "mods/changes-enhanced/chevron-down.svg").size(12).text_color(t.muted))
              .child(div().font_semibold().text_size(11.5).child("Uncommitted Changes")))
            .child(div().px(5).py(0.5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
            .child(div().flex_1())
            .child(div().text_size(10.5).text_color(t.ansi2).child(`+${add}`))
            .child(div().text_size(10.5).text_color(t.ansi1).child(`−${del}`))
          )
          .when(!this.changesCollapsed, changesBox => changesBox
            // File list
            .child(div().h(Math.min(100, Math.max(34, this.files.length * 26 + 8))).relative().border_b(1).border_color(t.border)
              .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(4).children(this.files.map((f) => {
                const parts = f.path.split("/"), name = parts.pop();
                return h_flex().id(`change-${f.path}`).h(25).flex_none().px(8).gap(6).items_center().rounded(5).cursor_pointer()
                  .when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
                  .child(div().w(14).text_size(10.5).font_semibold().text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
                  .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).text_size(11).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(240).min_w(0).text_size(11).truncate().child(name)))
                  .when(f.add > 0, (e) => e.child(div().text_size(10).text_color(t.ansi2).child(`+${f.add}`)))
                  .when(f.del > 0, (e) => e.child(div().text_size(10).text_color(t.ansi1).child(`−${f.del}`)));
              })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).text_size(11).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
              .child(Scrollbar.vertical("changes-list").absolute().inset_0())
            )
            // Diff preview
            .child(div().flex_1().min_h(60).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(10.5)
              .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
                .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
                  (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
              .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
              .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes")))
            )
            .when(Boolean(this.note), (e) => e.child(div().px(10).pb(4).text_size(10.5).text_color(t.ansi1).child(this.note)))
            // Commit input & button
            .child(h_flex().flex_none().p(8).gap(6).border_t(1).border_color(t.border)
              .child(div().id("commit-message").flex_1().min_w(0).h(30).px(8).flex().items_center().rounded(6).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(11.5).text_color(t.foreground)))
              .child(div().id("commit").h(30).px(12).flex().items_center().rounded(6).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(11.5).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit"))
            )
          )
      ))

      // ================= SECTION 2: SOURCETREE-STYLE BRANCH TREE =================
      .when(showTree, el => el.child(
        v_flex().id("section-tree").flex_1().min_h(140).border_t(showChanges ? 1 : 0).border_color(t.border).overflow_hidden()
          // SourceTree Columns Header
          .child(h_flex().h(28).flex_none().px(8).gap(6).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(11).font_semibold().text_color(t.muted)
            .child(div().w(graphWidth).flex_none().px(2).child("Graph"))
            .child(div().flex_1().min_w(0).child("Description"))
            .child(div().w(68).flex_none().child("Commit"))
            .child(div().w(110).flex_none().child("Author"))
            .child(div().w(105).flex_none().child("Date"))
          )
          // Table Body: Virtualized / Scrollable Commit Rows
          .child(div().flex_1().min_h(0).relative().overflow_x_scroll()
            .child(div().min_w(520).size_full().relative()
              .child(v_flex().id("commit-tree-list").absolute().inset_0().overflow_y_scroll().children(
                this.graph.rows.map((row) => {
                  const c = row.commit;
                  const isSelected = this.selectedCommit?.hash === c.hash;
                  return h_flex().id(`commit-row-${c.hash}`).h(26).flex_none().px(8).gap(6).items_center().cursor_pointer()
                    .when(isSelected, e => e.bg(t.selected))
                    .when(!isSelected, e => e.hover(s => s.bg(t.hover)))
                    .on_click((_e, cx) => this.selectCommit(c, cx))
                    // Graph Column
                    .child(this.renderGraphCell(row, t, 14))
                    // Description Column (Ref Badges + Commit Message)
                    .child(h_flex().flex_1().min_w(0).gap(5).items_center()
                      .children(c.refs.map(ref => this.renderRefBadge(ref, t)))
                      .child(div().flex_1().min_w(0).text_size(11.5).truncate().text_color(isSelected ? t.foreground : t.foreground).child(c.subject))
                    )
                    // Commit Hash Column
                    .child(h_flex().w(68).flex_none().items_center().gap(3)
                      .child(div().text_size(11).font_family(settings().font_family ?? "JetBrains Mono").text_color(t.dim).child(c.short))
                      .child(div().size(16).flex().items_center().justify_center().rounded(3).hover(s => s.bg(t.raised))
                        .on_click((e, cx) => { e.stop_propagation(); this.copyHash(c.hash, cx); })
                        .child(svg("mods/changes-enhanced/copy.svg").size(10).text_color(t.muted)))
                    )
                    // Author Column
                    .child(div().w(110).flex_none().text_size(11).text_color(t.muted).truncate().child(c.author))
                    // Date Column
                    .child(div().w(105).flex_none().text_size(10.5).text_color(t.dim).truncate().child(c.date));
                })
              ).when(!this.commits.length, (e) =>
                e.child(div().p(12).text_color(t.dim).text_size(11).child(this.loadingHistory ? "Loading branch history…" : "No commit history found"))
              ))
              .child(Scrollbar.vertical("commit-tree-list").absolute().inset_0())
            )
          )
          // Commit Details Drawer (when a commit is clicked)
          .when(Boolean(this.selectedCommit), el => el.child(
            v_flex().flex_none().max_h(120).p(8).gap(4).bg(t.raised).border_t(1).border_color(t.border).text_size(11)
              .child(h_flex().items_center().gap(8)
                .child(div().font_semibold().text_color(t.accent).child(`Commit ${this.selectedCommit.short}`))
                .child(div().text_color(t.dim).font_family(settings().font_family ?? "JetBrains Mono").text_size(10).child(this.selectedCommit.hash))
                .child(div().id("copy-selected-hash").px(6).py(1).rounded(4).bg(t.surface).border_1().border_color(t.border).cursor_pointer()
                  .on_click((_e, cx) => this.copyHash(this.selectedCommit.hash, cx))
                  .child(this.copiedNotice ? "Copied!" : "Copy Full SHA"))
                .child(div().flex_1())
                .child(div().cursor_pointer().text_color(t.dim).hover(s => s.text_color(t.foreground))
                  .on_click((_e, cx) => { this.selectedCommit = null; cx.notify(); }).child("✕ Close"))
              )
              .child(div().font_medium().text_color(t.foreground).child(this.selectedCommit.subject))
              .child(h_flex().gap(12).text_color(t.muted).text_size(10.5)
                .child(div().child(`Author: ${this.selectedCommit.author}`))
                .child(div().child(`Date: ${this.selectedCommit.date} (${this.selectedCommit.relativeDate})`))
              )
              .when(Boolean(this.selectedCommitDetails?.statSummary), e =>
                e.child(div().text_color(t.dim).text_size(10).child(this.selectedCommitDetails.statSummary))
              )
          ))
      ));
  }
}
