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

**Desktop surface** is the workspace below the menu bar. It contains desktop icons, Finder windows, desk accessories, dialogs, and transient drag feedback.

**Finder** is the default application and owner of the desktop, virtual filesystem, Finder windows, and the current menu set.

**Finder window** presents one virtual filesystem node. A disk, folder, Trash, or document may have a Finder window.

**Desk accessory** is a small utility opened from the System menu. Calculator is the first desk accessory. A desk accessory may become the frontmost interaction target without replacing Finder as the menu owner.

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

Opening a node follows these rules:

- If its Finder window is already open, move that window to the front instead of creating a duplicate.
- If it is not open, create one window and place it at the front.
- New windows may cascade from the existing stack, but their geometry must remain within usable desktop bounds.
- Opening a node clears stale desktop and Finder selections.

Clicking an inactive Finder window activates it and moves it to the front before performing the requested window operation. Clicking its title bar, content, scroll controls, or grow box counts as interaction with that window.

Closing the active Finder window removes it from the stack. The next frontmost Finder window becomes active automatically. Closing a non-frontmost window must not disturb the relative order of the remaining windows.

An inactive Finder window remains visible but uses inactive title-bar treatment. There is never more than one visually active Finder window.

## Desk accessories

Calculator is a single-instance desk accessory opened from the System menu.

In version 1, opening Calculator makes it the frontmost interaction target until it closes. Finder remains the menu owner, Finder windows use inactive treatment, and Calculator receives its supported unmodified keyboard input. Pointer interaction with Finder may still occur, but it does not transfer Calculator's keyboard ownership in the current constrained model.

Opening Calculator while it is already open must not create a second Calculator.

Calculator state is session-local:

- closing and reopening it resets the calculation;
- its position is not persisted;
- Escape closes it;
- digits, decimal point, the four basic operators, Return or Enter, equals, C, Backspace, and Delete route to Calculator when applicable;
- Command-, Control-, or Option-modified keys are not consumed by Calculator.

Calculator movement uses an outline preview. Its actual frame remains fixed during the drag and moves only when the pointer is released successfully. Cancellation restores the original position.

When a second real desk accessory or application is added, replace one-off precedence flags with an explicit shared model for active interaction target, stacking, keyboard ownership, and optional persistence. Do not build that framework before a second implementation demonstrates the common behavior it must support.

## Menus and commands

The menu bar is a single global surface. Finder owns the current menu definitions in version 1. A desk accessory may be the active interaction target without replacing the Finder menu set.

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

- **New Folder** creates a folder in the active disk or folder window; otherwise it creates one on System Disk.
- **Open** targets the selected node.
- **Close Window** targets the active Finder window.
- **Get Info** targets the selected node.
- **Select All** selects all children of the active non-document Finder window; otherwise it selects the desktop icons.
- **Clear Selection** clears both selection domains.
- **View by Icon** and **View by Name** change the persisted Finder view mode.
- **Empty Trash** is enabled only when Trash contains nodes.
- **Clean Up Desktop** restores the default desktop icon positions.
- **Eject System Disk…** explains the drag-to-Trash shutdown gesture; it does not eject by itself.

## Selection

Desktop and Finder selection are mutually exclusive.

A normal click replaces the current selection in its domain. Shift-click toggles the clicked item without preserving selection in the other domain.

Clicking bare desktop space clears both domains. A desktop marquee updates the desktop selection from icons whose bounds overlap the marquee. A movement shorter than the click threshold is a background click, not a marquee selection.

Selecting a desktop icon clears Finder selection. Selecting a Finder item clears desktop selection.

Finder selection is currently one shared selection set. Commands must interpret it only in a context where the selected node is visible and meaningful. When multiple independent application windows require simultaneous retained selections, selection ownership should become window-specific rather than extending the shared set with exceptions.

The current command model acts on one selected node for Open and Get Info. Multi-selection exists for visual selection and Select All but must not imply unimplemented batch operations.

## Finder windows

### Opening and identity

There is at most one Finder window for a given virtual filesystem node. The window identifier is stable for that node.

