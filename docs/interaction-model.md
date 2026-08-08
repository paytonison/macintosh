# Macintosh Workbench Interaction Model

## Status

This document is the normative contract for user-visible interaction in Macintosh Workbench. It describes the coherent behavior the project intends to preserve as features are added. It is not a promise of hardware emulation, binary compatibility, or exact reproduction of one historical System release.

Macintosh Workbench draws from the black-and-white interaction language of System 6 and System 7. When those systems differ, choose the behavior that best preserves internal consistency, tactile clarity, and the project's existing design. Record deliberate departures here rather than allowing accidental behavior to become precedent.

The current implementation is the baseline. A rule in this document may also identify an intended invariant that the code has not fully generalized yet. In that case, fix the implementation when the relevant feature is touched, or update this document if Payton deliberately chooses a different behavior.

## Product principles

1. Macintosh Workbench is one coherent desktop, not a set of unrelated retro widgets.
2. Behavior outranks decorative imitation. Focus, stacking, selection, drag release, menu ownership, and persistence must agree with one another.
3. Feedback is immediate, discrete, and legible in a 1-bit visual language.
4. Pointer interactions are sessions with a beginning, preview, commit or cancellation, and an observable result.
5. Durable state and transient interaction state remain separate.
6. A preview must not silently mutate durable state.
7. Existing working behavior is evidence. Do not replace it merely to make an abstraction look cleaner.

## Terms

**Desktop surface** is the workspace below the menu bar. It contains desktop icons, Finder windows, application windows, desk accessories, dialogs, and transient drag feedback.

**Finder** is the default application and owner of the desktop, virtual filesystem, and Finder windows. It owns the menu set whenever Write is not active.

**Finder window** presents a disk, folder, or Trash node. Documents belong to Write, application nodes launch their application, and the reserved Desktop root is never exposed as a Finder item or window.

**Application window** is a transient window owned by an application. Write is the first full application and may own several document windows at once.

**Desk accessory** is a small utility opened from the System menu. Calculator is the first desk accessory. A desk accessory may become the frontmost interaction target without replacing the active Finder or Write application as the menu owner.

**Dialog** is a modal question, notice, or information surface. Dialogs are not ordinary application windows.

**Active interaction target** is the window or dialog that receives ordinary keyboard input and is visually frontmost for the current task.

**Active Finder window** is the frontmost Finder window within Finder's window stack. Finder commands use its context unless a selected desktop item supplies the context instead.

**Stack order** is back-to-front window order. For Finder windows, the last item in the persisted window array is frontmost.

**Selection domain** is either the desktop or Finder. Only one domain may own the current selection at a time.

**Preview state** is temporary feedback during a pointer session, such as a drag outline, icon shadow, or provisional icon position.

**Durable state** is state expected to survive application relaunch.

## Input ownership and precedence

Input has one owner. The following precedence applies from highest to lowest:

1. A save or fatal-state alert that requires acknowledgement.
2. A normal-quit final-save transaction.
3. An open modal dialog.
4. An active drag or resize session.
5. An open menu.
6. The active desk accessory or application window.
7. The active Finder window.
8. The desktop surface.

A higher-priority context must prevent the same event from also triggering a lower-priority action. Components should use pointer capture, propagation control, and explicit keyboard routing rather than relying on incidental DOM focus.

Authored pointer-session drags remain a press until movement reaches the shared four-pixel Euclidean threshold. Releasing before that threshold is a click; crossing it begins the drag and latches that state until release or cancellation. Pointer capture keeps the session owned when the pointer leaves its source element. Pointer cancellation or losing application focus clears transient interaction state so a later interaction starts cleanly.

Cursor feedback mirrors that ownership without changing gesture semantics. Every authored cursor uses a white interior with a crisp black outline. The normal cursor is a 1-bit System 1-style arrow. Finder and desktop files and folders, together with System Disk and Trash, show a 1-bit pointing finger while any part of their icon-and-label region is hovered. A primary-button press changes immediately to an open hand and keeps it until the shared drag threshold is crossed. An active item drag uses a closed fist latched for the entire pointer-captured drag, including after the pointer leaves its source. Pointer-up, pointer cancellation, lost pointer capture, or application-focus cancellation clears the pressed or dragging state immediately and restores the pointing finger when the pointer remains over an eligible item or the arrow otherwise. Native drag-and-drop remains reserved for explicit host-file imports; internal virtual-filesystem item movement uses the authored pointer session so platform drag feedback cannot replace the closed-fist cursor.

