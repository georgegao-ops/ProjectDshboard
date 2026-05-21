'use client';

import { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode, Suspense, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import './workspace.css';

const PdfViewer = dynamic(() => import('./PdfViewer'), { ssr: false, loading: () => null });

type DocKind = 'pdf' | 'txt' | 'docx' | 'xlsx' | 'image';

interface WorkspaceDoc {
  id: string;
  title: string;
  kind: DocKind;
  fileId?: string;
  url?: string;
  text?: string;
  page?: number;
  searchTerm?: string;
  source: 'library' | 'dropped';
}

interface ChatReference {
  fileName: string;
  displayName?: string;
  fileId?: string;
  suggestedPages?: number[];
  bestPage?: number;
  pageOrigin?: 'exact' | 'fallback' | 'mixed';
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  references?: ChatReference[];
  suggestions?: string[];
  isStreaming?: boolean;
}

interface ChatSessionRecord {
  id: string;
  projectId: string;
  createdAt: string;
}

interface ChatSessionsListResponse {
  sessions: ChatSessionRecord[];
}

interface CreateChatSessionResponse {
  session?: ChatSessionRecord;
}

interface ChatSource {
  fileId: string;
  fileName: string;
  displayName?: string;
  relevance: number;
  suggestedPages?: number[];
  bestPage?: number;
  pageOrigin?: 'exact' | 'fallback' | 'mixed';
}

interface SendChatMessageResponse {
  content: string;
  sources?: ChatSource[];
  suggestions?: string[];
  autoOpenFileName?: string;
}

interface ProjectFilesListResponse {
  files: Array<{
    id: string;
    fileName: string;
  }>;
}

interface ProjectsListResponse {
  projects: Array<{
    id: string;
  }>;
}

interface DocumentDetailChunk {
  chunkIndex: number;
  chunkText: string;
  pageNumber?: number;
}

interface DocumentDetailResponse {
  fileId: string;
  fileName: string;
  chunks: DocumentDetailChunk[];
}

interface ViewerSearchHit {
  id: string;
  chunkIndex: number;
  pageNumber?: number;
  excerpt: string;
}

const DOC_LIBRARY: WorkspaceDoc[] = [
  {
    id: 'doc-structural-report',
    title: 'structural-report.pdf',
    kind: 'pdf',
    url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    source: 'library',
  },
  {
    id: 'doc-site-notes',
    title: 'site-notes.txt',
    kind: 'txt',
    source: 'library',
    text: [
      'Project: North Tower Retrofit',
      'Safety status: clear',
      'Critical path risk: steel delivery slips by 4 days',
      'Action: coordinate alternate supplier quote by Wednesday',
      'Page 12 summary: concrete curing variance requires timeline adjustment',
    ].join('\n'),
  },
  {
    id: 'doc-contract-scope',
    title: 'contract-scope.docx',
    kind: 'docx',
    source: 'library',
  },
  {
    id: 'doc-cost-tracker',
    title: 'cost-tracker.xlsx',
    kind: 'xlsx',
    source: 'library',
  },
  {
    id: 'doc-crane-photo',
    title: 'crane-inspection.jpg',
    kind: 'image',
    source: 'library',
    url: 'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?auto=format&fit=crop&w=1600&q=80',
  },
];

const SUGGESTED_PROMPTS = [
  'Open structural-report.pdf and summarize page 12',
  'Compare cost-tracker.xlsx with contract-scope.docx for overruns',
  'List unresolved risks in site-notes.txt',
  'Open crane-inspection.jpg and draft a safety observation',
];

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now()}`;
}

function detectDocKind(fileName: string, mimeType?: string): DocKind | null {
  const lower = fileName.toLowerCase();

  if (mimeType?.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp)$/i.test(lower)) {
    return 'image';
  }

  if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) {
    return 'pdf';
  }

  if (mimeType?.includes('word') || lower.endsWith('.docx')) {
    return 'docx';
  }

  if (mimeType?.includes('sheet') || lower.endsWith('.xlsx')) {
    return 'xlsx';
  }

  if (mimeType?.startsWith('text/') || lower.endsWith('.txt')) {
    return 'txt';
  }

  return null;
}

function buildProjectFileContentUrl(projectId: string, fileId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/content`;
}

function createDocFromFileName(
  fileName: string,
  options?: { projectId?: string; fileId?: string }
): WorkspaceDoc {
  const kind = detectDocKind(fileName) ?? 'txt';
  const id = `doc-runtime-${fileName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const projectFileUrl =
    kind === 'pdf' && options?.projectId && options?.fileId
      ? buildProjectFileContentUrl(options.projectId, options.fileId)
      : undefined;

  const baseDoc: WorkspaceDoc = {
    id,
    title: fileName,
    kind,
    fileId: options?.fileId,
    source: 'library',
  };

  if (kind === 'txt') {
    return {
      ...baseDoc,
      text: `Preview for ${fileName} is linked from AI citations.`,
    };
  }

  return {
    ...baseDoc,
    url: projectFileUrl,
  };
}

function highlightText(content: string, query: string): Array<string | JSX.Element> {
  if (!query.trim()) {
    return [content];
  }

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'ig');
  const parts = content.split(regex);

  return parts.map((part, idx) =>
    idx % 2 === 1 ? (
      <mark key={`hit-${idx}`} className="rounded bg-yellow-300 px-0.5 font-semibold text-slate-950">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

function buildChunkExcerpt(text: string, query: string): string {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedText = text.toLowerCase();
  const matchIndex = normalizedText.indexOf(normalizedQuery);

  if (matchIndex === -1) {
    return text.slice(0, 180).trim();
  }

  const start = Math.max(0, matchIndex - 60);
  const end = Math.min(text.length, matchIndex + normalizedQuery.length + 90);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

function extractNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((child) => extractNodeText(child)).join(' ');
  }

  if (isValidElement(node)) {
    return extractNodeText(node.props.children as ReactNode);
  }

  return '';
}

function hasRenderableListItemText(node: ReactNode): boolean {
  const normalized = extractNodeText(node)
    .replace(/^[\s\-*+\u2022\u2023\u2043\u2219\u25E6\u2027\u00B7\uF0B7]+/g, '')
    .replace(/[\s.,:;!?()[\]{}'"`~_-]+/g, '')
    .trim();

  return normalized.length > 0;
}

