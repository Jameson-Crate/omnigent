"""Deterministic stdio peer for the language-server process boundary tests."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def send(payload: dict[str, Any]) -> None:
    encoded = json.dumps({"jsonrpc": "2.0", **payload}).encode()
    sys.stdout.buffer.write(f"Content-Length: {len(encoded)}\r\n\r\n".encode() + encoded)
    sys.stdout.buffer.flush()


def main() -> None:
    log = Path(sys.argv[1])
    mode = sys.argv[2] if len(sys.argv) > 2 else "full"
    documents: dict[str, str] = {}
    while True:
        headers = {}
        while line := sys.stdin.buffer.readline():
            if line == b"\r\n":
                break
            key, value = line.split(b":", 1)
            headers[key.lower()] = value.strip()
        if not line:
            return
        payload = json.loads(sys.stdin.buffer.read(int(headers[b"content-length"])))
        with log.open("a") as output:
            output.write(json.dumps(payload) + "\n")
        method = payload.get("method")
        if method is None:
            continue
        params = payload.get("params", {})
        request_id = payload.get("id")
        result: Any = None
        if method == "initialize":
            if mode == "fail":
                send(
                    {
                        "id": request_id,
                        "error": {"code": -32001, "message": "fixture initialization rejected"},
                    }
                )
                continue
            result = {
                "capabilities": {
                    "textDocumentSync": {
                        "openClose": True,
                        "change": 2 if mode == "incremental" else 1,
                        "save": {"includeText": True}
                        if mode == "incremental"
                        else mode != "no-save",
                    },
                    "hoverProvider": True,
                    "definitionProvider": True,
                    "referencesProvider": True,
                    "documentSymbolProvider": True,
                    "documentFormattingProvider": mode != "no-format",
                }
            }
        elif method == "initialized":
            if mode == "crash":
                print("fixture startup crash", file=sys.stderr, flush=True)
                return
            send(
                {
                    "id": "config-1",
                    "method": "workspace/configuration",
                    "params": {"items": [{"section": "rust-analyzer"}]},
                }
            )
            send(
                {
                    "method": "$/progress",
                    "params": {
                        "token": "index",
                        "value": {"kind": "begin", "title": "Indexing fixture"},
                    },
                }
            )
        elif method in {"textDocument/didOpen", "textDocument/didChange"}:
            document = params["textDocument"]
            text = document.get("text", params.get("contentChanges", [{}])[0].get("text", ""))
            documents[document["uri"]] = text
            send(
                {
                    "method": "textDocument/publishDiagnostics",
                    "params": {
                        "uri": document["uri"],
                        "version": document["version"],
                        "diagnostics": [
                            {
                                "range": {
                                    "start": {"line": 0, "character": 0},
                                    "end": {"line": 0, "character": 2},
                                },
                                "severity": 1,
                                "message": "fixture diagnostic: " + text,
                            }
                        ],
                    },
                }
            )
            send({"method": "$/progress", "params": {"token": "index", "value": {"kind": "end"}}})
        elif method == "textDocument/didClose":
            documents.pop(params["textDocument"]["uri"], None)
        elif method == "textDocument/hover":
            if mode == "hang":
                continue
            result = {"contents": {"kind": "markdown", "value": "fixture hover"}}
        elif method in {"textDocument/definition", "textDocument/references"}:
            result = [
                {
                    "uri": params["textDocument"]["uri"],
                    "range": {
                        "start": {"line": 0, "character": 0},
                        "end": {"line": 0, "character": 2},
                    },
                }
            ]
        elif method == "textDocument/documentSymbol":
            result = [
                {
                    "name": "main",
                    "kind": 12,
                    "range": {
                        "start": {"line": 0, "character": 0},
                        "end": {"line": 0, "character": 2},
                    },
                    "selectionRange": {
                        "start": {"line": 0, "character": 0},
                        "end": {"line": 0, "character": 2},
                    },
                }
            ]
        elif method == "textDocument/formatting":
            result = [
                {
                    "range": {
                        "start": {"line": 0, "character": 0},
                        "end": {"line": 0, "character": 0},
                    },
                    "newText": "// formatted\n",
                }
            ]
        elif method == "exit":
            return
        if request_id is not None:
            send({"id": request_id, "result": result})


if __name__ == "__main__":
    main()