An active internal virtual-filesystem item drag keeps each grabbed bitmap visible at its exact pointer-relative offset. A three-pixel aligned silhouette follows behind each bitmap as its shadow. The silhouette is solid black over the patterned Desktop and switches to 50% black-and-white dithering over white window surfaces so it remains distinct from either backdrop. This transient layer contains icon artwork only, has no rectangular boundary outline, does not participate in hit testing, and disappears immediately on release or cancellation. The source icons remain at their committed locations until the drop succeeds. System Disk uses the same icon-only preview and contextual shadow; Trash continues to use its existing provisional moving icon and hard shadow.

Opening a menu temporarily owns pointer interaction inside the menu bar. Clicking outside closes the menu; the underlying click may proceed only when doing so is intentional and tested.

## Startup and hydration

The desktop is not interactive until both of the following are true:

- persistent state has loaded or a safe default has been chosen; and
- the startup sequence has completed.

A failed state load opens the default desktop and presents a visible error. Corrupt, oversized, malformed, or incompatible state must not partially hydrate the desktop.

Automation may shorten delays, but it must preserve the same state transitions and final behavior as an ordinary launch.

## Finder activation and stacking

Finder window order is back-to-front. The final window in the order is the active Finder window.

Opening a Finder container follows these rules:

- If its Finder window is already open, move that window to the front instead of creating a duplicate.
- If it is not open, create one window and place it at the front.
- New windows may cascade from the existing stack, but their geometry must remain within usable desktop bounds.
- Opening a node clears stale desktop and Finder selections.

Opening a document routes to Write. Opening the Write application creates a new untitled Write window. Neither document nor application nodes are added to the persisted Finder-window stack.

Clicking an inactive Finder window activates it and moves it to the front before performing the requested window operation. Clicking its title bar, content, scroll controls, or grow box counts as interaction with that window.

Closing the active Finder window removes it from the stack. The next frontmost Finder window becomes active automatically. Closing a non-frontmost window must not disturb the relative order of the remaining windows.

An inactive Finder window remains visible but uses inactive title-bar treatment. There is never more than one visually active Finder window.

## Desk accessories

Calculator is a single-instance desk accessory opened from the System menu.

Opening Calculator makes it the frontmost interaction target. The Finder or Write application that opened it remains the menu owner, other windows use inactive treatment, and Calculator receives its supported unmodified keyboard input. Clicking a Finder or Write window explicitly transfers application activation and keyboard ownership; clicking Calculator transfers keyboard ownership back to the desk accessory without changing the active application.

Opening Calculator while it is already open must not create a second Calculator.

Calculator state is session-local:

- closing and reopening it resets the calculation;
- its position is not persisted;
- Escape closes it;
- digits, decimal point, the four basic operators, Return or Enter, equals, C, Backspace, and Delete route to Calculator when applicable;
- Command-, Control-, or Option-modified keys are not consumed by Calculator.

Calculator movement uses an outline preview. Its actual frame remains fixed during the drag and moves only when the pointer is released successfully. Cancellation restores the original position.

Finder, Write, and Calculator share an explicit active-application and active-target model. The active application owns the menu set, the active target owns ordinary keyboard input, and one transient ordinary-window order determines visual stacking while application-specific state remains local.

## Menus and commands

The menu bar is a single global surface. Finder owns System, File, Edit, View, and Special while Finder is the active application. Write owns System, File, Edit, Format, Font, Size, and View while Write is the active application. Calculator may become the active keyboard target without changing that menu owner. Activating a Finder or Write window changes the active application and menu set immediately.

Menu behavior follows these rules:

