# Endgame Roadmap

The Macintosh already has the foundation these ideas need: one coherent desktop, a main-owned
virtual filesystem, durable Finder state, bounded host import, explicit input ownership, and a real
document application in Write. This roadmap deliberately reserves only two final product milestones:

1. a web browser that behaves as an ordinary Macintosh application; and
2. a native drag-and-drop bridge that lets virtual items cross back into macOS.

This is not a general feature backlog and it does not assign release dates. The milestones begin only
after the existing desktop, Finder, persistence, and Write behavior are stable enough that new trust
boundaries will not conceal unfinished core work.

## Current baseline

The current application is local-first and has no runtime networking. Its renderer cannot access
Node.js or arbitrary host paths. Host files and folders can enter the virtual disk only through an
explicit user drop or paste, after which the main process inspects and commits a bounded virtual copy.
Internal virtual-file movement remains a custom pointer-owned session.

Neither endgame direction exists yet:

- There is no Browser application, guest web content, remote navigation, download handling, or
  persistent browsing session.
- There is no Macintosh-to-macOS drag. A virtual file is not currently materialized as a real file
  that Finder, Mail, Messages, TextEdit, or another host application can receive.

That boundary is intentional. Each milestone adds a capability that must remain narrower than the
feature it enables.

## Entry gate

Before either milestone starts:

- `npm run check` and `npm run smoke` must pass from a clean checkout.
- There must be no known data-loss path in Write save, dirty close, normal Quit, ejection, or canonical
  state persistence.
- The active-window, keyboard-owner, menu-owner, modal, drag, and cancellation rules in
  `docs/interaction-model.md` must match the live application.
- Any state-schema change needed by the milestone must have bounded sanitization, migration tests,
  malformed-state coverage, and a relaunch proof before UI work is called complete.
- New IPC must be typed, sender-validated, semantic rather than generic, and covered at the main,
  preload, and renderer boundary.

## Final milestone 1: Browser

### Intended result

The Browser should feel like software installed on the virtual System Disk, not an external Electron
panel. The user opens **Browser** from Applications, receives a normal Macintosh application window,
types an address, and navigates the modern web inside that window. The contrast is part of the idea:
strict black-and-white Macintosh chrome containing a real contemporary page.

The Browser must participate in the same environment as Write:

- a built-in Browser application node lives in Applications;
- opening it activates an existing Browser window or creates one according to its documented window
  rule;
- its window participates in the shared stack, active/inactive treatment, movement, resizing,
  close/zoom behavior, keyboard ownership, menu ownership, modal precedence, and normal Quit;
- System, File, Edit, Go, and View commands derive availability from the active Browser context and
  use the same actions as their visible controls and shortcuts; and
- closing the Browser tears down its remote content and leaves Finder or the next application as the
  coherent input owner.

The first complete version should be deliberately small and tabless. It needs:

- an address field and Go action;
- Back and Forward;
- Reload and Stop;
- a simple local start or empty page;
- page title, current address, loading, failure, and TLS-error feedback;
- ordinary scrolling, text selection, link activation, and page keyboard input; and
- a clear blocked-action response when a page requests something outside the allowed surface.

Tabs, extensions, password management, bookmark synchronization, developer tools, arbitrary
protocol handlers, and a general download manager are not required for this milestone.

### Rendering boundary

The Browser's title bar, controls, menus, status treatment, focus feedback, and errors remain authored
black-and-white Macintosh interface paint. Remote page content is foreign document content and may
render in its original color and typography. It must be visibly clipped to the Browser's content
viewport and must never repaint or style the surrounding desktop.

The Browser must not replace the existing renderer with a canvas, a literal 1-bit framebuffer, or a
global filter. If a future deliberate mode quantizes web content, that transformation belongs at the
guest-content boundary and is not part of the initial milestone.

### Architecture

Remote pages must not load inside the trusted local shell document. The preferred implementation is
a main-process-owned `WebContentsView` with its own hardened `WebContents`, visually synchronized to
an authored Browser window in the renderer.

The implementation should proceed in this order:

