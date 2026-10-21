"""Workspace-owned LSP transport; callers never manage framing or subprocesses."""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import json
import os
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

from omnigent.inner import _proc
from omnigent.inner._subprocess_lifecycle import close_subprocess_transport, terminate_subprocess
from omnigent.inner.os_env import CallerProcessOSEnvironment, build_helper_env
from omnigent.inner.sandbox import create_exec_launcher, get_backend

_MAX_MESSAGE_BYTES = 16 * 1024 * 1024


class LanguageServerError(RuntimeError):
    """An actionable startup, protocol, capability or lifecycle failure."""


class LanguageServer:
    """Own one stdio server in an existing environment, including its descendants.

    Notifications are delivered on the runner loop. Server-initiated execution
    and workspace edits are refused; callers own permission decisions.
    """

    def __init__(
        self,
        environment: CallerProcessOSEnvironment,
        command: list[str],
        settings: dict[str, Any],
        on_notification: Callable[[str, dict[str, Any]], None],
        *,
        configuration_section: str = "",
    ) -> None:
        self.environment = environment
        self.root = environment.cwd.resolve()
        self.command = command
        self.settings = settings
        self.configuration_section = configuration_section
        self.on_notification = on_notification
        self.capabilities: dict[str, Any] = {}
        self.status = "starting"
        self.message = "Starting language server…"
        self._process: asyncio.subprocess.Process | None = None
        self._reader: asyncio.Task[None] | None = None
        self._stderr_reader: asyncio.Task[None] | None = None
        self._stderr = ""
        self._launcher: str | None = None
        self._containment: Any = None
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._sequence = 0
        self._write_lock = asyncio.Lock()
        self._close_lock = asyncio.Lock()
        self._dispose_lock = asyncio.Lock()
        self._failure_cleanup: asyncio.Task[None] | None = None
        self._progress: dict[str, str] = {}

    async def start(self) -> None:
        """Initialize asynchronously; preserve startup causes and sandbox policy."""
        try:
            binary = shutil.which(self.command[0])
            if binary is None:
                raise LanguageServerError(
                    f"{self.command[0]} is not installed on the workspace host. "
                    "Install rust-analyzer (rustup component add rust-analyzer), "
                    "or configure its absolute executable path."
                )
            policy = dataclasses.replace(self.environment.sandbox)
            if self.environment._egress_rules or policy.credential_proxy or policy.git_ssh:
                raise LanguageServerError(
                    "LSP cannot yet attach the environment's credential/egress relays. "
                    "Use a separately configured workspace with an appropriate execution policy."
                )
            self.environment.prepare_sandbox(policy)
            child_env = build_helper_env(os.environ, policy)
            policy.spawn_env_allowlist = list(child_env)
            launcher_task = asyncio.create_task(
                asyncio.to_thread(create_exec_launcher, binary, policy, cwd=str(self.root))
            )
            try:
                self._launcher = await asyncio.shield(launcher_task)
            except asyncio.CancelledError:
                self._launcher = await launcher_task
                raise
            self._process = await asyncio.create_subprocess_exec(
                self._launcher,
                *self.command[1:],
                cwd="/" if policy.copy_on_write_namespace else self.root,
                env=child_env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=_MAX_MESSAGE_BYTES,
                **_proc.spawn_kwargs(),
            )
            _proc.remember_process_group(self._process)
            if policy.active:
                self._containment = get_backend(policy.backend_type).post_spawn(
                    policy, self._process.pid
                )
            self._reader = asyncio.create_task(self._read_messages())
            self._stderr_reader = asyncio.create_task(self._read_stderr())
            result = await self.request(
                "initialize",
                {
                    "processId": os.getpid(),
                    "rootUri": self.root.as_uri(),
                    "workspaceFolders": [{"uri": self.root.as_uri(), "name": self.root.name}],
                    "capabilities": {
                        "general": {"positionEncodings": ["utf-16"]},
                        "window": {"workDoneProgress": True},
                        "workspace": {"configuration": True},
                        "textDocument": {
                            "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
                            "publishDiagnostics": {"versionSupport": True},
                        },
                    },
                    "initializationOptions": self.settings,
                },
                timeout=30,
            )
            self.capabilities = result.get("capabilities", {})
            if self.capabilities.get("positionEncoding", "utf-16") != "utf-16":
                raise LanguageServerError("Server did not negotiate UTF-16 positions")
            await self.notify("initialized", {})
            configuration = (
                {self.configuration_section: self.settings}
                if self.configuration_section
                else self.settings
            )
            await self.notify("workspace/didChangeConfiguration", {"settings": configuration})
            self.status = "indexing" if self._progress else "ready"
            self.message = (
                next(reversed(self._progress.values()))
                if self._progress
                else "Language server ready"
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — startup failures become actionable status
            self.status = "failed"
            self.message = f"Language server startup failed: {exc} {self._stderr}".strip()
            await self._dispose()

    async def _send(self, payload: dict[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None or process.returncode is not None:
            raise LanguageServerError(f"Language server disconnected. {self._stderr}".strip())
        encoded = json.dumps({"jsonrpc": "2.0", **payload}).encode()
        if len(encoded) > _MAX_MESSAGE_BYTES:
            raise LanguageServerError("Language server message exceeds 16 MiB")
        async with self._write_lock:
            process.stdin.write(f"Content-Length: {len(encoded)}\r\n\r\n".encode() + encoded)
            await asyncio.wait_for(process.stdin.drain(), timeout=5)

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        await self._send({"method": method, "params": params})

    async def request(self, method: str, params: dict[str, Any], *, timeout: float = 15) -> Any:
        """Return a server result or its original error; cancel timed-out requests."""
        self._sequence += 1
        request_id = self._sequence
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._send({"id": request_id, "method": method, "params": params})
            return await asyncio.wait_for(future, timeout)
        except (TimeoutError, asyncio.CancelledError) as exc:
            with contextlib.suppress(LanguageServerError, OSError):
                await self.notify("$/cancelRequest", {"id": request_id})
            if isinstance(exc, TimeoutError):
                raise LanguageServerError(
                    f"Language server request {method} timed out after {timeout:g} seconds. "
                    "Wait for indexing to finish and retry, or stop and start LSP."
                ) from exc
            raise
        finally:
            self._pending.pop(request_id, None)

    async def _read_messages(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        stream = self._process.stdout
        try:
            while True:
                headers = await stream.readuntil(b"\r\n\r\n")
                fields = dict(line.split(b":", 1) for line in headers.strip().split(b"\r\n"))
                length = int(next(v for k, v in fields.items() if k.lower() == b"content-length"))
                if not 0 < length <= _MAX_MESSAGE_BYTES:
                    raise LanguageServerError("Invalid LSP Content-Length")
                payload = json.loads(await stream.readexactly(length))
                if "method" in payload:
                    method = payload["method"]
                    params = payload.get("params") or {}
                    if "id" in payload:
                        await self._server_request(payload["id"], method, params)
                    else:
                        self._notification(method, params)
                else:
                    future = self._pending.get(payload.get("id"))
                    if future is not None and not future.done():
                        if "error" in payload:
                            future.set_exception(LanguageServerError(str(payload["error"])))
                        else:
                            future.set_result(payload.get("result"))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — a broken peer fails every pending request
            self.status = "failed"
            self.message = f"Language server disconnected: {exc} {self._stderr}".strip()
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(LanguageServerError(self.message))
            self._failure_cleanup = asyncio.create_task(self._dispose())

    async def _server_request(self, request_id: Any, method: str, params: dict[str, Any]) -> None:
        if method == "workspace/configuration":
            result = []
            for item in params.get("items", []):
                section = item.get("section", "")
                value: Any = self.settings
                if section == self.configuration_section:
                    section = ""
                elif self.configuration_section and section.startswith(
                    self.configuration_section + "."
                ):
                    section = section[len(self.configuration_section) + 1 :]
                for part in section.split(".") if section else []:
                    value = value.get(part) if isinstance(value, dict) else None
                result.append(value)
            await self._send({"id": request_id, "result": result})
        elif method == "window/workDoneProgress/create":
            await self._send({"id": request_id, "result": None})
        elif method == "workspace/applyEdit":
            await self._send(
                {
                    "id": request_id,
                    "result": {"applied": False, "failureReason": "User edit required"},
                }
            )
        else:
            await self._send(
                {"id": request_id, "error": {"code": -32601, "message": f"Unsupported: {method}"}}
            )

    def _notification(self, method: str, params: dict[str, Any]) -> None:
        if method == "$/progress":
            value = params.get("value", {})
            token = str(params.get("token"))
            if value.get("kind") == "begin":
                self._progress[token] = (
                    value.get("message") or value.get("title") or "Indexing workspace…"
                )
            elif value.get("kind") == "end":
                self._progress.pop(token, None)
            elif token in self._progress and value.get("message"):
                self._progress[token] = value["message"]
            if self.status != "starting":
                self.status = "indexing" if self._progress else "ready"
            self.message = (
                next(reversed(self._progress.values()))
                if self._progress
                else "Language server ready"
            )
        elif method == "experimental/serverStatus":
            self.status = (
                "degraded"
                if params.get("health") != "ok"
                else ("ready" if params.get("quiescent", True) else "indexing")
            )
            self.message = params.get("message") or self.status
        self.on_notification(method, params)

    async def _read_stderr(self) -> None:
        assert self._process is not None and self._process.stderr is not None
        while chunk := await self._process.stderr.read(4096):
            self._stderr = (self._stderr + chunk.decode(errors="replace"))[-8192:]

    async def close(self) -> None:
        """Idempotently shut down the protocol, then terminate the process tree."""
        async with self._close_lock:
            if self._process is not None and self.status in {"ready", "indexing", "degraded"}:
                with contextlib.suppress(Exception):
                    await self.request("shutdown", {}, timeout=1)
                    await self.notify("exit", {})
            await self._dispose()
            self.status = "stopped"
            self.message = "Language server stopped"

    async def _dispose(self) -> None:
        async with self._dispose_lock:
            await self._dispose_resources()

    async def _dispose_resources(self) -> None:
        if self._process is not None:
            await terminate_subprocess(
                self._process, terminate_timeout=1, kill_timeout=1, label="language server"
            )
            close_subprocess_transport(self._process)
            self._process = None
        for task in (self._reader, self._stderr_reader):
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        if self._containment is not None:
            self._containment.close()
            self._containment = None
        if self._launcher:
            Path(self._launcher).unlink(missing_ok=True)
            self._launcher = None
        for future in self._pending.values():
            if not future.done():
                future.set_exception(LanguageServerError("Language server stopped"))