- Clicking a menu title opens it; clicking the same title again closes it.
- Moving across menu titles while a menu is open switches the open menu.
- Clicking outside the menu bar closes the open menu.
- Disabled entries are visible but inert.
- Checked entries communicate persistent or contextual state.
- Invoking an entry closes the menu before performing its action.
- Menu sound feedback accompanies opening and invoking commands, not passive rendering.

Menu commands must derive their enabled state and target from the same state used by their action. A command must not appear enabled and then silently do nothing because it read a different context.

Shortcut glyphs shown in a menu are a promise only after the shortcut is wired through the same command action and covered by a test. Do not implement a second, divergent code path for keyboard shortcuts.

Current Finder command context is:

- **New Folder** creates a folder in the active disk or folder window; otherwise it creates one on Desktop.
- **Open** targets the selected node.
- **Close Window** targets the active Finder window.
- **Get Info** targets the selected node.
- **Paste** targets the active disk or folder window; otherwise it targets Desktop.
- **Select All** selects all children of the active non-document Finder window; otherwise it selects the desktop icons.
- **Clear Selection** clears both selection domains.
- **View by Icon** and **View by Name** change the persisted Finder view mode.
- **Empty Trash** is enabled only when Trash contains nodes and no open saved Write document is
  directly or indirectly inside Trash. The action repeats that check against current state before
  mutating the VFS.
- **Clean Up Desktop** restores the default System Disk and Trash positions; ordinary Desktop item positions remain free-form.
- **Eject System Disk…** explains the drag-to-Trash shutdown gesture; it does not eject by itself.

## Write

Write is the built-in page-oriented WYSIWYG word processor. Its original code-drawn application icon lives in Applications as a VFS node with `kind: application` and `applicationId: write`.

### Document and window identity

- Opening Write creates a transient, untitled plain-text document. It does not allocate a VFS node until Save or Save As succeeds.
- Opening any VFS document opens it in Write, including imported and legacy plain-text documents.
- One saved document has at most one open Write window. Reopening it activates and raises that window instead of creating a duplicate.
- Several different saved documents and untitled documents may be open at once. Finder, Write, and
  Calculator share one transient back-to-front ordinary-window order. The active Write application
  owns Write menus, while its active document editor owns Write keyboard input unless Calculator is
  the active target.
- Write window geometry, zoom, selection, undo history, page projection, and open-window state are session-local. They are not restored after relaunch.
- Write uses the same stationary-outline move and resize sessions, zoom-box and
  title-bar-double-click action, inactive-control activation rule, and stepped opening or closing
  outline treatment as Finder, including the artwork-centered nearest-corner origin, mirrored close
  toward the currently visible source, and centered fallback when no source is visible. Reopening a
  saved document during its closing animation cancels the close and raises the existing window.

### Page model

Write displays US Letter pages at 612 by 792 logical points with 72-point margins, a 468-point text width, and 648-point usable page height. The initial view is 75%; View provides 50%, 75%, and 100% without changing document semantics.

Automatic overflow and backflow are editor projection. Manual page breaks are explicit semantic blocks, but automatic page boundaries, page count, caret page, page gaps, and measured layout never enter persistent state. Editing before an automatic boundary may move later text between pages. Each semantic editor generation removes prior projection paint, measures on a later animation frame, and requires two consecutive matching layout signatures within four passes. A superseded generation cannot publish stale pagination. Failure remains visible and recoverable, and Save refuses to mutate the VFS until the newest generation has a stable projection. The status line reports the caret page, total pages, current zoom, or the current layout failure.

The Write document viewport hides Chromium and host-platform scroll-bar chrome and uses the same
15-pixel authored arrow buttons, patterned tracks, and black-and-white thumbs as Finder. Wheel,
trackpad, and arrow-button scrolling affect only that Write window's viewport. Scroll position is
transient and does not alter document semantics, page projection, selection, undo history, or
durable state. When a page overflows horizontally, the ruler follows the viewport's horizontal
position so its text measurements remain aligned with the page at 50%, 75%, and 100% zoom.

### Editing and formatting

Write uses a custom ProseMirror schema and authored controls rather than a packaged editor UI. The implicit character default is 12-point Helvetica through the logical sans family. The default paragraph is left aligned, single spaced, with no indents and default tabs every 36 points.

