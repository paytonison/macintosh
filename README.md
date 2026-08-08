# The Macintosh

The Macintosh is a clean-room Electron recreation of the tactile black-and-white desktop
language associated with classic Macintosh System 6 and System 7. It is a working desktop shell,
not an emulator and not a modern application with a retro theme laid over it.

The program contains no Apple ROMs, copied system files, extracted icons, proprietary startup
artwork, or copied system sounds. Its interface, bitmap artwork, startup sequence, and audio are
original.

The current version is a small, coherent Macintosh environment with a persistent Finder, a virtual
disk, a Calculator desk accessory, and **Write**, a page-oriented word processor. On macOS, the
application menu and Dock identify it as **The Macintosh** with an original monochrome
compact-computer icon.

## What is included

### Desktop and Finder

- An original monochrome startup sequence and an application-owned Finder-style menu bar.
- A persistent System Disk, Trash, hidden Desktop root, and ordinary desktop files and folders.
- Finder windows with active and inactive states, title-bar movement, resizing, zooming, custom
  scrollbars, and stepped outline opening and closing transitions. Finder and Write outlines emerge
  from the actual pixel-art glyph center through the nearest final window corner and close back to
  the currently visible glyph; transitions without a visible source retain the centered fallback.
- Icon and name views. Icon view supports free, per-pixel placement inside Finder windows; name view
  remains sorted and restores saved icon positions when icon view returns.
- Click, Shift-click, marquee, and multi-item selection across the desktop and the active Finder
  window.
- Pointer-owned internal drags with authored pointing-finger, open-hand, and closed-fist cursors.
  Drag previews preserve the selected items' arrangement and use icon-shaped shadows that remain
  legible over either the patterned desktop or white windows.
- Movement between folders, the desktop, System Disk, and Trash, including recursive folder moves
  and protection against invalid descendant drops.
- New Folder, Open, Close Window, Get Info, Copy, Paste, Select All, Clear Selection, View by Icon,
  View by Name, Empty Trash, and Clean Up Desktop commands.
- Original Get Info, About, error, and ejection dialogs with modal input ownership.
- Synthesized menu and ejection sounds.

System Disk and Trash can be repositioned independently. Dragging System Disk onto the visible
Trash artwork begins the Macintosh shutdown gesture: dirty Write documents are reviewed, the latest
desktop and virtual-disk state is saved, and the application quits only after persistence succeeds.

### Write

Write is a built-in, page-oriented WYSIWYG word processor. Open it from **Applications**, or open any
virtual document directly from the desktop or Finder.

- Multiple document windows, with one live window per saved document and any number of untitled
  drafts.
- US Letter pages with one-inch margins, automatic forward and backward page flow, a current-page
  status line, semantic manual page breaks, and bounded layout convergence before saving.
- Helvetica by default, with serif and monospaced alternatives plus 9, 10, 12, 14, 18, and 24 point
  character formatting that can be applied to part of a paragraph.
- Bold, italic, and underline; left, center, and right alignment; single, 1.5, and double line
  spacing; and left, first-line, and right indents.
- A working ruler with draggable indents, default half-inch tabs, and custom tab stops that can be
  added, moved, or removed with cancellable pointer sessions.
- Finder-matched 15-pixel horizontal and vertical scroll bars with authored arrows, patterned
  tracks, and black-and-white thumbs. Wheel and trackpad scrolling remain native to each document
  viewport, while the ruler follows horizontal page scrolling at narrow window sizes.
- Undo, Redo, Cut, Copy, Paste, Clear, Plain Text, Select All, and exact supported Command-key
  shortcuts, including Shift-Command-S for Save As and Shift-Command-Z for Redo.
- 50%, 75%, and 100% page zoom without changing document semantics.
- Virtual-disk Open, Save, and Save As dialogs. Untitled documents begin in Documents; the dialogs
  can reach Desktop, System Disk, and ordinary folders; name collisions create a distinct copy; and
  Trash is never offered as a destination.
- Exact plain-text preservation until a rich-only operation promotes the document to the bounded
  `write-v1` format. Rich files store paragraph layout, inline family, size, bold, italic, and
  underline marks, tabs, and manual page breaks; they do not store HTML, arbitrary CSS, DOM state,
  or measured page coordinates. Earlier beta paragraph-level family and size values sanitize into
  equivalent inline marks.
- Explicit per-window saving with no autosave. Save waits for the latest stable page layout, and an
  edit made during an older in-flight save remains dirty for the next save. Closing a dirty document
  offers Save, Don’t Save, and Cancel; failed saves cancel the close or Quit attempt and keep the
  window and draft recoverable.
- Dirty-document review during both ordinary Quit and System Disk ejection. Cancel aborts the entire
  exit, and a failed final save keeps the program open.

Write does not currently provide printing, PDF or HTML export, images, tables, lists, spellcheck,
collaboration, arbitrary fonts, host Save dialogs, crash recovery, or session restoration.

