import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthHeaders,
  getBackendBaseUrl,
  getSessionToken,
  parseJsonSafe,
} from '../../../../_lib/proxy';

export const dynamic = 'force-dynamic';
const BACKEND_FETCH_TIMEOUT_MS = 30_000;
const BACKEND_FETCH_RETRIES = 2;

function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  const causeCode = (error as { cause?: { code?: string } }).cause?.code;
  return (
    error.name === 'AbortError' ||
    message.includes('aborted') ||
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    causeCode === 'ECONNRESET' ||
    causeCode === 'ECONNREFUSED'
  );
}

async function fetchBackendChatMessage(
  url: string,
  init: RequestInit,
  retries: number
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BACKEND_FETCH_TIMEOUT_MS);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      lastError = error;
      if (attempt === retries || !isTransientFetchError(error)) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to contact backend chat service');
}

export async function POST(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    const sessionToken = getSessionToken(request);
    const payload = await request.json();
    const sessionId = context.params.id;

    const response = await fetchBackendChatMessage(
      `${getBackendBaseUrl()}/api/chat/sessions/${encodeURIComponent(sessionId)}/message`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(sessionToken),
        },
        body: JSON.stringify(payload),
        cache: 'no-store',
      },
      BACKEND_FETCH_RETRIES
    );

    if (response.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    const data = await parseJsonSafe(response);
    if (!response.ok) {
      const payload = (data ?? {}) as { message?: string; error?: string };
      return NextResponse.json(
        {
          ...payload,
          message:
            payload.message ??
            payload.error ??
            `Chat request failed with status ${response.status}`,
        },
        { status: response.status }
      );
    }

    return NextResponse.json(data ?? {}, { status: response.status });
  } catch (error) {
    console.error('Send chat message error:', error);
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? `Chat request timed out after ${BACKEND_FETCH_TIMEOUT_MS / 1000}s. Please retry; the backend may still be processing a large context query.`
        : error instanceof Error
          ? error.message
          : 'Failed to contact backend chat service';
    return NextResponse.json({ error: 'Internal server error', message }, { status: 500 });
  }
}
