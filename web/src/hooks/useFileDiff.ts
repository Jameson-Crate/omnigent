// Workspace comparisons use an explicit Git revision or the legacy change baseline.
// A null before/after means the file is absent on that side.

import { useQuery } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/identity";
import { isTempConvId } from "@/lib/tempConversationId";
import {
  useWorkspaceChangedFiles,
  useWorkspaceEnvironment,
  useWorkspaceServeable,
} from "@/hooks/useWorkspaceChangedFiles";

// The primary workspace environment is always "default".
const DEFAULT_ENVIRONMENT_ID = "default";

export interface FileDiffResponse {
  object: "session.environment.filesystem.file_diff";
  path: string;
  /** Content at the selected revision or change baseline; null for additions. */
  before: string | null;
  base?: { ref: string; commit: string };
  /** Current file content, or null for deleted files. */
  after: string | null;
}

class FileDiffError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function fetchFileDiff(
  conversationId: string,
  path: string,
  base?: string,
): Promise<FileDiffResponse> {
  // Encode each path segment individually so slashes remain structural.
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url =
    `/v1/sessions/${encodeURIComponent(conversationId)}` +
    `/resources/environments/${DEFAULT_ENVIRONMENT_ID}/diff/${encodedPath}` +
    (base !== undefined ? `?${new URLSearchParams({ base })}` : "");
  const res = await authenticatedFetch(url);
  if (!res.ok) {
    // Surface the server's reason (e.g. "git status timed out after 5.0s")
    // so the diff view shows what actually went wrong rather than a bare
    // status code — mirroring the changed-files panel.
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      // Non-JSON body (gateway/front-door error) — keep the status line.
    }
    throw new FileDiffError(message, res.status);
  }
  return (await res.json()) as FileDiffResponse;
}

/**
 * Fetch a workspace file against a Git revision or its change baseline.
 *
 * Disabled (no request made) when:
 * - `conversationId` or `path` is missing, or the session id is temporary
 * - neither the runner nor host can serve the workspace
 * - a legacy comparison has no known change or explicit discovery request
 * - the caller disables the query while resolving comparison intent
 */
export function useFileDiff(
  conversationId: string | undefined,
  path: string | null,
  options: { requested?: boolean; base?: string; enabled?: boolean } = {},
) {
  const serveable = useWorkspaceServeable(conversationId);
  const changedFiles = useWorkspaceChangedFiles(conversationId);
  const environment = useWorkspaceEnvironment(conversationId);
  const isInChangedFiles = changedFiles.data?.data.some((f) => f.path === path) ?? false;

  const requestedBeforeDiscovery =
    options.requested && changedFiles.data === undefined && !changedFiles.isError;

  return useQuery({
    queryKey:
      options.base === undefined
        ? ["file-diff", conversationId, path]
        : ["file-diff", conversationId, path, options.base],
    queryFn: () => fetchFileDiff(conversationId!, path!, options.base),
    enabled:
      options.enabled !== false &&
      !!conversationId &&
      !isTempConvId(conversationId) &&
      !!path &&
      serveable !== false &&
      environment.data?.available !== false &&
      (options.base !== undefined || isInChangedFiles || !!requestedBeforeDiscovery),
    // An old diff link may point to a now-unchanged file; don't retry its expected 404.
    ...((requestedBeforeDiscovery || options.base !== undefined) && {
      retry: (failureCount: number, error: Error) =>
        !(error instanceof FileDiffError && [400, 404, 413].includes(error.status)) &&
        failureCount < 3,
    }),
    staleTime: 5_000,
  });
}
