import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

describe('/api/onedrive/browse proxy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards authenticated browse requests to the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          items: [{ id: 'folder-1', name: 'Specs', isFolder: true, webUrl: 'https://onedrive.test' }],
          parentId: 'parent-1',
        }),
      })
    );

    const request = new NextRequest('http://localhost:3000/api/onedrive/browse?folderId=folder-2', {
      method: 'GET',
      headers: {
        cookie: 'app_session=session-token-9',
      },
    });

    const response = await GET(request);
    const data = await response.json();

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/onedrive/browse?folderId=folder-2',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer session-token-9',
        },
      })
    );
    expect(response.status).toBe(200);
    expect(data.parentId).toBe('parent-1');
  });
});
