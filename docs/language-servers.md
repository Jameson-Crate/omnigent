# Rust language tools

Open a session's Rust source file in the source editor and choose **Start Rust
language server**. This runs rust-analyzer on the host that owns the selected
workspace/worktree. The root is shown beside the start control; the app server's
working directory is irrelevant. Opening a file alone does not execute Cargo.
Starting analysis can run project build scripts, so this operation requires
session owner access, just like the environment shell API.

## Prerequisites and configuration

Install a Rust toolchain and rust-analyzer on the workspace host:

```sh
rustup component add rust-analyzer
rust-analyzer --version
```

Open a Cargo workspace or worktree, not an unrelated parent directory. The runner
must be connected and its execution policy must allow the Rust toolchain, project
and build output. No generated Omnigent configuration needs editing.

**Server configuration for this workspace** accepts an executable/argument array
and rust-analyzer settings, for example:

```json
{
  "command": ["/absolute/path/to/rust-analyzer"],
  "settings": {
    "cargo": { "buildScripts": { "enable": false } },
    "procMacro": { "enable": false }
  }
}
```

Choose **Apply configuration**, then start the server. Stop existing LSP editors
in that session before changing configuration. Defaults persist in this browser
per server, host, canonical workspace root and language. They are not project
files, are not shared with other users, and do not install software. When a host
identity is unavailable the setting is scoped to the session instead.
Embedded backends without a stable server identity use configuration only for
the current editor; it is not persisted across backends.

## Supported operations

- Diagnostics appear as editor markers and a clickable **Diagnostics** list.
- Hover a symbol for server-provided documentation.
- **Definition** / **F12** opens the definition; multiple targets appear in Locations.
- **References** / **Shift+F12** lists clickable file/line locations.
- **Outline** retrieves document symbols; selecting one opens its source line.
- **Format** applies advertised formatting edits to the current editable buffer.
  Existing autosave persists the result; normal editor undo can undo formatting.
  Save notifications follow confirmed persisted content, so Cargo checks run
  against saved edits rather than an older file on disk.

Buttons reflect negotiated capabilities. Unsupported operations report the
server's missing capability instead of claiming success. Indexing is shown only
when the server reports progress. Starting, ready, degraded, failed and stopped
states include actionable messages. Missing binaries, expired attachments, changed
roots and disconnected hosts require correcting the cause and restarting LSP.

## Ownership and limitations

The owning runner reuses one process per session/root/language. Each visible
source editor attaches one document. Unsaved changes synchronize before requests;
results from replaced roots, generations or edited buffers are discarded. A
second editor for the same document must stop the first attachment before
starting its own LSP view. Different sessions use separate processes, even for
the same checkout.

Stopping LSP, leaving the source editor or closing its viewer detaches the
document. The final detach shuts down the server and its process tree. Browser
crashes/disconnections expire after a 60-second lease (checked at most every
10 seconds). Session-resource cleanup and orderly runner shutdown stop the
services before releasing their environments. Tab visibility alone does not
detach a mounted editor. A forcibly killed runner has the same process-cleanup
limitations as other runner-owned external processes; graceful shutdown is the
supported cleanup path.

This slice supports Rust on caller-process workspace environments. Credential,
egress and SSH relay configurations fail closed with an explicit explanation;
their relay lifetime is not silently bypassed. The sandbox launcher, environment
filtering and process-tree cleanup reuse existing Omnigent mechanisms. Server
requests to apply workspace edits or run arbitrary commands are refused.

LSP runs in the complete, non-truncated source editor, including the shared web,
desktop and responsive mobile surfaces. Diff-only previews do not attach an LSP
document. External file definitions use existing owner-authorized file browsing.
The coding agent's separate `LSP` tool stub is unchanged. Automatic restart,
completion, rename, code actions, dynamic capability registration and multi-root
servers are outside this slice; unsupported server requests receive protocol
errors. Hover documentation is untrusted Markdown with HTML disabled.

## Verification

Protocol fixtures exercise initialization, full/incremental UTF-16 changes,
capabilities, diagnostics, navigation/formatting results, failures, cancellation,
leases, shutdown and session/workspace isolation:

```sh
uv run --no-sync pytest tests/runner/test_language_service.py \
  tests/runner/test_environment_filesystem.py \
  tests/server/routes/test_shell_permission_gate.py --reruns 0
corepack pnpm --filter web exec vitest run src/shell/languageClient.test.ts \
  src/shell/LanguageTools.test.tsx
```

The optional real-server test probes `rust-analyzer --version` and skips explicitly
when absent or when a rustup shim lacks the component. On this development host,
rust-analyzer 1.95.0 in the installed `1.95.0-aarch64-apple-darwin` toolchain passed
the Cargo-project initialization and type-diagnostic test. This does not establish
real-server support for other versions, platforms, or sandbox configurations.

Follow [the feature map](../feature-map/rust-language-tools.md) for manual entry
points. Frontend unit/component tests, lint, type checking and production build
passed. Chromium verification with the real server covered direct links, chat
citations, Files and Changes source entry, diagnostics and navigation, hover,
outline, formatting/autosave, responsive phone width, workspace isolation and
missing-binary errors, and disconnected-host result clearing. The native Electron and native mobile shells were not
launched; their shared source editor does not establish native-shell verification.
