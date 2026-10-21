import { authenticatedFetch } from "@/lib/identity";
import { getBasePath } from "@/lib/basePath";
import { getOmnigentServerIdentity } from "@/lib/host";

export interface LanguagePosition {
  line: number;
  character: number;
}
export interface LanguageRange {
  start: LanguagePosition;
  end: LanguagePosition;
}
export interface LanguageDiagnostic {
  range: LanguageRange;
  message: string;
  severity?: number;
}
export interface LanguageLocation {
  uri: string;
  range: LanguageRange;
}
export interface LanguageSymbol {
  name: string;
  range?: LanguageRange;
  selectionRange?: LanguageRange;
  location?: LanguageLocation;
  children?: LanguageSymbol[];
}
export interface LanguageEdit {
  range: LanguageRange;
  newText: string;
}
export interface LanguageSnapshot {
  root: string;
  generation: string;
  status: "starting" | "ready" | "indexing" | "degraded" | "failed" | "stopped";
  message: string;
  capabilities: Record<string, unknown>;
  version: number;
  document_path: string;
  diagnostics: { path: string; version: number | null; diagnostics: LanguageDiagnostic[] }[];
  result?: unknown;
}
export interface LanguageConfiguration {
  command: string[];
  settings: Record<string, unknown>;
}

/** One editor attachment. Serializes unsaved buffers before requests and fences late responses. */
export class LanguageClient {
  readonly token = crypto.randomUUID();
  private version = 1;
  private text: string;
  private pendingSynchronization: { text: string; version: number } | null = null;
  private savedVersion: number | null = null;
  private closed = false;
  private generation: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  readonly endpoint: string;
  readonly sessionId: string;
  readonly root: string;
  readonly path: string;
  readonly configuration: LanguageConfiguration;

  constructor(
    sessionId: string,
    root: string,
    path: string,
    text: string,
    configuration: LanguageConfiguration,
    persistedText?: string,
  ) {
    this.sessionId = sessionId;
    this.root = root;
    this.path = path;
    this.configuration = configuration;
    this.text = text;
    // Opening unchanged disk content is not a save event.
    this.savedVersion = persistedText === text ? this.version : null;
    this.endpoint = `/v1/sessions/${encodeURIComponent(sessionId)}/resources/environments/default/language-server`;
  }

  private async send(
    action: string,
    fields: Record<string, unknown> = {},
  ): Promise<LanguageSnapshot> {
    const response = await authenticatedFetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        root: this.root,
        language: "rust",
        token: this.token,
        ...fields,
      }),
    });
    const payload = await response.json();
    if (!response.ok)
      throw new Error(
        payload.error?.message ??
          payload.detail ??
          `LSP request failed (${response.status}); reconnect the workspace host.`,
      );
    if (action === "detach") return payload as LanguageSnapshot;
    if (
      this.closed ||
      payload.root !== this.root ||
      (this.generation && payload.generation !== this.generation)
    ) {
      throw new Error("Workspace changed; start LSP in the current workspace again.");
    }
    this.generation = payload.generation;
    return payload as LanguageSnapshot;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => {
      if (this.closed) throw new Error("LSP editor closed");
      return operation();
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  attach(): Promise<LanguageSnapshot> {
    return this.enqueue(() =>
      this.send("attach", {
        path: this.path,
        text: this.text,
        version: this.version,
        ...this.configuration,
      }),
    );
  }

  synchronize(text: string): Promise<LanguageSnapshot | null> {
    return this.enqueue(async () => {
      let snapshot: LanguageSnapshot | null = null;
      while (this.pendingSynchronization || text !== this.text) {
        // A lost response may follow a committed write. Acknowledge it before newer text.
        const pending = this.pendingSynchronization ?? { text, version: this.version + 1 };
        this.pendingSynchronization = pending;
        // Each acknowledgement establishes the version for the next write.
        // eslint-disable-next-line no-await-in-loop
        snapshot = await this.send("sync", pending);
        this.version = pending.version;
        this.text = pending.text;
        this.pendingSynchronization = null;
      }
      return snapshot;
    });
  }

  poll(): Promise<LanguageSnapshot> {
    return this.enqueue(() => this.send("poll"));
  }

  /** Acknowledge persisted content only while it matches the synchronized buffer. */
  saved(text: string): Promise<void> {
    return this.enqueue(async () => {
      if (text !== this.text || this.version === this.savedVersion) return;
      await this.send("save", { text, version: this.version });
      this.savedVersion = this.version;
    });
  }

  request(
    method: string,
    position?: LanguagePosition,
    options: Record<string, unknown> = {},
  ): Promise<LanguageSnapshot> {
    return this.enqueue(() => this.send("request", { method, ...position, ...options }));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    await this.send("detach");
  }
}

/** Convert file URIs only; server results never become arbitrary external links. */
export function languageLocationPath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "file:" && !parsed.host ? decodeURIComponent(parsed.pathname) : null;
  } catch {
    return null;
  }
}

/** Browser-local defaults are scoped by server URL, root and language; no project files execute. */
export function languageConfigurationKey(root: string, host: string): string | null {
  const server = getOmnigentServerIdentity();
  return server
    ? `omnigent:lsp:${JSON.stringify([server, getBasePath(), host, root, "rust"])}`
    : null;
}

export function readLanguageConfiguration(root: string, host: string): LanguageConfiguration {
  try {
    const key = languageConfigurationKey(root, host);
    const stored: unknown = JSON.parse(key ? (localStorage.getItem(key) ?? "null") : "null");
    return parseLanguageConfiguration(stored);
  } catch {
    return { command: ["rust-analyzer"], settings: {} };
  }
}

export function parseLanguageConfiguration(value: unknown): LanguageConfiguration {
  const config = value as Partial<LanguageConfiguration> | null;
  if (
    !config ||
    !Array.isArray(config.command) ||
    !config.command.length ||
    config.command.some((part) => typeof part !== "string" || !part) ||
    !config.settings ||
    typeof config.settings !== "object" ||
    Array.isArray(config.settings)
  ) {
    throw new Error(
      'Use {"command":["rust-analyzer"],"settings":{}} with a nonempty executable/argument array.',
    );
  }
  return { command: config.command, settings: config.settings };
}
