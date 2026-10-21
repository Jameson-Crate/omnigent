# Rust language tools

Rust source files in the workspace editor can attach to rust-analyzer on the
workspace's owning host for diagnostics, hover, navigation, outline and formatting.

## Sub-features

- `start-stop`: explicit owner-authorized start, status, configuration and shutdown.
- `diagnostics`: live markers and clickable file/line diagnostics.
- `navigation`: hover, definitions, references and document outline.
- `format`: formatting only when advertised and the source buffer is editable.
- `isolation`: worktree/session changes clear results and release attachments.
- `failures`: missing binary, failed startup, expired lease and disconnected host.

## How to get to it (user POV)

- `files`: session Workspace → Files → a `.rs` file → source editor.
- `changes`: select a changed `.rs` file, then leave diff mode for its source.
- `direct-link`: open a session file link selecting a Rust source file.
- `chat-link`: click a Rust source path or line citation in a message or tool row.
- `desktop`: the same source viewer inside the Electron desktop shell.
- `mobile`: the Files drawer or chat file link at phone width, then source editor.

## Driving it with the repro environment

Preconditions: read [Verify Omnigent](skills/verify-omnigent/SKILL.md), build this
checkout and use an isolated instance. Install rust-analyzer on the owning runner
host, or supply its absolute path in Server configuration. Bind an owner session
to a disposable Cargo worktree with `src/main.rs` containing
`fn main() { let value: u32 = "wrong"; println!("{value}"); }`.

For each entry point above (manual; no browser journey exists yet), start LSP and
wait for ready/indexing. Confirm a type diagnostic appears; click it to reveal
the line. Hover `value`, place the cursor on its use, press F12, then Shift+F12.
Select Outline and click `main`. Choose Format, confirm autosave and reopen the
file. Stop LSP and confirm stopped status. Repeat at phone width and in Electron.
Record every entry point separately using the verification skill.

For isolation, use a second worktree with different source and switch sessions;
old markers, outline and locations must disappear. Close the viewer and confirm
its server process exits. Disconnect only the isolated test host and confirm an
actionable connection error clears displayed results. Configure a nonexistent
executable and confirm the host-installation hint, then restore configuration.

Lower-level verification:
`tests/runner/test_language_service.py::test_real_rust_analyzer_when_installed`
uses a real installed server; protocol fixtures in the same module cover shared
contracts. `tests/runner/test_environment_filesystem.py::test_language_server_resource_lifecycle`
covers route resolution and session cleanup. Real-server Chromium verification
covered direct links, chat citations, Files, Changes source entry and responsive
phone width, including diagnostics, navigation, hover, outline, formatting and
autosave, workspace isolation, missing binaries and disconnected-host result clearing. Native Electron and native
mobile shells remain unverified. Captures are kept outside the tracked tree.

## Gotchas

- Start can execute Cargo build scripts. Collaborator edit permission is
  insufficient; the server enforces owner access on every LSP operation.
- Diff previews and truncated files do not attach. Leave diff mode for source.
- A rustup shim on PATH is not proof that the component is installed. Run
  `rust-analyzer --version` on the workspace host, not just on the app server.
- Each mounted editor owns one document; a second editor for the same file must
  stop the first attachment. Closing the final editor stops its session's server.
- Fixture tests and real-server protocol tests do not prove browser interactions.
