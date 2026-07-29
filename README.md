# The Macintosh

The Macintosh is a clean-room Electron recreation of the tactile black-and-white desktop language associated with classic Macintosh System 6 and System 7. It is a desktop shell, not an emulator: it contains no Apple ROMs, copied system files, extracted icons, or proprietary startup artwork.

On macOS, the native application menu and Dock identify the program as **The Macintosh**, with an original monochrome compact-computer icon that follows the desktop's clean-room visual language.

The first version includes an original monochrome startup sequence, fixed Finder-style menu bar, pixel-authored pointer states, draggable desktop icons, marquee and multi-selection, active/inactive draggable and resizable Finder windows, internal and host file drag-and-drop, document Copy/Paste, custom scrollbars, working Finder commands, a functional Calculator desk accessory, an About dialog, original code-drawn 1-bit bitmap icons, synthesized system sounds, and a persistent virtual disk.

## Run it

Node.js 22 or newer is required.

```sh
npm install
npm run dev
```

`npm run dev` builds the production renderer and Electron main/preload processes, then launches the frameless desktop. After a successful build, `npm start` launches it directly. On macOS, both commands create a cached, ad-hoc-signed **The Macintosh.app** development runtime under `dist/runtime/`; the Electron dependency in `node_modules` is left untouched.

## Controls

- Click, Shift-click, or drag a marquee to select System Disk, Trash, and ordinary desktop files and folders.
- Drag System Disk or Trash to reposition it.
- Double-click System Disk, Trash, folders, or documents to open Finder windows.
- In icon view, drag one or more selected Finder items to any pixel position in the open window. Dropping them onto a folder still moves them into that folder.
- Drag selected documents or folders onto empty desktop space, into another folder, onto System Disk, or into Trash. Empty-desktop drops preserve a free icon position; moving a folder preserves its contents and invalid descendant drops are refused.
- Drop files or folders from the host Finder onto the desktop, System Disk, or an open folder. Empty-desktop drops create visible items at the drop point. Text documents keep their readable contents; binary files are represented by a safe document placeholder rather than copied into the virtual disk.
- Use **Edit > Copy** or Command-C on selected Finder items, then **Paste** or Command-V to duplicate them in the active folder. Host files copied in Finder can also be pasted, while pasted plain text becomes a new `Clipboard` document.
- Drag a window title bar to move its 1-bit outline; the full window redraws at the new position when released. Use its close and zoom boxes, or resize it from the lower-right grow box.
- Use the System, File, Edit, View, and Special menus for About, New Folder, Open, Close, Get Info, selection, view, cleanup, and Trash commands.
- Open **Calculator** from the System menu. It supports mouse or keyboard input for digits, decimal points, the four basic operators, Return/Enter for equals, C/Delete to clear, and Escape to close.
- To quit, drag **System Disk onto Trash**. Trash opens and highlights, the disk ejects with a sound and stepped animation, the current desktop and virtual disk are saved, and the Electron main process quits the application. Releasing the disk anywhere else simply leaves it at that position.

## Validation

```sh
npm run check
npm run smoke
```

`npm run check` runs formatting verification, ESLint, strict TypeScript checks for both renderer and Electron, Vitest, and the production build.

`npm run smoke` launches the real Electron application with isolated temporary user data. It verifies the native **The Macintosh** application name, menu label, window title, and icon asset; checks the authored arrow, grab, drag, and resize cursor dimensions and hotspots; exercises pointer-based menu selection plus Finder zoom and resize controls; places a disk-backed file and nested folder directly on Desktop; moves and freely repositions a Finder item on Desktop; tests Desktop selection, Open, Get Info, blocked document fall-through, and destination-specific System Disk, folder, and Trash drops; pastes and duplicates documents; freely repositions Finder and special desktop icons; exercises Calculator button and keyboard input, modal dialog precedence, drag-session input ownership, save-failure cancellation, and a Finder command through both its menu item and keyboard shortcut; verifies cancelled and committed Trash movement, exact Trash artwork-edge/label hit testing for System Disk and internal items at normal, scaled, and minimum-window coordinates, and eject animation; observes the renderer-to-main quit request; checks the resulting schema-3 state file; and relaunches Electron to prove exact Desktop/Finder icon layout, disk, and virtual-filesystem recovery.

## Architecture and security

- `src/main/` owns the frameless `BrowserWindow`, state files, IPC validation, and application quit.
- `src/renderer/` contains the React desktop, Finder components, interaction state, pixel artwork, sound synthesis, and styling.
- `src/shared/` contains the typed IPC contract and defensive persistent-state schema.
- Persistent state is written as `macintosh-state.json` inside Electron's per-user application-data directory using a temporary file followed by an atomic rename. The VFS has required System Disk, Trash, and hidden Desktop roots; ordinary desktop items are direct children of Desktop and always carry explicit persisted coordinates.
- The window uses `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and `webSecurity: true`.
- The preload exposes presentation-only persistence plus typed create, move, duplicate, document, import, Trash, paste-command, and eject capabilities. The main process owns the canonical virtual filesystem, serializes each mutation, and commits it atomically before returning the resulting state.
- The renderer owns selection, hit testing, drag previews, and free-form layout interaction, but it has no Node.js or direct host-filesystem access. Import paths can only be derived from browser-granted `File` objects created by a user drop or paste; host inspection and the resulting VFS import commit occur together in the main process.
- Navigation and new windows are denied. All code and visuals are bundled locally; there are no CDNs or runtime network requests.

The virtual disk deliberately contains documents and folders only. Application modules such as painting, text editing, and control panels can be added later without widening the preload API.
