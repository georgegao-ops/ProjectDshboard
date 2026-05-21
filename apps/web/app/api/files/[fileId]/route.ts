import { NextRequest, NextResponse } from "next/server";
import {
  getAuthHeaders,
  getBackendBaseUrl,
  getSessionToken,
  toProxyJsonResponse,
} from "../../_lib/proxy";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: { fileId: string } }
) {
  try {
    const sessionToken = getSessionToken(request);
    const projectId = request.nextUrl.searchParams.get("projectId");

    if (!projectId) {
      return NextResponse.json(
        { error: "project_id_required", message: "projectId query param is required" },
        { status: 400 }
      );
    }

    const response = await fetch(
      `${getBackendBaseUrl()}/api/files/${encodeURIComponent(context.params.fileId)}?projectId=${encodeURIComponent(projectId)}`,
      {
        method: "GET",
        headers: getAuthHeaders(sessionToken),
        cache: "no-store",
      }
    );

    return toProxyJsonResponse(response);
  } catch (error) {
    console.error("Get document detail error:", error);
    return NextResponse.json({ error: "internal_server_error" }, { status: 500 });
  }
}
