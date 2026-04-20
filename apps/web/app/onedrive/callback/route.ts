import { NextRequest, NextResponse } from 'next/server';

const APP_SESSION_COOKIE = 'app_session';
export const dynamic = 'force-dynamic';

function getBackendBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
}

function buildDashboardRedirect(request: NextRequest, error: string, message: string): URL {
  const url = new URL('/', request.url);
  url.searchParams.set('onedriveError', error);
  url.searchParams.set('onedriveMessage', message);
  return url;
}

export async function GET(request: NextRequest) {
  const authError = request.nextUrl.searchParams.get('error');
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state') ?? undefined;
  const sessionToken = request.cookies.get(APP_SESSION_COOKIE)?.value;

  if (authError) {
    return NextResponse.redirect(
      buildDashboardRedirect(
        request,
        'onedrive_auth_failed',
        'OneDrive authorization was cancelled or failed. Try connecting again.'
      ),
      302
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      buildDashboardRedirect(
        request,
        'onedrive_code_or_state_missing',
        'Missing OneDrive authorization code or state. Start connect again.'
      ),
      302
    );
  }

  if (!sessionToken) {
    return NextResponse.redirect(
      buildDashboardRedirect(
        request,
        'session_missing',
        'Your app session is missing. Sign in again and retry OneDrive connect.'
      ),
      302
    );
  }

  const redirectUri = `${request.nextUrl.origin}/onedrive/callback`;

  try {
    const response = await fetch(`${getBackendBaseUrl()}/api/onedrive/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        code,
        state,
        redirectUri,
      }),
      cache: 'no-store',
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };

      return NextResponse.redirect(
        buildDashboardRedirect(
          request,
          data.error ?? 'onedrive_connect_failed',
          data.message ?? 'OneDrive connection could not be completed. Try connecting again.'
        ),
        302
      );
    }

    return NextResponse.redirect(new URL('/', request.url), 302);
  } catch (error) {
    console.error('OneDrive callback exchange error:', error);
    return NextResponse.redirect(
      buildDashboardRedirect(
        request,
        'backend_unreachable',
        'Backend API is unavailable. Start the backend service and retry.'
      ),
      302
    );
  }
}
