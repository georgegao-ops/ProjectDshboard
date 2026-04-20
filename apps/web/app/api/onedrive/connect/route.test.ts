import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';

describe('/api/onedrive/connect proxy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts OneDrive connect and redirects to authorization URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          authorizationUrl:
            'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=abc123',
        }),
      })
    );

    const request = new NextRequest(
      'http://localhost:3000/api/onedrive/connect?redirectUri=http%3A%2F%2Flocalhost%3A3000%2Fonedrive%2Fcallback',
      {
        method: 'GET',
        headers: {
          cookie: 'app_session=session-token-4',
        },
      }
    );

    const response = await GET(request);

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/onedrive/connect/start?redirectUri=http%3A%2F%2Flocalhost%3A3000%2Fonedrive%2Fcallback',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer session-token-4',
        },
      })
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('https://login.microsoftonline.com/');
  });

  it('forwards connect callback exchanges to backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ connected: true, message: 'OneDrive connected' }),
      })
    );

    const request = new NextRequest('http://localhost:3000/api/onedrive/connect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'app_session=session-token-5',
      },
      body: JSON.stringify({
        code: 'onedrive-code',
        state: 'state-5',
        redirectUri: 'http://localhost:3000/onedrive/callback',
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/onedrive/connect',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer session-token-5',
        },
      })
    );
    expect(response.status).toBe(200);
    expect(data.connected).toBe(true);
  });
});
