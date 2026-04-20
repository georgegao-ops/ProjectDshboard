import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

describe('/api/projects/[id]/sync/progress proxy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards authenticated sync progress requests to the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          inProgress: true,
          downloadedFileCount: 6,
          completionPercent: 48,
        }),
      })
    );

    const request = new NextRequest(
      'http://localhost:3000/api/projects/project-321/sync/progress',
      {
        method: 'GET',
        headers: {
          cookie: 'app_session=session-token-sync-progress',
        },
      }
    );

    const response = await GET(request, { params: { id: 'project-321' } });
    const data = await response.json();

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/projects/project-321/sync/progress',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer session-token-sync-progress',
        },
      })
    );
    expect(response.status).toBe(200);
    expect(data.downloadedFileCount).toBe(6);
    expect(data.completionPercent).toBe(48);
  });
});
