import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

describe('/api/projects/[id]/indexing/progress proxy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards authenticated indexing progress requests to the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          total: 8,
          pending: 2,
          processing: 1,
          indexed: 5,
          failed: 0,
          completionPercent: 63,
        }),
      })
    );

    const request = new NextRequest(
      'http://localhost:3000/api/projects/project-321/indexing/progress',
      {
        method: 'GET',
        headers: {
          cookie: 'app_session=session-token-progress',
        },
      }
    );

    const response = await GET(request, { params: { id: 'project-321' } });
    const data = await response.json();

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/projects/project-321/indexing/progress',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer session-token-progress',
        },
      })
    );
    expect(response.status).toBe(200);
    expect(data.indexed).toBe(5);
    expect(data.completionPercent).toBe(63);
  });
});
