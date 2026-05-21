import { NextRequest, NextResponse } from "next/server";

export const APP_SESSION_COOKIE = "app_session";
export const BACKEND_BASE_URL =
  process.env.BACKEND_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3001";

export function getBackendBaseUrl(): string {
  return BACKEND_BASE_URL;
}

export function getSessionToken(request: NextRequest): string | undefined {
  return request.cookies.get(APP_SESSION_COOKIE)?.value;
}

export function getAuthHeaders(sessionToken?: string): HeadersInit {
  return sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
}

export async function parseJsonSafe(response: Response): Promise<unknown | undefined> {
  return response.json().catch(() => undefined);
}

export async function toProxyJsonResponse(response: Response): Promise<NextResponse> {
  if (response.status === 204) {
    return new NextResponse(null, { status: 204 });
  }

  const data = await parseJsonSafe(response);
  return NextResponse.json(data ?? {}, { status: response.status });
}