1. **Guest-view feasibility proof**
   - Prove in the real Electron app that a `WebContentsView` can remain clipped to the simulated
     Browser viewport while the window moves, resizes, zooms, activates, deactivates, and closes.
   - Prove that menus, dialogs, drag previews, shutdown layers, and inactive application windows are
     never trapped beneath native guest content. The guest view may be hidden while a higher-priority
     Macintosh layer owns input.
   - Prove focus can transfer among the address field, remote page, Browser chrome, another Macintosh
     window, and a modal dialog without sending one key or pointer event to two owners.

2. **Application identity and commands**
   - Add an allowlisted `browser` application identifier and a built-in Browser VFS node through an
     explicit state-schema migration.
   - Add Browser window state and active-owner handling without turning application-specific behavior
     into a speculative plugin framework.
   - Extract shared window or menu behavior only where Browser and Write demonstrate the same actual
     responsibility.

3. **Narrow control bridge**
   - Add typed commands for navigate, Back, Forward, Reload, Stop, focus, bounded viewport geometry,
     and close.
   - Return only bounded, sanitized status such as URL, title, load state, navigation availability,
     and a small error code. Remote page objects, arbitrary script execution, and generic
     `webContents` access must never cross preload.
   - Treat every title, URL, favicon, error string, and page-originated event as untrusted data.

4. **Lifecycle integration**
   - Create the guest only after an explicit Browser launch.
   - Synchronize its bounds from the renderer's measured content rectangle using integer, clamped
     geometry.
   - Hide or disable the guest whenever a higher-priority modal, menu, shutdown transaction, or
     non-Browser owner requires it.
   - Destroy it on Browser close and before application teardown so no remote page continues running
     without a visible owner.

### Security and privacy contract

The browser milestone is an explicit exception to the current no-networking boundary, not a reason to
weaken the trusted shell.

The guest must use:

- `nodeIntegration: false`;
- `contextIsolation: true`;
- `sandbox: true`;
- `webSecurity: true`;
- a dedicated session partition separate from the shell;
- no shell preload and no access to `window.macintosh`;
- denied permission requests, popups, new native windows, and external protocol launches by default;
- denied host-file navigation, uploads, filesystem handles, screen capture, geolocation, camera,
  microphone, notifications, Bluetooth, USB, serial, MIDI, and clipboard escalation;
- cancelled downloads until a separate, explicit download product decision exists;
- no TLS bypass, mixed-content relaxation, or certificate-error override; and
- an allowlist of `http:` and `https:` for user and page main-frame navigation, with any internal
  start page loaded from a separately controlled local source.

The shell's existing IPC handlers must continue accepting only the trusted local renderer. A guest
page or guest frame must not be able to invoke VFS, persistence, quit, import, Clipboard, or future
export capabilities.

The baseline Browser session should be ephemeral: history, cache, cookies, credentials, and local
storage do not survive closing the application. Persistent logins or browsing history would be a
separate product and privacy decision, with their own storage model and reset controls.

### Acceptance criteria

The milestone is complete only when all of the following are observable:

- Double-clicking Browser in Applications opens or activates a real Browser application window.
- A user can navigate to ordinary HTTP and HTTPS pages, follow links, go Back and Forward, Reload,
  Stop, and recover visibly from a failed navigation.
- Browser controls, menus, and supported shortcuts dispatch the same command actions.
- Moving, resizing, zooming, stacking, deactivating, and closing the window keep the guest content
  aligned and correctly clipped at every supported application size.
- An open Macintosh menu or modal always wins input and paint precedence over the guest.
- Popups, permissions, downloads, forbidden schemes, host paths, and guest attempts to reach shell IPC
  are denied and tested.
- Closing Browser destroys its guest content and stops its network activity.
- Browser application identity survives relaunch, while open windows and browsing state follow the
  explicitly chosen transient policy.
- Unit tests cover URL and IPC validation, command context, lifecycle, and state migration.
- `npm run check` and `npm run smoke` pass. Smoke navigation uses a local HTTP fixture so the suite is
  deterministic and does not depend on the public internet.
- The real Electron app is manually inspected with representative live sites for focus, clipping,
  scrolling, authentication prompts, failure presentation, and the visual boundary between 1-bit
  chrome and remote content.

## Final milestone 2: Native macOS drag bridge

### Intended result

This milestone completes the currently one-way host bridge. A user can drag a real Finder item into
The Macintosh as today, then drag a virtual item back out to Finder or another macOS application
without choosing an Import or Export command.

The gesture should preserve the illusion of one porous desktop boundary:

- within The Macintosh, the existing authored pointer session and internal drop rules remain in
  force;
- crossing the real application boundary hands the same drag to macOS as a native file drag;
- Finder receives real files or folders;
- Mail, Messages, TextEdit, and other file-drop targets receive ordinary materialized host files they
  understand;
- cancelling the host drag changes nothing in the virtual disk; and
- a successful host drop is copy-like and never deletes, moves, renames, or marks the virtual source
  as saved elsewhere.

The existing inbound path remains explicit and bounded. The renderer still receives no general host
filesystem access in either direction.

### Supported virtual items

The first complete bridge should support one or more selected ordinary documents and folders.
Selection is snapshotted at drag start, descendant duplicates are removed, and folder hierarchy is
preserved.

The following do not become host drag objects:

- System Disk, Trash, or the hidden Desktop root;
- application nodes such as Write or Browser;
- a node inside a pending mutation or save transaction; or
- a document whose stored representation cannot be exported honestly and completely.

The last rule matters because today's binary host imports retain a text placeholder rather than the
original bytes. Before outbound drag ships, the persistent model must distinguish a genuine text
document from a binary-content placeholder. A placeholder must be blocked with a visible explanation;
it must never be written under the original binary filename as though its bytes had survived.

### Host representation

Export must be deterministic and non-lossy for the supported surface:

- Plain-text documents become UTF-8 text files. A safe `.txt` suffix is added when the virtual name
  has no compatible text suffix.
- Rich `write-v1` documents become standards-readable RTF files that preserve the supported font
  family, size, bold, italic, underline, alignment, spacing, indents, tabs, paragraph boundaries, and
  manual page breaks. A safe `.rtf` suffix is added when needed.
- The inbound importer recognizes and defensively parses the finite RTF subset emitted by The
  Macintosh so a Write document can make a useful round trip. Unsupported RTF constructs are bounded
  and either flattened with an explicit notice or rejected; they are never evaluated or treated as
  HTML.
- Folders become real folders containing recursively materialized supported documents and folders.
- Names are sanitized for host rules, case-insensitive collisions receive visible copy suffixes, and
  path separators or traversal components cannot escape the staging root.
- Virtual modified timestamps are applied on a best-effort basis. Host creation metadata is not
  promised where the temporary-file API cannot preserve it reliably.

If any selected root contains an unsupported placeholder, the initial version should refuse the
entire native drag and explain which item prevents it. It must not silently produce a partial folder.

### Native handoff

Electron's native drag API requires real host paths before `webContents.startDrag` can hand the item to
macOS. The main process therefore needs an app-owned staging area, but that implementation detail must
remain invisible to the user and inaccessible to the renderer.

The preferred interaction design is a single continuous gesture:

1. A pointer press establishes the same internal owner and four-pixel drag threshold used today.
2. Once the threshold is crossed for an exportable selection, the renderer requests preparation by
   stable VFS IDs. It continues showing the existing Macintosh drag preview while preparation runs.
3. The main process snapshots those IDs from canonical state, validates the complete tree, writes a
   bounded staging copy, and returns an opaque, single-use drag token rather than any host path.
4. As long as the pointer remains over a valid Macintosh destination, release performs the existing
   internal move or placement and cancels the prepared export.
5. When the pointer crosses the actual application boundary, the renderer yields the interaction and
   asks the main process to start the native drag for that token. The authored preview disappears as
   the native drag image takes ownership.
6. A native drop or cancellation leaves the canonical VFS untouched. The staging lease expires and is
   cleaned later without invalidating a host application that is still reading the dropped file.

A real-Electron feasibility proof must demonstrate this pointer-to-native handoff before production
interaction code is reorganized. Setting every icon to generic HTML `draggable` and replacing the
current internal pointer session is not acceptable: it would discard the authored cursor, preview,
hit-testing, cancellation, and same-parent placement behavior. If Electron cannot support a safe
continuous handoff, the product interaction must be reconsidered explicitly rather than quietly
shipping a separate Export button as though it fulfilled this milestone.

### Main-process export capability

The new capability should be split into narrow typed operations such as prepare, start, and cancel.
It must not accept a destination path or renderer-provided file contents.

Preparation must:

