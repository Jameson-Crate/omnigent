"""Editor operations scoped to a session's selected workspace and language."""

from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import unquote, urlparse

from pydantic import BaseModel, Field

from omnigent.inner.os_env import CallerProcessOSEnvironment, OSEnvironment
from omnigent.runner.language_server import LanguageServer, LanguageServerError

METHOD_CAPABILITIES = {
    "textDocument/hover": "hoverProvider",
    "textDocument/definition": "definitionProvider",
    "textDocument/references": "referencesProvider",
    "textDocument/documentSymbol": "documentSymbolProvider",
    "textDocument/formatting": "documentFormattingProvider",
}


@dataclass(frozen=True)
class LanguageServerDefinition:
    """Language defaults; lifecycle, transport and editor operations stay shared."""

    command: tuple[str, ...]
    suffixes: tuple[str, ...]
    configuration_section: str


LANGUAGE_SERVERS = {
    "rust": LanguageServerDefinition(("rust-analyzer",), (".rs",), "rust-analyzer"),
}


class LanguageOperation(BaseModel):
    """Editor contract; root and attachment fence every operation to one workspace."""

    action: Literal["attach", "poll", "sync", "save", "request", "detach"]
    root: str
    language: Literal["rust"] = "rust"
    token: str = Field(min_length=1, max_length=100)
    path: str = ""
    text: str = Field(default="", max_length=2 * 1024 * 1024)
    version: int = Field(default=1, ge=1)
    command: list[str] = Field(
        default_factory=lambda: list(LANGUAGE_SERVERS["rust"].command), min_length=1, max_length=32
    )
    settings: dict[str, Any] = Field(default_factory=dict)
    method: str = ""
    line: int = Field(default=0, ge=0)
    character: int = Field(default=0, ge=0)
    tab_size: int = Field(default=4, ge=1, le=16)
    insert_spaces: bool = True


@dataclass
class Document:
    uri: str
    text: str
    version: int
    opened: bool = False
    saved_version: int | None = None
    last_used: float = field(default_factory=time.monotonic)


