import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from './page';

const mockUseAuthStore = vi.fn();
const mockPush = vi.fn();

vi.mock('@contractor/shared', () => ({
  useAuthStore: () => mockUseAuthStore(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe('Home page', () => {
  beforeEach(() => {
    mockUseAuthStore.mockReset();
    mockPush.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the landing view when signed out and hydrates auth state', () => {
    const hydrate = vi.fn();
    mockUseAuthStore.mockReturnValue({
      isAuthenticated: false,
      user: null,
      hydrate,
      logout: vi.fn(),
      isLoading: false,
      error: null,
    });

    render(<Home />);

    expect(hydrate).toHaveBeenCalled();
    expect(screen.getByText('Welcome to Contractor Dashboard')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign In' })).toHaveAttribute('href', '/login');
  });

  it('loads and renders OneDrive-connected onboarding data when signed in', async () => {
    const logout = vi.fn();
    const hydrate = vi.fn();
    mockUseAuthStore.mockReturnValue({
      isAuthenticated: true,
      user: { name: 'Jane Contractor' },
      hydrate,
      logout,
      isLoading: false,
      error: null,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);

        if (url.endsWith('/api/onedrive/status')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              connected: true,
              syncInProgress: false,
              fileCount: 3,
              accountEmail: 'jane@contractor.ai',
              tenantId: 'tenant-123',
              driveType: 'business',
            }),
          });
        }

        if (url.endsWith('/api/projects')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              projects: [
                {
                  id: 'project-1',
                  name: 'Airport Expansion',
                  onedriveFolderId: 'folder-123',
                },
              ],
            }),
          });
        }

        if (url.includes('/api/projects/project-1/files')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              files: [
                {
                  id: 'file-1',
                  fileName: 'spec.pdf',
                  filePath: 'Specs/spec.pdf',
                  indexStatus: 'pending',
                  tags: [],
                },
              ],
              total: 1,
              page: 1,
              pageSize: 50,
              hasMore: false,
            }),
          });
        }

        if (url.includes('/api/projects/project-1/indexing/progress')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              total: 1,
              pending: 1,
              processing: 0,
              indexed: 0,
              failed: 0,
              completionPercent: 0,
            }),
          });
        }

        if (url.includes('/api/projects/project-1/sync/progress')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              inProgress: false,
              downloadedFileCount: 0,
              completionPercent: 0,
            }),
          });
        }

        return Promise.reject(new Error(`Unexpected request: ${url}`));
      })
    );

    render(<Home />);

    expect(hydrate).toHaveBeenCalled();
    expect(await screen.findByText('Welcome, Jane Contractor')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Airport Expansion' })).toBeInTheDocument();
    expect(await screen.findByText('Connection:')).toBeInTheDocument();
    expect(await screen.findByText('Account:')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Open OneDrive' })).toBeInTheDocument();
    expect(await screen.findByText('spec.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign Out' })).toBeInTheDocument();
  });

  it('creates a project from onboarding form', async () => {
    const user = userEvent.setup();
    mockUseAuthStore.mockReturnValue({
      isAuthenticated: true,
      user: { name: 'Jane Contractor' },
      hydrate: vi.fn(),
      logout: vi.fn(),
      isLoading: false,
      error: null,
    });

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/api/onedrive/status') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            connected: true,
            syncInProgress: false,
            fileCount: 0,
            accountEmail: 'jane@contractor.ai',
            tenantId: 'tenant-123',
            driveType: 'business',
          }),
        });
      }

      if (url.endsWith('/api/projects') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ projects: [] }),
        });
      }

      if (url.endsWith('/api/projects') && method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            project: {
              id: 'project-2',
              name: 'Hospital Tower',
              onedriveFolderId: 'folder-900',
            },
          }),
        });
      }

      if (url.includes('/api/projects/') && url.includes('/files') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            files: [],
            total: 0,
            page: 1,
            pageSize: 50,
            hasMore: false,
          }),
        });
      }

      if (url.includes('/api/projects/') && url.includes('/indexing/progress') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            total: 0,
            pending: 0,
            processing: 0,
            indexed: 0,
            failed: 0,
            completionPercent: 0,
          }),
        });
      }

      return Promise.reject(new Error(`Unexpected request: ${method} ${url}`));
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<Home />);

    await screen.findByRole('button', { name: 'Create Project' });

    await user.type(screen.getByLabelText('Project Name'), 'Hospital Tower');
    await user.type(
      screen.getByLabelText('OneDrive Folder URL Or ID'),
      'https://onedrive.live.com/?id=folder-901'
    );

    await user.click(screen.getByRole('button', { name: 'Create Project' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            name: 'Hospital Tower',
            onedriveFolderId: 'folder-901',
          }),
        })
      );
    });
  });

  it('runs manual sync for the selected project', async () => {
    const user = userEvent.setup();
    mockUseAuthStore.mockReturnValue({
      isAuthenticated: true,
      user: { name: 'Jane Contractor' },
      hydrate: vi.fn(),
      logout: vi.fn(),
      isLoading: false,
      error: null,
    });

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/api/onedrive/status') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            connected: true,
            syncInProgress: false,
            fileCount: 1,
            accountEmail: 'jane@contractor.ai',
            tenantId: 'tenant-123',
            driveType: 'business',
          }),
        });
      }

      if (url.endsWith('/api/onedrive/browse') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ items: [] }),
        });
      }

      if (url.endsWith('/api/projects') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: 'project-1', name: 'Airport Expansion', onedriveFolderId: 'folder-1' }],
          }),
        });
      }

      if (url.includes('/api/projects/project-1/files') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            files: [{ id: 'file-1', fileName: 'spec.pdf', filePath: 'spec.pdf', indexStatus: 'pending', tags: [] }],
            total: 1,
            page: 1,
            pageSize: 50,
            hasMore: false,
          }),
        });
      }

      if (url.includes('/api/projects/project-1/indexing/progress') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            total: 0,
            pending: 0,
            processing: 0,
            indexed: 0,
            failed: 0,
            completionPercent: 0,
          }),
        });
      }

      if (url.includes('/api/projects/project-1/sync/progress') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            inProgress: false,
            downloadedFileCount: 0,
            completionPercent: 0,
          }),
        });
      }

      if (url.includes('/api/projects/project-1/indexing/progress') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            total: 1,
            pending: 0,
            processing: 1,
            indexed: 0,
            failed: 0,
            completionPercent: 0,
          }),
        });
      }

      if (url.endsWith('/api/onedrive/sync') && method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            syncStarted: true,
            message: 'Sync completed.',
            scannedFileCount: 3,
            supportedFileCount: 2,
            unsupportedFileCount: 1,
          }),
        });
      }

      return Promise.reject(new Error(`Unexpected request: ${method} ${url}`));
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<Home />);

    await screen.findByRole('heading', { name: 'Airport Expansion' });
    await user.click(screen.getByRole('button', { name: 'Run Manual Sync' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/onedrive/sync',
        expect.objectContaining({ method: 'POST' })
      );
    });

    expect(await screen.findByText(/Scanned 3, supported 2, unsupported 1/)).toBeInTheDocument();
  });

  it('opens OneDrive in a new tab from the feature tile', async () => {
    const user = userEvent.setup();
    mockUseAuthStore.mockReturnValue({
      isAuthenticated: true,
      user: { name: 'Jane Contractor' },
      hydrate: vi.fn(),
      logout: vi.fn(),
      isLoading: false,
      error: null,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';

        if (url.endsWith('/api/onedrive/status') && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              connected: true,
              syncInProgress: false,
              fileCount: 0,
              accountEmail: 'jane@contractor.ai',
              tenantId: 'tenant-123',
              driveType: 'business',
            }),
          });
        }

        if (url.endsWith('/api/projects') && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              projects: [
                {
                  id: 'project-1',
                  name: 'Airport Expansion',
                  onedriveFolderId: 'folder-123',
                },
              ],
            }),
          });
        }

        if (url.includes('/api/projects/project-1/files') && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              files: [],
              total: 0,
              page: 1,
              pageSize: 50,
              hasMore: false,
            }),
          });
        }

        if (url.includes('/api/projects/project-1/sync/progress') && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              inProgress: false,
              downloadedFileCount: 0,
              completionPercent: 0,
            }),
          });
        }

        return Promise.reject(new Error(`Unexpected request: ${method} ${url}`));
      })
    );

    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window);

    render(<Home />);

    await screen.findByRole('button', { name: 'Open OneDrive' });
    await user.click(screen.getByRole('button', { name: /OneDrive Open folder website/i }));

    expect(openSpy).toHaveBeenCalledWith(
      'https://onedrive.live.com/?id=folder-123',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('loads chunk diagnostics and retrieval preview', async () => {
    const user = userEvent.setup();
    mockUseAuthStore.mockReturnValue({
      isAuthenticated: true,
      user: { name: 'Jane Contractor' },
      hydrate: vi.fn(),
      logout: vi.fn(),
      isLoading: false,
      error: null,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';

        if (url.endsWith('/api/onedrive/status') && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              connected: true,
              syncInProgress: false,
              fileCount: 1,
              accountEmail: 'jane@contractor.ai',
              tenantId: 'tenant-123',
              driveType: 'business',
            }),
          });
        }

        if (url.endsWith('/api/projects') && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              projects: [{ id: 'project-1', name: 'Airport Expansion', onedriveFolderId: 'folder-1' }],
            }),
          });
        }

        if (url.includes('/api/projects/project-1/files') && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              files: [{ id: 'file-1', fileName: 'spec.pdf', filePath: 'spec.pdf', indexStatus: 'indexed', tags: [] }],
              total: 1,
              page: 1,
              pageSize: 50,
              hasMore: false,
            }),
          });
        }

        if (url.includes('/api/projects/project-1/indexing/progress') && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              total: 1,
              pending: 0,
              processing: 0,
              indexed: 1,
              failed: 0,
              completionPercent: 100,
            }),
          });
        }

        if (url.includes('/api/projects/project-1/sync/progress') && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              inProgress: false,
              downloadedFileCount: 12,
              completionPercent: 100,
            }),
          });
        }

        if (url.includes('/api/projects/project-1/chunks') && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              chunks: [
                {
                  id: 'chunk-1',
                  fileId: 'file-1',
                  fileName: 'spec.pdf',
                  chunkIndex: 0,
                  chunkText: 'Permit status received and approved',
                  tokenCount: 32,
                },
              ],
            }),
          });
        }

        if (url.includes('/api/projects/project-1/retrieval/preview') && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              sources: [
                {
                  fileId: 'file-1',
                  fileName: 'spec.pdf',
                  relevance: 0.91,
                },
              ],
            }),
          });
        }

        return Promise.reject(new Error(`Unexpected request: ${method} ${url}`));
      })
    );

    render(<Home />);

    await screen.findByRole('heading', { name: 'Airport Expansion' });
    await user.click(screen.getByRole('button', { name: 'Load Chunks' }));
    expect(await screen.findByText('Chunk count:')).toBeInTheDocument();
    expect(await screen.findByText('Permit status received and approved')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Retrieval Query'));
    await user.type(screen.getByLabelText('Retrieval Query'), 'permit status');
    await user.click(screen.getByRole('button', { name: 'Preview Retrieval' }));

    expect(await screen.findByText('Relevance: 91%')).toBeInTheDocument();
  });

  it('starts sync automatically when selecting a project folder', async () => {
    const user = userEvent.setup();
    mockUseAuthStore.mockReturnValue({
      isAuthenticated: true,
      user: { name: 'Jane Contractor' },
      hydrate: vi.fn(),
      logout: vi.fn(),
      isLoading: false,
      error: null,
    });

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/api/onedrive/status') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            connected: true,
            syncInProgress: false,
            fileCount: 3,
            accountEmail: 'jane@contractor.ai',
            tenantId: 'tenant-123',
            driveType: 'business',
          }),
        });
      }

      if (url.endsWith('/api/projects') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            projects: [
              { id: 'project-1', name: 'Airport Expansion', onedriveFolderId: 'folder-1' },
              { id: 'project-2', name: 'City Hall', onedriveFolderId: 'folder-2' },
            ],
          }),
        });
      }

      if (url.includes('/api/projects/') && url.includes('/files') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ files: [], total: 0, page: 1, pageSize: 50, hasMore: false }),
        });
      }

      if (url.includes('/api/projects/') && url.includes('/indexing/progress') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ total: 0, pending: 0, processing: 0, indexed: 0, failed: 0, completionPercent: 0 }),
        });
      }

      if (url.includes('/api/projects/') && url.includes('/sync/progress') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ inProgress: true, downloadedFileCount: 1, completionPercent: 10 }),
        });
      }

      if (url.endsWith('/api/onedrive/sync') && method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            syncStarted: true,
            message: 'Sync completed.',
            scannedFileCount: 3,
            supportedFileCount: 3,
            unsupportedFileCount: 0,
          }),
        });
      }

      return Promise.reject(new Error(`Unexpected request: ${method} ${url}`));
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<Home />);

    await screen.findByRole('heading', { name: 'City Hall' });
    await user.click(screen.getByRole('button', { name: 'Select Project' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/onedrive/sync',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ projectId: 'project-2' }),
        })
      );
    });
  });
});