import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffBases } from "./useDiffBases";
import { useFileDiffBaseline } from "./useFileDiffBaseline";

vi.mock("@/hooks/useWorkspaceChangedFiles", () => ({
  useWorkspaceServeable: () => true,
  useWorkspaceEnvironment: () => ({ data: { available: true } }),
}));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function provider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("comparison choices", () => {
  it("loads branches and commits only when enabled", async () => {
    const payload = {
      available: true,
      default: { ref: "main", label: "main" },
      branches: [],
      commits: [],
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload)));
    const { result, rerender } = renderHook(({ enabled }) => useDiffBases("session", enabled), {
      wrapper: provider(),
      initialProps: { enabled: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data).toEqual(payload));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/v1/sessions/session/resources/environments/default/diff-bases",
    );
  });

  it("surfaces a server error without retrying", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Git timed out" } }), { status: 500 }),
    );
    const { result } = renderHook(() => useDiffBases("session", true), { wrapper: provider() });
    await waitFor(() => expect(result.current.error?.message).toBe("Git timed out"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("comparison selection", () => {
  it("shares a baseline across viewers and resets when switching sessions", async () => {
    const wrapper = provider();
    const { result, rerender } = renderHook(
      ({ session }) => [useFileDiffBaseline(session, null), useFileDiffBaseline(session, null)],
      { wrapper, initialProps: { session: "first" } },
    );
    const selected = { ref: "HEAD~2", label: "HEAD~2" };
    act(() => {
      result.current[0][1](selected);
    });
    await waitFor(() => expect(result.current[1][0]).toEqual(selected));
    rerender({ session: "second" });
    expect(result.current[0][0]).toBeNull();
    rerender({ session: "first" });
    expect(result.current[0][0]).toBeNull();
  });
});