The supported rich surface is deliberately finite:

- serif, sans, and monospaced font-family marks on text selections;
- 9, 10, 12, 14, 18, and 24 point size marks on text selections;
- bold, italic, and underline marks;
- left, center, and right paragraph alignment;
- left, first-line, and right indents;
- single, 1.5, and double line spacing;
- inline tabs, draggable or removable custom tab stops, and new ruler stops;
- manual page breaks;
- Undo, Redo, Cut, Copy, Paste, Clear, Plain Text, and Select All.

Menu items, keyboard shortcuts, and ruler controls dispatch the same editor commands and read availability or checked state from the same active editor context. Mixed selections expose no invented paragraph value; character marks and ruler state use an explicit indeterminate presentation. Plain Text removes bold, italic, and underline only; it retains font family, font size, and paragraph formatting. Clear deletes only the current non-empty selection. Clipboard commands cross only a narrow semantic main-process capability; the renderer receives no general Electron or host-filesystem access. Supported rich clipboard structure is retained, including partial-selection family and size marks. Unsupported families, sizes, HTML capabilities, and arbitrary CSS are discarded by the finite schema, and a file paste owned by Write never becomes a Finder import.

An existing plain document remains `{format: plain-text, text}` through ordinary text editing, line breaks, and plain tabs. The first rich-only action promotes it in place to `write-v1` without changing its text or whitespace. A rich document persists a linear list of paragraph and page-break blocks. Paragraphs contain allowlisted alignment, indent, tab-stop, and line-spacing state; text inlines carry allowlisted family, size, bold, italic, and underline marks. Sans at 12 points remains implicit until a different value is explicitly applied. Sanitization upgrades the earlier beta representation that stored family and size on a paragraph into equivalent inline marks, preserving explicit serif or other supported legacy formatting. Write does not persist HTML, DOM state, measured coordinates, cached pages, or arbitrary CSS.

### Open, save, close, and quit

Write does not autosave and has no crash recovery or session restoration. Save first waits for the live editor's newest stable layout and then explicitly replaces the canonical payload of an existing VFS document through the typed main-process mutation. Each window has an independent coalescing save queue. A completed older snapshot advances only the saved baseline; it never overwrites a newer live draft, which remains dirty until saved. Save As creates a new VFS document, resolves name collisions without overwriting, and then binds the current window to the committed node. A payload that cannot be stored completely is rejected atomically: Write never accepts a truncated save, and the draft remains dirty and recoverable.

Open and Save As browse the virtual disk only, begin in Documents, and provide routes to Desktop, System Disk, and nested ordinary folders. Open lists documents and folders; Save As lists destination folders only. Both exclude Trash and every descendant of Trash. They do not expose host paths. Host documents enter the VFS only through the existing explicit drop or paste import path.

Closing a clean Write window needs no prompt and removes it after the closing animation. Closing a dirty window asks Save, Don’t Save, or Cancel. Saving an untitled window enters Save As; a failed save cancels that close attempt and keeps the window and draft recoverable behind a visible persistence error. A close or Quit request made during an in-flight save joins that window's queue and cannot advance until the latest requested generation is clean.

Normal Quit and System Disk ejection review every dirty Write window before final shutdown. Each document receives its own Save, Don’t Save, or Cancel decision. Cancel or a failed document save aborts the whole exit and preserves every open draft, including a draft previously reviewed with Don’t Save during that canceled attempt. A dirty discard-close animation already in progress yields to a newer Quit or ejection review instead of deleting its document underneath that review. Electron may proceed only after required document mutations and the final presentation save succeed.

Printing, PDF or HTML export, images, tables, lists, spellcheck, collaboration, arbitrary font loading, and host Save dialogs are outside this version.

## Selection

Desktop and Finder selection are mutually exclusive. Desktop selection stores stable VFS node IDs, including the special System Disk and Trash IDs and arbitrary IDs for ordinary Desktop files and folders.

A normal click replaces the current selection in its domain. Shift-click toggles the clicked item without preserving selection in the other domain.

Clicking bare desktop space clears both domains. A desktop marquee updates the desktop selection from icons whose bounds overlap the marquee. A movement shorter than the click threshold is a background click, not a marquee selection.

