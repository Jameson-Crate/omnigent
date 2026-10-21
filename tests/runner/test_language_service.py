"""LSP protocol/process checks without a separate server or model provider."""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from omnigent.inner.datamodel import OSEnvSandboxSpec, OSEnvSpec
from omnigent.inner.os_env import CallerProcessOSEnvironment, create_os_environment
from omnigent.runner.language_server import LanguageServer, LanguageServerError
from omnigent.runner.language_service import LanguageOperation, SessionLanguageServices
from tests._helpers.polling import poll_until_async


def test_progress_reports_remaining_phase(environment: CallerProcessOSEnvironment) -> None:
    server = LanguageServer(environment, ["rust-analyzer"], {}, lambda *_: None)
    server.status = "ready"
    server._notification(
        "$/progress", {"token": "load", "value": {"kind": "begin", "title": "Loading crates"}}
    )
    server._notification(
        "$/progress", {"token": "cache", "value": {"kind": "begin", "title": "Building caches"}}
    )
    server._notification("$/progress", {"token": "load", "value": {"kind": "end"}})
    assert server.status == "indexing"
    assert server.message == "Building caches"
    server._notification(
        "$/progress", {"token": "cache", "value": {"kind": "report", "message": "10/20 caches"}}
    )
    assert server.message == "10/20 caches"
    server._notification("$/progress", {"token": "cache", "value": {"kind": "end"}})
    assert server.status == "ready"
    assert server.message == "Language server ready"


@pytest.fixture
def environment(tmp_path: Path) -> CallerProcessOSEnvironment:
    root = tmp_path / "rust workspace"
    root.mkdir()
    (root / "main.rs").write_text("fn main() {}\n")
    result = create_os_environment(
        OSEnvSpec(type="caller_process", cwd=str(root), sandbox=OSEnvSandboxSpec(type="none"))
    )
    assert isinstance(result, CallerProcessOSEnvironment)
    return result


@pytest.fixture
async def services() -> AsyncIterator[SessionLanguageServices]:
    service = SessionLanguageServices()
    yield service
    await service.close()


def operation(
    environment: CallerProcessOSEnvironment, tmp_path: Path, **changes: object
) -> LanguageOperation:
    return LanguageOperation.model_validate(
        {
            "action": "attach",
            "root": str(environment.cwd.resolve()),
            "token": "editor-1",
            "path": "main.rs",
            "text": "fn main() {}",
            "command": [
                sys.executable,
                "-u",
                str(Path(__file__).with_name("lsp_fixture.py")),
                str(tmp_path / "protocol.jsonl"),
            ],
            **changes,
        }
    )


async def ready(
    services: SessionLanguageServices,
    environment: CallerProcessOSEnvironment,
    request: LanguageOperation,
    session: str = "session-1",
) -> dict:
    service = services.services[(session, request.root, request.language)]
    await poll_until_async(
        lambda: service.server.status != "starting", timeout_s=10, interval_s=0.02
    )
    return await services.operate(
        session, environment, request.model_copy(update={"action": "poll"})
    )


