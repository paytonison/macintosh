# AGENTS.md

## Purpose

This file defines how coding agents should work in Macintosh Workbench. Read it before proposing or making changes. Also read `README.md` and, for anything that affects user-visible behavior, `docs/interaction-model.md`.

Macintosh Workbench is a clean-room Electron recreation of the tactile black-and-white desktop language associated with classic Macintosh System 6 and System 7. It is a desktop shell, not an emulator and not a modern application with a retro theme pasted over it.

Payton owns product direction, scope, historical interpretation, and aesthetic judgment. Preserve that intent. Do not silently replace it with generic frontend conventions, fashionable abstractions, or a broader product vision.

## Decision order

When requirements compete, prefer them in this order:

1. Coherent Macintosh behavior.
2. Tactile, legible 1-bit interaction feedback.
3. Clean-room originality and local operation.
4. Security and data integrity.
5. Maintainable architecture.
6. Feature breadth.

A smaller feature that behaves like part of one operating environment is better than several impressive but disconnected demonstrations.

## Core working rule

Inspect before changing.

Before editing, locate the relevant implementation, tests, state schema, styles, and automation. Understand the current behavior and preserve unrelated working behavior. Treat existing behavior as evidence, not as disposable scaffolding.

Prefer the smallest coherent change that satisfies the request. Do not refactor, rename, reorganize, add dependencies, or broaden scope merely because another structure appears cleaner.

If something is working well and is not inefficient, do not refactor it.

## Product boundaries

Macintosh Workbench must remain:

- a clean-room implementation using original code, code-drawn or original artwork, and synthesized or original sounds;
- a desktop shell rather than a ROM, operating-system, or hardware emulator;
- local-first, with no runtime network dependency;
- behavior-first rather than screenshot-first;
- visually grounded in a crisp black-and-white Macintosh language;
- one coherent environment rather than a gallery of isolated components.

Do not add Apple ROMs, copied system files, extracted icons, proprietary startup artwork, or other unlicensed source material. Historical references may guide behavior and proportions, but implementation assets must remain original.

Do not add host-filesystem access, arbitrary path access, external navigation, remote content, analytics, telemetry, update services, or network requests without an explicit product decision from Payton.

## Repository map

The primary responsibility boundaries are:

- `src/main/`: Electron host lifecycle, secure persistence, trusted IPC handling, automation entry points, and application quit.
- `src/preload/`: the minimal typed bridge between the renderer and main process.
- `src/renderer/`: the simulated Macintosh desktop, React components, interaction state, application UI, pixel artwork, sound synthesis, and styling.
- `src/renderer/model/`: pure or mostly pure domain behavior suitable for focused tests.
- `src/shared/`: typed IPC contracts, persistent-state types, defaults, validation, and sanitization shared across process boundaries.
- `scripts/`: integrated Electron automation and smoke validation.
- `docs/interaction-model.md`: the normative contract for user-visible input, focus, stacking, selection, drag, menu, dialog, and persistence behavior.

Keep those boundaries narrow. Do not move browser-only interaction logic into Electron main. Do not expose Node.js or the host filesystem to the renderer. Do not make preload a general RPC layer.

## Architecture rules

### Electron boundary

The main process owns only host-level responsibilities:

- creating and securing the `BrowserWindow`;
- application lifecycle and quit;
- validated, bounded, atomic persistence;
- narrow, explicitly typed IPC;
- integrated automation that truly requires Electron or native input.

The renderer owns the simulated operating environment and its interaction model.

The preload bridge must expose the minimum operations needed by the renderer. Every new method expands the security boundary and therefore requires a concrete justification, typed contract, validation, and test coverage.

Preserve these window security properties unless Payton explicitly approves a change:

- `contextIsolation: true`;
- `nodeIntegration: false`;
- `sandbox: true`;
- `webSecurity: true`;
- denied navigation and new-window creation;
- local bundled resources only.

### Renderer structure

Keep application-specific behavior local. Calculator arithmetic belongs in the Calculator model. Finder virtual-filesystem behavior belongs in Finder or VFS modules. Shared window behavior belongs in a shared abstraction only after more than one real implementation demonstrates the same requirement.

Do not split a component simply because it is long. Split when there is a stable responsibility boundary, a pure behavior worth testing, repeated logic with the same semantics, or a module that can be understood independently.

Do not create a universal desktop, application, window-manager, command-bus, or plugin framework for hypothetical future features.