function sanitizeAssistantMarkdown(content: string): string {
  return content
    .split('\n')
    .filter((line) => !/^\s*(?:[-*+]\s*)?(?:[\u2022\u2023\u2043\u2219\u25E6\u2027\u00B7\uF0B7]\s*)+$/.test(line))
    .join('\n');
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="group relative my-3 overflow-hidden rounded-xl border border-slate-700/80 bg-slate-950">
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="absolute right-2 top-2 rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 opacity-0 transition group-hover:opacity-100"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="overflow-x-auto p-4 text-xs leading-6 text-slate-200">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function ChatWorkspacePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryProjectId = searchParams?.get('projectId') ?? null;
  const [inferredProjectId, setInferredProjectId] = useState<string | null>(null);
  const projectId = queryProjectId ?? inferredProjectId;
  const dashboardHref = projectId
    ? `/?projectId=${encodeURIComponent(projectId)}`
    : '/';

  const [panelRatio, setPanelRatio] = useState(50);
  const [isDraggingDivider, setIsDraggingDivider] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);

  const [openDocs, setOpenDocs] = useState<WorkspaceDoc[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerSearchResults, setViewerSearchResults] = useState<ViewerSearchHit[]>([]);
  const [viewerSearchError, setViewerSearchError] = useState<string | null>(null);
  const [viewerSearchBusy, setViewerSearchBusy] = useState(false);
  const [viewerSearchAppliedTerm, setViewerSearchAppliedTerm] = useState('');
  const [pdfZoom, setPdfZoom] = useState(120);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [pdfRenderError, setPdfRenderError] = useState<string | null>(null);
  const [activePdfPage, setActivePdfPage] = useState<number | undefined>(undefined);
  // Tracks the page currently visible in the viewer (scroll-driven). Never fed back into targetPage.
  const [displayedPdfPage, setDisplayedPdfPage] = useState<number | undefined>(undefined);
  const [isDropActive, setIsDropActive] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const [isTyping, setIsTyping] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);

  const [workspaceSearch, setWorkspaceSearch] = useState('');

  const panelRootRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const viewerSearchInputRef = useRef<HTMLInputElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const docDetailCacheRef = useRef<Map<string, DocumentDetailResponse>>(new Map());

  useEffect(() => {
    if (queryProjectId) {
      setInferredProjectId(null);
      return;
    }

    let cancelled = false;

    const resolveProjectFromApi = async () => {
      try {
        const response = await fetch('/api/projects', { method: 'GET', cache: 'no-store' });
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as ProjectsListResponse;
        const fallbackProjectId = payload.projects?.[0]?.id;
        if (!fallbackProjectId || cancelled) {
          return;
        }

        setInferredProjectId(fallbackProjectId);
        router.replace(`/workspace/chat?projectId=${encodeURIComponent(fallbackProjectId)}`);
      } catch {
        // Keep current state when project lookup fails; send handler will surface a clear error.
      }
    };

    void resolveProjectFromApi();

    return () => {
      cancelled = true;
    };
  }, [queryProjectId, router]);

  const activeDoc = useMemo(
    () => openDocs.find((doc) => doc.id === activeDocId) ?? null,
    [openDocs, activeDocId]
  );

  const openDoc = useCallback((doc: WorkspaceDoc) => {
    const existingMatch = openDocs.find(
      (item) => item.id === doc.id || (Boolean(doc.fileId) && item.fileId === doc.fileId)
    );
    const isSameActiveDoc = Boolean(
      activeDoc && (activeDoc.id === doc.id || (Boolean(doc.fileId) && activeDoc.fileId === doc.fileId))
    );
    const nextUrl = doc.url ?? existingMatch?.url;
    const shouldShowPdfLoading = doc.kind === 'pdf' && (!isSameActiveDoc || nextUrl !== activeDoc?.url);
    setViewerLoading(shouldShowPdfLoading);

    setOpenDocs((current) => {
      const existingIndex = current.findIndex(
        (item) => item.id === doc.id || (Boolean(doc.fileId) && item.fileId === doc.fileId)
      );
      if (existingIndex === -1) {
        return [...current, doc];
      }

      const next = [...current];
      const existing = next[existingIndex];
      next[existingIndex] = {
        ...existing,
        ...doc,
        url: doc.url ?? existing.url,
      };
      return next;
    });

    setActiveDocId(doc.id);
  }, [activeDoc, openDocs]);

  useEffect(() => {
    if (!activeDoc || activeDoc.kind !== 'pdf') {
      setViewerLoading(false);
      setActivePdfPage(undefined);
      setDisplayedPdfPage(undefined);
      setPdfPageCount(0);
      setPdfRenderError(null);
      return;
    }

    setPdfRenderError(null);
    setActivePdfPage(activeDoc.page);
  }, [activeDoc]);

  const jumpToPdfPage = useCallback((page?: number) => {
    if (typeof page !== 'number') {
      return;
    }

    setActivePdfPage((current) => (current === page ? current : page));
  }, []);

  const runViewerSearch = useCallback(async (rawTerm?: string) => {
    const term = (rawTerm ?? viewerSearchInputRef.current?.value ?? '').trim();
    if (!term) {
      setViewerSearchAppliedTerm('');
      setViewerSearchResults([]);
      setViewerSearchError(null);
      return;
    }

    if (!activeDoc) {
      setViewerSearchResults([]);
      setViewerSearchError('Open a document first, then run search.');
      return;
    }

    setViewerSearchBusy(true);
    setViewerSearchAppliedTerm(term);
    setViewerSearchError(null);

    try {
      if (activeDoc.kind === 'txt') {
        const text = activeDoc.text ?? '';
        const lowered = text.toLowerCase();
        const loweredTerm = term.toLowerCase();
        const hits: ViewerSearchHit[] = [];
        let cursor = 0;

        while (cursor < lowered.length && hits.length < 25) {
          const next = lowered.indexOf(loweredTerm, cursor);
          if (next === -1) {
            break;
          }
          const start = Math.max(0, next - 60);
          const end = Math.min(text.length, next + loweredTerm.length + 90);
          const excerpt = `${start > 0 ? '...' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '...' : ''}`;
          hits.push({
            id: `txt-hit-${next}`,
            chunkIndex: hits.length + 1,
            excerpt,
          });
          cursor = next + loweredTerm.length;
        }

        setViewerSearchResults(hits);
        if (hits.length === 0) {
          setViewerSearchError(`No matches found for "${term}" in this document.`);
        }
        return;
      }

      if (!activeDoc.fileId || !projectId) {
        setViewerSearchResults([]);
        setViewerSearchError('Indexed search is unavailable for this document.');
        return;
      }

      const activeFileId = activeDoc.fileId;

      const cached = docDetailCacheRef.current.get(activeFileId);
      const detail = cached
        ? cached
        : await (async () => {
            const response = await fetch(
              `/api/files/${encodeURIComponent(activeFileId)}?projectId=${encodeURIComponent(projectId)}`,
              { method: 'GET', cache: 'no-store' }
            );

            if (!response.ok) {
              throw new Error(`Document search failed (${response.status}).`);
            }

            const payload = (await response.json()) as DocumentDetailResponse;
            docDetailCacheRef.current.set(activeFileId, payload);
            return payload;
          })();
      const loweredTerm = term.toLowerCase();
      const hits = (detail.chunks ?? [])
        .filter((chunk) => chunk.chunkText.toLowerCase().includes(loweredTerm))
        .slice(0, 25)
        .map((chunk) => ({
          id: `${chunk.chunkIndex}-${chunk.pageNumber ?? 'na'}`,
          chunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          excerpt: buildChunkExcerpt(chunk.chunkText, term),
        }));

      setViewerSearchResults(hits);
      if (hits.length === 0) {
        setViewerSearchError(`No matches found for "${term}" in indexed text.`);
      }

      const firstPageHit = hits.find((hit) => typeof hit.pageNumber === 'number');
      if (firstPageHit && activeDoc.kind === 'pdf') {
        jumpToPdfPage(firstPageHit.pageNumber);
      }
    } catch (error) {
      setViewerSearchResults([]);
      setViewerSearchError(error instanceof Error ? error.message : 'Search failed.');
    } finally {
      setViewerSearchBusy(false);
    }
  }, [activeDoc, jumpToPdfPage, projectId]);

  const resolveProjectFileIdByName = useCallback(async (fileName: string): Promise<string | undefined> => {
    if (!projectId) {
      return undefined;
    }

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/files?search=${encodeURIComponent(fileName)}&page=1&pageSize=50`,
        {
          method: 'GET',
          cache: 'no-store',
        }
      );

      if (!response.ok) {
        return undefined;
      }

      const payload = (await response.json()) as ProjectFilesListResponse;
      const exact = payload.files.find((file) => file.fileName.toLowerCase() === fileName.toLowerCase());
      if (exact) {
        return exact.id;
      }

      return payload.files[0]?.id;
    } catch {
      return undefined;
    }
  }, [projectId]);

  const openOrCreateDoc = useCallback(async (fileName: string, page?: number, fileId?: string) => {
    let resolvedFileId = fileId;
    if (!resolvedFileId && detectDocKind(fileName) === 'pdf') {
      resolvedFileId = await resolveProjectFileIdByName(fileName);
    }

    const existing = openDocs.find((doc) =>
      (resolvedFileId && doc.fileId === resolvedFileId) || doc.title.toLowerCase() === fileName.toLowerCase()
    )
      ?? DOC_LIBRARY.find((doc) => doc.title.toLowerCase() === fileName.toLowerCase());

    const previewUrl = resolvedFileId && projectId ? buildProjectFileContentUrl(projectId, resolvedFileId) : undefined;

    const doc = existing
      ? {
          ...existing,
          fileId: resolvedFileId ?? existing.fileId,
          page: page ?? existing.page,
            searchTerm: existing.searchTerm,
          url: previewUrl ?? existing.url,
        }
      : createDocFromFileName(fileName, { projectId: projectId ?? undefined, fileId: resolvedFileId });

    openDoc(doc);
  }, [openDoc, openDocs, projectId, resolveProjectFileIdByName]);

  useEffect(() => {
    document.body.classList.add('workspace-mode');

    return () => {
      document.body.classList.remove('workspace-mode');
    };
  }, []);

  useEffect(() => {
    const cached = window.localStorage.getItem(`workspace-chat-${projectId}`);
    if (!cached) {
      setMessages([
        {
          id: uid('m'),
          role: 'assistant',
          content:
            'Workspace memory restored. I can open docs, cross-reference clauses, and summarize critical findings with citation chips.',
        },
      ]);
      return;
    }

    try {
      const parsed = JSON.parse(cached) as Array<ChatMessage & { references?: Array<ChatReference | string> }>;
      const normalized = parsed.map((message) => ({
        ...message,
        references: Array.isArray(message.references)
          ? message.references.map((reference) =>
              typeof reference === 'string'
                ? { fileName: reference }
                : reference
            )
          : undefined,
      }));
      setMessages(normalized);
    } catch {
      setMessages([]);
    }
  }, [projectId]);

  useEffect(() => {
    if (messages.length > 0) {
      window.localStorage.setItem(`workspace-chat-${projectId}`, JSON.stringify(messages));
    }
  }, [messages, projectId]);

  useEffect(() => {
    const loadSession = async () => {
      setChatError(null);

      try {
        const response = await fetch('/api/chat/sessions', { method: 'GET' });
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as ChatSessionsListResponse;
        const matching = (payload.sessions ?? [])
          .filter((session) => session.projectId === projectId)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        setChatSessionId(matching[0]?.id ?? null);
      } catch {
        setChatSessionId(null);
      }
    };

    void loadSession();
  }, [projectId]);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  const handleBackToDashboard = useCallback(() => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();

      // If there is no in-app history entry, fall back to the dashboard route.
      window.setTimeout(() => {
        if (window.location.pathname.startsWith('/workspace/chat')) {
          router.push(dashboardHref);
        }
      }, 140);
      return;
    }

    router.push(dashboardHref);
  }, [dashboardHref, router]);

  // Cycle status messages while waiting for AI response
  useEffect(() => {
    if (!isTyping) {
      setStatusMessage('');
      return;
    }
    const steps = [
      'Searching project files\u2026',
      'Reading indexed context\u2026',
      'Analyzing document graph\u2026',
      'Composing response\u2026',
    ];
    let idx = 0;
    setStatusMessage(steps[0]);
    const interval = window.setInterval(() => {
      idx = (idx + 1) % steps.length;
      setStatusMessage(steps[idx]);
    }, 1800);
    return () => window.clearInterval(interval);
  }, [isTyping]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!isDraggingDivider || !panelRootRef.current) {
        return;
      }

      const rect = panelRootRef.current.getBoundingClientRect();
      const ratio = ((event.clientX - rect.left) / rect.width) * 100;
      setPanelRatio(Math.max(28, Math.min(72, ratio)));
    };

    const handleMouseUp = () => setIsDraggingDivider(false);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingDivider]);

  const handleCloseTab = (docId: string) => {
    setOpenDocs((current) => {
      const next = current.filter((doc) => doc.id !== docId);

      if (activeDocId === docId) {
        const lastDoc = next.length > 0 ? next[next.length - 1] : null;
        setActiveDocId(lastDoc?.id ?? null);
      }

      return next;
    });
  };

  const resolveReferencedDocs = (prompt: string): WorkspaceDoc[] => {
    const lowered = prompt.toLowerCase();
    return DOC_LIBRARY.filter((doc) => lowered.includes(doc.title.toLowerCase()));
  };

  // Detect whether the user wants to open/show a document
  const isOpenIntent = (prompt: string): boolean => {
    return /\b(open|show|pull up|display|bring up|view|load|launch|see|look at|find|get)\b/i.test(prompt);
  };

  const parseRequestedPage = (prompt: string): number | undefined => {
    const match = prompt.match(/\bpage\s+(\d+)\b|\bp\.?\s*(\d+)\b|\bslide\s+(\d+)\b/i);
    return match ? Number(match[1] ?? match[2] ?? match[3]) : undefined;
  };

  const ensureChatSession = useCallback(async (): Promise<string> => {
    if (chatSessionId) {
      return chatSessionId;
    }

    if (!projectId) {
      throw new Error('No project selected. Please open a project to start chatting.');
    }

    const response = await fetch('/api/chat/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectId }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Session expired after backend restart — redirect to re-login
        window.location.href = '/login';
        throw new Error('Your session has expired. Redirecting to login...');
      }
      const errBody = await response.json().catch(() => undefined) as { message?: string; error?: string } | undefined;
      throw new Error(errBody?.message ?? errBody?.error ?? `Unable to create a chat session (${response.status}).`);
    }

    const payload = (await response.json()) as CreateChatSessionResponse;
    const sessionId = payload.session?.id;

    if (!sessionId) {
      throw new Error('Chat session setup returned an invalid response.');
    }

    setChatSessionId(sessionId);
    return sessionId;
  }, [chatSessionId, projectId]);

  const streamAssistantMessage = useCallback(async (fullText: string, references: ChatReference[], suggestions?: string[]) => {
    setMessages((current) => [
      ...current,
      {
        id: uid('m'),
        role: 'assistant',
        content: fullText,
        references,
        suggestions,
        isStreaming: false,
      },
    ]);
  }, []);

  const handleSendPrompt = useCallback(async (rawPrompt?: string) => {
    const prompt = (rawPrompt ?? promptInputRef.current?.value ?? '').trim();
    if (!prompt) {
      return;
    }

    if (!rawPrompt && promptInputRef.current) {
      promptInputRef.current.value = '';
    }
    setChatError(null);
    setMessages((current) => [
      ...current,
      {
        id: uid('m'),
        role: 'user',
        content: prompt,
      },
    ]);

    setIsTyping(true);

    const referencedDocs = resolveReferencedDocs(prompt);
    const requestedPage = parseRequestedPage(prompt);
    const wantsOpen = isOpenIntent(prompt);

    // Immediately open any directly-named doc from the library
    if (wantsOpen && referencedDocs.length > 0) {
      openDoc({ ...referencedDocs[0], page: requestedPage });
    }

    try {
      const sessionId = await ensureChatSession();

      // Pass current workspace state as context
      const currentOpenDocs = openDocs.map((d) => ({ fileName: d.title, fileId: d.fileId, page: d.page }));
      const currentActiveDoc = activeDoc?.title;
      const currentActiveDocFileId = activeDoc?.fileId;

      const response = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          message: prompt,
          history: messagesRef.current
            .filter((m) => !m.isStreaming)
            .slice(-8)
            .map((m) => ({ role: m.role, content: m.content })),
          openDocs: currentOpenDocs,
          activeDocFileName: currentActiveDoc,
          activeDocFileId: currentActiveDocFileId,
        }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          throw new Error('Your session has expired. Redirecting to login...');
        }
        const errorPayload = (await response.json().catch(() => undefined)) as
          | { message?: string; error?: string }
          | undefined;
        throw new Error(errorPayload?.message ?? errorPayload?.error ?? 'AI chat request failed.');
      }

      const payload = (await response.json()) as SendChatMessageResponse;
      const responseText = payload.content?.trim() || 'No response content returned.';
      const referencesMap = new Map<string, ChatReference>();

      for (const doc of referencedDocs) {
        referencesMap.set(doc.title.toLowerCase(), {
          fileName: doc.title,
          displayName: doc.title,
          fileId: doc.fileId,
        });
      }
      for (const source of payload.sources ?? []) {
        referencesMap.set(source.fileName.toLowerCase(), {
          fileName: source.fileName,
          displayName: source.displayName,
          fileId: source.fileId,
          suggestedPages: source.suggestedPages,
          bestPage: source.bestPage,
          pageOrigin: source.pageOrigin,
        });
      }
      const references = Array.from(referencesMap.values());

      // The primary source's best page (from AI citation evidence)
      const primaryBestPage = references[0]?.bestPage ?? references[0]?.suggestedPages?.[0];

      // Auto-open best source if open intent or no doc is open
      const shouldAutoOpen = wantsOpen || (!activeDoc && references.length > 0);
      if (shouldAutoOpen && references.length > 0) {
        await openOrCreateDoc(references[0].fileName, requestedPage ?? primaryBestPage, references[0].fileId);
      } else if (payload.autoOpenFileName && !wantsOpen && references.length > 0) {
        // Proactively open the top source when AI finds strong evidence.
        await openOrCreateDoc(references[0].fileName, primaryBestPage, references[0].fileId);
      }

      // If the active doc is already open and the AI cited a specific page, jump to it.
      if (
        !shouldAutoOpen &&
        primaryBestPage &&
        activeDoc?.kind === 'pdf' &&
        references.length > 0 &&
        (activeDoc.fileId === references[0].fileId ||
          activeDoc.title.toLowerCase() === references[0].fileName.toLowerCase())
      ) {
        jumpToPdfPage(primaryBestPage);
      }

      setIsTyping(false);
      await streamAssistantMessage(responseText, references, payload.suggestions);
    } catch (error) {
      setIsTyping(false);
      setChatError(error instanceof Error ? error.message : 'AI chat request failed.');
    }
  }, [activeDoc, ensureChatSession, isOpenIntent, jumpToPdfPage, openDoc, openDocs, openOrCreateDoc, parseRequestedPage, resolveReferencedDocs, streamAssistantMessage]);

  const handlePromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      void handleSendPrompt();
    }

    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void handleSendPrompt();
    }
  };

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInputRef.current?.focus();
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setLeftCollapsed((current) => !current);
      }

      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void handleSendPrompt();
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [handleSendPrompt]);

  const filteredLibrary = useMemo(() => {
    if (!workspaceSearch.trim()) {
      return DOC_LIBRARY;
    }

    const lowered = workspaceSearch.toLowerCase();
    return DOC_LIBRARY.filter((doc) => doc.title.toLowerCase().includes(lowered));
  }, [workspaceSearch]);

  const handleDropFiles = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropActive(false);

    const droppedFiles = Array.from(event.dataTransfer.files);
    for (const file of droppedFiles) {
      const kind = detectDocKind(file.name, file.type);
      if (!kind) {
        continue;
      }

      const objectUrl = URL.createObjectURL(file);
      const nextDoc: WorkspaceDoc = {
        id: uid('d'),
        title: file.name,
        kind,
        url: objectUrl,
        source: 'dropped',
      };

      if (kind === 'txt') {
        nextDoc.text = await file.text();
      }

      openDoc(nextDoc);
    }
  };

  const renderDocumentBody = () => {
    if (!activeDoc) {
      return (
        <div className="flex h-full min-h-[360px] items-center justify-center rounded-2xl border border-dashed border-slate-700 bg-slate-900/50">
          <p className="text-lg font-medium text-slate-300">Ask AI to open a document</p>
        </div>
      );
    }

    if (viewerLoading && activeDoc.kind !== 'pdf') {
      return (
        <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <div className="h-6 w-52 animate-pulse rounded bg-slate-700/70" />
          <div className="h-56 animate-pulse rounded-xl bg-slate-800/80" />
          <div className="h-4 w-72 animate-pulse rounded bg-slate-700/50" />
        </div>
      );
    }

    if (activeDoc.kind === 'pdf') {
      if (!activeDoc.url) {
        return (
          <div className="flex h-[66vh] flex-col justify-center rounded-xl border border-slate-700 bg-slate-900/80 p-6 text-slate-300">
            <h4 className="text-lg font-semibold text-slate-100">PDF Preview Unavailable</h4>
            <p className="mt-2 text-sm text-slate-400">
              This referenced PDF was opened from chat citations, but no preview URL is available yet.
            </p>
            <p className="mt-2 text-sm text-slate-400">
              File: <span className="font-medium text-slate-200">{activeDoc.title}</span>
            </p>
          </div>
        );
      }

      const activePage = Math.min(Math.max(activePdfPage ?? activeDoc.page ?? 1, 1), Math.max(pdfPageCount, 1));
      const thumbStart = Math.max(1, activePage - 3);
      const thumbEnd = Math.min(Math.max(pdfPageCount, 1), thumbStart + 6);
      const thumbPages = Array.from({ length: Math.max(thumbEnd - thumbStart + 1, 0) }, (_, index) => thumbStart + index);

      return (
        <div className="flex h-full gap-3">
          <aside className="hidden w-16 shrink-0 space-y-2 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/80 p-2 lg:block">
            {thumbPages.map((page) => {
              return (
                <button
                  key={`thumb-${page}`}
                  type="button"
                  onClick={() => setActivePdfPage(page)}
                  className={`h-14 w-full rounded-md border text-xs ${
                    activePage === page
                      ? 'border-blue-400 bg-blue-500/25 text-blue-100'
                      : 'border-slate-700 bg-slate-800 text-slate-300'
                  }`}
                >
                  Pg {page}
                </button>
              );
            })}
          </aside>
          <div className="flex flex-col gap-1.5">
          <div className="relative h-[66vh] w-full overflow-hidden rounded-xl border border-slate-700 bg-slate-950">
            {viewerLoading ? (
              <div className="absolute inset-0 z-10 space-y-3 bg-slate-950/80 p-5">
                <div className="h-6 w-52 animate-pulse rounded bg-slate-700/70" />
                <div className="h-56 animate-pulse rounded-xl bg-slate-800/80" />
                <div className="h-4 w-72 animate-pulse rounded bg-slate-700/50" />
              </div>
            ) : null}
            <PdfViewer
              url={activeDoc.url}
              docKey={activeDoc.id}
              targetPage={activePage}
              zoom={pdfZoom}
              onVisiblePageChange={(page) => setDisplayedPdfPage(page)}
              onPageCount={(count) => {
                setPdfPageCount(count);
                setActivePdfPage((current) => {
                  const next = current ?? activeDoc.page ?? 1;
                  return Math.min(Math.max(next, 1), count);
                });
                setPdfRenderError(null);
              }}
              onReady={() => setViewerLoading(false)}
            />
          </div>
          {/* Page indicator */}
          <div className="flex items-center justify-center gap-2 rounded-b-xl border border-t-0 border-slate-700 bg-slate-900/80 px-3 py-1.5">
            <button
              type="button"
              disabled={activePage <= 1}
              onClick={() => setActivePdfPage(Math.max(1, activePage - 1))}
              className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-700 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="Previous page"
            >
              ‹
            </button>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const input = (e.currentTarget.elements.namedItem('pageInput') as HTMLInputElement);
                const val = Number.parseInt(input.value, 10);
                if (Number.isFinite(val) && val >= 1 && val <= pdfPageCount) {
                  setActivePdfPage(val);
                } else {
                  input.value = String(activePage);
                }
              }}
              className="flex items-center gap-1.5 text-sm text-slate-300"
            >
              <input
                name="pageInput"
                key={displayedPdfPage ?? activePage}
                defaultValue={displayedPdfPage ?? activePage}
                type="number"
                min={1}
                max={pdfPageCount || 1}
                className="w-12 rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 text-center text-sm text-slate-100 [appearance:textfield] focus:border-blue-500 focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                aria-label="Current page"
              />
              <span className="text-slate-500">/</span>
              <span className="min-w-[1.5rem] text-center text-slate-400">{pdfPageCount || '—'}</span>
            </form>
            <button
              type="button"
              disabled={activePage >= pdfPageCount}
              onClick={() => setActivePdfPage(Math.min(pdfPageCount, activePage + 1))}
              className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-700 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="Next page"
            >
              ›
            </button>
          </div>
          </div>
        </div>
      );
    }

    if (activeDoc.kind === 'txt') {
      return (
        <div className="h-[66vh] overflow-auto rounded-xl border border-slate-700 bg-slate-950 p-4 font-mono text-sm leading-7 text-slate-200">
          {highlightText(activeDoc.text ?? 'No text available.', viewerSearchAppliedTerm)}
        </div>
      );
    }

    if (activeDoc.kind === 'image') {
      return (
        <div className="flex h-[66vh] items-center justify-center overflow-hidden rounded-xl border border-slate-700 bg-slate-950 p-3">
          <img
            src={activeDoc.url}
            alt={activeDoc.title}
            className="max-h-full w-auto rounded-lg object-contain shadow-2xl"
          />
        </div>
      );
    }

    return (
      <div className="flex h-[66vh] flex-col justify-center rounded-xl border border-slate-700 bg-slate-900/80 p-6 text-slate-300">
        <h4 className="text-lg font-semibold text-slate-100">Preview Ready</h4>
        <p className="mt-2 text-sm text-slate-400">
          {activeDoc.kind === 'docx'
            ? 'DOCX rendering is available in the full backend integration. For now, metadata and citation linking are enabled.'
            : 'Excel preview is staged. AI can still read and cite this file during response composition.'}
        </p>
      </div>
    );
  };

  const leftWidth = leftCollapsed ? '0%' : `${panelRatio}%`;
  const rightWidth = leftCollapsed ? '100%' : `${100 - panelRatio}%`;

  const markdownComponents = useMemo(() => ({
    h1({ children }: { children?: ReactNode }) {
      return <h1 className="mb-2 mt-1 text-base font-bold text-slate-100">{children}</h1>;
    },
    h2({ children }: { children?: ReactNode }) {
      return <h2 className="mb-2 mt-1 text-sm font-bold text-slate-100">{children}</h2>;
    },
    h3({ children }: { children?: ReactNode }) {
      return <h3 className="mb-1.5 mt-1 text-sm font-semibold text-slate-200">{children}</h3>;
    },
    ul({ children }: { children?: ReactNode }) {
      return <ul className="mb-1 mt-1 space-y-1 pl-4">{children}</ul>;
    },
    ol({ children }: { children?: ReactNode }) {
      return <ol className="mb-1 mt-1 list-decimal space-y-1 pl-5 text-sm text-slate-200">{children}</ol>;
    },
    li({ children }: { children?: ReactNode }) {
      if (!hasRenderableListItemText(children)) {
        return null;
      }

      return (
        <li className="flex gap-2 text-sm leading-5 text-slate-200">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" />
          <span>{children}</span>
        </li>
      );
    },
    p({ children }: { children?: ReactNode }) {
      return <p className="text-sm leading-6 text-slate-200">{children}</p>;
    },
    strong({ children }: { children?: ReactNode }) {
      return <strong className="font-semibold text-slate-100">{children}</strong>;
    },
    code({ className, children }: { className?: string; children?: ReactNode }) {
      const codeText = String(children).replace(/\n$/, '');

      if (className && className.includes('language-')) {
        return <CodeBlock code={codeText} />;
      }

      return <code className="rounded bg-slate-800 px-1 py-0.5 text-xs">{children}</code>;
    },
  }), []);

  const renderedChatMessages = useMemo(() => messages.map((message) => {
    const isAssistant = message.role === 'assistant';

    return (
      <motion.div
        key={message.id}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className={`flex ${isAssistant ? 'justify-start' : 'justify-end'}`}
      >
        <div
          className={`max-w-[88%] rounded-2xl border px-4 py-3 ${
            isAssistant
              ? 'border-slate-700 bg-slate-900 text-slate-100'
              : 'border-blue-400/40 bg-blue-500/20 text-blue-50'
          }`}
        >
          {isAssistant ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {sanitizeAssistantMarkdown(message.content)}
            </ReactMarkdown>
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>
          )}

          {message.references?.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {message.references.map((reference) => (
                <button
                  key={`${message.id}-${reference.fileId ?? reference.fileName}`}
                  type="button"
                  onClick={() => {
                    const trustedSuggestedPages =
                      reference.pageOrigin === 'exact' ? reference.suggestedPages : undefined;
                    void openOrCreateDoc(
                      reference.fileName,
                      reference.pageOrigin === 'exact'
                        ? (reference.bestPage ?? trustedSuggestedPages?.[0])
                        : undefined,
                      reference.fileId
                    );
                  }}
                  className="rounded-full border border-blue-400/50 bg-blue-500/15 px-2.5 py-1 text-xs text-blue-100 transition hover:bg-blue-500/30"
                >
                  {reference.displayName ?? reference.fileName}
                  {reference.pageOrigin === 'exact' && reference.suggestedPages && reference.suggestedPages.length > 0
                    ? ` (p. ${reference.suggestedPages.join(", ")})`
                    : ""}
                </button>
              ))}
            </div>
          ) : null}

          {!message.isStreaming && message.suggestions?.length ? (
            <div className="mt-3 border-t border-slate-700/60 pt-3">
              <p className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">Next steps</p>
              <div className="flex flex-wrap gap-1.5">
                {message.suggestions.map((suggestion) => (
                  <button
                    key={`${message.id}-sug-${suggestion}`}
                    type="button"
                    onClick={() => void handleSendPrompt(suggestion)}
                    className="rounded-full border border-slate-600 bg-slate-800/80 px-2.5 py-1 text-xs text-slate-300 transition hover:border-blue-400 hover:text-blue-100"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {message.isStreaming ? (
            <span className="mt-2 inline-flex h-2 w-2 animate-pulse rounded-full bg-blue-400" />
          ) : null}
        </div>
      </motion.div>
    );
  }), [handleSendPrompt, markdownComponents, messages, openOrCreateDoc]);

  return (
    <div className="workspace-root min-h-screen bg-workspace-950 text-slate-100">
      <div className="pointer-events-none absolute inset-0 bg-transparent" />

      <header className="relative z-10 flex h-16 items-center justify-between border-b border-slate-800/90 px-4 md:px-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleBackToDashboard}
            className="rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 transition hover:border-blue-400"
          >
            Back
          </button>
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/90 text-sm font-semibold text-white shadow-glow">
            AI
          </div>
          <div>
            <p className="text-sm font-semibold tracking-wide text-slate-100">Contractor Workspace</p>
            <p className="text-xs text-slate-400">Project {projectId}</p>
          </div>
        </div>

        <div className="mx-4 hidden flex-1 md:block md:max-w-xl">
          <label className="relative block">
            <span className="pointer-events-none absolute left-3 top-2.5 text-xs text-slate-500">Search (Ctrl+K)</span>
            <input
              ref={searchInputRef}
              value={workspaceSearch}
              onChange={(event) => setWorkspaceSearch(event.target.value)}
              className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900/90 px-3 pt-4 text-sm text-slate-100 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/40"
              placeholder=""
            />
          </label>
        </div>

        <div className="flex items-center gap-2">
          <button type="button" className="toolbar-icon" aria-label="Notifications">
            N
          </button>
          <button type="button" className="toolbar-icon" aria-label="Settings">
            S
          </button>
          <div className="h-9 w-9 rounded-full border border-slate-600 bg-slate-800 text-center text-xs leading-9 text-slate-200">
            GK
          </div>
        </div>
      </header>

      <main className="relative z-10 p-3 md:p-4">
        <div
          ref={panelRootRef}
          className="flex h-[calc(100vh-5.6rem)] flex-col gap-3 md:flex-row md:gap-0"
        >
          <motion.section
            animate={{ width: leftWidth, opacity: leftCollapsed ? 0 : 1 }}
            transition={{ type: 'spring', stiffness: 220, damping: 28 }}
            className={`workspace-panel overflow-hidden rounded-panel border border-slate-800 bg-workspace-900/90 shadow-panel ${
              leftCollapsed ? 'hidden md:block' : 'block'
            }`}
            style={{ width: leftWidth }}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDropActive(true);
            }}
            onDragLeave={() => setIsDropActive(false)}
            onDrop={handleDropFiles}
          >
            <div className="flex h-full flex-col">
              <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2">
                <button
                  type="button"
                  onClick={() => setLeftCollapsed(true)}
                  className="rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 transition hover:border-blue-400"
                >
                  Collapse (Ctrl+B)
                </button>
                <input
                  ref={viewerSearchInputRef}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void runViewerSearch(event.currentTarget.value);
                    }
                  }}
                  placeholder="Search in document"
                  className="min-w-[160px] flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-blue-400"
                />
                <button
                  type="button"
                  onClick={() => void runViewerSearch()}
                  className="rounded border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 transition hover:border-blue-400"
                >
                  {viewerSearchBusy ? 'Finding...' : 'Find'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (viewerSearchInputRef.current) {
                      viewerSearchInputRef.current.value = '';
                    }
                    setViewerSearchAppliedTerm('');
                    setViewerSearchResults([]);
                    setViewerSearchError(null);
                  }}
                  className="rounded border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 transition hover:border-blue-400"
                >
                  Clear
                </button>
                {activeDoc?.kind === 'pdf' ? (
                  <div className="flex items-center gap-1 text-xs text-slate-300">
                    <button
                      type="button"
                      onClick={() => setPdfZoom((current) => Math.max(60, current - 10))}
                      className="rounded border border-slate-700 bg-slate-800 px-2 py-1"
                    >
                      -
                    </button>
                    <span className="w-10 text-center">{pdfZoom}%</span>
                    <button
                      type="button"
                      onClick={() => setPdfZoom((current) => Math.min(220, current + 10))}
                      className="rounded border border-slate-700 bg-slate-800 px-2 py-1"
                    >
                      +
                    </button>
                  </div>
                ) : null}
              </div>

              {(viewerSearchAppliedTerm || viewerSearchError) ? (
                <div className="max-h-36 overflow-y-auto border-b border-slate-800 bg-slate-900/85 px-3 py-2">
                  {viewerSearchError ? (
                    <p className="text-xs text-rose-300">{viewerSearchError}</p>
                  ) : null}
                  {!viewerSearchError && viewerSearchResults.length > 0 ? (
                    <>
                      <p className="mb-2 text-xs text-slate-300">
                        {viewerSearchResults.length} match{viewerSearchResults.length === 1 ? '' : 'es'} for "{viewerSearchAppliedTerm}"
                      </p>
                      <div className="space-y-1">
                        {viewerSearchResults.map((hit) => (
                          <button
                            key={hit.id}
                            type="button"
                            onClick={() => {
                              if (!activeDoc) {
                                return;
                              }
                              if (typeof hit.pageNumber === 'number') {
                                jumpToPdfPage(hit.pageNumber);
                              }
                            }}
                            className="block w-full rounded border border-slate-700 bg-slate-800/90 px-2 py-1 text-left text-xs text-slate-200 transition hover:border-blue-400"
                          >
                            <span className="mr-2 text-blue-300">
                              {typeof hit.pageNumber === 'number' ? `p.${hit.pageNumber}` : `chunk ${hit.chunkIndex}`}
                            </span>
                            <span>{hit.excerpt}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}

              <div className="border-b border-slate-800 bg-slate-900/70 px-2 py-1.5">
                <div className="flex gap-1 overflow-x-auto whitespace-nowrap">
                  {openDocs.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      onClick={() => setActiveDocId(doc.id)}
                      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition ${
                        doc.id === activeDocId
                          ? 'border-blue-400 bg-blue-500/20 text-blue-100'
                          : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500'
                      }`}
                    >
                      <span>{doc.title}</span>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleCloseTab(doc.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.stopPropagation();
                            handleCloseTab(doc.id);
                          }
                        }}
                        className="rounded px-1 text-slate-400 hover:bg-slate-700 hover:text-slate-100"
                      >
                        x
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="relative flex-1 overflow-hidden p-3">{renderDocumentBody()}</div>

              <div className="border-t border-slate-800 p-3">
                <p className="mb-2 text-xs uppercase tracking-[0.22em] text-slate-500">Available Files</p>
                <div className="flex flex-wrap gap-2">
                  {filteredLibrary.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      onClick={() => openDoc(doc)}
                      className="rounded-full border border-slate-700 bg-slate-800/90 px-3 py-1 text-xs text-slate-200 transition hover:border-blue-400"
                    >
                      {doc.title}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <AnimatePresence>
              {isDropActive ? (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="pointer-events-none absolute inset-0 m-3 flex items-center justify-center rounded-panel border-2 border-dashed border-blue-400 bg-slate-900/75"
                >
                  <p className="text-sm font-semibold text-blue-100">Drop files to open in viewer</p>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </motion.section>

          <div
            className="hidden w-2 cursor-col-resize items-center justify-center bg-transparent md:flex"
            onMouseDown={() => setIsDraggingDivider(true)}
          >
            <div className="h-24 w-1 rounded bg-slate-700/80" />
          </div>

          <motion.section
            animate={{ width: rightWidth }}
            transition={{ type: 'spring', stiffness: 220, damping: 28 }}
            className="workspace-panel flex-1 overflow-hidden rounded-panel border border-slate-800 bg-workspace-900/90 shadow-panel"
            style={{ width: rightWidth }}
          >
            <div className="flex h-full flex-col">
              <div ref={chatScrollRef} className="chat-scroll flex-1 space-y-4 overflow-y-auto p-4">
                {renderedChatMessages}

                {isTyping ? (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-2 rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3">
                      <div className="typing-dots">
                        <span />
                        <span />
                        <span />
                      </div>
                      {statusMessage ? (
                        <span className="text-xs text-slate-400">{statusMessage}</span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="border-t border-slate-800 p-3 md:p-4">
                <div className="mb-3 flex flex-wrap gap-2">
                  {SUGGESTED_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => {
                        if (promptInputRef.current) {
                          promptInputRef.current.value = prompt;
                        }
                        promptInputRef.current?.focus();
                      }}
                      className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-xs text-slate-200 transition hover:border-blue-400 hover:text-blue-100"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>

                <form
                  onSubmit={(event: FormEvent) => {
                    event.preventDefault();
                    void handleSendPrompt();
                  }}
                  className="rounded-2xl border border-slate-700 bg-slate-900/90 p-2"
                >
                  {chatError ? <p className="px-2 pb-2 text-xs text-rose-300">{chatError}</p> : null}
                  <textarea
                    ref={promptInputRef}
                    onKeyDown={handlePromptKeyDown}
                    className="min-h-[120px] w-full resize-none rounded-xl border border-transparent bg-slate-900 p-3 text-sm leading-6 text-slate-100 outline-none transition focus:border-blue-400"
                    placeholder="Ask AI to analyze, compare, summarize, and cite relevant project documents..."
                  />
                  <div className="flex items-center justify-between gap-2 p-2">
                    <div className="flex items-center gap-2">
                      <button type="button" className="toolbar-chip" aria-label="Attach file">
                        Attach
                      </button>
                      <button type="button" className="toolbar-chip" aria-label="Voice input">
                        Voice
                      </button>
                    </div>
                    <button
                      type="submit"
                      className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-400"
                    >
                      Send (Ctrl+Enter)
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </motion.section>
        </div>
      </main>
    </div>
  );
}

export default function ChatWorkspacePage() {
  return (
    <Suspense fallback={null}>
      <ChatWorkspacePageContent />
    </Suspense>
  );
}
