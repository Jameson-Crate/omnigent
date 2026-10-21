import { useQuery } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/identity";
import { isTempConvId } from "@/lib/tempConversationId";
import { useWorkspaceEnvironment, useWorkspaceServeable } from "./useWorkspaceChangedFiles";

export interface DiffBase {
  ref: string;
  label: string;
  commit?: string;
}

export interface DiffBasesResponse {
  available: boolean;
  default: DiffBase | null;
  branches: DiffBase[];
  commits: { commit: string; subject: string }[];
}

export function useDiffBases(conversationId: string | undefined, enabled: boolean) {
  const serveable = useWorkspaceServeable(conversationId);
  const environment = useWorkspaceEnvironment(conversationId);
  return useQuery({
    queryKey: ["file-diff-bases", conversationId],
    queryFn: async (): Promise<DiffBasesResponse> => {
      const response = await authenticatedFetch(
        `/v1/sessions/${encodeURIComponent(conversationId!)}/resources/environments/default/diff-bases`,
      );
      if (!response.ok) {
        let message = `${response.status} ${response.statusText}`;
        try {
          const body = await response.json();
          message = body.error?.message ?? message;
        } catch {
          // Keep the status when a gateway returns a non-JSON response.
        }
        throw new Error(message);
      }
      return response.json();
    },
    enabled:
      enabled &&
      !!conversationId &&
      !isTempConvId(conversationId) &&
      serveable !== false &&
      environment.data?.available !== false,
    staleTime: 30_000,
    retry: false,
  });
}