class WorkspaceLanguageService:
    """Reuse a server within one session/root/language; final detach releases it.

    Owns buffers, capability checks and diagnostics. A lease covers browser crashes;
    session cleanup is the authoritative lifetime boundary.
    """

    def __init__(
        self, environment: CallerProcessOSEnvironment, operation: LanguageOperation
    ) -> None:
        self.root = environment.cwd.resolve()
        self.definition = LANGUAGE_SERVERS[operation.language]
        self.generation = uuid.uuid4().hex
        self.server = LanguageServer(
            environment,
            operation.command,
            operation.settings,
            self._notify,
            configuration_section=self.definition.configuration_section,
        )
        self.documents: dict[str, Document] = {}
        self.diagnostics: dict[str, dict[str, Any]] = {}
        self.lock = asyncio.Lock()
        self.closed = False
        self.active_operations = 0
        self.start_task = asyncio.create_task(self.server.start())
        self.expiry_task: asyncio.Task[None] | None = None

    def _notify(self, method: str, params: dict[str, Any]) -> None:
        if method != "textDocument/publishDiagnostics":
            return
        uri = params.get("uri", "")
        parsed = urlparse(uri)
        if parsed.scheme != "file" or parsed.netloc:
            return
        path = Path(unquote(parsed.path)).resolve()
        if not path.is_relative_to(self.root):
            return
        document = next((doc for doc in self.documents.values() if doc.uri == uri), None)
        version = params.get("version")
        if document is not None and version is not None and version != document.version:
            return
        self.diagnostics[uri] = {
            "path": str(path.relative_to(self.root)),
            "version": version,
            "diagnostics": params.get("diagnostics", []),
        }

    def _uri(self, path: str) -> str:
        candidate = (self.root / path).resolve()
        if candidate == self.root or not candidate.is_relative_to(self.root):
            raise LanguageServerError("LSP document must be inside the selected workspace root")
        if candidate.suffix not in self.definition.suffixes:
            raise LanguageServerError("Only Rust source documents are supported by this server")
        return candidate.as_uri()

    async def operate(self, operation: LanguageOperation) -> dict[str, Any]:
        async with self.lock:
            if self.closed:
                raise LanguageServerError("Language server stopped. Start it again.")
            if operation.action == "attach":
                uri = self._uri(operation.path)
                existing = self.documents.get(operation.token)
                if existing is not None:
                    if existing.uri != uri:
                        raise LanguageServerError("Attachment already owns a different document")
                else:
                    if any(doc.uri == uri for doc in self.documents.values()):
                        raise LanguageServerError(
                            "This document already has an LSP editor. "
                            "Stop it in the other viewer first."
                        )
                    self.documents[operation.token] = Document(
                        uri, operation.text, operation.version
                    )
            document = self.documents.get(operation.token)
            if document is None:
                raise LanguageServerError(
                    "LSP attachment expired. Start the language server again."
                )
            document.last_used = time.monotonic()
            if operation.action == "detach":
                if document.opened and self.server.status in {"ready", "indexing", "degraded"}:
                    await self.server.notify(
                        "textDocument/didClose", {"textDocument": {"uri": document.uri}}
                    )
                self.diagnostics.pop(document.uri, None)
                self.documents.pop(operation.token)
                return {"status": "stopped", "generation": self.generation}
            if operation.action == "sync":
                if operation.version < document.version or (
                    operation.version == document.version and operation.text != document.text
                ):
                    raise LanguageServerError(
                        "Stale document version; retry with the current buffer"
                    )
                if operation.version == document.version:
                    return self.snapshot(document)
                previous = document.text
                previous_version = document.version
                document.text = operation.text
                document.version = operation.version
                self.diagnostics.pop(document.uri, None)
                if document.opened:
                    try:
                        await self._change(document, previous)
                    except (LanguageServerError, OSError, TimeoutError):
                        document.text = previous
                        document.version = previous_version
                        raise
            if self.server.status in {"ready", "indexing", "degraded"} and not document.opened:
                sync = self.server.capabilities.get("textDocumentSync", 0)
                if not sync or (isinstance(sync, dict) and not sync.get("openClose")):
                    raise LanguageServerError(
                        "Server does not support document open/close synchronization"
                    )
                await self.server.notify(
                    "textDocument/didOpen",
                    {
                        "textDocument": {
                            "uri": document.uri,
                            "languageId": operation.language,
                            "text": document.text,
                            "version": document.version,
                        }
                    },
                )
                document.opened = True
            if operation.action == "save":
                if operation.version != document.version or operation.text != document.text:
                    raise LanguageServerError("Saved content no longer matches the LSP buffer")
                sync = self.server.capabilities.get("textDocumentSync", 0)
                save = sync.get("save", False) if isinstance(sync, dict) else False
                if (
                    document.opened
                    and save is not False
                    and save is not None
                    and document.saved_version != document.version
                ):
                    params: dict[str, Any] = {"textDocument": {"uri": document.uri}}
                    if isinstance(save, dict) and save.get("includeText"):
                        params["text"] = document.text
                    await self.server.notify("textDocument/didSave", params)
                    document.saved_version = document.version
            if operation.action == "request":
                if not document.opened or self.server.status not in {
                    "ready",
                    "indexing",
                    "degraded",
                }:
                    raise LanguageServerError(self.server.message)
                capability = METHOD_CAPABILITIES.get(operation.method)
                if capability is None or self.server.capabilities.get(capability) in (None, False):
                    raise LanguageServerError(f"Server does not advertise {operation.method}")
                params: dict[str, Any] = {"textDocument": {"uri": document.uri}}
                if operation.method == "textDocument/formatting":
                    params["options"] = {
                        "tabSize": operation.tab_size,
                        "insertSpaces": operation.insert_spaces,
                    }
                elif operation.method != "textDocument/documentSymbol":
                    params["position"] = {"line": operation.line, "character": operation.character}
                    if operation.method == "textDocument/references":
                        params["context"] = {"includeDeclaration": True}
                # Keep synchronization serialized through the response: a result
                # always belongs to the requested document version.
                result = await self.server.request(operation.method, params)
                return {**self.snapshot(document), "result": result}
            return self.snapshot(document)

    async def _change(self, document: Document, previous: str) -> None:
        sync = self.server.capabilities.get("textDocumentSync", 0)
        kind = sync.get("change", 0) if isinstance(sync, dict) else sync
        change: dict[str, Any] = {"text": document.text}
        if kind == 2:
            lines = previous.split("\n")
            change["range"] = {
                "start": {"line": 0, "character": 0},
                "end": {
                    "line": len(lines) - 1,
                    "character": len(lines[-1].encode("utf-16-le")) // 2,
                },
            }
        elif kind != 1:
            raise LanguageServerError("Server does not advertise document change synchronization")
        await self.server.notify(
            "textDocument/didChange",
            {
                "textDocument": {"uri": document.uri, "version": document.version},
                "contentChanges": [change],
            },
        )

    def snapshot(self, document: Document) -> dict[str, Any]:
        return {
            "document_path": str(
                Path(unquote(urlparse(document.uri).path)).relative_to(self.root)
            ),
            "root": str(self.root),
            "generation": self.generation,
            "status": self.server.status,
            "message": self.server.message,
            "capabilities": self.server.capabilities,
            "version": document.version,
            "diagnostics": list(self.diagnostics.values()),
        }

    async def close(self) -> None:
        self.closed = True
        self.start_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.start_task
        if self.expiry_task is not None and self.expiry_task is not asyncio.current_task():
            self.expiry_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.expiry_task
        async with self.lock:
            self.documents.clear()
            self.diagnostics.clear()
            await self.server.close()


