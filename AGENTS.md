# AGENTS.md

## Scope and sources of truth

These instructions apply to the entire repository.

Before changing code, read `README.md`. For any user-visible behavior, also read
`docs/interaction-model.md`; it is the normative interaction contract. Treat the
current implementation and its tests as evidence. If code and documentation
disagree, determine the intended behavior and update the implementation, tests,
and documentation together.

The product is **The Macintosh**, a clean-room Electron recreation of the
tactile black-and-white desktop language associated with classic Macintosh
System 6 and System 7. It is a desktop shell, not an emulator or a modern app
with a retro theme pasted over it.

Payton owns product direction, scope, historical interpretation, and aesthetic
judgment. Preserve that intent rather than substituting generic frontend
conventions, speculative abstractions, or a broader product vision.

## Product boundaries

- Use original code, code-drawn or original artwork, and synthesized or original
  sounds. Do not add Apple ROMs, copied system files, extracted icons,
  proprietary startup artwork, or copied system sounds.
- Keep the application local-first. Do not add runtime networking, remote
  content, analytics, telemetry, arbitrary host-path access, update services, or
  external navigation without an explicit product decision.
- Preserve one coherent Macintosh environment. Prefer behavior and tactile
  clarity over decorative imitation or feature breadth.
- Do not create speculative desktop, window-manager, application, command, or
  plugin frameworks. Extract shared behavior only after real implementations
  demonstrate the same responsibility.

## Architecture and security

- `src/main/` owns Electron lifecycle, the secured `BrowserWindow`, canonical
  durable state and virtual-filesystem mutations, host import inspection,
  validated IPC, serialized atomic persistence, and application quit.
- `src/main/preload.ts` is the minimal typed bridge between the renderer and the
  main process.
- `src/renderer/` owns the simulated desktop, React UI, selection, hit testing,
  interaction previews, proposed layout, pixel artwork, synthesized sound, and
  styling. It has no Node.js or direct host-filesystem access.
- `src/renderer/model/` contains pure or mostly pure domain behavior suitable
  for focused tests.
- `src/shared/` owns typed IPC contracts, cross-process domain types, and
  defensive persistent-state schemas.
- `scripts/` contains runtime assembly and integrated Electron smoke automation.

Keep these boundaries narrow. Do not move browser-only interaction logic into
Electron main or turn preload into a general RPC layer.

Preserve the current Electron security posture unless Payton explicitly approves
a change:

- `contextIsolation: true`;
- `nodeIntegration: false`;
- `sandbox: true`;
- `webSecurity: true`;
- denied navigation and new-window creation;
- local bundled resources only.

Every new preload or IPC capability expands the security boundary. It requires
a concrete need, a typed contract, defensive validation and bounds, a narrow
implementation, and relevant tests.

## Interaction and persistence invariants

- Input has one owner. Follow the precedence in `docs/interaction-model.md` and
  prevent the same event from triggering lower-priority behavior.
- Pointer interactions are sessions: press establishes ownership, movement
  changes preview state, release commits, and cancellation restores committed
  state. Handle release outside the originating element and always clean up
  captures and listeners.
- Preview state must never silently mutate durable state.
- Pointer controls, menu items, and keyboard shortcuts must dispatch the same
  command action and derive availability from the same context.
- The main process owns canonical durable state. Renderer persistence is limited
  to allowlisted presentation fields and parent-scoped icon positions.
- Persistent-state changes require updated types and defaults, defensive bounds
  and sanitization, an explicit migration or reset decision, malformed and
  prior-state tests where relevant, and an Electron relaunch check.
- Save-dependent actions must not quit until persistence succeeds. Failures must
  remain visible and recoverable.
- Host imports may originate only from browser-granted `File` objects produced
  by an explicit user drop or paste. Inspection and insertion remain one bounded,
  serialized main-process transaction; do not retain arbitrary host paths.

Persist only intentionally durable product state. Open menus, selections,
pointer sessions, previews, hover state, animations, ordinary dialogs,
Calculator session state, startup progress, and acknowledged errors are
transient.

## Visual and audio language

The renderer remains a normal DOM/RGBA scene. Do not replace it with a literal
1-bit framebuffer, canvas-wide rasterization, or global post-processing filter.

Authored interface paint uses black, white, and deterministic aligned dithering.
Preserve hard edges, integer-aligned geometry where practical, distinct states
without reliance on color, restrained or stepped motion, and original bitmap
artwork. Intermediate tones come from patterns, not literal gray, gradients,
translucency, blur, soft shadows, or antialias-like effects.

Do not introduce spring motion, rounded-card layouts, toast notifications, stock
emoji, modern icon libraries, or platform-native controls unless Payton chooses
them for a specific reason. System sounds must be synthesized in code or created
from original local assets and should remain brief interaction feedback.

## Change discipline

Inspect the working tree, relevant callers, tests, styles, contracts, and state
schema before editing. Preserve unrelated user changes. Make the smallest
complete change; avoid unrelated refactors, dependency churn, renames,
formatting, and generated output.

Use strict TypeScript and treat `unknown` data as untrusted until validated. Keep
React state close to the behavior that coordinates it, and move pure transitions
into model modules only when that creates a stable testable boundary. Do not add
a state-management library or another dependency for a problem the existing
stack can reasonably solve.

Preserve semantic controls, labels, dialog and menu roles, keyboard ownership,
and alert status. Accessibility is part of behavior, not a reason to substitute
generic visual components.

Update `README.md` when product scope, controls, architecture, security
assumptions, or run and validation commands change. Update
`docs/interaction-model.md` when user-visible interaction, ownership,
persistence, or visual invariants change.

Do not commit, push, create or switch branches, rewrite history, tag releases,
open pull requests, publish artifacts, or alter external systems unless the user
explicitly asks. Never discard or overwrite user work.

## Validation

Node.js 22 or newer is required. The standard commands are:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
npm run smoke
```

`npm run check` runs formatting verification, ESLint, both strict TypeScript
projects, Vitest, and the production build. It does not run or replace
`npm run smoke`.

Match validation to the change:

- Documentation-only: inspect the Markdown and final diff, run formatting
  verification, and run `git diff --check`.
- Pure model or schema behavior: run focused tests while iterating, then
  `npm run check`.
- Renderer interaction: run focused regression coverage and `npm run check`.
- Persistence, IPC, lifecycle, host import, native pointer, ejection, quit, or
  relaunch behavior: run `npm run check` and `npm run smoke`.
- Meaningful visual changes: inspect the affected states in the real Electron
  app at the intended window size, including active and inactive treatment,
  clipping, pixel alignment, selected-text legibility, and drag or modal layers.

Use `npm run dev` for ordinary real-application inspection. Browser-only review
is not proof of IPC-backed or native Electron behavior, and smoke automation is
not a substitute for judging the live interface.

Do not claim a check, build, behavior, historical detail, pixel accuracy, or
security property was verified unless it was actually observed. Report skipped
checks and pre-existing or environmental failures separately.
