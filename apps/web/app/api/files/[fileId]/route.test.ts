import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

describe("/api/files/[fileId] proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when projectId is missing", async () => {
    const request = new NextRequest("http://localhost:3000/api/files/file-123", {
      method: "GET",
      headers: {
        cookie: "app_session=session-token-files",
      },
    });

    const response = await GET(request, { params: { fileId: "file-123" } });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("project_id_required");
  });

  it("forwards authenticated document detail requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          fileId: "file-123",
          fileName: "spec.pdf",
          chunks: [{ chunkIndex: 1, chunkText: "expansion joints", pageNumber: 27 }],
        }),
      })
    );

    const request = new NextRequest(
      "http://localhost:3000/api/files/file-123?projectId=project-321",
      {
        method: "GET",
        headers: {
          cookie: "app_session=session-token-files",
        },
      }
    );

    const response = await GET(request, { params: { fileId: "file-123" } });
    const data = await response.json();

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/files/file-123?projectId=project-321",
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "Bearer session-token-files",
        },
      })
    );
    expect(response.status).toBe(200);
    expect(data.fileName).toBe("spec.pdf");
    expect(data.chunks).toHaveLength(1);
  });
});
