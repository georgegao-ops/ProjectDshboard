import { NextRequest, NextResponse } from 'next/server';

const APP_SESSION_COOKIE = 'app_session';
export const dynamic = 'force-dynamic';

function getBackendBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
}

function buildLoginErrorRedirect(request: NextRequest, error: string, message: string): URL {
  const url = new URL('/login', request.url);
  url.searchParams.set('error', error);
  url.searchParams.set('message', message);
  return url;
}

export async function GET(request: NextRequest) {
  const redirectUri = request.nextUrl.searchParams.get('redirectUri');
  const prompt = request.nextUrl.searchParams.get('prompt');
  const params = new URLSearchParams();
  if (redirectUri) {
    params.set('redirectUri', redirectUri);
  }
  if (prompt) {
    params.set('prompt', prompt);
  }
  const query = params.toString() ? `?${params.toString()}` : '';

  try {
    const response = await fetch(`${getBackendBaseUrl()}/api/auth/login${query}`, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'manual',
    });

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      return NextResponse.redirect(location, 302);
    }

    const data = (await response.json().catch(() => undefined)) as
      | { error?: string; message?: string }
      | undefined;

    const error = data?.error ?? 'auth_start_failed';
    const message = data?.message ?? 'Unable to start Microsoft sign-in. Please try again.';
    return NextResponse.redirect(buildLoginErrorRedirect(request, error, message), 302);
  } catch (error) {
    console.error('Login start proxy error:', error);
    return NextResponse.redirect(
      buildLoginErrorRedirect(
        request,
        'backend_unreachable',
        'Backend API is unavailable. Start the backend service and retry.'
      ),
      302
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    const response = await fetch(`${getBackendBaseUrl()}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });

    const data = await response.json();
    const nextResponse = NextResponse.json(
      response.ok ? { user: data.user } : data,
      { status: response.status }
    );

    if (response.ok && data.accessToken) {
      nextResponse.cookies.set(APP_SESSION_COOKIE, data.accessToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      });
    }

    return nextResponse;
  } catch (error) {
    console.error('Login exchange error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