Selecting a desktop icon clears Finder selection. Selecting a Finder item clears desktop selection.

Finder selection is currently one shared selection set. Commands must interpret it only in a context where the selected node is visible and meaningful. When multiple independent application windows require simultaneous retained selections, selection ownership should become window-specific rather than extending the shared set with exceptions.

The current command model acts on one selected node for Open and Get Info. Multi-selection also supplies the movable ordinary Desktop or Finder roots for a drag; selected required roots are never swept into an ordinary VFS move.

## Finder windows

### Opening and identity

There is at most one Finder window for a given virtual filesystem node. The window identifier is stable for that node.

Disk, folder, and Trash windows list their children. Documents and applications never create Finder windows.

Creating a Finder window uses a short stepped black-and-white frame outline from the opening icon
to the final window bounds. Its source is the center of the actual pixel-art artwork SVG, excluding
the surrounding icon tile, label, whitespace, or name-view row. The final window corner nearest
that center begins there, and the outline expands toward its committed rectangle. The rendered
window remains hidden until the outline, including its minimal title-bar detail and hard pixel
shadow, reaches those bounds. Commands without a visible source begin from the final frame's
center. Bringing an existing window to the front does not replay the effect, and opening animation
state is transient. Closing hides the rendered window and mirrors the outline back through the same
nearest corner toward the node's currently visible artwork center, or toward the window center when
no fully visible, unobscured source artwork is available. The window leaves the Finder stack only
after the close animation finishes; reopening it during that transition removes the outline,
reveals the existing window, and cancels the pending close.

### Moving

A Finder window move begins with a primary-button press on its title bar.

- The window activates before the move begins.
- The real window remains at its committed geometry during the drag.
- A 1-bit outline or shadow previews the destination.
- Releasing the pointer commits the final bounded geometry.
- Pointer cancellation discards the preview.
- Releasing outside the original title-bar element must still conclude the session correctly.
- The window must retain enough visible title-bar area to be recovered.

A press and release without movement activates the window but does not create a geometry update.

### Resizing

Resize begins from the grow box. The rendered window remains at its committed geometry while the
same black-and-white frame outline previews width and height from the original rectangle, respects
minimum dimensions, and remains bounded by the desktop whenever the committed upper-left corner
leaves enough room. The component minimum takes priority for a window already positioned partly
offscreen, matching the recoverable move policy. Releasing the pointer commits the final previewed
geometry once. Cancelling the pointer discards the preview, and either conclusion removes the
outline and ends the resize session cleanly.

### Zooming

The zoom box and a title-bar double-click use the same action. The first zoom stores the current geometry and expands the window within a small desktop margin. The next zoom restores the stored geometry.

Zoom restore geometry is transient in version 1. Relaunch preserves the last committed window rectangle, not an invisible pre-zoom restore rectangle.

### Scrolling

Scroll controls affect only their own Finder window content. A scroll action must not activate, select, move, or resize another window.

### Icon placement

Icon view begins with an orderly deterministic arrangement ranked by stable node identity rather than VFS storage order, but it does not constrain committed positions to that arrangement.

- Dragging onto bare icon-view space commits an integer-pixel position relative to that folder's scrollable content.
- Dragging multiple selected icons applies one shared delta so their relative arrangement remains intact.
- Every dragged icon remains visible with its backdrop-contrasted icon-shaped shadow throughout the pointer session, including over another folder or outside its source window.
- Dropping onto a folder icon performs the existing virtual filesystem move instead of a placement-only change.
- Dropping into the bare icon canvas of another open folder moves the items and places them at the drop point.
- List view ignores icon positions and remains name-sorted. Returning to icon view restores the saved positions.
- Cancellation or a drop outside a valid target discards the preview and changes neither layout nor filesystem state.

## Desktop icons and drag behavior

The desktop renders System Disk and Trash as special icons plus every direct child of the hidden `desktop` VFS root as an ordinary file or folder icon. The Desktop root itself is structural and is never rendered.

Ordinary Desktop items follow Finder semantics:

