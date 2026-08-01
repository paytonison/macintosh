# The Macintosh

The Macintosh is a clean-room Electron recreation of the tactile black-and-white desktop language associated with classic Macintosh System 6 and System 7. It is a desktop shell, not an emulator: it contains no Apple ROMs, copied system files, extracted icons, or proprietary startup artwork.

On macOS, the native application menu and Dock identify the program as **The Macintosh**, with an original monochrome compact-computer icon that follows the desktop's clean-room visual language.

The first version includes an original monochrome startup sequence, an application-owned Finder-style menu bar, pixel-authored pointer states, draggable desktop icons, marquee and multi-selection, active/inactive draggable and resizable windows, internal and host file drag-and-drop, document Copy/Paste, custom scrollbars, working Finder commands, a functional Calculator desk accessory, the page-oriented Write word processor, an About dialog, original code-drawn 1-bit bitmap icons, synthesized system sounds, and a persistent virtual disk.

## Run it

Node.js 22 or newer is required.

```sh
npm install
npm run dev
```

`npm run dev` builds the production renderer and Electron main/preload processes, then launches the frameless desktop. After a successful build, `npm start` launches it directly. On macOS, both commands create a cached, ad-hoc-signed **The Macintosh.app** development runtime under `dist/runtime/`; the Electron dependency in `node_modules` is left untouched.

## Controls

- Click, Shift-click, or drag a marquee to select System Disk, Trash, and ordinary desktop files and folders.
- The authored white-filled, black-outlined 1-bit pointer uses a System 1-style arrow normally. Finder and desktop files and folders, plus the complete System Disk and Trash icon-and-label regions, use a pointing finger on hover, an open hand while pressed before dragging begins, and a closed fist throughout an active drag. Internal item and System Disk drags keep icon-only previews under the pointer, with solid shadows over Desktop and dithered shadows over white window surfaces; the committed source remains in place until release.
- Drag System Disk or Trash to reposition it.
- Double-click System Disk, Trash, or a folder to open a Finder window with a short stepped scale from the originating icon. The Finder move-preview outline and its hard pixel shadow follow the scaling window; closing reverses the effect.
- Double-click **Write** in Applications to create a transient untitled document. Double-click any virtual document to open it in Write; opening the same saved document again activates its existing window instead of making a duplicate.
- In icon view, drag one or more selected Finder items to any pixel position in the open window. Dropping them onto a folder still moves them into that folder.
- Drag selected documents or folders onto empty desktop space, into another folder, onto System Disk, or into Trash. Empty-desktop drops preserve a free icon position; moving a folder preserves its contents and invalid descendant drops are refused.
- Drop files or folders from the host Finder onto the desktop, System Disk, or an open folder. Empty-desktop drops create visible items at the drop point. Text documents keep their readable contents; binary files are represented by a safe document placeholder rather than copied into the virtual disk.
- Use **Edit > Copy** or Command-C on selected Finder items, then **Paste** or Command-V to duplicate them in the active folder. Host files copied in Finder can also be pasted, while pasted plain text becomes a new `Clipboard` document.
- Drag a window title bar to move its 1-bit outline; the full window redraws at the new position when released. Use its close and zoom boxes, or resize it from the lower-right grow box.
- Use the System, File, Edit, View, and Special menus for About, New Folder, Open, Close, Get Info, selection, view, cleanup, and Trash commands.
- In Write, use File, Edit, Format, Font, Size, and View for explicit Save and Save As, virtual-disk Open, Undo/Redo, Clipboard editing, bold/italic/underline, paragraph alignment and spacing, indents, tabs, manual page breaks, the three built-in font families, six point sizes, and 50%, 75%, or 100% page zoom. The ruler controls left, first-line, and right indents plus custom tab stops.
- Write lays out a linear document on US Letter pages with one-inch margins. Automatic page flow is editor-only presentation; manual page breaks are semantic blocks. Saved rich documents contain paragraphs, formatting, tabs, and explicit page breaks rather than pixel coordinates or cached automatic pages. An untouched plain-text document remains plain text until a rich-formatting action is used.
- Write never autosaves. Closing a dirty document asks for Save, Don’t Save, or Cancel. Untitled documents enter the virtual Save As dialog, which starts in Documents and never exposes Trash. Normal Quit and disk ejection review every dirty Write window before the final desktop save and shutdown transaction.
- Open **Calculator** from the System menu. It supports mouse or keyboard input for digits, decimal points, the four basic operators, Return/Enter for equals, C/Delete to clear, and Escape to close.
- Command-Q, the native application-menu Quit item, and closing the application first review dirty Write documents, then reconcile one final renderer presentation snapshot into the main process's canonical state through the serialized writer before Electron exits. Repeated requests join the same transaction. Cancel resumes the application; if the final save fails, the application stays open and presents a persistence error so the session can be recovered or retried.
- To quit, drag **System Disk onto Trash**. Trash opens and highlights, the disk ejects with a sound and stepped animation, the current desktop and virtual disk are saved, and the Electron main process quits the application. Releasing the disk anywhere else simply leaves it at that position.

