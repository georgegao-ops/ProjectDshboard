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
  const authError = request.nextUrl.searchParams.get('error');
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state') ?? undefined;

  if (authError) {
    return NextResponse.redirect(
      buildLoginErrorRedirect(
        request,
        'auth_callback_failed',
        'Microsoft sign-in was cancelled or failed. Try again.'
      ),
      302
    );
  }

  if (!code) {
    return NextResponse.redirect(
      buildLoginErrorRedirect(
        request,
        'missing_auth_code',
        'Open /login and start the Microsoft sign-in flow from there.'
      ),
      302
    );
  }

  const redirectUri = `${request.nextUrl.origin}/auth/callback`;

  try {
    const response = await fetch(`${getBackendBaseUrl()}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code,
        state,
        redirectUri,
      }),
      cache: 'no-store',
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
      return NextResponse.redirect(
        buildLoginErrorRedirect(
          request,
          data.error ?? 'oauth_exchange_failed',
          data.message ?? 'Microsoft sign-in could not be completed. Start sign-in again.'
        ),
        302
      );
    }

    const data = (await response.json()) as { accessToken?: string };
    if (!data.accessToken) {
      return NextResponse.redirect(
        buildLoginErrorRedirect(
          request,
          'missing_session_token',
          'Sign-in succeeded but no app session was returned. Retry from /login.'
        ),
        302
      );
    }

    const nextResponse = NextResponse.redirect(new URL('/', request.url), 302);
    nextResponse.cookies.set(APP_SESSION_COOKIE, data.accessToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });

    return nextResponse;
  } catch (error) {
    console.error('Auth callback exchange error:', error);
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
