import { NextRequest, NextResponse } from 'next/server';

const APP_SESSION_COOKIE = 'app_session';
export const dynamic = 'force-dynamic';

function getBackendBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
}

function getSessionToken(request: NextRequest): string | undefined {
  return request.cookies.get(APP_SESSION_COOKIE)?.value;
}

function getAuthHeaders(sessionToken?: string): HeadersInit {
  return sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
}

function buildQuery(request: NextRequest): string {
  const params = new URLSearchParams();

  for (const key of ['page', 'pageSize', 'search', 'category', 'tags']) {
    const value = request.nextUrl.searchParams.get(key);
    if (value) {
      params.set(key, value);
    }
  }

  const query = params.toString();
  return query ? `?${query}` : '';
}

export async function GET(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    const sessionToken = getSessionToken(request);
    const query = buildQuery(request);

    const response = await fetch(
      `${getBackendBaseUrl()}/api/projects/${encodeURIComponent(context.params.id)}/files${query}`,
      {
        method: 'GET',
        headers: getAuthHeaders(sessionToken),
        cache: 'no-store',
      }
    );

    if (response.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Get project files error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