@pytest.mark.parametrize("mode", ["full", "incremental", "no-save"])
async def test_lifecycle_sync_capabilities_and_navigation(
    services: SessionLanguageServices,
    environment: CallerProcessOSEnvironment,
    tmp_path: Path,
    mode: str,
) -> None:
    request = operation(
        environment,
        tmp_path,
        text="fn main() {}\n// 🦀",
        command=[
            sys.executable,
            "-u",
            str(Path(__file__).with_name("lsp_fixture.py")),
            str(tmp_path / "protocol.jsonl"),
            mode,
        ],
    )
    attached = await services.operate("session-1", environment, request)
    assert attached["status"] == "starting"
    result = await ready(services, environment, request)
    assert result["status"] in {"ready", "indexing"}, result
    service = next(iter(services.services.values()))
    assert service.server.capabilities["hoverProvider"] is True
    for method in ("hover", "definition", "references", "documentSymbol", "formatting"):
        response = await services.operate(
            "session-1",
            environment,
            request.model_copy(update={"action": "request", "method": f"textDocument/{method}"}),
        )
        assert response["result"]
    await services.operate(
        "session-1",
        environment,
        request.model_copy(update={"action": "sync", "version": 2, "text": "fn other() {}"}),
    )
    saved = request.model_copy(update={"action": "save", "version": 2, "text": "fn other() {}"})
    await services.operate("session-1", environment, saved)
    await services.operate("session-1", environment, saved)
    with pytest.raises(LanguageServerError, match="Saved content no longer matches"):
        await services.operate(
            "session-1", environment, saved.model_copy(update={"text": "unsaved"})
        )

    await poll_until_async(
        lambda: any(entry["version"] == 2 for entry in service.diagnostics.values()),
        timeout_s=3,
        interval_s=0.01,
    )
    process = service.server._process
    assert process is not None
    await services.operate(
        "session-1", environment, request.model_copy(update={"action": "detach"})
    )
    assert services.services == {}
    assert process.returncode is not None
    messages = [
        json.loads(line) for line in (tmp_path / "protocol.jsonl").read_text().splitlines()
    ]
    initialized = next(message for message in messages if message.get("method") == "initialize")
    assert initialized["params"]["rootUri"] == environment.cwd.resolve().as_uri()
    assert initialized["params"]["capabilities"]["general"]["positionEncodings"] == ["utf-16"]
    change = next(
        message for message in messages if message.get("method") == "textDocument/didChange"
    )
    edits = change["params"]["contentChanges"]
    if mode == "incremental":
        assert edits[0]["range"]["end"] == {"line": 1, "character": 5}
    else:
        assert "range" not in edits[0]
    assert any(message.get("method") == "textDocument/didClose" for message in messages)
    saves = [message for message in messages if message.get("method") == "textDocument/didSave"]
    if mode == "no-save":
        assert saves == []
    else:
        assert len(saves) == 1
        assert saves[0]["params"]["textDocument"] == {
            "uri": (environment.cwd / "main.rs").as_uri()
        }
        if mode == "incremental":
            assert saves[0]["params"]["text"] == "fn other() {}"
        else:
            assert "text" not in saves[0]["params"]
    assert any(message.get("id") == "config-1" for message in messages)


@pytest.mark.parametrize(
    "mode,reason", [("fail", "fixture initialization rejected"), ("crash", "disconnected")]
)
async def test_startup_failures_are_actionable(
    services: SessionLanguageServices,
    environment: CallerProcessOSEnvironment,
    tmp_path: Path,
    mode: str,
    reason: str,
) -> None:
    request = operation(environment, tmp_path)
    request.command.append(mode)
    await services.operate("session-1", environment, request)
    snapshot = await ready(services, environment, request)
    service = next(iter(services.services.values()))
    await poll_until_async(lambda: service.server.status == "failed", timeout_s=3)
    snapshot = await services.operate(
        "session-1", environment, request.model_copy(update={"action": "poll"})
    )
    assert snapshot["status"] == "failed"
    assert reason in snapshot["message"]


async def test_missing_binary_and_unsupported_capability(
    services: SessionLanguageServices, environment: CallerProcessOSEnvironment, tmp_path: Path
) -> None:
    request = operation(environment, tmp_path, command=["nonexistent-omnigent-language-server"])
    await services.operate("session-1", environment, request)
    snapshot = await ready(services, environment, request)
    assert snapshot["status"] == "failed"
    assert "workspace host" in snapshot["message"]
    await services.cleanup_session("session-1")
    request = operation(environment, tmp_path)
    request.command.append("no-format")
    await services.operate("session-1", environment, request)
    await ready(services, environment, request)
    with pytest.raises(LanguageServerError, match="does not advertise"):
        await services.operate(
            "session-1",
            environment,
            request.model_copy(update={"action": "request", "method": "textDocument/formatting"}),
        )


async def test_workspace_session_and_document_isolation(
    services: SessionLanguageServices, environment: CallerProcessOSEnvironment, tmp_path: Path
) -> None:
    request = operation(environment, tmp_path)
    await services.operate("session-1", environment, request)
    await services.operate("session-2", environment, request)
    assert len(services.services) == 2
    first, second = services.services.values()
    assert first.generation != second.generation
    first._notify(
        "textDocument/publishDiagnostics",
        {
            "uri": (tmp_path / "outside.rs").as_uri(),
            "diagnostics": [{"message": "wrong workspace"}],
        },
    )
    assert not first.diagnostics
    first._notify(
        "textDocument/publishDiagnostics",
        {
            "uri": (environment.cwd / "main.rs").as_uri(),
            "version": 0,
            "diagnostics": [{"message": "stale version"}],
        },
    )
    assert not first.diagnostics
    with pytest.raises(LanguageServerError, match="already has an LSP editor"):
        await services.operate(
            "session-1", environment, request.model_copy(update={"token": "other-editor"})
        )
    with pytest.raises(LanguageServerError, match="root changed"):
        await services.operate(
            "session-1", environment, request.model_copy(update={"root": str(tmp_path)})
        )
    assert len(services.services) == 2
    await services.cleanup_session("session-1")
    assert len(services.services) == 1
    assert next(iter(services.services))[0] == "session-2"


