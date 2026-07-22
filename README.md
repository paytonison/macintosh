# Macintosh Workbench

Macintosh Workbench is a clean-room Electron recreation of the tactile black-and-white desktop language associated with classic Macintosh System 6 and System 7. It is a desktop shell, not an emulator: it contains no Apple ROMs, copied system files, extracted icons, or proprietary startup artwork.

The first version includes an original monochrome startup sequence, fixed Finder-style menu bar, draggable desktop icons, marquee and multi-selection, active/inactive draggable and resizable Finder windows, custom scrollbars, working Finder commands, an About dialog, original code-drawn bitmap icons, synthesized system sounds, and a persistent virtual disk.

## Run it

Node.js 22 or newer is required.

```sh
npm install
npm run dev
```

`npm run dev` builds the production renderer and Electron main/preload processes, then launches the frameless desktop. After a successful build, `npm start` launches it directly.

## Controls

- Click, Shift-click, or drag a marquee to select desktop icons.
- Drag System Disk or Trash to reposition it.
- Double-click System Disk, Trash, folders, or documents to open Finder windows.
- Drag a window title bar to move its 1-bit outline; the full window redraws at the new position when released. Use its close and zoom boxes, or resize it from the lower-right grow box.
- Use the System, File, Edit, View, and Special menus for About, New Folder, Open, Close, Get Info, selection, view, cleanup, and Trash commands.
- To quit, drag **System Disk onto Trash**. Trash opens and highlights, the disk ejects with a sound and stepped animation, the current desktop and virtual disk are saved, and the Electron main process quits the application. An invalid drop snaps the disk back without changing the saved position.

## Validation

```sh
npm run check
npm run smoke
```

`npm run check` runs formatting verification, ESLint, strict TypeScript checks for both renderer and Electron, Vitest, and the production build.

`npm run smoke` launches the real Electron application with isolated temporary user data. It exercises a working menu command and About dialog, verifies that the disk follows native pointer input, verifies invalid-drop snapback, confirms the live Trash drop-target state and eject animation, observes the renderer-to-main quit request, checks the atomically written state file, and relaunches Electron to prove the disk and virtual filesystem reload.

## Architecture and security

- `src/main/` owns the frameless `BrowserWindow`, state files, IPC validation, and application quit.
- `src/renderer/` contains the React desktop, Finder components, interaction state, pixel artwork, sound synthesis, and styling.
- `src/shared/` contains the typed IPC contract and defensive persistent-state schema.
- Persistent state is written as `macintosh-state.json` inside Electron's per-user application-data directory using a temporary file followed by an atomic rename.
- The window uses `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and `webSecurity: true`.
- The preload exposes only `loadState`, `saveState`, and `quitAfterEject`; the renderer has no Node.js or host-filesystem access.
- Navigation and new windows are denied. All code and visuals are bundled locally; there are no CDNs or runtime network requests.

The virtual disk deliberately contains documents and folders only. Application modules such as painting, text editing, and control panels can be added later without widening the preload API.
