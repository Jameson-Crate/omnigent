import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/identity";
import type * as HostModule from "@/lib/host";
import type { CodeEditorInstance } from "./useMonacoCommentLayer";
import { LanguageTools } from "./LanguageTools";
import type { LanguageSnapshot } from "./languageClient";

const mocks = vi.hoisted(() => ({
  markers: vi.fn(),
  hover: vi.fn(),
  disposeHover: vi.fn(),
  openFile: vi.fn(),
}));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof HostModule>()),
  getOmnigentServerIdentity: () => "test-server",
}));
vi.mock("./FileViewerContext", async () => {
  const { createContext } = await import("react");
  return {
    FileViewerContext: createContext(null),
    useFileViewer: () => mocks.openFile,
    useWorkspacePaths: () => ({ root: "/worktree" }),
  };
});
// Like the source editor tests, use only the Monaco API driven by these controls.
vi.mock("./monacoSetup", () => ({
  monaco: {
    editor: { setModelMarkers: mocks.markers },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
    languages: { registerHoverProvider: mocks.hover },
    KeyCode: { F12: 123 },
    KeyMod: { Shift: 1024 },
  },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("clears markers, outline, locations and hover after a successful poll reports server failure", async () => {
  vi.useFakeTimers();
  localStorage.clear();
  mocks.hover.mockReturnValue({ dispose: mocks.disposeHover });
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } };
  const snapshot: LanguageSnapshot = {
    root: "/worktree",
    generation: "one",
    status: "ready",
    message: "Ready",
    version: 1,
    document_path: "main.rs",
    capabilities: {
      hoverProvider: true,
      documentSymbolProvider: true,
      referencesProvider: true,
      definitionProvider: true,
    },
    diagnostics: [
      {
        path: "main.rs",
        version: 1,
        diagnostics: [{ range, severity: 1, message: "type mismatch" }],
      },
    ],
  };
  let failed = false;
  vi.mocked(authenticatedFetch).mockImplementation(async (_url, options) => {
    const operation = JSON.parse(String(options?.body));
    const result =
      operation.method === "textDocument/documentSymbol"
        ? [{ name: "main symbol", range }]
        : [{ uri: "file:///worktree/main.rs", range }];
    return {
      ok: true,
      json: async () => ({ ...snapshot, status: failed ? "failed" : "ready", result }),
    } as Response;
  });
  const model = {
    getValue: () => "fn main() {}",
    getVersionId: () => 1,
    isDisposed: () => false,
    getLanguageId: () => "rust",
    getOptions: () => ({ tabSize: 4, insertSpaces: true }),
    onDidChangeContent: () => ({ dispose: vi.fn() }),
  };
  const editor = {
    getModel: () => model,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    addAction: () => ({ dispose: vi.fn() }),
  } as unknown as CodeEditorInstance;
  render(
    <LanguageTools
      sessionId="one"
      path="main.rs"
      editorRef={{ current: editor }}
      mounted
      canEdit
      savedText="fn main() {}"
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByText("Start Rust language server"));
  });
  expect(screen.getByRole("status").textContent).toContain("ready");
  expect(mocks.markers.mock.lastCall?.[2]).toHaveLength(1);
  await act(async () => {
    fireEvent.click(screen.getByText("Definition"));
  });
  expect(mocks.openFile).toHaveBeenCalledWith("main.rs", { line: 1, column: 1 });
  await act(async () => {
    fireEvent.click(screen.getByText("Outline"));
  });
  await act(async () => {
    fireEvent.click(screen.getByText("References"));
  });
  expect(screen.getByText("main symbol")).toBeTruthy();
  expect(screen.getByText("Locations")).toBeTruthy();
  failed = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByRole("status").textContent).toContain("failed");
  expect(mocks.markers.mock.lastCall?.[2]).toEqual([]);
  expect(screen.queryByText("Diagnostics")).toBeNull();
  expect(screen.queryByText("main symbol")).toBeNull();
  expect(screen.queryByText("Locations")).toBeNull();
  expect(mocks.disposeHover).toHaveBeenCalled();
});
