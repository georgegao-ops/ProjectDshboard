import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

describe('/api/onedrive/status proxy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards authenticated status requests to the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ connected: true, syncInProgress: false, fileCount: 12 }),
      })
    );

    const request = new NextRequest('http://localhost:3000/api/onedrive/status', {
      method: 'GET',
      headers: {
        cookie: 'app_session=session-token-3',
      },
    });

    const response = await GET(request);
    const data = await response.json();

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/onedrive/status',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer session-token-3',
        },
      })
    );
    expect(response.status).toBe(200);
    expect(data).toEqual({ connected: true, syncInProgress: false, fileCount: 12 });
  });
});
