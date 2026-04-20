import { NextRequest, NextResponse } from 'next/server';

const APP_SESSION_COOKIE = 'app_session';
export const dynamic = 'force-dynamic';

function getBackendBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
}

export async function GET(request: NextRequest) {
  try {
    const sessionToken = request.cookies.get(APP_SESSION_COOKIE)?.value;
    const response = await fetch(`${getBackendBaseUrl()}/api/onedrive/status`, {
      method: 'GET',
      headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
      cache: 'no-store',
    });

    if (response.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Get OneDrive status error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
