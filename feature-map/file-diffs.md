# Workspace file diffs

Open a text file's diff against a local Git revision, compare it with the saved workspace contents, and leave comments on the current-file side. The comparison defaults to main/master and is preserved in shared diff URLs.

## Sub-features

- `open`: clean and changed text files expose Show diff in Git workspaces.
- `baseline`: search branches and recent commits or enter a SHA, tag, or revision.
- `default`: prefer main/master, then origin's default branch, then HEAD.
- `comments`: preserve an unsent comment draft across baseline changes and post its current-side anchor.
- `navigation`: retain the comparison across files and responsive layouts; restore its exact commit on refresh.
- `states`: show loading, empty comparisons, unavailable revisions, and retryable read failures.
- `snapshot`: non-Git workspaces retain their existing change snapshot comparisons.

## How to get to it (user POV)

- Files: open Workspace, choose Files, and open a text file.
- Changes: choose a modified file from Workspace's Changes tab.
- Chat: click a workspace file link in a message.
- Content search: open a matching file from the search results.
- Shared URL: open a session URL containing a file and diff comparison.

On each surface, click Show diff and use Compare against above the editor. Select HEAD to compare only uncommitted changes. Select text on the Working tree side to add a comment.

## Driving it with the repro environment

Preconditions: build this checkout's web UI and install Chromium. Browser-contract tests use a sealed mock backend and need no Omnigent instance. Backend tests exercise real temporary Git repositories.

- All five entry points: `tests/browser_ui/files/test_file_line_navigation.py::test_selectable_diff_baseline_for_workspace_files` opens each surface, changes the baseline, resizes to mobile, and reloads the exact comparison URL. The direct-file variant also preserves and posts a comment draft.
- Runner: `tests/runner/test_environment_filesystem.py::test_git_comparison_routes_read_clean_files` verifies a clean file against main and an unavailable revision.
- Host fallback: `tests/host/test_connect.py::test_host_serves_git_comparison_reads` verifies baseline discovery and clean-file reads through host request frames.
- Git semantics: `tests/test_workspace_fs.py::test_explicit_diff_uses_exact_revision_and_saved_contents` compares exact revisions with saved staged and unstaged edits.

Run browser tests with `--browser-ui-skip-build --video=on --screenshot=on --output=/tmp/omnigent-file-diff-evidence` after building. For a manual real-workspace check, use a Git-backed session with an older commit, open a clean text file, select that commit, add a comment, and verify the selected comparison survives refresh.

## Gotchas

- The right side is saved disk content; save editor changes before comparing.
- Comparisons use the exact commit, not its merge base. Renamed paths are not followed automatically.
- Only locally available Git history is used; the picker does not fetch missing objects.
- The GitHub/GitLab/Azure DevOps request diff panel is a separate surface.
- Binary, image, PDF, video, and model files do not expose this text comparison.
- Non-Git snapshots depend on the runner's recorded edits; the host cannot reconstruct them.