### Calculator

Calculator is a single-instance desk accessory available from the System menu. It supports pointer
and keyboard entry for decimal numbers, the four basic operations, repeated equals, clear, and
classic immediate-execution arithmetic. It can be moved independently, and closing it clears its
session.

### macOS input bridge

Files and folders can currently move **into** The Macintosh:

- Drop host items from Finder onto the virtual desktop, System Disk, or an open folder.
- Paste files copied in Finder into the active virtual folder or desktop.
- Paste plain text to create a new `Clipboard` document.
- Preserve bounded text contents and nested folder structure. Binary files become clearly marked
  document placeholders; their original bytes are not copied into the virtual disk.

Host imports are bounded virtual copies, not live references. They do not retain arbitrary host
paths, follow symbolic links, or give the renderer general filesystem access. Host items cannot be
dropped into Trash.

The reverse direction is **not implemented yet**: dragging a virtual Macintosh item into Finder,
Mail, or another macOS application does not currently materialize a native host file. A web browser
is also not part of the current program. These are intentionally reserved as the two final product
milestones in [ROADMAP.md](ROADMAP.md).

## Essential controls

- Click, Shift-click, or drag a marquee to select desktop or Finder items.
- Double-click System Disk, Trash, or a folder to open its Finder window.
- Double-click a document to open it in Write; double-click Write in Applications for a new untitled
  document.
- Drag selected files and folders onto folders, open Finder windows, the desktop, System Disk, or
  Trash. A bare drop within the same icon view changes only the saved icon layout.
- Drag Finder or Write title bars to move them with an outline preview, use the lower-right grow box
  to preview a resize with the same stationary-window outline, and use the zoom box or title-bar
  double-click to toggle window zoom.
- Use the System, File, Edit, View, and Special menus for Finder commands. An active Write window
  replaces them with System, File, Edit, Format, Font, Size, and View.
- Open Calculator from the System menu. It receives ordinary keyboard input while preserving the
  current Finder or Write menus; Escape closes it.
- Quit with Command-Q, the native macOS application menu, or the authored System Disk-to-Trash
  gesture. Every normal path observes the same dirty-document and final-save rules.

## Persistence

The main process owns the canonical virtual disk and durable desktop state. It persists:

- System Disk, Trash, and ordinary desktop icon positions;
- per-folder icon positions;
- Finder window identity, geometry, stack order, and view mode;
- virtual files, folders, timestamps, and plain-text or `write-v1` document payloads; and
- the last successful ejection time.

Selections, open menus and dialogs, drag previews, Calculator state, Write windows, untitled drafts,
undo history, page projection, and zoom are intentionally transient.

State is stored as `macintosh-state.json` in Electron's per-user application-data directory. The
main process validates mutations, serializes them through one writer, and replaces the state file
atomically. Normal Quit and ejection do not exit until required document saves and the final desktop
write have completed successfully.

## Run it

Node.js 22 or newer is required.

```sh
npm install
npm run dev
```

`npm run dev` builds the renderer and Electron main/preload processes, then launches the frameless
desktop. After a successful build, `npm start` launches it directly. On macOS, both commands create a
cached, ad-hoc-signed **The Macintosh.app** development runtime under `dist/runtime/`; the Electron
dependency in `node_modules` remains untouched.

## Architecture and security

- `src/main/` owns Electron lifecycle, the secured `BrowserWindow`, canonical state, virtual-disk
  mutations, bounded host-file inspection, atomic persistence, normal Quit, and ejection.
- `src/main/preload.ts` exposes a minimal typed capability bridge.
- `src/renderer/` owns the React desktop, Finder and Write windows, selection, hit testing,
  interaction previews, page projection, pixel artwork, synthesized audio, and styling. It has no
  Node.js or direct host-filesystem access.
- `src/shared/` contains typed IPC contracts, defensive state schemas, virtual-filesystem commands,
  and the bounded plain-text and `write-v1` document models.

The shell runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and
`webSecurity: true`. Navigation and new windows are denied. All current code and visuals are bundled
locally, and the current version performs no runtime networking.

Authored interface paint uses black, white, and aligned bitmap patterns inside a normal DOM/RGBA
renderer. The program does not emulate a literal 1-bit framebuffer or apply a destructive global
image filter.

For the normative interaction, persistence, and ownership rules, see
[docs/interaction-model.md](docs/interaction-model.md).

## Validation

```sh
npm run check
npm run smoke
```

`npm run check` runs formatting verification, ESLint, both strict TypeScript projects, Vitest, and a
production build.

`npm run smoke` builds and launches the real Electron application with isolated temporary user data.
It exercises the native application identity, desktop and Finder interactions, host import,
Calculator, Write editing and saving, dirty-document exit review, persistence failures, System Disk
ejection, atomic state recovery, and relaunch persistence.

The project is licensed under the [BSD 3-Clause License](LICENSE).