@pytest.mark.parametrize("path", ["../outside.rs", "/etc/passwd", "main.py"])
async def test_paths_are_workspace_and_language_scoped(
    services: SessionLanguageServices,
    environment: CallerProcessOSEnvironment,
    tmp_path: Path,
    path: str,
) -> None:
    with pytest.raises(LanguageServerError):
        await services.operate(
            "session-1", environment, operation(environment, tmp_path, path=path)
        )
    assert services.services == {}


async def test_abandoned_attachment_expires(
    environment: CallerProcessOSEnvironment, tmp_path: Path
) -> None:
    services = SessionLanguageServices(lease_seconds=0.05)
    try:
        await services.operate("session-1", environment, operation(environment, tmp_path))
        await poll_until_async(lambda: not services.services, timeout_s=3, interval_s=0.02)
    finally:
        await services.close()


async def test_cancellation_and_timeout_keep_original_error(
    services: SessionLanguageServices, environment: CallerProcessOSEnvironment, tmp_path: Path
) -> None:
    request = operation(environment, tmp_path)
    request.command.append("hang")
    await services.operate("session-1", environment, request)
    await ready(services, environment, request)
    service = next(iter(services.services.values()))
    with pytest.raises(
        LanguageServerError, match=r"textDocument/hover timed out after 0\.02"
    ) as error:
        await service.server.request("textDocument/hover", {}, timeout=0.02)
    assert isinstance(error.value.__cause__, TimeoutError)
    pending = asyncio.create_task(service.server.request("textDocument/hover", {}))
    await poll_until_async(lambda: bool(service.server._pending), timeout_s=3)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert not service.server._pending


async def test_synchronization_retransmission_after_lost_response(
    services: SessionLanguageServices, environment: CallerProcessOSEnvironment, tmp_path: Path
) -> None:
    request = operation(environment, tmp_path)
    await services.operate("session-1", environment, request)
    await ready(services, environment, request)
    changed = request.model_copy(
        update={"action": "sync", "text": "fn changed() {}", "version": 2}
    )
    # The runner committed this write, but the editor did not receive its response.
    await services.operate("session-1", environment, changed)
    acknowledged = await services.operate("session-1", environment, changed)
    assert acknowledged["version"] == 2
    for conflict in (
        changed.model_copy(update={"text": "different buffer"}),
        changed.model_copy(update={"version": 1}),
    ):
        with pytest.raises(LanguageServerError, match="Stale document version"):
            await services.operate("session-1", environment, conflict)
    await services.operate(
        "session-1",
        environment,
        changed.model_copy(update={"version": 3, "text": "fn later() {}"}),
    )
    await services.operate(
        "session-1", environment, request.model_copy(update={"action": "detach"})
    )
    messages = [
        json.loads(line) for line in (tmp_path / "protocol.jsonl").read_text().splitlines()
    ]
    changes = [
        message for message in messages if message.get("method") == "textDocument/didChange"
    ]
    assert [message["params"]["textDocument"]["version"] for message in changes] == [2, 3]


async def test_real_rust_analyzer_when_installed(
    services: SessionLanguageServices, environment: CallerProcessOSEnvironment, tmp_path: Path
) -> None:
    binary = shutil.which("rust-analyzer")
    if binary is None:
        pytest.skip("rust-analyzer is not installed on the workspace host")
    probe = subprocess.run([binary, "--version"], capture_output=True, timeout=10)
    if probe.returncode:
        pytest.skip("rust-analyzer executable is unavailable: " + probe.stderr.decode().strip())
    (environment.cwd / "Cargo.toml").write_text(
        '[package]\nname="omnigent_lsp_fixture"\nversion="0.1.0"\nedition="2021"\n[[bin]]\nname="fixture"\npath="main.rs"\n'
    )
    source = 'fn main() { let value: u32 = "wrong"; }'
    (environment.cwd / "main.rs").write_text(source)
    request = operation(
        environment,
        tmp_path,
        command=[binary],
        text=source,
    )
    await services.operate("session-1", environment, request)
    snapshot = await ready(services, environment, request)
    assert snapshot["status"] != "failed", snapshot
    await services.operate("session-1", environment, request.model_copy(update={"action": "save"}))

    service = next(iter(services.services.values()))

    def has_type_diagnostic() -> bool:
        return any(
            "mismatched types" in diagnostic["message"].lower()
            or "expected u32" in diagnostic["message"].lower()
            for entry in service.diagnostics.values()
            for diagnostic in entry["diagnostics"]
        )

    await poll_until_async(has_type_diagnostic, timeout_s=45, interval_s=0.25)