- click and Shift-click use the Desktop selection domain;
- double-click and **Open** use the same node-opening path as Finder items;
- folders open Finder windows, documents open Write windows, and application entries launch their application;
- marquee and **Select All** include their stable node IDs;
- **Get Info** reports Desktop as their parent;
- a folder icon is a drop destination, while a document icon blocks the drop instead of allowing it to fall through to bare Desktop behind it.

Ordinary Desktop icon positions are explicit persisted integer-pixel coordinates relative to the actual Desktop surface. They are free-form and never grid-snapped or derived from node-array order. A drag of several selected Desktop children applies one shared translation so their relative layout remains intact. Committed positions are clamped using the rendered icon footprint so every item remains recoverable inside the usable surface.

Dragging an ordinary item from Finder to bare Desktop moves its selected top-level VFS roots beneath `desktop` and assigns positions from the drop point. Dragging an ordinary Desktop item to another container moves it and clears its Desktop-relative root position. Descendant layout inside moved folders remains unchanged. Moving an item to Desktop is a filesystem mutation; dropping an item already on Desktop onto another bare Desktop location is placement-only and does not change its parent or timestamps.

Host files and folders dropped on bare Desktop are imported as bounded virtual copies beneath `desktop`. Their top-level roots begin at the drop point with a small deterministic free-form cascade; nested hierarchy and content use the same guarded import path as other destinations. Name collisions use copy suffixes and never overwrite existing items.

Bare Desktop is a destination only when it actually owns the hit. Finder windows, desk accessories, dialogs, ejection layers, and other blocked surfaces do not fall through. Direct drops onto System Disk, folders, and the precise Trash artwork retain those destinations. Host drops remain prohibited on Trash.

Internal desktop movement uses the authored pointer session:

- The moving icon-only preview and its solid-black Desktop shadow follow the pointer without changing the committed Desktop layout.
- Dragging onto bare desktop space moves a Finder item into Desktop or repositions an item already there.
- A same-parent drag changes only the item's parent-scoped desktop position; it does not alter its timestamp, name, contents, or descendants.
- Dragging multiple selected items applies one bounded shared delta so their relative arrangement remains intact.
- Dropping onto a desktop folder, System Disk, or Trash performs the corresponding virtual-filesystem move instead of a bare-desktop placement.
- A desktop document consumes the drop without accepting it; it must not allow the event to fall through to bare Desktop.
- An item and its descendants are invalid destinations for that item's drag.
- Cancellation or release outside a valid destination changes neither layout nor filesystem state.

System Disk and Trash are freely repositionable. System Disk uses the shared icon-only preview while its committed icon and label remain in place; Trash's provisional position follows the pointer. Their new positions become durable only when the drag commits.

System Disk drag is the eject gesture:

- During drag, its preview follows the pointer while its committed position remains unchanged.
- Trash becomes visibly full or highlighted when the pointer enters the valid drop region. That
  region is the stable union of the rendered empty/full Trash artwork plus four CSS pixels of
  tolerance; the label and the desktop button's distant transparent margins are excluded. The same
  region governs internal Finder-item drops onto the desktop Trash icon.
- Releasing away from Trash commits the disk's new desktop position.
- Releasing on Trash begins ejection.
- The disk's position immediately before the eject drag remains its durable position after ejection.

Ejection is a transaction:

1. if Write has dirty documents, restore the disk icon and complete the per-document exit review;
2. mark the interface as ejecting;
3. play the synthesized ejection sound once, keep the disk and its label at the durable pre-drag
   position, and complete exactly two stepped normal-to-inverted-to-normal artwork flashes;
4. ask the main process to record the last-eject timestamp;
5. atomically commit the latest presentation against canonical state;
6. quit from that same main-process transaction only after the save succeeds.

The label remains in its normal treatment throughout both flashes. System Disk does not translate,
bob, fall into Trash, become hidden, or begin finalization before the second normal state has been
held. Automation may shorten each phase without removing or reordering any phase, and reduced-motion
preferences retain two legible discrete flashes rather than collapsing the feedback.

If saving fails, Macintosh Workbench must not quit. It must report the failure, leave durable state recoverable, and return System Disk to its origin.

