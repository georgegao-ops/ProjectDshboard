import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import LoginPage from './page';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

describe('Login page', () => {
  it('renders a Microsoft sign-in link that points at the web auth proxy route', () => {
    window.history.pushState({}, '', 'http://localhost:3000/login');
    render(<LoginPage />);

    expect(
      screen.getByRole('link', { name: 'Continue with Microsoft' })
    ).toHaveAttribute(
      'href',
      '/api/auth/login?redirectUri=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback&prompt=select_account'
    );
    expect(
      screen.getByText('The backend completes the OAuth exchange and issues the app session.')
    ).toBeInTheDocument();
  });

  it('renders a friendly setup message when OAuth is not configured', () => {
    window.history.pushState(
      {},
      '',
      'http://localhost:3000/login?error=oauth_not_configured&message=Microsoft%20OAuth%20is%20not%20configured'
    );

    render(<LoginPage />);

    expect(screen.getByText('Microsoft OAuth is not configured')).toBeInTheDocument();
  });
});