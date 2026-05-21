import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthHeaders,
  getBackendBaseUrl,
  getSessionToken,
} from '../../../../../_lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: { id: string; fileId: string } }
) {
  try {
    const sessionToken = getSessionToken(request);

    const response = await fetch(
      `${getBackendBaseUrl()}/api/projects/${encodeURIComponent(context.params.id)}/files/${encodeURIComponent(context.params.fileId)}/content`,
      {
        method: 'GET',
        headers: getAuthHeaders(sessionToken),
        cache: 'no-store',
      }
    );

    if (!response.ok) {
      const payload = await response.json().catch(() => undefined) as
        | { message?: string; error?: string }
        | undefined;
      return NextResponse.json(
        {
          error: payload?.error ?? 'file_preview_failed',
          message: payload?.message ?? 'Failed to load file preview',
        },
        { status: response.status }
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const headers = new Headers();
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    headers.set('Content-Type', contentType);

    const contentDisposition = response.headers.get('content-disposition');
    if (contentDisposition) {
      headers.set('Content-Disposition', contentDisposition);
    }

    return new NextResponse(arrayBuffer, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error('Get project file content error:', error);
    return NextResponse.json({ error: 'internal_server_error', message: 'Failed to load file preview' }, { status: 500 });
  }
}
