import { NextRequest, NextResponse } from 'next/server';

const APP_SESSION_COOKIE = 'app_session';
export const dynamic = 'force-dynamic';

function getBackendBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
}

export async function POST(request: NextRequest) {
  try {
    const sessionToken = request.cookies.get(APP_SESSION_COOKIE)?.value;
    const response = await fetch(`${getBackendBaseUrl()}/api/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      },
      body: JSON.stringify({}),
      cache: 'no-store',
    });

    const nextResponse = new NextResponse(null, { status: response.status });
    nextResponse.cookies.set(APP_SESSION_COOKIE, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      expires: new Date(0),
    });

    return nextResponse;
  } catch (error) {
    console.error('Logout auth error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}