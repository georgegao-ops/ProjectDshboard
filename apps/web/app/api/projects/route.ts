import { NextRequest, NextResponse } from 'next/server';

const APP_SESSION_COOKIE = 'app_session';
export const dynamic = 'force-dynamic';

function getBackendBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
}

function getAuthHeaders(sessionToken?: string): HeadersInit {
  return sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
}

export async function GET(request: NextRequest) {
  try {
    const sessionToken = request.cookies.get(APP_SESSION_COOKIE)?.value;
    const response = await fetch(`${getBackendBaseUrl()}/api/projects`, {
      method: 'GET',
      headers: getAuthHeaders(sessionToken),
      cache: 'no-store',
    });

    if (response.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Get projects error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessionToken = request.cookies.get(APP_SESSION_COOKIE)?.value;
    const payload = await request.json();
    const response = await fetch(`${getBackendBaseUrl()}/api/projects`, {
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

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Create project error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
