'use client';

import { useSearchParams } from 'next/navigation';
import './login.css';

function getErrorMessage(error: string | null, message: string | null): string | null {
  if (message) {
    return message;
  }

  if (error === 'oauth_not_configured') {
    return 'Microsoft OAuth is not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in your local environment.';
  }

  if (error === 'backend_unreachable') {
    return 'Backend API is unavailable. Start the backend service on localhost:3001 and retry.';
  }

  return null;
}

export default function LoginPage() {
  const searchParams = useSearchParams();
  const redirectUri = typeof window === 'undefined'
    ? undefined
    : `${window.location.origin}/auth/callback`;
  const authUrl = redirectUri
    ? `/api/auth/login?redirectUri=${encodeURIComponent(redirectUri)}&prompt=select_account`
    : '/api/auth/login';
  const errorParam = searchParams?.get?.('error') ?? null;
  const messageParam = searchParams?.get?.('message') ?? null;
  const errorMessage = getErrorMessage(
    errorParam,
    messageParam
  );

  return (
    <div className="login-container">
      <div className="login-box">
        <div className="login-header">
          <h1>Contractor Dashboard</h1>
          <p>Sign in with Microsoft to access your projects and documents.</p>
        </div>

        <div className="login-form">
          {errorMessage ? <div className="error-message">{errorMessage}</div> : null}
          <a href={authUrl} className="btn btn-primary btn-lg">
            Continue with Microsoft
          </a>
        </div>

        <div className="login-footer">
          <p>Your Microsoft account is used for authentication.</p>
          <p>The backend completes the OAuth exchange and issues the app session.</p>
        </div>
      </div>
    </div>
  );
}
