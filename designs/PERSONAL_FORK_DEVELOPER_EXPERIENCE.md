# Personal fork developer experience

## Discovery (PR 1)

The Apache-2.0 checkout at `7fc8e9d49` has one shared React UI: `web/src/main.tsx`
and `App.tsx` route to `shell/AppShell.tsx`; Electron embeds that UI, and the
iOS/Android wrappers use its responsive surfaces. Files enter through FilesPanel,
chat/tool links, deep links and the mobile drawer. FileViewer delegates source
editing to CodeViewer/MonacoCodeEditor; autosave, comments, line navigation and
MonacoDiffViewer already exist. Monaco/Shiki provide highlighting, not LSP.
The coding-tool LSP stub and Antigravity's private RPC are unrelated protocols.

PullRequestPanel already renders lazy unified/split PR diffs with `@pierre/diffs`;
runner `pr_resource.py` and `github_resource.py` own Git/provider access. Stable
revision-aware references remain a separate extension. FileViewerContext and
AppShell own file navigation. Comment entities, routes, stores and hooks provide
local range anchors, authors and addressed state, but lack revision-aware diff
anchors and reply threads. Session workspace state persists open files and rail
layout; gridLayout and canvasLayout own distinct layout models.

Host service/worktree code selects execution roots; SessionResourceRegistry
materializes the session environment on the owning runner and cleans it up.
Runner resource routes serve files; server resource routes enforce permissions
and proxy through the existing runner tunnel. CallerProcessFilesystem validates
paths, OSEnvironment owns sandbox policy, and `create_exec_launcher` applies it
to processes. Filesystem deletion already exists on both API sides. Existing
worktree hooks/pickers, ComposerWorkspaceStatus and host git_worktree should be
extended in PR 7 rather than replaced.

## LSP design

Using software-design-advisor's information-hiding and design-it-twice principles:

1. **Runner-owned service (selected):** session/root/language own the process,
   transport, synchronization and capability state. A small editor API hides
   JSON-RPC framing, initialization, cancellation, leases and language defaults.
   Reuses environment resolution, runner routing, sandbox launcher and cleanup.
   Duplicates indexing between sessions, but keeps permission and lifecycle
   ownership unambiguous.
2. **Host-wide LSP broker:** shares processes across sessions and supports offline
   browsing, but introduces another routed service, shared unsaved-buffer state,
   authorization and cleanup coordination. Too much machinery for this slice.

A direct browser-to-LSP socket would expose process/protocol details and duplicate
host routing. Separate Rust/Python/Java/Scala clients would amplify every change.
Use shared stdio JSON-RPC and a language configuration record instead.

The runner resolves the root from the session environment, never process cwd.
Clients supply the expected root and a generation token; stale roots and expired
attachments fail explicitly. Each editor attachment synchronizes one document;
conflicting owners of an unsaved document must not silently overwrite each other.
Closing a viewer detaches; abandoned attachments expire; the final detach stops
the server. Session cleanup stops all attached servers before its environment.
Startup/request tasks are asynchronous and bounded. Server failures retain their
original messages and stderr tail. Progress is indexing only when reported.

Startup is an explicit owner action, matching shell execution permissions:
rust-analyzer may invoke Cargo and build scripts. Reuse the environment sandbox,
filtered environment and launcher; unsupported environment execution must fail
closed. Server requests to apply edits or run commands are not auto-approved.
Formatting returns edits to Monaco and uses existing autosave/permissions.

Persisted-content acknowledgement reuses the editor's existing server-content
state. The shared client sends advertised save notifications only when that
content matches its synchronized buffer. Sending save after every change would
make Cargo inspect older disk content; adding another file writer would duplicate
autosave conflict and permission decisions. The runner deduplicates saved versions
and supplies text only when requested by the server's sync capability. Opening
unchanged persisted content does not synthesize a save event; this also avoids
a rust-analyzer 1.95.0 indexing panic observed on an unnecessary initial save.

Risks to review: global Monaco providers crossing models/worktrees; URI/UTF-16
conversion; old diagnostics surviving document edits; server-request deadlocks;
subprocess descendants surviving detach; raw protocol configuration leaking
through UI components; shallow wrappers around existing permission/routing APIs.

## Sequence and validation

PR 1 adds shared transport/service, Rust defaults, editor adapter, status,
diagnostics/navigation/outline/formatting, configuration and user documentation.
PRs 2 and 3 add language records and environment/project guidance to this service.
PR 4 builds on existing PR diffs and establishes revision identity; PRs 5 and 6
extend that identity for references and local comments. PRs 7–9 reuse worktree,
filesystem mutation and layout owners. Each starts only after the prior fork PR
has been merged by the user and origin/main refreshed.

Tests follow tests/README.md and tests/_helpers/README.md. Extend runner filesystem
and server shell-permission scenarios for API boundaries; keep protocol matrices
in runner unit tests with a local fixture process. Add an optional real
rust-analyzer Cargo-project test (explicit skip if unavailable), adapter tests
for model isolation and conversion, and a browser journey for visible controls.
Use existing isolated verification environment and server_runner primitives for
distinct process/tunnel boundaries, not redundant stacks per protocol case.
Run narrow tests, Python/web static checks, web build and pre-commit; run the
read-only review-agent loop on the complete merge-base diff until No findings.

Verification completed with rust-analyzer 1.95.0 on macOS: protocol integration,
saved-file type diagnostics and Chromium source-editor interactions. Frontend
dependencies were installed through the existing configured mirror without
changing project registries or lockfiles. Frontend tests, lint, type checking
and build passed. Native Electron/mobile shells remain unverified; no other
server version, platform or sandbox combination is claimed. `just` is absent,
so the corresponding underlying check commands were used directly.
