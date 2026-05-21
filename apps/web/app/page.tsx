'use client';

import { useAuthStore } from '@contractor/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import './page.css';

interface HomeProject {
  id: string;
  name: string;
  onedriveFolderId?: string;
}

interface OneDriveBrowseItem {
  id: string;
  name: string;
  isFolder: boolean;
  webUrl: string;
}

interface OneDriveBrowseResponse {
  items: OneDriveBrowseItem[];
  parentId?: string;
}

interface UpdateProjectFolderResponse {
  project: HomeProject;
  resetPerformed: boolean;
  sync: SyncResponse;
  message: string;
}

interface OneDriveStatus {
  connected: boolean;
  syncInProgress: boolean;
  fileCount?: number;
  accountEmail?: string;
  tenantId?: string;
  driveId?: string;
  driveType?: string;
}

interface FileInventoryItem {
  id: string;
  fileName: string;
  filePath: string;
  fileSize?: number;
  indexStatus: 'pending' | 'processing' | 'indexed' | 'failed';
  tags?: string[];
}

interface ProjectFilesResponse {
  files: FileInventoryItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

interface SyncResponse {
  syncStarted: boolean;
  message: string;
  scannedFileCount?: number;
  supportedFileCount?: number;
  unsupportedFileCount?: number;
}

interface SyncProgressResponse {
  inProgress: boolean;
  downloadedFileCount: number;
  completionPercent: number;
  scannedFileCount?: number;
  supportedFileCount?: number;
  unsupportedFileCount?: number;
  message?: string;
}

interface IndexingProgressResponse {
  total: number;
  processableTotal: number;
  pending: number;
  processing: number;
  indexed: number;
  failed: number;
  skipped: number;
  unsupportedCount: number;
  oversizeCount: number;
  completionPercent: number;
  paused: boolean;
  pauseReasonCode?: string;
  pauseMessage?: string;
  pauseSince?: string;
  pauseUntil?: string;
  circuitOpen: boolean;
  groupedFailureReasons?: Array<{
    stage: string;
    errorCode: string;
    count: number;
    lastMessage: string;
    lastSeenAt: string;
  }>;
  anomalies?: Array<{
    type: string;
    count: number;
    message: string;
  }>;
}

interface ProjectChunkItem {
  id: string;
  fileId: string;
  fileName: string;
  chunkIndex: number;
  chunkText: string;
  tokenCount: number;
}

interface ProjectChunksResponse {
  chunks: ProjectChunkItem[];
}

interface RetrievalSource {
  fileId: string;
  fileName: string;
  relevance: number;
}

interface RetrievalPreviewResponse {
  sources: RetrievalSource[];
}

interface ChatSessionResponse {
  session: {
    id: string;
  };
}

interface ChatSendResponse {
  content: string;
  sources?: RetrievalSource[];
  coordinator?: {
    domains?: string[];
    splitSignals?: string[];
  };
}

export default function Home() {
  const { isAuthenticated, user, hydrate, logout, isLoading, error } = useAuthStore();
  const router = useRouter();
  const oneDriveMessageFromUrl =
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('onedriveMessage');
  const [onboardingLoading, setOnboardingLoading] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [oneDriveStatus, setOneDriveStatus] = useState<OneDriveStatus | null>(null);
  const [projects, setProjects] = useState<HomeProject[]>([]);
  const [projectName, setProjectName] = useState('');
  const [folderId, setFolderId] = useState('');
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(undefined);
  const [projectFiles, setProjectFiles] = useState<FileInventoryItem[]>([]);
  const [projectFilesTotal, setProjectFilesTotal] = useState(0);
  const [isProjectFilesLoading, setIsProjectFilesLoading] = useState(false);
  const [indexingProgress, setIndexingProgress] = useState<IndexingProgressResponse | null>(null);
  const [isIndexingProgressLoading, setIsIndexingProgressLoading] = useState(false);
  const [projectChunks, setProjectChunks] = useState<ProjectChunkItem[]>([]);
  const [isChunksLoading, setIsChunksLoading] = useState(false);
  const [retrievalQuery, setRetrievalQuery] = useState('project update status');
  const [retrievalSources, setRetrievalSources] = useState<RetrievalSource[]>([]);
  const [isRetrievalLoading, setIsRetrievalLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [chatPrompt, setChatPrompt] = useState('Summarize key risks from the latest synced files.');
  const [chatAnswer, setChatAnswer] = useState<string | null>(null);
  const [chatSources, setChatSources] = useState<RetrievalSource[]>([]);
  const [chatRouteSummary, setChatRouteSummary] = useState<string | null>(null);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null);
  const [syncStatusMessage, setSyncStatusMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncElapsedSeconds, setSyncElapsedSeconds] = useState(0);
  const [syncProgress, setSyncProgress] = useState<SyncProgressResponse | null>(null);
  const [isSyncProgressLoading, setIsSyncProgressLoading] = useState(false);
  const [oneDriveFolders, setOneDriveFolders] = useState<OneDriveBrowseItem[]>([]);
  const [isOneDriveFoldersLoading, setIsOneDriveFoldersLoading] = useState(false);
  const [oneDriveFolderError, setOneDriveFolderError] = useState<string | null>(null);
  const [selectedMainFolderId, setSelectedMainFolderId] = useState('');
  const [isUpdatingMainFolder, setIsUpdatingMainFolder] = useState(false);
  const lastProjectSelectionRef = useRef<string | undefined>(undefined);

  // Restore the last successful app session from persisted auth state.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const extractFolderId = useCallback((value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = new URL(trimmed);
      const idFromQuery = parsed.searchParams.get('id');
      if (idFromQuery) {
        return idFromQuery;
      }

      const decodedPath = decodeURIComponent(parsed.pathname);
      const itemsMatch = decodedPath.match(/\/items\/([^/]+)/i);
      if (itemsMatch?.[1]) {
        return itemsMatch[1];
      }
    } catch {
      return trimmed;
    }

