import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';

describe('/api/projects proxy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards authenticated project list requests to the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ projects: [{ id: 'project-1', name: 'Airport Expansion' }] }),
      })
    );

    const request = new NextRequest('http://localhost:3000/api/projects', {
      method: 'GET',
      headers: {
        cookie: 'app_session=session-token-1',
      },
    });

    const response = await GET(request);
    const data = await response.json();

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/projects',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer session-token-1',
        },
      })
    );
    expect(response.status).toBe(200);
    expect(data.projects).toEqual([{ id: 'project-1', name: 'Airport Expansion' }]);
  });

  it('forwards project creation requests to the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ project: { id: 'project-2', name: 'Hospital Tower' } }),
      })
    );

    const request = new NextRequest('http://localhost:3000/api/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'app_session=session-token-2',
      },
      body: JSON.stringify({
        name: 'Hospital Tower',
        onedriveFolderId: 'folder-900',
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/projects',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer session-token-2',
        },
      })
    );
    expect(response.status).toBe(200);
    expect(data.project).toEqual({ id: 'project-2', name: 'Hospital Tower' });
  });
});
