import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

describe('/api/projects/[id]/chunks proxy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards authenticated chunk requests to the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          chunks: [
            {
              id: 'chunk-1',
              fileId: 'file-1',
              fileName: 'spec.pdf',
              chunkIndex: 0,
              chunkText: 'spec text',
              tokenCount: 128,
            },
          ],
        }),
      })
    );

    const request = new NextRequest(
      'http://localhost:3000/api/projects/project-321/chunks',
      {
        method: 'GET',
        headers: {
          cookie: 'app_session=session-token-chunks',
        },
      }
    );

    const response = await GET(request, { params: { id: 'project-321' } });
    const data = await response.json();

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/projects/project-321/chunks',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer session-token-chunks',
        },
      })
    );
    expect(response.status).toBe(200);
    expect(data.chunks).toHaveLength(1);
    expect(data.chunks[0].fileName).toBe('spec.pdf');
  });
});