    return trimmed;
  }, []);

  const buildOneDriveFolderUrl = useCallback((folderRef?: string): string => {
    const parsedFolderId = folderRef ? extractFolderId(folderRef) : null;
    if (!parsedFolderId) {
      return 'https://onedrive.live.com/';
    }

    return `https://onedrive.live.com/?id=${encodeURIComponent(parsedFolderId)}`;
  }, [extractFolderId]);

  const loadOnboardingData = useCallback(async () => {
    setOnboardingLoading(true);
    setOnboardingError(null);

    try {
      const [statusResponse, projectsResponse] = await Promise.all([
        fetch('/api/onedrive/status', { method: 'GET' }),
        fetch('/api/projects', { method: 'GET' }),
      ]);

      if (!statusResponse.ok || !projectsResponse.ok) {
        throw new Error('Unable to load onboarding status. Refresh and try again.');
      }

      const statusData = (await statusResponse.json()) as OneDriveStatus;
      const projectsData = (await projectsResponse.json()) as { projects: HomeProject[] };
      const nextProjects = projectsData.projects ?? [];

      setOneDriveStatus(statusData);
      setProjects(nextProjects);
      setSelectedProjectId((current) => {
        if (current && nextProjects.some((project) => project.id === current)) {
          return current;
        }

        return nextProjects[0]?.id;
      });

    } catch (requestError) {
      setOnboardingError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to load onboarding status. Refresh and try again.'
      );
    } finally {
      setOnboardingLoading(false);
    }
  }, []);

  const loadProjectFiles = useCallback(async (projectId: string) => {
    setIsProjectFilesLoading(true);

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/files?page=1&pageSize=50`,
        { method: 'GET' }
      );

      if (!response.ok) {
        throw new Error('Unable to load project file inventory.');
      }

      const data = (await response.json()) as ProjectFilesResponse;
      setProjectFiles(data.files ?? []);
      setProjectFilesTotal(data.total ?? 0);
    } catch (filesError) {
      setOnboardingError(
        filesError instanceof Error
          ? filesError.message
          : 'Unable to load project file inventory.'
      );
    } finally {
      setIsProjectFilesLoading(false);
    }
  }, []);

  const loadIndexingProgress = useCallback(async (projectId: string) => {
    setIsIndexingProgressLoading(true);

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/indexing/progress`,
        { method: 'GET' }
      );

      if (!response.ok) {
        throw new Error('Unable to load indexing progress.');
      }

      const data = (await response.json()) as IndexingProgressResponse;
      setIndexingProgress(data);
    } catch (progressError) {
      setOnboardingError(
        progressError instanceof Error
          ? progressError.message
          : 'Unable to load indexing progress.'
      );
    } finally {
      setIsIndexingProgressLoading(false);
    }
  }, []);

  const loadProjectChunks = useCallback(async (projectId: string) => {
    setIsChunksLoading(true);
    setDiagnosticsError(null);

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/chunks`,
        { method: 'GET' }
      );

      if (!response.ok) {
        throw new Error('Unable to load indexed chunks.');
      }

      const data = (await response.json()) as ProjectChunksResponse;
      setProjectChunks(data.chunks ?? []);
    } catch (chunksError) {
      const message = chunksError instanceof Error ? chunksError.message : 'Unable to load indexed chunks.';
      setDiagnosticsError(message);
    } finally {
      setIsChunksLoading(false);
    }
  }, []);

  const loadSyncProgress = useCallback(async (projectId: string) => {
    setIsSyncProgressLoading(true);

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/sync/progress`,
        { method: 'GET' }
      );

      if (!response.ok) {
        throw new Error('Unable to load sync progress.');
      }

      const data = (await response.json()) as SyncProgressResponse;
      setSyncProgress(data);
      setIsSyncing(data.inProgress);
    } catch {
      // Sync progress is best-effort UI feedback and should not block the page.
    } finally {
      setIsSyncProgressLoading(false);
    }
  }, []);

  const runRetrievalPreview = useCallback(async (projectId: string, query: string) => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setDiagnosticsError('Enter a retrieval query before previewing sources.');
      return;
    }

    setIsRetrievalLoading(true);
    setDiagnosticsError(null);

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/retrieval/preview?q=${encodeURIComponent(normalizedQuery)}`,
        { method: 'GET' }
      );

      if (!response.ok) {
        throw new Error('Unable to run retrieval preview.');
      }

      const data = (await response.json()) as RetrievalPreviewResponse;
      setRetrievalSources(data.sources ?? []);
    } catch (previewError) {
      const message = previewError instanceof Error ? previewError.message : 'Unable to run retrieval preview.';
      setDiagnosticsError(message);
    } finally {
      setIsRetrievalLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      void loadOnboardingData();
    }
  }, [isAuthenticated, loadOnboardingData]);

  useEffect(() => {
    if (selectedProjectId) {
      void loadProjectFiles(selectedProjectId);
      void loadIndexingProgress(selectedProjectId);
      void loadSyncProgress(selectedProjectId);
      return;
    }

    setProjectFiles([]);
    setProjectFilesTotal(0);
    setIndexingProgress(null);
    setProjectChunks([]);
    setRetrievalSources([]);
    setDiagnosticsError(null);
    setChatSessionId(null);
    setChatAnswer(null);
    setChatSources([]);
    setChatRouteSummary(null);
    setChatError(null);
    setSyncProgress(null);
    setSelectedMainFolderId('');
  }, [selectedProjectId, loadProjectFiles, loadIndexingProgress, loadSyncProgress]);

  useEffect(() => {
    if (!selectedProjectId) {
      lastProjectSelectionRef.current = undefined;
      setSelectedMainFolderId('');
      return;
    }

    // Only initialize folder selection when the selected project changes.
    if (lastProjectSelectionRef.current !== selectedProjectId) {
      const selectedProject = projects.find((project) => project.id === selectedProjectId);
      setSelectedMainFolderId(selectedProject?.onedriveFolderId ?? '');
      lastProjectSelectionRef.current = selectedProjectId;
    }
  }, [selectedProjectId, projects]);

  useEffect(() => {
    setChatSessionId(null);
    setChatAnswer(null);
    setChatSources([]);
    setChatRouteSummary(null);
    setChatError(null);
  }, [selectedProjectId]);

  useEffect(() => {
    if (!isSyncing) {
      setSyncElapsedSeconds(0);
      return;
    }

    const startedAt = Date.now();
    const timerId = window.setInterval(() => {
      setSyncElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [isSyncing]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }

    const pollId = window.setInterval(() => {
      void loadOnboardingData();
      void loadProjectFiles(selectedProjectId);
      void loadIndexingProgress(selectedProjectId);
      void loadSyncProgress(selectedProjectId);
    }, 1000);

    return () => {
      window.clearInterval(pollId);
    };
  }, [selectedProjectId, loadOnboardingData, loadProjectFiles, loadIndexingProgress, loadSyncProgress]);

  useEffect(() => {
    const query = selectedProjectId
      ? `?projectId=${encodeURIComponent(selectedProjectId)}`
      : '';

    // Warm the chat route bundle/data to reduce delay after clicking AI Chat.
    router.prefetch(`/workspace/chat${query}`);
  }, [router, selectedProjectId]);

  const handleOpenOneDrive = () => {
    const activeProjectFolderId = projects.find((project) => project.id === selectedProjectId)?.onedriveFolderId;
    const targetUrl = buildOneDriveFolderUrl(activeProjectFolderId ?? folderId);
    const popup = window.open(targetUrl, '_blank', 'noopener,noreferrer');
    if (!popup) {
      window.location.href = targetUrl;
    }
  };

  const handleStartOneDriveConnect = () => {
    const redirectUri = `${window.location.origin}/onedrive/callback`;
    window.location.href = `/api/onedrive/connect?redirectUri=${encodeURIComponent(redirectUri)}`;
  };

  const handleOpenAiChat = () => {
    const query = selectedProjectId
      ? `?projectId=${encodeURIComponent(selectedProjectId)}`
      : '';
    router.push(`/workspace/chat${query}`);
  };

  const loadOneDriveFolders = useCallback(async () => {
    if (!oneDriveStatus?.connected) {
      setOneDriveFolderError('Connect OneDrive first to browse folders.');
      return;
    }

    setIsOneDriveFoldersLoading(true);
    setOneDriveFolderError(null);

    try {
      const response = await fetch('/api/onedrive/browse', { method: 'GET' });
      if (!response.ok) {
        throw new Error('Unable to load OneDrive folders.');
      }

      const payload = (await response.json()) as OneDriveBrowseResponse;
      const folders = (payload.items ?? []).filter((item) => item.isFolder);
      setOneDriveFolders(folders);

      const selectedProject = projects.find((project) => project.id === selectedProjectId);
      if (selectedProject?.onedriveFolderId) {
        setSelectedMainFolderId(selectedProject.onedriveFolderId);
      } else if (folders[0]?.id) {
        setSelectedMainFolderId(folders[0].id);
      }
    } catch (browseError) {
      setOneDriveFolderError(
        browseError instanceof Error ? browseError.message : 'Unable to load OneDrive folders.'
      );
    } finally {
      setIsOneDriveFoldersLoading(false);
    }
  }, [oneDriveStatus?.connected, projects, selectedProjectId]);

  const ensureChatSession = useCallback(async (projectId: string): Promise<string> => {
    if (chatSessionId) {
      return chatSessionId;
    }

    const response = await fetch('/api/chat/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectId }),
    });

    if (!response.ok) {
      throw new Error('Unable to create chat session for this project.');
    }

    const payload = (await response.json()) as ChatSessionResponse;
    const nextSessionId = payload.session?.id;
    if (!nextSessionId) {
      throw new Error('Chat session creation returned an invalid response.');
    }

    setChatSessionId(nextSessionId);
    return nextSessionId;
  }, [chatSessionId]);

  const handleRunAiChat = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();

    const projectId = selectedProjectId;
    const prompt = chatPrompt.trim();

    if (!projectId) {
      setChatError('Select a project before sending an AI chat message.');
      return;
    }

    if (!prompt) {
      setChatError('Enter a message before sending.');
      return;
    }

    setIsChatLoading(true);
    setChatError(null);

    try {
      const sessionId = await ensureChatSession(projectId);
      const response = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
          message: prompt,
        }),
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => undefined) as
          | { message?: string }
          | undefined;
        throw new Error(errorPayload?.message ?? 'AI chat request failed.');
      }

      const payload = (await response.json()) as ChatSendResponse;
      setChatAnswer(payload.content ?? 'No response content returned.');
      setChatSources(payload.sources ?? []);

      const domainSummary = payload.coordinator?.domains?.length
        ? `Domains: ${payload.coordinator.domains.join(', ')}`
        : null;
      const splitSummary = payload.coordinator?.splitSignals?.length
        ? `Split signals: ${payload.coordinator.splitSignals.join(', ')}`
        : null;

      setChatRouteSummary([domainSummary, splitSummary].filter(Boolean).join(' | ') || null);
    } catch (requestError) {
      setChatError(
        requestError instanceof Error ? requestError.message : 'AI chat request failed.'
      );
    } finally {
      setIsChatLoading(false);
    }
  };

  const handleCreateProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedFolderId = extractFolderId(folderId) ?? '';

    if (!projectName.trim() || !parsedFolderId.trim()) {
      setOnboardingError('Project name and OneDrive folder URL or ID are required.');
      return;
    }

    setIsCreatingProject(true);
    setOnboardingError(null);

    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: projectName.trim(),
          onedriveFolderId: parsedFolderId.trim(),
        }),
      });

      if (!response.ok) {
        throw new Error('Project creation failed. Verify inputs and try again.');
      }

      setProjectName('');
      setFolderId('');
      await loadOnboardingData();
    } catch (createError) {
      setOnboardingError(
        createError instanceof Error
          ? createError.message
          : 'Project creation failed. Verify inputs and try again.'
      );
    } finally {
      setIsCreatingProject(false);
    }
  };

  const handleRunManualSync = async (projectIdOverride?: string) => {
    const projectIdToSync = projectIdOverride ?? selectedProjectId;

    if (!projectIdToSync) {
      setSyncError('Create or select a project before running sync.');
      return;
    }

    setIsSyncing(true);
    setSyncError(null);
    setSyncStatusMessage('Starting sync. This can take a bit for larger folders.');
    setOnboardingError(null);

    try {
      const response = await fetch('/api/onedrive/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ projectId: projectIdToSync }),
      });

      const payload = (await response.json().catch(() => undefined)) as SyncResponse | undefined;
      if (!response.ok) {
        throw new Error(payload?.message ?? 'Manual sync failed.');
      }

      const scanned = payload?.scannedFileCount ?? 0;
      const supported = payload?.supportedFileCount ?? 0;
      const unsupported = payload?.unsupportedFileCount ?? 0;
      setLastSyncSummary(`${payload?.message ?? 'Sync completed.'} Scanned ${scanned}, supported ${supported}, unsupported ${unsupported}.`);
      setSyncStatusMessage('Sync completed successfully.');
      await loadSyncProgress(projectIdToSync);

      await Promise.all([
        loadOnboardingData(),
        loadProjectFiles(projectIdToSync),
        loadIndexingProgress(projectIdToSync),
      ]);
    } catch (syncError) {
      const message =
        syncError instanceof Error
            ? syncError.message
            : 'Manual sync failed.';
      setSyncError(message);
      setOnboardingError(
        message
      );
      setSyncStatusMessage(null);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleApplyMainProjectFolder = useCallback(async () => {
    if (!selectedProjectId) {
      setOneDriveFolderError('Select a project first.');
      return;
    }

    const nextFolderId = selectedMainFolderId.trim();
    if (!nextFolderId) {
      setOneDriveFolderError('Select a OneDrive folder before applying.');
      return;
    }

    setIsUpdatingMainFolder(true);
    setOneDriveFolderError(null);
    setOnboardingError(null);
    setProjectFiles([]);
    setProjectFilesTotal(0);
    setProjectChunks([]);
    setRetrievalSources([]);
    setDiagnosticsError(null);
    setChatAnswer(null);
    setChatSources([]);
    setChatRouteSummary(null);
    setSyncProgress(null);
    setSyncStatusMessage('Updating project folder, clearing old index, and starting a fresh sync...');
    setIsSyncing(true);

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(selectedProjectId)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          onedriveFolderId: nextFolderId,
          resetIndexedData: true,
        }),
      });

      const payload = (await response.json().catch(() => undefined)) as
        | UpdateProjectFolderResponse
        | { message?: string; error?: string }
        | undefined;

      if (!response.ok) {
        const payloadMessage = payload && 'message' in payload ? payload.message : undefined;
        const payloadError = payload && 'error' in payload ? payload.error : undefined;
        const fallback = response.statusText
          ? `Unable to update project folder (${response.status}: ${response.statusText}).`
          : `Unable to update project folder (${response.status}).`;
        throw new Error(payloadMessage || payloadError || fallback);
      }

      setLastSyncSummary(
        payload && 'sync' in payload && payload.sync?.message
          ? payload.sync.message
          : payload && 'message' in payload && payload.message
            ? payload.message
            : 'Project folder updated.'
      );
      setSyncStatusMessage(
        payload && 'sync' in payload && payload.sync?.syncStarted
          ? 'Fresh sync started for selected main folder.'
          : 'Project folder updated. Sync did not start because there were no supported files.'
      );

      // Do not block the Apply button on potentially heavy refresh calls.
      // Refresh data in the background so the user can continue interacting immediately.
      void Promise.allSettled([
        loadOnboardingData(),
        loadProjectFiles(selectedProjectId),
        loadIndexingProgress(selectedProjectId),
        loadSyncProgress(selectedProjectId),
      ]);
    } catch (updateError) {
      const message = updateError instanceof Error ? updateError.message : 'Unable to update project folder.';
      setOneDriveFolderError(message);
      setOnboardingError(message);
      setSyncStatusMessage(null);
      setIsSyncing(false);
    } finally {
      setIsUpdatingMainFolder(false);
    }
  }, [loadIndexingProgress, loadOnboardingData, loadProjectFiles, loadSyncProgress, selectedMainFolderId, selectedProjectId]);

  const handleSelectProject = (projectId: string) => {
    const isNewSelection = selectedProjectId !== projectId;
    setSelectedProjectId(projectId);

    setSyncStatusMessage(
      isNewSelection
        ? 'Folder selected. Starting sync automatically...'
        : 'Project re-selected. Starting sync automatically...'
    );
    void handleRunManualSync(projectId);
  };

  return (
    <div className="home-container">
      {isAuthenticated ? (
        <div className="onboarding-shell">
          <div className="welcome-section">
            <h2>Welcome, {user?.name || 'User'}</h2>
            <p>Finish OneDrive connection and project setup to start document sync.</p>
            <button type="button" className="btn btn-secondary" onClick={() => void logout()}>
              Sign Out
            </button>
          </div>

          <div className="phase2-grid">
            <div className="phase2-card">
              <h3>OneDrive Status</h3>
              {onboardingLoading && !oneDriveStatus ? <p>Loading status...</p> : null}
              {oneDriveStatus ? (
                <>
                  <p className="status-row">
                    Connection: <strong>{oneDriveStatus.connected ? 'Connected' : 'Not connected'}</strong>
                  </p>
                  <p className="status-row">
                    Sync: <strong>{oneDriveStatus.syncInProgress ? 'In progress' : 'Idle'}</strong>
                  </p>
                  <p className="status-row">
                    Files detected: <strong>{oneDriveStatus.fileCount ?? 0}</strong>
                  </p>
                  {oneDriveStatus.accountEmail ? (
                    <p className="status-row">
                      Account: <strong>{oneDriveStatus.accountEmail}</strong>
                    </p>
                  ) : null}
                  {oneDriveStatus.tenantId ? (
                    <p className="status-row">
                      Tenant: <strong>{oneDriveStatus.tenantId}</strong>
                    </p>
                  ) : null}
                  {oneDriveStatus.driveType ? (
                    <p className="status-row">
                      Drive Type: <strong>{oneDriveStatus.driveType}</strong>
                    </p>
                  ) : null}
                </>
              ) : null}
              {oneDriveStatus?.connected ? (
                <button type="button" className="btn btn-secondary" onClick={handleOpenOneDrive}>
                  Open OneDrive
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={handleStartOneDriveConnect}>
                  Connect OneDrive
                </button>
              )}
              <p className="phase2-note">
                Browse folders directly on OneDrive. In this app, set one folder as the main folder to read.
              </p>
            </div>

            <div className="phase2-card">
              <h3>MVP Features</h3>
              <div className="feature-grid">
                <button type="button" className="feature-tile feature-tile-live" onClick={handleOpenOneDrive}>
                  <span className="feature-icon">OD</span>
                  <span className="feature-label">OneDrive</span>
                  <span className="feature-sub">Open folder website</span>
                </button>
                <button type="button" className="feature-tile feature-tile-live" onClick={handleOpenAiChat}>
                  <span className="feature-icon">AI</span>
                  <span className="feature-label">AI Chat</span>
                  <span className="feature-sub">Test routed agent on selected project</span>
                </button>
                <button type="button" className="feature-tile feature-tile-soon" disabled>
                  <span className="feature-icon">PH</span>
                  <span className="feature-label">Daily Photos</span>
                  <span className="feature-sub">Coming soon</span>
                </button>
                <button type="button" className="feature-tile feature-tile-soon" disabled>
                  <span className="feature-icon">JR</span>
                  <span className="feature-label">Job Reports</span>
                  <span className="feature-sub">Coming soon</span>
                </button>
              </div>

              <h3>Projects</h3>
              {projects.length === 0 ? (
                <p>No projects yet. Create your first project to continue onboarding.</p>
              ) : (
                <ul className="project-list">
                  {projects.map((project) => (
                    <li key={project.id} className="project-item">
                      <h4>{project.name}</h4>
                      <p>Folder ID: {project.onedriveFolderId ?? 'Not set'}</p>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => handleSelectProject(project.id)}
                      >
                        {selectedProjectId === project.id ? 'Selected' : 'Select Project'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="folder-dropdown-panel">
                <h4>Main Project Folder</h4>
                <p className="phase2-note">
                  Change the OneDrive folder used for this project. Existing indexed data will be cleared before re-indexing.
                </p>
                <div className="folder-dropdown-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void loadOneDriveFolders()}
                    disabled={!oneDriveStatus?.connected || isOneDriveFoldersLoading}
                  >
                    {isOneDriveFoldersLoading ? 'Loading folders...' : 'Load OneDrive Folders'}
                  </button>
                  <select
                    value={selectedMainFolderId}
                    onChange={(event) => setSelectedMainFolderId(event.target.value)}
                    disabled={oneDriveFolders.length === 0 || isUpdatingMainFolder}
                  >
                    <option value="">Select OneDrive folder...</option>
                    {oneDriveFolders.map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folder.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleApplyMainProjectFolder()}
                  disabled={!selectedProjectId || !selectedMainFolderId || isUpdatingMainFolder}
                >
                  {isUpdatingMainFolder ? 'Applying...' : 'Set As Main Folder And Re-index'}
                </button>
                {oneDriveFolderError ? <p className="page-error">{oneDriveFolderError}</p> : null}
              </div>
            </div>

            <div className="phase2-card">
              <h3>Create Project</h3>
              <p className="phase2-note">
                Use OneDrive website for browsing. Paste a OneDrive folder URL or folder ID below to set the main folder.
              </p>
              <button type="button" className="btn btn-secondary" onClick={handleOpenOneDrive}>
                Open OneDrive Website
              </button>

              <form onSubmit={handleCreateProject} className="project-form">
                <label htmlFor="project-name">Project Name</label>
                <input
                  id="project-name"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="Downtown Hospital Renovation"
                />

                <label htmlFor="folder-id">OneDrive Folder URL Or ID</label>
                <input
                  id="folder-id"
                  value={folderId}
                  onChange={(event) => setFolderId(event.target.value)}
                  placeholder="https://onedrive.live.com/?id=... or 01ABCDEF23GHIJKL"
                />
                <p className="phase2-note folder-tip">
                  Tip: In OneDrive, open your target folder and copy its link. You can paste either the full URL or just the folder ID.
                </p>

                <button type="submit" className="btn btn-primary" disabled={isCreatingProject}>
                  {isCreatingProject ? 'Creating...' : 'Create Project'}
                </button>
              </form>
            </div>

            <div className="phase2-card phase3-card">
              <h3>Sync And File Inventory</h3>
              <p className="status-row">
                Active project: <strong>{projects.find((project) => project.id === selectedProjectId)?.name ?? 'None selected'}</strong>
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleRunManualSync()}
                disabled={!selectedProjectId || isSyncing}
              >
                {isSyncing ? 'Syncing...' : 'Run Manual Sync'}
              </button>
              {isSyncing ? (
                <p className="phase2-note" aria-live="polite">
                  Sync in progress ({syncElapsedSeconds}s). Downloaded files: {syncProgress?.downloadedFileCount ?? 0}.
                </p>
              ) : null}
              {syncProgress ? (
                <>
                  <p className="status-row">
                    Sync download progress:{' '}
                    <strong>{syncProgress.completionPercent}%</strong>
                  </p>
                  <div className="sync-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={syncProgress.completionPercent}>
                    <div
                      className="sync-progress-fill"
                      style={{ width: `${syncProgress.completionPercent}%` }}
                    />
                  </div>
                </>
              ) : null}
              {isSyncProgressLoading && isSyncing ? <p className="phase2-note">Updating sync progress...</p> : null}
              {syncStatusMessage ? <p className="phase2-note">{syncStatusMessage}</p> : null}
              {syncError ? <p className="page-error sync-error">{syncError}</p> : null}
              {lastSyncSummary ? <p className="phase2-note">{lastSyncSummary}</p> : null}
              <p className="status-row">
                Indexing completion:{' '}
                <strong>{indexingProgress ? `${indexingProgress.completionPercent}%` : 'Not available'}</strong>
              </p>
              <div className="indexing-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={indexingProgress?.completionPercent ?? 0}>
                <div
                  className="indexing-progress-fill"
                  style={{ width: `${indexingProgress?.completionPercent ?? 0}%` }}
                />
              </div>
              {isIndexingProgressLoading ? (
                <p className="phase2-note">Updating indexing progress...</p>
              ) : indexingProgress ? (
                <>
                  <p className="phase2-note">
                    Indexed {indexingProgress.indexed}, processing {indexingProgress.processing}, pending {indexingProgress.pending}, skipped {indexingProgress.skipped}, failed {indexingProgress.failed}.
                  </p>
                  <p className="phase2-note">
                    Processable files: {indexingProgress.processableTotal} of {indexingProgress.total} inventory files.
                  </p>
                  {indexingProgress.paused ? (
                    <p className="page-error sync-error">
                      Indexing paused{indexingProgress.pauseReasonCode ? ` [${indexingProgress.pauseReasonCode}]` : ''}: {indexingProgress.pauseMessage ?? 'Unknown pause reason.'}
                    </p>
                  ) : null}
                  {indexingProgress.circuitOpen ? (
                    <p className="phase2-note">
                      Circuit breaker is open. Remaining files stay pending until provider recovery.
                    </p>
                  ) : null}
                </>
              ) : null}
              <p className="status-row">
                Inventory count: <strong>{projectFilesTotal}</strong>
              </p>

              {isProjectFilesLoading ? (
                <p>Loading file inventory...</p>
              ) : projectFiles.length === 0 ? (
                <p>No files in inventory yet. Run manual sync to populate files.</p>
              ) : (
                <ul className="inventory-list">
                  {projectFiles.map((file) => {
                    const isUnsupportedType = (file.tags ?? []).includes('unsupported_type');
                    const isOversize = (file.tags ?? []).includes('oversize');
                    const skippedReason = isOversize ? 'Skipped: oversize' : isUnsupportedType ? 'Skipped: unsupported' : null;

                    return (
                      <li key={file.id} className="inventory-item">
                        <p className="inventory-name">{file.fileName}</p>
                        <p className="inventory-meta">{file.filePath}</p>
                        <p className="inventory-meta">
                          Status: <strong>{skippedReason ? 'skipped' : file.indexStatus}</strong>
                          {skippedReason ? <span className="inventory-unsupported">{skippedReason}</span> : null}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="diagnostics-panel">
                <h4>Indexing Diagnostics</h4>
                <p className="phase2-note">
                  Use this to verify indexed chunks and run a retrieval preview query.
                </p>
                <div className="diagnostics-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => selectedProjectId && void loadProjectChunks(selectedProjectId)}
                    disabled={!selectedProjectId || isChunksLoading}
                  >
                    {isChunksLoading ? 'Loading Chunks...' : 'Load Chunks'}
                  </button>
                </div>
                <p className="status-row">
                  Chunk count: <strong>{projectChunks.length}</strong>
                </p>
                {indexingProgress?.anomalies && indexingProgress.anomalies.length > 0 ? (
                  <ul className="diagnostics-list">
                    {indexingProgress.anomalies.map((anomaly) => (
                      <li key={anomaly.type} className="diagnostics-item">
                        <p>
                          <strong>{anomaly.type}</strong> ({anomaly.count})
                        </p>
                        <p className="inventory-meta">{anomaly.message}</p>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {indexingProgress?.groupedFailureReasons && indexingProgress.groupedFailureReasons.length > 0 ? (
                  <>
                    <p className="phase2-note">Top failure reasons</p>
                    <ul className="diagnostics-list">
                      {indexingProgress.groupedFailureReasons.map((reason) => (
                        <li key={`${reason.stage}:${reason.errorCode}`} className="diagnostics-item">
                          <p>
                            <strong>{reason.stage}</strong> / {reason.errorCode} ({reason.count})
                          </p>
                          <p className="inventory-meta">{reason.lastMessage}</p>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {projectChunks.length > 0 ? (
                  <ul className="diagnostics-list">
                    {projectChunks.slice(0, 5).map((chunk) => (
                      <li key={chunk.id} className="diagnostics-item">
                        <p>
                          <strong>{chunk.fileName}</strong> (chunk {chunk.chunkIndex})
                        </p>
                        <p className="inventory-meta">{chunk.chunkText.slice(0, 120)}{chunk.chunkText.length > 120 ? '...' : ''}</p>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <form
                  className="project-form diagnostics-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (selectedProjectId) {
                      void runRetrievalPreview(selectedProjectId, retrievalQuery);
                    }
                  }}
                >
                  <label htmlFor="retrieval-query">Retrieval Query</label>
                  <input
                    id="retrieval-query"
                    value={retrievalQuery}
                    onChange={(event) => setRetrievalQuery(event.target.value)}
                    placeholder="latest permit status"
                  />
                  <button
                    type="submit"
                    className="btn btn-secondary"
                    disabled={!selectedProjectId || isRetrievalLoading}
                  >
                    {isRetrievalLoading ? 'Running Preview...' : 'Preview Retrieval'}
                  </button>
                </form>

                {retrievalSources.length > 0 ? (
                  <ul className="diagnostics-list">
                    {retrievalSources.map((source) => (
                      <li key={source.fileId} className="diagnostics-item">
                        <p>
                          <strong>{source.fileName}</strong>
                        </p>
                        <p className="inventory-meta">Relevance: {Math.round(source.relevance * 100)}%</p>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {diagnosticsError ? <p className="page-error sync-error">{diagnosticsError}</p> : null}
              </div>

              <div className="diagnostics-panel ai-chat-panel" id="ai-chat-tester">
                <h4>AI Chat Tester</h4>
                <p className="phase2-note">
                  Send a question to the Phase 4.5c coordinator agent for the selected project.
                </p>
                <form className="project-form diagnostics-form" onSubmit={(event) => void handleRunAiChat(event)}>
                  <label htmlFor="chat-prompt">Question</label>
                  <textarea
                    id="chat-prompt"
                    className="chat-textarea"
                    value={chatPrompt}
                    onChange={(event) => setChatPrompt(event.target.value)}
                    placeholder="What are schedule and cost risks we should notify the owner about this week?"
                  />
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={!selectedProjectId || isChatLoading}
                  >
                    {isChatLoading ? 'Sending...' : 'Send To AI Chat'}
                  </button>
                </form>

                {chatRouteSummary ? <p className="phase2-note">{chatRouteSummary}</p> : null}
                {chatAnswer ? <p className="chat-answer">{chatAnswer}</p> : null}
                {chatSources.length > 0 ? (
                  <ul className="diagnostics-list">
                    {chatSources.map((source) => (
                      <li key={source.fileId} className="diagnostics-item">
                        <p>
                          <strong>{source.fileName}</strong>
                        </p>
                        <p className="inventory-meta">Relevance: {Math.round(source.relevance * 100)}%</p>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {chatError ? <p className="page-error sync-error">{chatError}</p> : null}
              </div>
            </div>
          </div>

          {onboardingError || oneDriveMessageFromUrl ? (
            <p className="page-error">{onboardingError ?? oneDriveMessageFromUrl}</p>
          ) : null}
        </div>
      ) : (
        <div className="landing">
          <div className="hero">
            <h2>Welcome to Contractor Dashboard</h2>
            <p>
              {isLoading
                ? 'Restoring your session...'
                : error ?? 'Manage your projects efficiently across all platforms'}
            </p>
            <Link href="/login" className="btn btn-primary btn-lg">
              Sign In
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