Repositioning either special desktop icon has no hidden filesystem effect. Their pointer-driven drag implementation remains separate from ordinary VFS item drags so disk ejection and precise Trash hit testing retain their behavior.

## Dialogs and alerts

Only one ordinary dialog is open at a time. About, Get Info, the eject explanation, Write's virtual Open and Save As, and Write's unsaved-changes question share the classic modal behavior.

Dialogs are modal interaction contexts. They appear above ordinary windows, retain input priority until dismissed, and do not alter Finder stacking merely by opening. Their geometry is transient.

A dialog may be moved by its title bar. Closing it through its close box or default button produces the same result. Modal keyboard behavior should be explicit; do not allow an underlying Calculator or Finder shortcut to consume a key intended for the dialog.

System Disk, Trash, Write, and the shipped folders and documents own canonical simulated creation metadata for January 24, 1984. Their Get Info dialogs render that date exactly as `Created: 1/24/1984`, independent of the host locale and timezone. The hidden Desktop root and user-created, imported, pasted, or duplicated nodes retain their own creation timestamps.

A persistence error is an alert state with higher priority than ordinary desktop interaction. Dismissing the alert acknowledges the message; it does not fabricate a successful save.

## Virtual filesystem behavior

The virtual filesystem is local application state. A user may copy host files or folders into
that state through an explicit drop or paste, but the imported nodes are bounded virtual copies,
not live references to host paths.

Each node has a stable identifier, parent identifier, name, kind, and timestamps. Non-root nodes may also carry bounded icon coordinates. Documents carry either a bounded exact plain-text payload or a defensively sanitized `write-v1` payload. Application nodes carry an allowlisted application identifier and no executable host path. System Disk, Trash, and Desktop are required roots. Desktop has the stable identity `desktop`, kind `desktop`, and a null parent. Root nodes never retain `iconPosition`.

Finder and Write commands operate on the virtual tree only. Create, update, move, duplicate, host-import,
and Trash mutations cross a typed preload boundary and execute against canonical state in the main
process. Host import paths may come only from browser-granted `File` objects and must be inspected
behind that boundary; inspection and insertion into the VFS are one serialized main-process
transaction. Imported nodes do not retain arbitrary paths or ongoing host access. General host
filesystem browsing or arbitrary path handling remains a separate product and security decision.

Opening, selecting, changing view mode, moving a window, and repositioning icons must not mutate virtual filesystem contents. Finder and same-parent Desktop icon movement change layout metadata only. Filesystem mutations occur only through explicit commands and transfers such as New Folder, Paste, import, cross-container move, or Empty Trash.

The renderer owns selection, hit testing, previews, and proposed layout coordinates. It may persist
only allowlisted presentation fields and parent-scoped icon positions; it cannot replace node
identity, hierarchy, names, document payloads, application identifiers, or timestamps through the presentation channel.

## Persistence boundary

The following state is durable in schema version 4:

- System Disk and Trash positions;
- ordinary Desktop-child icon positions;
- Finder icon positions within disks, folders, and Trash;
- Finder window identity, geometry, and stack order;
- Finder view mode;
- virtual filesystem nodes, the Write application entry, and bounded plain-text or `write-v1` document payloads;
- the last successful eject timestamp.

The following state is transient:

- desktop and Finder selection;
- drag origins, previews, hover states, and cancellation feedback;
- the current open menu;
- dialogs and dialog positions;
- Calculator open state, calculation state, and position;
- Write windows, window geometry, active document, untitled drafts, dirty flags, selection, undo history, page projection, ruler previews, and zoom;
- zoom restore geometry;
- startup progress;
- temporary errors after acknowledgement.

The main process owns canonical durable state. It merges allowlisted renderer presentation patches,
validates semantic VFS commands, and serializes all resulting atomic writes. Canonical state
advances only after a write succeeds. A relaunch must never observe a partially written state file.