class SessionLanguageServices:
    """Own workspace services for one runner; never share buffers between sessions."""

    def __init__(self, *, lease_seconds: float = 60) -> None:
        self.services: dict[tuple[str, str, str], WorkspaceLanguageService] = {}
        self.lease_seconds = lease_seconds
        self.lock = asyncio.Lock()
        self.closed = False
        self._closing_sessions: set[str] = set()

    async def operate(
        self, session_id: str, environment: OSEnvironment, operation: LanguageOperation
    ) -> dict[str, Any]:
        if not isinstance(environment, CallerProcessOSEnvironment):
            raise LanguageServerError(
                "This workspace environment does not support LSP process execution"
            )
        root = environment.cwd.resolve()
        if str(root) != operation.root or not root.is_dir():
            for stale_key, stale_service in list(self.services.items()):
                if stale_key[0] == session_id and (stale_key[1] != str(root) or not root.is_dir()):
                    await self._remove(stale_key, stale_service)
            raise LanguageServerError(
                "Workspace root changed or disappeared. Reopen the file and start LSP again."
            )
        key = (session_id, str(root), operation.language)
        async with self.lock:
            if self.closed or session_id in self._closing_sessions:
                raise LanguageServerError("Workspace runner is stopping")
            service = self.services.get(key)
            if service is None:
                if operation.action != "attach":
                    if operation.action == "detach":
                        return {"status": "stopped"}
                    raise LanguageServerError("Language server stopped. Start it again.")
                service = WorkspaceLanguageService(environment, operation)
                self.services[key] = service
                service.expiry_task = asyncio.create_task(self._expire(key, service))
            elif operation.action == "attach" and (
                operation.command != service.server.command
                or operation.settings != service.server.settings
            ):
                raise LanguageServerError(
                    "Stop existing LSP editors before changing workspace server configuration"
                )
            service.active_operations += 1
        try:
            return await service.operate(operation)
        finally:
            async with self.lock:
                service.active_operations -= 1
            await self._remove(key, service, only_if_unused=True)

    async def _remove(
        self,
        key: tuple[str, str, str],
        service: WorkspaceLanguageService,
        *,
        only_if_unused: bool = False,
    ) -> bool:
        async with self.lock:
            if self.services.get(key) is not service:
                return False
            if only_if_unused and (service.active_operations or service.documents):
                return False
            self.services.pop(key)
            service.closed = True
        await service.close()
        return True

    async def _expire(self, key: tuple[str, str, str], service: WorkspaceLanguageService) -> None:
        while True:
            await asyncio.sleep(min(self.lease_seconds, 10))
            async with service.lock:
                stale_tokens = [
                    token
                    for token, doc in service.documents.items()
                    if time.monotonic() - doc.last_used > self.lease_seconds
                ]
                for token in stale_tokens:
                    document = service.documents.pop(token)
                    service.diagnostics.pop(document.uri, None)
                    if document.opened and service.server.status in {
                        "ready",
                        "indexing",
                        "degraded",
                    }:
                        with contextlib.suppress(LanguageServerError, OSError):
                            await service.server.notify(
                                "textDocument/didClose", {"textDocument": {"uri": document.uri}}
                            )
            if await self._remove(key, service, only_if_unused=True):
                return

    async def cleanup_session(self, session_id: str) -> None:
        async with self.lock:
            self._closing_sessions.add(session_id)
        try:
            for key, service in list(self.services.items()):
                if key[0] == session_id:
                    await self._remove(key, service)
        finally:
            async with self.lock:
                self._closing_sessions.discard(session_id)

    async def close(self) -> None:
        self.closed = True
        for key, service in list(self.services.items()):
            await self._remove(key, service)
