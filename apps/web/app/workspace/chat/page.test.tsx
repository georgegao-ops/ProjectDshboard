import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatWorkspacePage from "./page";

const mockPush = vi.fn();
const mockBack = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    back: mockBack,
  }),
  useSearchParams: () => new URLSearchParams("projectId=project-321"),
}));

vi.mock("framer-motion", () => {
  const passthrough = ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <div {...props}>{children}</div>
  );

  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
    motion: new Proxy(
      {},
      {
        get: () => passthrough,
      }
    ),
  };
});

describe("Workspace chat interactions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPush.mockReset();
    mockBack.mockReset();
    window.localStorage.clear();
  });

  it("navigates to citation pages and preserves search term across PDF hit clicks", async () => {
    const user = userEvent.setup();

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/api/chat/sessions") && method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            sessions: [
              {
                id: "session-1",
                projectId: "project-321",
                createdAt: "2026-05-05T10:00:00.000Z",
              },
            ],
          }),
        });
      }

      if (url.includes("/api/chat/sessions/session-1/message") && method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            content: "Found key expansion joint notes.",
            sources: [
              {
                fileId: "file-123",
                fileName: "spec.pdf",
                relevance: 0.93,
                suggestedPages: [27, 31],
                bestPage: 27,
                pageOrigin: "exact",
              },
            ],
          }),
        });
      }

      if (url.includes("/api/files/file-123?projectId=project-321") && method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            fileId: "file-123",
            fileName: "spec.pdf",
            chunks: [
              {
                chunkIndex: 11,
                pageNumber: 27,
                chunkText: "Expansion joints on elevated deck sections need sealant class A.",
              },
              {
                chunkIndex: 16,
                pageNumber: 31,
                chunkText: "Expansion joints at wall interface require movement accommodation.",
              },
            ],
          }),
        });
      }

      return Promise.reject(new Error(`Unexpected request: ${url} (${method})`));
    });

    vi.stubGlobal(
      "fetch",
      fetchMock
    );

    render(<ChatWorkspacePage />);

    const promptBox = await screen.findByPlaceholderText(
      "Ask AI to analyze, compare, summarize, and cite relevant project documents..."
    );
    await user.type(promptBox, "Show me expansion joint requirements");
    await user.click(screen.getByRole("button", { name: "Send (Ctrl+Enter)" }));

    const citationChip = await screen.findByRole("button", {
      name: "spec.pdf (p. 27, 31)",
    });
    await user.click(citationChip);

    await waitFor(() => {
      expect(screen.getByText("120%")).toBeInTheDocument();
    });

    const searchBox = screen.getByPlaceholderText("Search in document");
    await user.clear(searchBox);
    await user.type(searchBox, "expansion joint");
    await user.click(screen.getByRole("button", { name: "Find" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /p\.31/i })).toBeInTheDocument();
      expect(screen.getByText(/2 matches for "expansion joint"/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /p\.31/i }));

    await waitFor(() => {
      expect((screen.getByPlaceholderText("Search in document") as HTMLInputElement).value).toBe("expansion joint");
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files/file-123?projectId=project-321",
      expect.objectContaining({ method: "GET", cache: "no-store" })
    );
  });

  it("uses high-contrast marks for in-document text highlights", async () => {
    const user = userEvent.setup();

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/api/chat/sessions") && method === "GET") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ sessions: [] }),
          });
        }

        return Promise.reject(new Error(`Unexpected request: ${url} (${method})`));
      })
    );

    render(<ChatWorkspacePage />);

    await user.click(await screen.findByRole("button", { name: "site-notes.txt" }));

    const searchBox = screen.getByPlaceholderText("Search in document");
    await user.type(searchBox, "critical path");
    await user.click(screen.getByRole("button", { name: "Find" }));

    const mark = await screen.findByText(/critical path/i, { selector: "mark" });
    expect(mark).toHaveClass("bg-yellow-300", "font-semibold", "text-slate-950");
  });

  it("clears viewer search query, hit list, and highlight state", async () => {
    const user = userEvent.setup();

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/api/chat/sessions") && method === "GET") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ sessions: [] }),
          });
        }

        return Promise.reject(new Error(`Unexpected request: ${url} (${method})`));
      })
    );

    render(<ChatWorkspacePage />);

    await user.click(await screen.findByRole("button", { name: "site-notes.txt" }));

    const searchBox = screen.getByPlaceholderText("Search in document") as HTMLInputElement;
    await user.type(searchBox, "critical path");
    await user.click(screen.getByRole("button", { name: "Find" }));

    await waitFor(() => {
      expect(screen.getByText(/1 match for "critical path"/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/critical path/i, { selector: "mark" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => {
      expect(searchBox.value).toBe("");
      expect(screen.queryByText(/match for "critical path"/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/critical path/i, { selector: "mark" })).not.toBeInTheDocument();
    });
  });
});