### Abstraction threshold

One implementation may remain local.

When two real implementations duplicate a behavioral responsibility—such as activation, stacking, keyboard ownership, bounded geometry, outline dragging, menu ownership, modal precedence, or persistent application state—consolidate the demonstrated common behavior before adding a third one.

Extract the common rule, not every superficial similarity. A generic window shell must not absorb Calculator state or Finder filesystem logic.

## Interaction behavior

`docs/interaction-model.md` is authoritative for user-visible behavior. Consult it before changing:

- active and inactive window treatment;
- Finder window order and activation;
- desk-accessory focus;
- keyboard routing;
- menu ownership and command state;
- desktop and Finder selection;
- drag previews, pointer release, cancellation, and snapback;
- dialog modality;
- ejection and shutdown;
- durable versus transient state.

When implementation and documentation disagree, do not quietly choose one. Determine whether the code is an accidental deviation, the documentation is stale, or Payton intends a new rule. Update tests and documentation with the chosen behavior.

For every significant interaction, be able to state:

1. which context owns the input;
2. what changes on press;
3. what is preview-only during movement;
4. what commits on release;
5. what cancellation or invalid release does;
6. what persists across relaunch;
7. what happens when saving or IPC fails.

Pointer interactions must survive release outside the original element when the interaction logically continues beyond it. Use pointer capture and explicit cleanup. Never leave a drag, resize, hover, or global listener active after completion, cancellation, or unmount.

## State and persistence

Persistent state is an external input, even when Macintosh Workbench wrote it previously. Validate it defensively.

The persistent-state contract must remain:

- typed;
- schema-versioned;
- bounded in size and cardinality;
- sanitized on load;
- sanitized again at the main-process boundary;
- written serially and atomically;
- recoverable through safe defaults.

Do not deserialize arbitrary component state. Persist only product state that is intentionally durable.

Transient interaction state—open menus, selections, pointer sessions, drag previews, hover state, animations, ordinary dialogs, startup progress, and temporary errors—should not become durable merely because it is easy to serialize.

A persistent schema change requires:

- updated TypeScript types;
- updated defaults;
- defensive sanitization and bounds;
- an explicit migration or reset decision;
- unit coverage for malformed and prior state where relevant;
- an Electron relaunch check when the user-visible behavior depends on persistence.

Never quit after a save-dependent action until the save has succeeded. Failure must remain visible and recoverable.

## Visual language

Preserve a crisp 1-bit vocabulary:

- integer-aligned geometry where practical;
- hard edges and deliberate patterns;
- clear active, inactive, selected, disabled, and drop-target states without relying on color;
- restrained or stepped motion;
- code-drawn or original bitmap artwork;
- compact controls with strong visual hierarchy.

Avoid modern visual defaults unless deliberately requested:

- blur and translucency;
- soft shadows;
- spring animation;
- excessive easing;
- rounded-card layouts;
- toast notifications;
- stock emoji or modern icon libraries;
- platform-native controls that break the simulated environment.

Do not "improve" historical awkwardness automatically. First decide whether it contributes to the Macintosh character, harms usability, or conflicts with the project's coherent behavior.

## Audio

System sounds must be synthesized in code or created from original assets and bundled locally. Sound is interaction feedback, not ambience. Keep it brief, purposeful, and synchronized with the action it communicates.

Do not add remote audio, copied system sounds, autoplaying background audio, or a general audio framework for a single effect.

## Commands and menus

A user command should have one action path. Pointer controls, menu entries, and keyboard shortcuts should dispatch the same underlying behavior rather than maintaining parallel implementations.

A command's enabled, disabled, or checked state must derive from the same context its action uses. Avoid stale closure behavior and avoid commands that appear available but silently do nothing.

A shortcut printed in a menu is a contract. Do not display one until it is implemented and covered.

## TypeScript and React

Use strict TypeScript. Prefer explicit domain types over unchecked casts. Treat `unknown` data as untrusted until validated.

Keep React state ownership close to the behavior that coordinates it, but move pure state transitions into model modules when that makes them independently testable.

Use functional state updates when the next value depends on the current value. Avoid duplicating derived state unless it represents a deliberate interaction snapshot such as a drag origin or zoom restore rectangle.

Do not introduce a state-management library to avoid ordinary React state. Add a dependency only when it solves a demonstrated problem better than the platform and existing stack.

Preserve accessibility semantics where they do not compromise the product language:

