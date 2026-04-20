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

async function parseJsonSafe(response: Response): Promise<unknown | undefined> {
  return response.json().catch(() => undefined);
}

export async function GET(request: NextRequest) {
  try {
    const sessionToken = getSessionToken(request);
    const redirectUri = request.nextUrl.searchParams.get('redirectUri');
    const query = redirectUri ? `?redirectUri=${encodeURIComponent(redirectUri)}` : '';

    const response = await fetch(`${getBackendBaseUrl()}/api/onedrive/connect/start${query}`, {
      method: 'GET',
      headers: getAuthHeaders(sessionToken),
      cache: 'no-store',
    });

    const data = await parseJsonSafe(response);

    if (!response.ok) {
      if (data && typeof data === 'object') {
        return NextResponse.json(data, { status: response.status });
      }

      return NextResponse.json(
        {
          error: 'connect_start_failed',
          message: response.statusText || 'OneDrive connect start failed.',
        },
        { status: response.status }
      );
    }

    const authorizationUrl =
      data && typeof data === 'object' ? (data as { authorizationUrl?: string }).authorizationUrl : undefined;
    if (!authorizationUrl) {
      return NextResponse.json(
        { error: 'invalid_connect_response', message: 'Missing authorization URL' },
        { status: 502 }
      );
    }

    return NextResponse.redirect(authorizationUrl, 302);
  } catch (error) {
    console.error('Start OneDrive connect error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessionToken = getSessionToken(request);
    const payload = await request.json();

    const response = await fetch(`${getBackendBaseUrl()}/api/onedrive/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(sessionToken),
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });

    if (response.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    const data = await parseJsonSafe(response);

    if (data && typeof data === 'object') {
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(
      {
        error: response.ok ? 'invalid_connect_response' : 'connect_exchange_failed',
        message: response.statusText || 'OneDrive connection failed.',
      },
      { status: response.status }
    );
  } catch (error) {
    console.error('Complete OneDrive connect error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
