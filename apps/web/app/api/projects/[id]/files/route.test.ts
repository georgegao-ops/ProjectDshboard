import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

describe('/api/projects/[id]/files proxy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards authenticated file inventory requests to the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          files: [{ id: 'file-1', fileName: 'spec.pdf' }],
          total: 1,
          page: 1,
          pageSize: 25,
          hasMore: false,
        }),
      })
    );

    const request = new NextRequest(
      'http://localhost:3000/api/projects/project-321/files?page=1&pageSize=25&search=spec',
      {
        method: 'GET',
        headers: {
          cookie: 'app_session=session-token-files',
        },
      }
    );

    const response = await GET(request, { params: { id: 'project-321' } });
    const data = await response.json();

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/projects/project-321/files?page=1&pageSize=25&search=spec',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer session-token-files',
        },
      })
    );
    expect(response.status).toBe(200);
    expect(data.total).toBe(1);
    expect(data.files[0].fileName).toBe('spec.pdf');
  });
});
