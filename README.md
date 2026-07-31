# The Macintosh

The Macintosh is a clean-room Electron recreation of the tactile black-and-white desktop language associated with classic Macintosh System 6 and System 7. It is a desktop shell, not an emulator: it contains no Apple ROMs, copied system files, extracted icons, or proprietary startup artwork.

On macOS, the native application menu and Dock identify the program as **The Macintosh**, with an original monochrome compact-computer icon that follows the desktop's clean-room visual language.

The first version includes an original monochrome startup sequence, fixed Finder-style menu bar, draggable desktop icons, marquee and multi-selection, active/inactive draggable and resizable Finder windows, internal and host file drag-and-drop, document Copy/Paste, custom scrollbars, working Finder commands, a functional Calculator desk accessory, an About dialog, original code-drawn 1-bit bitmap icons, synthesized system sounds, and a persistent virtual disk.

## Run it

Node.js 22 or newer is required.

```sh
npm install
npm run dev
```

`npm run dev` builds the production renderer and Electron main/preload processes, then launches the frameless desktop. After a successful build, `npm start` launches it directly. On macOS, both commands create a cached, ad-hoc-signed **The Macintosh.app** development runtime under `dist/runtime/`; the Electron dependency in `node_modules` is left untouched.

## Controls

- Click, Shift-click, or drag a marquee to select desktop icons.
- The authored white-filled, black-outlined 1-bit pointer uses a System 1-style arrow normally. Finder and desktop files and folders, plus the complete System Disk and Trash icon-and-label regions, use a pointing finger on hover, an open hand while the primary button is held before dragging begins, and a closed fist for the full active drag. Once an internal file, folder, or System Disk drag begins, the grabbed bitmap stays under the fist with a three-pixel icon-shaped shadow instead of a rectangular drag image. The shadow is solid black over the patterned Desktop and 50% dithered over white window surfaces. The committed source remains in place until release. Release, cancellation, or lost pointer capture restores the pointing finger over an item and the arrow elsewhere.
- Drag any desktop item to reposition it. Multi-item drags preserve the selected icons' relative arrangement.
- Double-click System Disk, Trash, folders, or documents to open Finder windows with a short stepped scale from the originating icon. The Finder move-preview outline and its hard pixel shadow follow behind the scaling window; closing reverses the effect.
- In icon view, drag one or more selected Finder items to any pixel position in the open window. Dropping them onto a folder still moves them into that folder.
- Drag selected documents or folders into another folder, onto System Disk, or into Trash. Moving a folder preserves its contents and invalid descendant drops are refused.
- Drop files or folders from the host Finder onto bare desktop space to place them there, or directly onto System Disk or an open folder to import them into that destination. Text documents keep their readable contents; binary files are represented by a safe document placeholder rather than copied into the virtual disk.
- Use **Edit > Copy** or Command-C on selected Finder items, then **Paste** or Command-V to duplicate them in the active folder. Host files copied in Finder can also be pasted, while pasted plain text becomes a new `Clipboard` document.
- Drag a window title bar to move its 1-bit outline; the full window redraws at the new position when released. Use its close and zoom boxes, or resize it from the lower-right grow box.
- Use the System, File, Edit, View, and Special menus for About, New Folder, Open, Close, Get Info, selection, view, cleanup, and Trash commands.
- Open **Calculator** from the System menu. It supports mouse or keyboard input for digits, decimal points, the four basic operators, Return/Enter for equals, C/Delete to clear, and Escape to close.
- Command-Q, the native application-menu Quit item, and closing the application all flush the latest desktop state through the serialized writer before Electron exits. If that final save fails, the application stays open and presents a persistence error so the session can be recovered or retried.
- To quit, drag **System Disk onto Trash**. Trash opens and highlights, the disk ejects with a sound and stepped animation, the current desktop and virtual disk are saved, and the Electron main process quits the application. Releasing the disk anywhere else simply leaves it at that position.

## Validation

```sh
npm run check
npm run smoke
```

`npm run check` runs formatting verification, ESLint, strict TypeScript checks for both renderer and Electron, Vitest, and the production build.

`npm run smoke` launches the real Electron application with isolated temporary user data. It verifies the native **The Macintosh** application name, menu label, window title, and icon asset; checks the authored 1-bit cursor bindings, hover, press, thresholded drag, backdrop-contrasted icon shadows for virtual items and System Disk, reset transitions, and native closed-fist continuity through Electron cursor-change events; verifies off-center pointer alignment and focus-loss cleanup; imports a disk-backed file and nested folder onto bare Desktop space; checks Desktop selection, Get Info, stepped Finder folder and document opening and closing with the move-preview outline and hard shadow aligned behind every sampled frame, direct System Disk import, document fall-through blocking, and host Trash rejection; moves and freely repositions an internal item on Desktop; pastes and duplicates documents; freely repositions a Finder icon; moves a folder and document into direct targets; exercises Calculator button and keyboard input, modal dialog precedence, drag-session input ownership, save-failure cancellation, and a Finder command through both its menu item and keyboard shortcut; verifies cancelled Trash movement, disk preview following, the live Trash drop-target state, and eject animation; checks that a failed normal-quit save keeps the app open, repeated quit requests coalesce, and a mutation made inside the 220 ms debounce window survives normal Quit; checks the resulting state file, including canonical System Disk creation metadata; and relaunches Electron to prove the exact icon layout, Desktop content and hierarchy, disk, and virtual filesystem reload.

## Architecture and security

- `src/main/` owns the frameless `BrowserWindow`, state files, IPC validation, and application quit.
- `src/renderer/` contains the React desktop, Finder components, interaction state, pixel artwork, sound synthesis, and styling.
- `src/shared/` contains the typed IPC contract and defensive persistent-state schema.
- Persistent state is written as `macintosh-state.json` inside Electron's per-user application-data directory using a temporary file followed by an atomic rename.
- The window uses `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and `webSecurity: true`.
- The preload exposes narrow state, paste-command, bounded file-import, final-state quit-flush, and post-eject quit capabilities; the renderer has no Node.js or direct host-filesystem access. Import paths can only be derived from browser-granted `File` objects created by a user drop or paste, and filesystem inspection stays in the main process.
- Navigation and new windows are denied. All code and visuals are bundled locally; there are no CDNs or runtime network requests.

The virtual disk deliberately contains documents and folders only. Application modules such as painting, text editing, and control panels can be added later without widening the preload API.