- useful labels for windows and controls;
- correct button elements for actions;
- dialog and menu roles;
- keyboard focus where input ownership requires it;
- status or alert semantics for important feedback.

Accessibility is part of behavior, not a reason to substitute generic visual components.

## Styling

Keep styles local to the established renderer stylesheet structure unless a real maintenance boundary justifies a change. Reuse established dimensions, borders, patterns, and state classes before inventing near-duplicates.

Do not convert the project to a CSS framework, CSS-in-JS system, utility framework, component library, or design-token architecture without an explicit request.

Test visual state through meaningful DOM attributes and classes, not brittle assumptions about incidental element order.

## Dependencies

The default answer to a new dependency is no.

Before adding one, establish that:

- the behavior is required now;
- the browser, Electron, React, TypeScript, or a small local module cannot reasonably provide it;
- it does not add runtime network access or weaken the security boundary;
- its license is compatible with the project;
- its maintenance cost is justified.

Do not update unrelated dependencies during a feature or bug fix. Do not perform broad version churn without a dedicated request.

## Testing strategy

Match validation to the change.

### Unit tests

Use Vitest for pure or isolated behavior such as:

- Calculator transitions;
- virtual-filesystem operations;
- geometry and overlap calculations;
- sanitization and schema bounds;
- command-state derivation;
- shared interaction reducers introduced later.

Test externally meaningful behavior and edge cases, not implementation trivia.

### Renderer-focused regression tests

Use focused tests when a component-level interaction can be exercised reliably without launching Electron. Prefer assertions on state transitions, semantic roles, and deliberate data attributes.

### Electron smoke tests

Use the real application for critical integrated behavior involving:

- native pointer input and release;
- menus and desk accessories;
- renderer-to-main IPC;
- atomic persistence;
- quit sequencing;
- relaunch and state recovery;
- security-sensitive window behavior.

Smoke tests should prove a user journey, not reproduce every unit test through expensive automation. Keep deterministic automation hooks narrow and unavailable as hidden product features.

### Visual review

For meaningful visual changes, capture or inspect the affected state at the intended window size. Check active and inactive states, clipping, pixel alignment, selected text legibility, and drag or modal layering. A passing typecheck does not validate a visual interaction.

## Validation commands

The standard commands are:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
npm run smoke
```

`npm run check` runs formatting verification, linting, strict TypeScript checks, unit tests, and the production build. It does not replace `npm run smoke` when the change affects integrated Electron behavior.

Use the narrowest useful validation while iterating. Before reporting completion, run the full relevant set:

- documentation-only changes: inspect the rendered Markdown and repository diff;
- pure model changes: targeted tests, then `npm run check`;
- renderer interaction changes: `npm run check` plus focused interaction coverage;
- persistence, IPC, lifecycle, native pointer, or critical desktop changes: `npm run check` and `npm run smoke`.

Do not claim a command passed unless it was actually run. Report any skipped validation and why.

## Change discipline

Keep changes scoped. Do not mix a requested feature with unrelated formatting, renaming, dependency updates, or cleanup.

Preserve public data attributes used by smoke automation unless the automation is updated in the same change. Prefer stable semantic hooks over selectors tied to presentation.

Comments should explain a non-obvious constraint, historical choice, security boundary, or interaction invariant. Do not narrate obvious code.

Update documentation when a change alters:

- product scope;
- architecture boundaries;
- the interaction contract;
- persisted state;
- run or validation commands;
- security assumptions;
- supported controls.

## Git and repository safety

Do not commit, push, create branches, rewrite history, force-push, tag releases, or open pull requests unless the user explicitly asks for that action.

When an explicit repository edit necessarily creates a commit through the connected GitHub tool, keep the commit small, accurately named, and limited to the requested change.

Never discard or overwrite user work. Before resolving conflicts or replacing a file, inspect the current content and preserve intentional changes.

Do not include generated build output, dependencies, coverage, screenshots, temporary automation data, local state files, or secrets unless a requested artifact deliberately belongs in the repository.

## Reporting work

A completion report should state:

- what changed;
- why that shape was chosen;
- what validation ran and its result;
- any remaining uncertainty, limitation, or deliberate follow-up boundary.

Do not inflate the report with routine details. Never claim pixel accuracy, historical accuracy, security, compatibility, or test coverage beyond the evidence available.

## Final principle

Macintosh Workbench should feel authored, not generated. Every feature must belong to the same machine.