## Validation

```sh
npm run check
npm run smoke
```

`npm run check` runs formatting verification, ESLint, strict TypeScript checks for both renderer and Electron, Vitest, and the production build.

`npm run smoke` launches the real Electron application with isolated temporary user data. It verifies the native **The Macintosh** application name, menu label, window title, and icon asset; checks the authored 1-bit cursor bindings, dimensions, hotspots, hover, press, thresholded drag, backdrop-contrasted icon shadows, reset transitions, off-center pointer alignment, and focus-loss cleanup; exercises pointer-based menu selection plus Finder zoom and resize controls; places a disk-backed file and nested folder directly on Desktop; tests selection, Open, Get Info, stepped Finder opening and closing with the outline and hard shadow aligned behind sampled frames, blocked document fall-through, and destination-specific System Disk, folder, and Trash drops; moves and freely repositions items on Desktop and in Finder; pastes and duplicates documents; exercises Calculator input, modal precedence, drag-session ownership, save-failure cancellation, and Finder commands through menus and shortcuts; opens plain documents in Write, promotes and explicitly saves rich content, creates an untitled paged document, exercises formatting, tabs, manual page breaks, virtual Open and Save As, one-window identity, dirty-close recovery, multi-document quit review, and saved-document relaunch; verifies cancelled and committed special-icon movement, System Disk drag preview, exact Trash artwork-edge and label hit testing at normal, scaled, and minimum-window coordinates, and eject animation; proves a failed normal-quit save keeps the app open, repeated quit requests coalesce, and a mutation inside the presentation debounce window survives normal Quit; checks the resulting schema-4 state file and canonical built-in creation metadata; and relaunches Electron to prove exact Desktop/Finder layout, Write content, disk, and virtual-filesystem recovery.

## Architecture and security

- `src/main/` owns the frameless `BrowserWindow`, state files, IPC validation, and application quit.
- `src/renderer/` contains the React desktop, Finder and Write components, application/interaction state, the custom ProseMirror schema and page projection, pixel artwork, sound synthesis, and styling.
- `src/shared/` contains the typed IPC contract, defensive persistent-state schema, and bounded plain-text/`write-v1` document types.
- Persistent state is written as `macintosh-state.json` inside Electron's per-user application-data directory using a temporary file followed by an atomic rename. The VFS has required System Disk, Trash, and hidden Desktop roots; ordinary desktop items are direct children of Desktop and always carry explicit persisted coordinates.
- The window uses `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and `webSecurity: true`.
- The preload exposes presentation-only persistence plus typed create, update, move, duplicate, document, import, Trash, narrow Clipboard-edit, cancellable normal-quit, and eject capabilities. The main process owns canonical document content and the rest of the virtual filesystem, serializes each mutation, and commits it atomically before returning the resulting state.
- Normal quit uses the same main-owned writer: the renderer supplies only its final allowlisted presentation patch, the main process merges it into canonical state, and Electron exits only after that atomic write succeeds.
- The renderer owns selection, hit testing, drag previews, and free-form layout interaction, but it has no Node.js or direct host-filesystem access. Import paths can only be derived from browser-granted `File` objects created by a user drop or paste; host inspection and the resulting VFS import commit occur together in the main process.
- Navigation and new windows are denied. All code and visuals are bundled locally; there are no CDNs or runtime network requests.

The virtual disk contains documents, folders, and the built-in Write application entry. Write uses only original UI and code-drawn artwork, and its document mutations stay inside the existing bounded, local-first VFS authority rather than widening the renderer to host filesystem access.