- accept only a bounded array of stable VFS node IDs from the trusted local renderer;
- read document payloads and descendants from main-owned canonical state;
- remove duplicate descendants and reject roots, applications, cycles, malformed trees, unsupported
  payloads, and capacity overflows;
- materialize beneath a newly created application-owned temporary directory with private directory and
  file permissions;
- use sanitized, collision-safe relative names and refuse any resolved path outside that directory;
- enforce node, depth, per-document, and total-byte limits before beginning the native drag;
- expose only an unguessable, expiring token to the renderer; and
- produce an original black-and-white native drag image without loading arbitrary renderer-supplied
  image paths.

Starting the drag must validate that the token belongs to the current renderer, has not expired or
already been consumed, and resolves only to the prepared staging paths. It may then call
`webContents.startDrag` with the prepared `files` list and native image.

Staging cleanup must be resilient:

- a cancelled internal drag revokes its unused token;
- consumed files remain available for a conservative lease after native drag completion;
- expired sessions are removed on a bounded timer;
- stale staging directories from a crash are removed on the next launch; and
- application shutdown attempts cleanup without making a successful normal Quit depend on deleting
  temporary exports.

No operation may reveal an arbitrary host path to the renderer, browse the host filesystem, overwrite
a user-selected destination, retain access to the receiver, or create symbolic links.

### Inbound compatibility

The existing host-to-Macintosh path remains the authority for incoming drops and paste:

- it starts only from browser-granted `File` objects created by an explicit user gesture;
- inspection and VFS insertion remain one serialized main-process transaction;
- host paths are not retained after inspection;
- symbolic links and non-file objects remain excluded;
- bounded import and collision rules continue to apply; and
- Trash remains unavailable as an inbound host destination.

The only required schema expansion is the minimum needed to distinguish faithfully exportable content
from placeholders and to represent a supported rich-text round trip. The bridge is not permission to
turn the VFS into a host-directory mount, watcher, sync service, or arbitrary binary store.

### Acceptance criteria

The bridge is complete only when all of the following are observable:

- A plain virtual document can be dragged from Desktop or Finder into macOS Finder and opens there
  with the exact stored text.
- A rich Write document can be dragged to Finder or a compatible application as RTF with every
  supported semantic feature preserved, then dropped back into The Macintosh as a usable Write
  document.
- A selected folder tree and a multi-selection become correctly named native files and folders with
  no missing supported descendants.
- Finder, Mail, Messages, and TextEdit accept representative outgoing drags in live macOS testing.
- Internal moves, same-parent free placement, folder drops, Trash drops, multi-item geometry, cursors,
  shadows, pointer capture, and cancellation behave exactly as before when the drag never leaves the
  app.
- Cancelling before or after native handoff leaves the virtual source untouched and eventually removes
  staging data.
- Reserved roots, applications, binary placeholders, malformed trees, oversized selections, expired
  tokens, forged IDs, reused tokens, and untrusted IPC senders are rejected visibly and safely.
- The renderer never receives a host path, and export cannot write outside the app-owned staging root.
- Unit tests cover name sanitization, collision handling, text and RTF serialization, placeholder
  refusal, tree bounds, token lifecycle, and cleanup.
- `npm run check` and `npm run smoke` pass, including real-Electron inbound and outbound drag coverage,
  persistence failure injection, cancellation, relaunch, and stale-staging cleanup.
- The final interface is manually inspected at supported window sizes for native drag-image alignment,
  ownership handoff, target feedback, menus and modals during preparation, and behavior when the
  application loses focus.

## End-state release gate

After both milestones:

- `README.md` must describe the browser and both drag directions as shipped behavior rather than
  roadmap work.
- `docs/interaction-model.md` must define Browser ownership, guest-content precedence, navigation,
  outbound drag preparation, native handoff, cancellation, and staging durability.
- The Browser's remote-content boundary and the drag bridge's host-filesystem boundary must receive a
  focused security review against the live implementation.
- The standard checks, deterministic Electron smoke suite, live Browser inspection, and live macOS
  cross-application drag matrix must all pass from the final build.
- No temporary test server, staged export, downloaded content, debug switch, generalized RPC method,
  or renderer-visible host path may remain in the production artifact.

At that point the final idea is not merely that The Macintosh resembles a small operating system. It
can reach the web as one of its own applications and exchange tangible objects with the real computer
around it, while the desktop itself remains coherent, local-first, and deliberately bounded.
