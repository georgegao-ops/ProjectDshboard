import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

describe('/api/projects/[id]/retrieval/preview proxy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards authenticated retrieval preview requests to the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          sources: [
            {
              fileId: 'file-1',
              fileName: 'spec.pdf',
              relevance: 0.92,
            },
          ],
        }),
      })
    );

    const request = new NextRequest(
      'http://localhost:3000/api/projects/project-321/retrieval/preview?q=permit%20status',
      {
        method: 'GET',
        headers: {
          cookie: 'app_session=session-token-retrieval',
        },
      }
    );

    const response = await GET(request, { params: { id: 'project-321' } });
    const data = await response.json();

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/projects/project-321/retrieval/preview?q=permit%20status',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer session-token-retrieval',
        },
      })
    );
    expect(response.status).toBe(200);
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0].relevance).toBe(0.92);
  });
});
