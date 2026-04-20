import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

describe('/api/onedrive/sync proxy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards authenticated sync requests to the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          syncStarted: true,
          message: 'Sync completed',
          scannedFileCount: 4,
          supportedFileCount: 3,
          unsupportedFileCount: 1,
        }),
      })
    );

    const request = new NextRequest('http://localhost:3000/api/onedrive/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'app_session=session-token-sync',
      },
      body: JSON.stringify({ projectId: 'project-123' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/onedrive/sync',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer session-token-sync',
        },
      })
    );
    expect(response.status).toBe(200);
    expect(data.syncStarted).toBe(true);
    expect(data.supportedFileCount).toBe(3);
  });
});
