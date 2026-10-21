import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/identity";
import { getOmnigentServerIdentity } from "@/lib/host";
import {
  LanguageClient,
  languageConfigurationKey,
  languageLocationPath,
  parseLanguageConfiguration,
  readLanguageConfiguration,
  type LanguageSnapshot,
} from "./languageClient";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/lib/host", () => ({ getOmnigentServerIdentity: vi.fn() }));

const configuration = { command: ["rust-analyzer"], settings: {} };
const snapshot: LanguageSnapshot = {
  root: "/worktree",
  generation: "generation-1",
  status: "ready",
  message: "Ready",
  capabilities: { hoverProvider: true },
  version: 1,
  document_path: "main.rs",
  diagnostics: [],
};

function response(value: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => value } as Response;
}

function client() {
  return new LanguageClient("session/one", "/worktree", "main.rs", "fn main() {}", configuration);
}

beforeEach(() => {
  vi.mocked(authenticatedFetch).mockReset();
  vi.mocked(authenticatedFetch).mockResolvedValue(response(snapshot));
  localStorage.clear();
  vi.mocked(getOmnigentServerIdentity).mockReturnValue("server-one");
  delete window.__OMNIGENT_BASE_PATH__;
});

describe("language editor attachment", () => {
  it("does not synthesize a save when opening unchanged persisted content", async () => {
    const connection = new LanguageClient(
      "session/one",
      "/worktree",
      "main.rs",
      "disk",
      configuration,
      "disk",
    );
    await connection.attach();
    await connection.saved("disk");
    expect(vi.mocked(authenticatedFetch).mock.calls).toHaveLength(1);
    await connection.synchronize("edited");
    await connection.saved("edited");
    const actions = vi
      .mocked(authenticatedFetch)
      .mock.calls.map(([, options]) => JSON.parse(String(options?.body)).action);
    expect(actions).toEqual(["attach", "sync", "save"]);
  });

  it("notifies saves only for the persisted synchronized version, including undo", async () => {
    const connection = client();
    await connection.attach();
    await connection.saved("fn main() {}");
    await connection.saved("fn main() {}");
    await connection.synchronize("unsaved text");
    await connection.saved("fn main() {}");
    await connection.synchronize("fn main() {}");
    await connection.saved("fn main() {}");
    const saves = vi
      .mocked(authenticatedFetch)
      .mock.calls.map(([, options]) => JSON.parse(String(options?.body)))
      .filter((operation) => operation.action === "save");
    expect(saves.map((operation) => operation.version)).toEqual([1, 3]);
  });
  it("serializes document changes before navigation requests", async () => {
    const connection = client();
    await connection.attach();
    let release!: (value: Response) => void;
    vi.mocked(authenticatedFetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const sync = connection.synchronize("changed buffer");
    const navigation = connection.request("textDocument/definition", { line: 2, character: 4 });
    await Promise.resolve();
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    release(response({ ...snapshot, version: 2 }));
    await sync;
    await navigation;
    const requests = vi
      .mocked(authenticatedFetch)
      .mock.calls.map(([, options]) => JSON.parse(String(options?.body)));
    expect(requests.map((request) => request.action)).toEqual(["attach", "sync", "request"]);
    expect(requests[1]).toMatchObject({ text: "changed buffer", version: 2, root: "/worktree" });
    expect(requests[2]).toMatchObject({ method: "textDocument/definition", line: 2, character: 4 });
    expect(vi.mocked(authenticatedFetch).mock.calls[0][0]).toContain("session%2Fone");
  });

  it("keeps a failed synchronization retryable at the same version", async () => {
    const connection = client();
    await connection.attach();
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(
      response({ error: { message: "host offline" } }, 503),
    );
    await expect(connection.synchronize("new buffer")).rejects.toThrow("host offline");
    await connection.synchronize("new buffer");
    const writes = vi
      .mocked(authenticatedFetch)
      .mock.calls.slice(1)
      .map(([, options]) => JSON.parse(String(options?.body)));
    expect(writes.map((write) => write.version)).toEqual([2, 2]);
  });

  it.each([{ root: "/other-worktree" }, { generation: "new-server" }])(
    "rejects results from a different workspace generation: %j",
    async (changed) => {
      const connection = client();
      await connection.attach();
      vi.mocked(authenticatedFetch).mockResolvedValueOnce(response({ ...snapshot, ...changed }));
      await expect(connection.poll()).rejects.toThrow("Workspace changed");
    },
  );

  it("acknowledges a lost synchronization response before sending newer text", async () => {
    const connection = client();
    await connection.attach();
    let serverVersion = 1;
    let serverText = "fn main() {}";
    let loseResponse = true;
    vi.mocked(authenticatedFetch).mockImplementation(async (_url, options) => {
      const write = JSON.parse(String(options?.body));
      if (
        write.version < serverVersion ||
        (write.version === serverVersion && write.text !== serverText)
      ) {
        return response({ error: { message: "Stale document version" } }, 409);
      }
      serverVersion = write.version;
      serverText = write.text;
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost after commit");
      }
      return response({ ...snapshot, version: serverVersion });
    });
    await expect(connection.synchronize("buffer A")).rejects.toThrow("response lost");
    await connection.synchronize("buffer B");
    const writes = vi
      .mocked(authenticatedFetch)
      .mock.calls.slice(1)
      .map(([, options]) => JSON.parse(String(options?.body)));
    expect(writes.map(({ version, text }) => ({ version, text }))).toEqual([
      { version: 2, text: "buffer A" },
      { version: 2, text: "buffer A" },
      { version: 3, text: "buffer B" },
    ]);
    expect(serverText).toBe("buffer B");
  });

  it("detaches even when an attachment response arrives after the editor closes", async () => {
    let release!: (value: Response) => void;
    vi.mocked(authenticatedFetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const connection = client();
    const attach = connection.attach();
    await Promise.resolve();
    const rejected = expect(attach).rejects.toThrow("Workspace changed");
    const close = connection.close();
    release(response(snapshot));
    await rejected;
    await close;
    const [, options] = vi.mocked(authenticatedFetch).mock.calls[1];
    expect(JSON.parse(String(options?.body)).action).toBe("detach");
    await expect(connection.poll()).rejects.toThrow("closed");
  });
});

describe("workspace configuration and locations", () => {
  it("scopes browser configuration by server base path, host and root", () => {
    const first = languageConfigurationKey("/worktree", "host-one");
    expect(languageConfigurationKey("/worktree", "host-two")).not.toBe(first);
    expect(languageConfigurationKey("/other", "host-one")).not.toBe(first);
    vi.mocked(getOmnigentServerIdentity).mockReturnValue("server-two");
    expect(languageConfigurationKey("/worktree", "host-one")).not.toBe(first);
    vi.mocked(getOmnigentServerIdentity).mockReturnValue("server-one");
    window.__OMNIGENT_BASE_PATH__ = "/another-server";
    expect(languageConfigurationKey("/worktree", "host-one")).not.toBe(first);
    const alternate = { command: ["/tools/rust-analyzer"], settings: { checkOnSave: false } };
    localStorage.setItem(
      languageConfigurationKey("/worktree", "host-one")!,
      JSON.stringify(alternate),
    );
    expect(readLanguageConfiguration("/worktree", "host-one")).toEqual(alternate);
    expect(readLanguageConfiguration("/worktree", "host-two")).toEqual(configuration);
  });

  it("does not reuse persisted configuration for an unidentified embedded backend", () => {
    localStorage.setItem(
      languageConfigurationKey("/worktree", "host-one")!,
      JSON.stringify({ command: ["private-server"], settings: {} }),
    );
    vi.mocked(getOmnigentServerIdentity).mockReturnValue(null);
    expect(languageConfigurationKey("/worktree", "host-one")).toBeNull();
    expect(readLanguageConfiguration("/worktree", "host-one")).toEqual(configuration);
  });

  it.each([
    null,
    {},
    { command: [], settings: {} },
    { command: [42], settings: {} },
    { command: ["rust-analyzer"], settings: [] },
  ])("rejects malformed configuration: %j", (value) => {
    expect(() => parseLanguageConfiguration(value)).toThrow("executable/argument array");
  });

  it.each([
    ["file:///worktree/src/a%20b.rs", "/worktree/src/a b.rs"],
    ["https://example.com/file.rs", null],
    ["file://other-host/file.rs", null],
    ["not a URI", null],
  ])("converts file-only navigation: %s", (uri, expected) => {
    expect(languageLocationPath(uri!)).toBe(expected);
  });
});
