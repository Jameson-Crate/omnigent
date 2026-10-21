import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DiffBase } from "./useDiffBases";

/** Share the comparison choice across files and responsive viewers in one session. */
export function useFileDiffBaseline(sessionId: string | undefined, initial: DiffBase | null) {
  const client = useQueryClient();
  const previousSession = useRef(sessionId);
  const key = ["file-diff-baseline", sessionId];
  const { data } = useQuery<DiffBase | null>({
    queryKey: key,
    queryFn: () => null,
    initialData: initial,
    enabled: false,
  });
  useEffect(() => {
    if (previousSession.current !== sessionId) {
      client.removeQueries({
        queryKey: ["file-diff-baseline", previousSession.current],
        exact: true,
      });
      previousSession.current = sessionId;
    }
  }, [client, sessionId]);
  return [data ?? null, (value: DiffBase) => client.setQueryData(key, value)] as const;
}