Disk, folder, and Trash windows list their children. Document windows display read-only document content until editing is deliberately introduced.

Creating a Finder window uses a short stepped scale from the opening icon to the final window frame.
The same transparent outline and hard pixel shadow used for Finder window-move previews follow behind
the scaling frame. Commands without a visible source scale from the final frame's center. Bringing an
existing window to the front does not replay the effect, and window animation state is transient.
Closing reverses that scale toward the node's currently rendered icon, or toward the window center when
no source icon is available. The window leaves the Finder stack only after the close animation finishes;
reopening it during that transition cancels the pending close.

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

Resize begins from the grow box. Width and height update from the original geometry, respect minimum dimensions, and remain bounded by the desktop. Releasing or cancelling the pointer ends the resize session cleanly.

### Zooming

The zoom box and a title-bar double-click use the same action. The first zoom stores the current geometry and expands the window within a small desktop margin. The next zoom restores the stored geometry.

Zoom restore geometry is transient in version 1. Relaunch preserves the last committed window rectangle, not an invisible pre-zoom restore rectangle.

### Scrolling

Scroll controls affect only their own Finder window content. A scroll action must not activate, select, move, or resize another window.

### Icon placement

Icon view begins with an orderly deterministic arrangement, but it does not constrain committed positions to that arrangement.

- Dragging onto bare icon-view space commits an integer-pixel position relative to that folder's scrollable content.
- Dragging multiple selected icons applies one shared delta so their relative arrangement remains intact.
- Every dragged icon remains visible with its backdrop-contrasted icon-shaped shadow throughout the pointer session, including over another folder or outside its source window.
- Dropping onto a folder icon performs the existing virtual filesystem move instead of a placement-only change.
- Dropping into the bare icon canvas of another open folder moves the items and places them at the drop point.
- List view ignores icon positions and remains name-sorted. Returning to icon view restores the saved positions.
- Cancellation or a drop outside a valid target discards the preview and changes neither layout nor filesystem state.

## Desktop icons and drag behavior

The desktop contains System Disk, Trash, and the visible children of a reserved Desktop virtual-filesystem root. The Desktop root is a durable container, not a visible icon or an openable Finder window.

Desktop files and folders use the same selection, Open, and Get Info commands as Finder items. Double-clicking a desktop item opens it. Desktop marquee selection includes every overlapping visible desktop icon, including ordinary files and folders.

Internal desktop movement uses the authored pointer session:

- The moving icon-only preview and its solid-black Desktop shadow follow the pointer without changing the committed Desktop layout.
- Dragging onto bare desktop space moves a Finder item into Desktop or repositions an item already there.
- A same-parent drag changes only the item's parent-scoped desktop position; it does not alter its timestamp, name, contents, or descendants.
- Dragging multiple selected items applies one bounded shared delta so their relative arrangement remains intact.
- Dropping onto a desktop folder, System Disk, or Trash performs the corresponding virtual-filesystem move instead of a bare-desktop placement.
- A desktop document consumes the drop without accepting it; it must not allow the event to fall through to bare Desktop.
- An item and its descendants are invalid destinations for that item's drag.
- Cancellation or release outside a valid destination changes neither layout nor filesystem state.

An explicit host drop onto bare desktop space imports bounded virtual copies into Desktop and places the imported roots at and near the drop point. Multiple roots use a deterministic bounded, non-overlapping layout while space remains available. A direct drop onto a folder or System Disk imports into that explicit target instead. Host drops onto Trash remain rejected.

System Disk and Trash are freely repositionable. System Disk uses the shared icon-only preview while its committed icon and label remain in place; Trash's provisional position follows the pointer. Their new positions become durable only when the drag commits.

System Disk drag is the eject gesture:

- During drag, its preview follows the pointer while its committed position remains unchanged.
- Trash becomes visibly full or highlighted when the pointer enters the valid drop region.
- Releasing away from Trash commits the disk's new desktop position.
- Releasing on Trash begins ejection.
- The disk's position immediately before the eject drag remains its durable position after ejection.

Ejection is a transaction:

1. mark the interface as ejecting;
2. provide sound and stepped visual feedback;
3. update the last-eject timestamp;
4. save the complete sanitized state;
5. request application quit only after the save succeeds.

If saving fails, Macintosh Workbench must not quit. It must report the failure, leave durable state recoverable, and return System Disk to its origin.

Repositioning System Disk or Trash has no hidden filesystem effect.

## Dialogs and alerts

Only one ordinary dialog is open at a time. About, Get Info, and the eject explanation share the classic dialog behavior.

Dialogs are modal interaction contexts. They appear above ordinary windows, retain input priority until dismissed, and do not alter Finder stacking merely by opening. Their geometry is transient.

A dialog may be moved by its title bar. Closing it through its close box or default button produces the same result. Modal keyboard behavior should be explicit; do not allow an underlying Calculator or Finder shortcut to consume a key intended for the dialog.

System Disk, Trash, and the shipped folders and documents own canonical simulated creation metadata for January 24, 1984. Their Get Info dialogs render that date exactly as `Created: 1/24/1984`, independent of the host locale and timezone. The hidden Desktop root and user-created, imported, pasted, or duplicated nodes retain their own creation timestamps.

A persistence error is an alert state with higher priority than ordinary desktop interaction. Dismissing the alert acknowledges the message; it does not fabricate a successful save.

## Virtual filesystem behavior

The virtual filesystem is local application state. A user may copy host files or folders into
that state through an explicit drop or paste, but the imported nodes are bounded virtual copies,
not live references to host paths.

Each node has a stable identifier, parent identifier, name, kind, and timestamps. Non-root nodes may also carry bounded parent-scoped icon coordinates. Documents may contain bounded text content. System Disk, Trash, and the hidden Desktop container are required roots.

Finder commands operate on the virtual tree only. Host import paths may come only from
browser-granted `File` objects and must be inspected behind the existing narrow main-process
boundary. Imported nodes do not retain arbitrary paths or ongoing host access. General host
filesystem browsing or arbitrary path handling remains a separate product and security decision.

Opening, selecting, changing view mode, moving a window, and repositioning icons must not mutate virtual filesystem contents. Finder icon movement changes layout metadata only. Filesystem mutations occur only through explicit commands such as New Folder or Empty Trash.

## Persistence boundary

The following state is durable in schema version 3:

- System Disk and Trash positions;
- icon positions within Desktop, disks, folders, and Trash;
- Finder window identity, geometry, and stack order;
- Finder view mode;
- virtual filesystem nodes and document content;
- the last successful eject timestamp.

The following state is transient:

- desktop and Finder selection;
- drag origins, previews, hover states, and cancellation feedback;
- the current open menu;
- dialogs and dialog positions;
- Calculator open state, calculation state, and position;
- zoom restore geometry;
- startup progress;
- temporary errors after acknowledgement.

Renderer state is sanitized before persistence and again in the main process. Writes are serialized and atomic. A relaunch must never observe a partially written state file.

Normal application quit is a persistence transaction. Command-Q, the native Quit item, and closing
the last application window request one final renderer snapshot, stop further interaction, and enqueue
that snapshot behind any save already in flight. Electron may exit only after the final write succeeds.
Repeated quit requests join the same transaction. If the write fails, the application remains open,
interaction resumes behind a visible persistence alert, and the user may retry. Explicit automation
shutdown and forced process termination remain separate escape paths and must not be mistaken for a
successful normal save-and-quit.

Schema version 1 and 2 states migrate to version 3 without resetting the desktop or virtual disk. Migration adds the hidden Desktop root when needed. Desktop children without a saved icon position receive a stable, bounded position derived from their node identity; other nodes continue to use their deterministic parent layout until the user moves them.

Adding durable fields requires all of the following:

- a typed schema change;
- defensive sanitization and bounds;
- an explicit decision to migrate old state or intentionally reset it;
- a relaunch test for the new behavior.

Do not persist transient state merely because it is convenient to serialize a component wholesale.

## Visual and audio feedback

Visual feedback must communicate state, not decorate latency.

- Active and inactive windows must be distinguishable without color.
- Selected items must remain legible under inverse or patterned treatment.
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
