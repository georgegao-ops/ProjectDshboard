import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';

describe('GET /api/auth/login', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redirects to Microsoft authorization URL when backend returns 302', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 302,
        headers: {
          get: (key: string) =>
            key.toLowerCase() === 'location'
              ? 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=abc123'
              : null,
        },
      })
    );

    const request = new NextRequest(
      'http://localhost:3000/api/auth/login?redirectUri=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback',
      {
        method: 'GET',
      }
    );

    const response = await GET(request);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('login.microsoftonline.com');
  });

  it('redirects back to /login with friendly error when backend cannot start OAuth', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 503,
        headers: {
          get: () => null,
        },
        json: async () => ({
          error: 'oauth_not_configured',
          message: 'Microsoft OAuth is not configured',
        }),
      })
    );

    const request = new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'GET',
    });

    const response = await GET(request);
    const location = response.headers.get('location') ?? '';

    expect(response.status).toBe(302);
    expect(location).toContain('/login');
    expect(location).toContain('error=oauth_not_configured');
    expect(location).toContain('message=Microsoft+OAuth+is+not+configured');
  });
});

describe('POST /api/auth/login', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('proxies the OAuth code exchange to the backend API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          accessToken: 'backend-session-token',
          refreshToken: 'backend-refresh-token',
          expiresIn: 3600,
          user: {
            id: 'user-1',
            orgId: 'tenant-1',
            name: 'Jane Contractor',
            email: 'jane@contractor.ai',
            role: 'admin',
            createdAt: '2026-04-14T00:00:00.000Z',
          },
        }),
      })
    );

    const request = new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        code: 'oauth-code',
        redirectUri: 'http://localhost:3000/auth/callback',
        state: 'oauth-state',
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.user).toMatchObject({
      id: 'user-1',
      orgId: 'tenant-1',
      name: 'Jane Contractor',
      email: 'jane@contractor.ai',
      role: 'admin',
    });
    expect(data.accessToken).toBeUndefined();
    expect(data.refreshToken).toBeUndefined();
    expect(response.cookies.get('app_session')?.value).toBe('backend-session-token');
  });

  it('forwards backend auth failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 400,
        json: async () => ({
          error: 'invalid_oauth_state',
          message: 'OAuth state is invalid or expired',
        }),
      })
    );

    const request = new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        code: 'oauth-code',
        redirectUri: 'http://localhost:3000/auth/callback',
        state: 'bad-state',
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data).toEqual({
      error: 'invalid_oauth_state',
      message: 'OAuth state is invalid or expired',
    });
  });
});