Normal application quit is a two-stage persistence transaction. Command-Q, the native Quit item, and closing the last application window first review dirty Write documents without blocking their dialogs behind the final-save layer. Cancel returns the coordinator to idle and resumes presentation persistence. After every dirty document has been saved or deliberately declined, the renderer submits one final allowlisted presentation patch and stops further interaction while the main process reconciles it behind any write already in flight. Electron may exit only after the final atomic write succeeds. Repeated quit requests join the same transaction. If the write fails, the application remains open, interaction resumes behind a visible persistence alert, and the user may retry. Explicit automation shutdown and forced process termination remain separate escape paths and must not be mistaken for a successful normal save-and-quit.

Valid schema versions 1, 2, and 3 migrate to version 4 without resetting the desktop or virtual disk. Migration preserves legacy document strings exactly by wrapping them as plain-text payloads, inserts the hidden Desktop root when needed, adds the built-in Write entry only for older schemas, preserves the prior ordinary-node capacity, and removes document or application IDs from the Finder-window stack. Existing names, hierarchy, payload text, modified timestamps, user-owned creation timestamps, valid Finder window state, view mode, special icon positions, Finder icon positions, and eject time remain intact. A schema-4 user who deletes or moves Write is authoritative; sanitization does not resurrect it. Sanitization normalizes the simulated creation date of built-in IDs to January 24, 1984, repairs missing or malformed required roots, removes root `iconPosition` values, and preserves arbitrary bounded positions for Desktop children. A legacy Desktop child without coordinates receives one identity-derived free-form position during sanitization; that materialized position is persisted and never depends on node-array order.

Adding durable fields requires all of the following:

- a typed schema change;
- defensive sanitization and bounds;
- an explicit decision to migrate old state or intentionally reset it;
- a relaunch test for the new behavior.

Do not persist transient state merely because it is convenient to serialize a component wholesale.

## Visual and audio feedback

Visual feedback must communicate state, not decorate latency.

- Active and inactive windows must be distinguishable without color.
- Write pages remain white paper with hard black boundaries and shadows over an aligned dithered pasteboard at every supported zoom and window size.
- Selected items must remain legible under inverse or patterned treatment.
- Unused pixels outside authored icon glyphs remain transparent in free-placement Desktop and Finder icon views; labels and transient selection or drop-target treatments may paint only their own bounded feedback surfaces.
- Drag outlines must be crisp and aligned to integer pixels.
- Hover treatment appears only for a meaningful target.
- Cursor artwork and hotspots must remain crisp, integer-aligned 1-bit bitmaps so changing pointer states does not create an apparent positional jump.
- Animation should be stepped or restrained when that better fits the 1-bit language.
- System sounds are synthesized or original and remain local to the application.

The renderer remains an ordinary DOM/RGBA scene; it does not emulate a 1-bit framebuffer. Authored
interface paint is limited to black, white, and deterministic black-and-white patterns. Intermediate
tones must come from aligned bitmap dithering rather than literal gray, translucency, blur, gradients,
or a global post-processing filter. If raster-image display is added later, quantize that content at
its rendering boundary instead of filtering the live desktop. Browser text rasterization may still use
compositor antialiasing and is not evidence of a larger authored palette.

Do not import modern easing, translucency, blur, spring motion, toast notifications, or platform-native controls unless Payton deliberately chooses them for a specific reason.

## Extension threshold

Do not create a general desktop framework from hypothetical requirements.

A shared abstraction is justified when two real implementations duplicate a behavioral responsibility such as:

- window identity and stacking;
- activation and keyboard ownership;
- outline movement and bounded geometry;
- menu ownership and command dispatch;
- durable application state;
- modal input precedence.

The abstraction should encode the demonstrated common rule while leaving application-specific behavior local. Calculator arithmetic does not belong in a generic window manager; Finder virtual filesystem behavior does not belong in a generic application shell.

## Interaction acceptance criteria

For every significant interaction, tests or review should be able to answer:

1. What context owns the input?
2. What changes immediately on press?
3. What is only a preview while moving?
4. What commits on release?
5. What happens on cancellation or invalid release?
6. Which state, if any, survives relaunch?
7. What happens if persistence or IPC fails?
8. Does the same command path serve pointer, menu, and keyboard invocation?

Pure state transitions belong in unit tests. Critical integrated behavior, native pointer release, IPC, persistence, and relaunch belong in Electron smoke coverage.
