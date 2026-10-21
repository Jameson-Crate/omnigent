import { useCallback, useContext, useEffect, useRef, useState, type RefObject } from "react";
import { monaco } from "./monacoSetup";
import { relativizeToWorkspace } from "@/hooks/useWorkspaceChangedFiles";
import { FileViewerContext, useFileViewer, useWorkspacePaths } from "./FileViewerContext";
import type { CodeEditorInstance } from "./useMonacoCommentLayer";
import {
  LanguageClient,
  languageConfigurationKey,
  languageLocationPath,
  parseLanguageConfiguration,
  readLanguageConfiguration,
  type LanguageConfiguration,
  type LanguageEdit,
  type LanguageLocation,
  type LanguagePosition,
  type LanguageRange,
  type LanguageSnapshot,
  type LanguageSymbol,
} from "./languageClient";

function editorRange(range: LanguageRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function flattenSymbols(symbols: LanguageSymbol[]): LanguageSymbol[] {
  return symbols.flatMap((symbol) => [symbol, ...flattenSymbols(symbol.children ?? [])]);
}

function locations(result: unknown): LanguageLocation[] {
  const items = Array.isArray(result) ? result : result ? [result] : [];
  return items.map((item) =>
    "targetUri" in item
      ? { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange }
      : (item as LanguageLocation),
  );
}

/** Rust controls on the shared source editor, including mobile and embedded surfaces. */
export function LanguageTools(props: {
  sessionId: string;
  path: string;
  editorRef: RefObject<CodeEditorInstance | null>;
  mounted: boolean;
  canEdit: boolean;
  /** Latest persisted file content; unsaved buffers must never emit didSave. */
  savedText: string;
}) {
  const { root } = useWorkspacePaths();
  const host = useContext(FileViewerContext)?.sessionHostId ?? `session:${props.sessionId}`;
  if (!root) return null;
  return (
    <WorkspaceLanguageTools
      key={`${props.sessionId}:${host}:${root}:${props.path}`}
      {...props}
      root={root}
      host={host}
    />
  );
}

function WorkspaceLanguageTools({
  sessionId,
  root,
  host,
  path,
  editorRef,
  mounted,
  canEdit,
  savedText,
}: {
  sessionId: string;
  root: string;
  host: string;
  path: string;
  editorRef: RefObject<CodeEditorInstance | null>;
  mounted: boolean;
  canEdit: boolean;
  savedText: string;
}) {
  const openFile = useFileViewer();
  const [configuration, setConfiguration] = useState<LanguageConfiguration>(() =>
    readLanguageConfiguration(root, host),
  );
  const [configurationText, setConfigurationText] = useState(() =>
    JSON.stringify(configuration, null, 2),
  );
  const [enabled, setEnabled] = useState(false);
  const [snapshot, setSnapshot] = useState<LanguageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [symbols, setSymbols] = useState<LanguageSymbol[]>([]);
  const [references, setReferences] = useState<LanguageLocation[]>([]);
  const clientRef = useRef<LanguageClient | null>(null);
  const savedTextRef = useRef(savedText);
  savedTextRef.current = savedText;

  const navigate = useCallback(
    (location: LanguageLocation) => {
      const target = languageLocationPath(location.uri);
      if (target) {
        const relative = relativizeToWorkspace(target, root);
        const destination = relative === relativizeToWorkspace(path, root) ? path : relative;
        openFile?.(destination, {
          line: location.range.start.line + 1,
          column: location.range.start.character + 1,
        });
      }
    },
    [openFile, root, path],
  );

  const request = useCallback(
    async (method: string, position?: LanguagePosition, options?: Record<string, unknown>) => {
      const client = clientRef.current;
      const model = editorRef.current?.getModel();
      if (!client || !model) throw new Error("Start the language server first.");
      const version = model.getVersionId();
      await client.synchronize(model.getValue());
      const result = await client.request(method, position, options);
      if (clientRef.current !== client || model.isDisposed() || model.getVersionId() !== version) {
        throw new Error("Document changed while the request was running. Try again.");
      }
      return result.result;
    },
    [editorRef],
  );

  useEffect(() => {
    if (!enabled || !mounted) return;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!model) return;
    const client = new LanguageClient(
      sessionId,
      root,
      path,
      model.getValue(),
      configuration,
      savedTextRef.current,
    );
    clientRef.current = client;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let syncTimer: ReturnType<typeof setTimeout> | undefined;
    setError(null);
    setSnapshot(null);
    const poll = async () => {
      const version = model.getVersionId();
      try {
        await client.synchronize(model.getValue());
        const next = await client.poll();
        if (
          ["ready", "indexing", "degraded"].includes(next.status) &&
          savedTextRef.current === model.getValue()
        ) {
          await client.saved(savedTextRef.current);
        }
        if (!disposed && !model.isDisposed() && model.getVersionId() === version) {
          if (next.status === "failed" || next.status === "stopped") {
            setSnapshot({ ...next, diagnostics: [] });
            setSymbols([]);
            setReferences([]);
            monaco.editor.setModelMarkers(model, client.token, []);
            return;
          }
          setSnapshot(next);
          const diagnostics = next.diagnostics.find((entry) => entry.path === next.document_path);
          monaco.editor.setModelMarkers(
            model,
            client.token,
            diagnostics?.diagnostics.map((diagnostic) => ({
              ...editorRange(diagnostic.range),
              message: diagnostic.message,
              severity:
                diagnostic.severity === 1
                  ? monaco.MarkerSeverity.Error
                  : diagnostic.severity === 2
                    ? monaco.MarkerSeverity.Warning
                    : monaco.MarkerSeverity.Info,
            })) ?? [],
          );
        }
      } catch (failure) {
        if (!disposed) {
          setError(`${String(failure)} Reconnect the workspace host or stop and start LSP.`);
          setSnapshot((current) =>
            current ? { ...current, status: "degraded", diagnostics: [] } : current,
          );
          setSymbols([]);
          setReferences([]);
          if (!model.isDisposed()) monaco.editor.setModelMarkers(model, client.token, []);
        }
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void client
      .attach()
      .then(() => {
        if (!disposed) void poll();
      })
      .catch((failure) => {
        if (!disposed) setError(String(failure));
      });
    const change = model.onDidChangeContent(() => {
      monaco.editor.setModelMarkers(model, client.token, []);
      setSymbols([]);
      setReferences([]);
      setSnapshot((current) => (current ? { ...current, diagnostics: [] } : current));
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        void client.synchronize(model.getValue()).catch((failure) => {
          if (!disposed) setError(String(failure));
        });
      }, 150);
    });
    return () => {
      disposed = true;
      clientRef.current = null;
      clearTimeout(timer);
      clearTimeout(syncTimer);
      change.dispose();
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, client.token, []);
      void client.close().catch(() => undefined); // The runner lease also covers disconnected browsers.
    };
  }, [enabled, mounted, sessionId, root, path, configuration, editorRef]);

  const capabilities = snapshot?.capabilities;
  const status = snapshot?.status;
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (
      !enabled ||
      !model ||
      !capabilities?.hoverProvider ||
      !status ||
      !["ready", "indexing", "degraded"].includes(status)
    )
      return;
    const hover = monaco.languages.registerHoverProvider(model.getLanguageId(), {
      provideHover: async (target, position, token) => {
        if (target !== model || token.isCancellationRequested) return null;
        try {
          const result = (await request("textDocument/hover", {
            line: position.lineNumber - 1,
            character: position.column - 1,
          })) as {
            contents:
              | string
              | { value: string; language?: string }
              | (string | { value: string; language?: string })[];
            range?: LanguageRange;
          } | null;
          if (!result || token.isCancellationRequested) return null;
          const content = Array.isArray(result.contents) ? result.contents : [result.contents];
          return {
            contents: content.map((item) => ({
              value:
                typeof item === "string"
                  ? item
                  : item.language
                    ? `\`\`\`${item.language}\n${item.value}\n\`\`\``
                    : item.value,
              isTrusted: false,
              supportHtml: false,
            })),
            range: result.range ? editorRange(result.range) : undefined,
          };
        } catch (failure) {
          setError(String(failure));
          return null;
        }
      },
    });
    return () => hover.dispose();
  }, [enabled, capabilities, status, request, editorRef]);

  const perform = useCallback(
    async (method: string) => {
      setError(null);
      const editor = editorRef.current;
      const position = editor?.getPosition();
      if (!editor || !position) return;
      try {
        const model = editor.getModel();
        const options = model?.getOptions();
        const result = await request(
          method,
          { line: position.lineNumber - 1, character: position.column - 1 },
          { tab_size: options?.tabSize ?? 4, insert_spaces: options?.insertSpaces ?? true },
        );
        if (method === "textDocument/definition") {
          const targets = locations(result);
          if (targets.length === 1) navigate(targets[0]);
          else setReferences(targets);
        } else if (method === "textDocument/references") setReferences(locations(result));
        else if (method === "textDocument/documentSymbol")
          setSymbols(flattenSymbols((result ?? []) as LanguageSymbol[]));
        else if (
          method === "textDocument/formatting" &&
          canEdit &&
          !editor.getOption(monaco.editor.EditorOption.readOnly)
        ) {
          editor.pushUndoStop();
          editor.executeEdits(
            "language-server-format",
            ((result ?? []) as LanguageEdit[]).map((edit) => ({
              range: editorRange(edit.range),
              text: edit.newText,
            })),
          );
          editor.pushUndoStop();
        }
      } catch (failure) {
        setError(String(failure));
      }
    },
    [request, navigate, canEdit, editorRef],
  );

  useEffect(() => {
    const editor = editorRef.current;
    if (!enabled || !mounted || !editor) return;
    const actions = [
      editor.addAction({
        id: "omnigent.lsp.definition",
        label: "LSP: Go to Definition",
        keybindings: [monaco.KeyCode.F12],
        run: () => perform("textDocument/definition"),
      }),
      editor.addAction({
        id: "omnigent.lsp.references",
        label: "LSP: Find References",
        keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
        run: () => perform("textDocument/references"),
      }),
    ];
    return () => actions.forEach((action) => action.dispose());
  }, [enabled, mounted, editorRef, perform]);

  const ready =
    enabled && !!snapshot && ["ready", "indexing", "degraded"].includes(snapshot.status);
  return (
    <div
      className="shrink-0 border-b border-border px-3 py-2 text-xs max-h-64 overflow-auto"
      aria-label="Rust language tools"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span role="status">
          Rust LSP: {enabled ? (snapshot?.status ?? "starting") : "stopped"}
        </span>
        <button
          type="button"
          disabled={!mounted}
          onClick={() => {
            setEnabled(!enabled);
            setSnapshot(null);
            setSymbols([]);
            setReferences([]);
            setError(null);
          }}
        >
          {enabled ? "Stop language server" : "Start Rust language server"}
        </button>
        {(
          [
            ["Definition", "textDocument/definition", "definitionProvider"],
            ["References", "textDocument/references", "referencesProvider"],
            ["Outline", "textDocument/documentSymbol", "documentSymbolProvider"],
            ["Format", "textDocument/formatting", "documentFormattingProvider"],
          ] as const
        ).map(([label, method, capability]) => (
          <button
            type="button"
            key={label}
            title={
              capabilities?.[capability]
                ? label
                : `Server does not advertise ${label.toLowerCase()}`
            }
            disabled={!ready || !capabilities?.[capability] || (label === "Format" && !canEdit)}
            onClick={() => void perform(method)}
          >
            {label}
          </button>
        ))}
      </div>
      {!enabled && (
        <p>
          Starting runs rust-analyzer on the workspace host; Cargo may execute build scripts. Root:{" "}
          <code>{root}</code>.
        </p>
      )}
      {snapshot?.message && <p>{snapshot.message}</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <details>
        <summary>Server configuration for this workspace</summary>
        <textarea
          aria-label="Language server configuration"
          className="w-full min-h-24 font-mono"
          value={configurationText}
          disabled={enabled}
          onChange={(event) => setConfigurationText(event.target.value)}
        />
        <button
          type="button"
          disabled={enabled}
          onClick={() => {
            try {
              const next = parseLanguageConfiguration(JSON.parse(configurationText));
              setConfiguration(next);
              try {
                const key = languageConfigurationKey(root, host);
                if (key) localStorage.setItem(key, JSON.stringify(next));
                else
                  setError(
                    "Configuration applies now. Saving requires a stable backend identity from the embedding host.",
                  );
              } catch {
                setError("Configuration applies now, but browser storage could not save it.");
              }
            } catch (failure) {
              setError(String(failure));
            }
          }}
        >
          Apply configuration
        </button>
      </details>
      {!!snapshot?.diagnostics.some((entry) => entry.diagnostics.length) && (
        <details>
          <summary>Diagnostics</summary>
          {snapshot.diagnostics.flatMap((entry) =>
            entry.diagnostics.map((diagnostic) => (
              <div key={JSON.stringify([entry.path, diagnostic.range, diagnostic.message])}>
                <button
                  type="button"
                  onClick={() =>
                    openFile?.(entry.path, {
                      line: diagnostic.range.start.line + 1,
                      column: diagnostic.range.start.character + 1,
                    })
                  }
                >
                  {entry.path}:{diagnostic.range.start.line + 1}: {diagnostic.message}
                </button>
              </div>
            )),
          )}
        </details>
      )}
      {!!symbols.length && (
        <details open>
          <summary>Outline</summary>
          {symbols.map((symbol) => (
            <div
              key={JSON.stringify([
                symbol.name,
                symbol.location,
                symbol.selectionRange ?? symbol.range,
              ])}
            >
              <button
                type="button"
                onClick={() => {
                  if (symbol.location) navigate(symbol.location);
                  else {
                    const range = symbol.selectionRange ?? symbol.range;
                    if (range)
                      openFile?.(path, {
                        line: range.start.line + 1,
                        column: range.start.character + 1,
                      });
                  }
                }}
              >
                {symbol.name}
              </button>
            </div>
          ))}
        </details>
      )}
      {!!references.length && (
        <details open>
          <summary>Locations</summary>
          {references.map((location) => (
            <div key={JSON.stringify([location.uri, location.range])}>
              <button type="button" onClick={() => navigate(location)}>
                {languageLocationPath(location.uri) ?? "Unavailable file URI"}:
                {location.range.start.line + 1}
              </button>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
