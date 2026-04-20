import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../state/authStore';
import type { UUID, User } from '../types/entities';

const asUuid = (value: string) => value as UUID;

const demoUser: User = {
  id: asUuid('1'),
  orgId: asUuid('org-1'),
  name: 'Demo User',
  email: 'demo@contractor.ai',
  role: 'admin' as const,
  createdAt: new Date('2026-04-13T00:00:00.000Z'),
};

describe('useAuthStore', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    useAuthStore.setState({
      isAuthenticated: false,
      user: null,
      isLoading: false,
      error: null,
    });
  });

  it('hydrates auth state from persisted storage', async () => {
    localStorage.setItem(
      'auth-storage',
      JSON.stringify({
        state: {
          user: demoUser,
          isAuthenticated: true,
        },
        version: 0,
      })
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ user: demoUser }),
      })
    );

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: true,
      user: expect.objectContaining({
        id: '1',
        orgId: 'org-1',
        name: 'Demo User',
        email: 'demo@contractor.ai',
        role: 'admin',
      }),
    });
    expect(fetch).toHaveBeenCalledWith('/api/auth/me', {
      method: 'GET',
    });
  });

  it('hydrates from cookie-backed session even without persisted auth', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ user: demoUser }),
      })
    );

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: true,
      user: expect.objectContaining({
        email: 'demo@contractor.ai',
      }),
      error: null,
    });
  });

  it('stays signed out without error when no cookie session exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: 'unauthorized' }),
      })
    );

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: false,
      user: null,
      error: null,
    });
  });

  it('logs in and persists token and user', async () => {
    const loginRequest = {
      code: 'oauth-code',
      redirectUri: 'http://localhost:3000/auth/callback',
      state: 'oauth-state',
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          user: demoUser,
        }),
      })
    );

    await useAuthStore.getState().login(loginRequest);

    expect(fetch).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginRequest),
      signal: expect.any(AbortSignal),
    });
    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: true,
      user: demoUser,
    });
  });

  it('surfaces login failure without authenticating', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ message: 'OAuth state is invalid or expired' }),
      })
    );

    await expect(
      useAuthStore.getState().login({
        code: 'bad-code',
        redirectUri: 'http://localhost:3000/auth/callback',
        state: 'bad-state',
      })
    ).rejects.toThrow('OAuth state is invalid or expired');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('logs out and clears persisted auth', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        json: async () => undefined,
      })
    );

    useAuthStore.setState({
      isAuthenticated: true,
      user: demoUser,
      isLoading: false,
      error: null,
    });

    await useAuthStore.getState().logout();

    expect(fetch).toHaveBeenCalledWith('/api/auth/logout', {
      method: 'POST',
    });
    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: false,
      user: null,
    });
  });
});