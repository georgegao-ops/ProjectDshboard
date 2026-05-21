'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PdfViewerProps {
  url: string;
  docKey: string;
  targetPage: number;
  zoom: number;
  onPageCount: (count: number) => void;
  onVisiblePageChange?: (page: number) => void;
  onReady: () => void;
}

// Number of pages to initially render
const INITIAL_PAGES = 12;
// Pages to render behind the target when jumping
const RENDER_BEHIND = 2;
// Pages to render ahead of the target when jumping
const RENDER_AHEAD = 10;
// Additional batch when scrolling past the window edge
const LOAD_BATCH = 12;
// Fallback page height (px at 100% zoom, A4 portrait)
const FALLBACK_PAGE_H = 1056;
// gap-3 = 12px between pages
const PAGE_GAP = 12;

export default function PdfViewer({
  url,
  docKey,
  targetPage,
  zoom,
  onPageCount,
  onVisiblePageChange,
  onReady,
}: PdfViewerProps) {
  const [error, setError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  // Virtualized window: only pages [windowStart, windowEnd] are in the DOM.
  // Spacers above/below give the scrollbar full document height.
  const [windowStart, setWindowStart] = useState(1);
  const [windowEnd, setWindowEnd] = useState(0);

  const viewerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Measured average page height — updated after each render batch or zoom change.
  const avgPageHRef = useRef<number>(FALLBACK_PAGE_H);
  // Page we still need to scroll to (set when targetPage changes, cleared after scrollIntoView).
  const pendingScrollRef = useRef<number | null>(null);
  const prevTargetRef = useRef<number>(targetPage);

  // ── Reset on document switch ──────────────────────────────────────────────
  useEffect(() => {
    pageRefs.current.clear();
    avgPageHRef.current = FALLBACK_PAGE_H;
    pendingScrollRef.current = null;
    prevTargetRef.current = 1;
    lastReportedPageRef.current = null;
    setNumPages(0);
    setWindowStart(1);
    setWindowEnd(0);
  }, [docKey]);

  // ── Measure actual page height after each window change or zoom ───────────
  useEffect(() => {
    if (!windowEnd) return;
    let total = 0;
    let count = 0;
    for (const el of pageRefs.current.values()) {
      if (el.offsetHeight > 0) { total += el.offsetHeight; count++; }
    }
    if (count > 0) avgPageHRef.current = total / count;
  }, [windowEnd, zoom]);

  // ── Scroll-to-page: re-center window when target is outside it ───────────
  useEffect(() => {
    if (!numPages || !windowEnd) return;

    const clamped = Math.min(Math.max(targetPage, 1), numPages);

    if (prevTargetRef.current !== clamped) {
      prevTargetRef.current = clamped;
      pendingScrollRef.current = clamped;
    }

    const scrollTo = pendingScrollRef.current;
    if (scrollTo === null) return;

    // If the target is outside the current render window, shift the window to it.
    if (scrollTo < windowStart || scrollTo > windowEnd) {
      const newStart = Math.max(1, scrollTo - RENDER_BEHIND);
      const newEnd   = Math.min(numPages, scrollTo + RENDER_AHEAD);
      setWindowStart(newStart);
      setWindowEnd(newEnd);
      return; // Wait for the window state to settle, then this effect re-runs.
    }

    const node = pageRefs.current.get(scrollTo);
    if (!node) return; // DOM not committed yet — effect will re-run after render.

    pendingScrollRef.current = null;
    node.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [numPages, windowStart, windowEnd, targetPage]);

  // ── Load more pages when approaching the bottom of the render window ──────
  const lastReportedPageRef = useRef<number | null>(null);

  const handleScroll = () => {
    // Update visible page indicator — only fire callback when the page actually changes
    if (onVisiblePageChange) {
      const top = getTopVisiblePage();
      if (top !== null && top !== lastReportedPageRef.current) {
        lastReportedPageRef.current = top;
        onVisiblePageChange(top);
      }
    }

    if (!viewerRef.current || windowEnd >= numPages) return;

    const { scrollTop, clientHeight } = viewerRef.current;
    const avgH = avgPageHRef.current + PAGE_GAP;
    const spacerBefore = Math.max(0, windowStart - 1) * avgH;
    const renderedBottom = spacerBefore + (windowEnd - windowStart + 1) * avgH;

    // Trigger 3 pages before the user reaches the end of rendered content.
    if (scrollTop + clientHeight < renderedBottom - avgH * 3) return;

    // Batch-load enough pages to cover the viewport and beyond, handling large drags.
    const viewportBottom = scrollTop + clientHeight;
    const neededEnd = Math.ceil((viewportBottom + avgH * RENDER_AHEAD - spacerBefore) / avgH) + windowStart - 1;
    const newEnd = Math.min(numPages, Math.max(windowEnd + LOAD_BATCH, neededEnd));
    if (newEnd > windowEnd) setWindowEnd(newEnd);
  };

  // After window expands (e.g. large scrollbar drag), check if we still need more.
  useEffect(() => {
    if (!viewerRef.current || windowEnd >= numPages) return;
    const { scrollTop, clientHeight } = viewerRef.current;
    const avgH = avgPageHRef.current + PAGE_GAP;
    const spacerBefore = Math.max(0, windowStart - 1) * avgH;
    const renderedBottom = spacerBefore + (windowEnd - windowStart + 1) * avgH;
    if (scrollTop + clientHeight >= renderedBottom - avgH * 3) {
      const viewportBottom = scrollTop + clientHeight;
      const neededEnd = Math.ceil((viewportBottom + avgH * RENDER_AHEAD - spacerBefore) / avgH) + windowStart - 1;
      const newEnd = Math.min(numPages, Math.max(windowEnd + LOAD_BATCH, neededEnd));
      if (newEnd > windowEnd) setWindowEnd(newEnd);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowEnd]);

  // ── Visible page tracking (IntersectionObserver) ──────────────────────────
  const renderedPages = useMemo(() => {
    if (!windowEnd || !numPages) return [];
    const start = Math.max(1, windowStart);
    const end   = Math.min(numPages, windowEnd);
    return end >= start
      ? Array.from({ length: end - start + 1 }, (_, i) => start + i)
      : [];
  }, [windowStart, windowEnd, numPages]);

  // Returns the page whose top edge is closest to (but not below) the top of the viewport.
  const getTopVisiblePage = (): number | null => {
    if (!viewerRef.current) return null;
    const viewTop = viewerRef.current.scrollTop;
    let bestPage: number | null = null;
    let bestDist = Infinity;
    for (const [page, node] of pageRefs.current.entries()) {
      const nodeTop = node.offsetTop;
      // Only pages whose top edge is at or above the midpoint of the viewport
      const mid = viewTop + viewerRef.current.clientHeight / 2;
      if (nodeTop > mid) continue;
      const dist = Math.abs(nodeTop - viewTop);
      if (dist < bestDist) { bestDist = dist; bestPage = page; }
    }
    return bestPage;
  };

  useEffect(() => {
    if (!onVisiblePageChange || !renderedPages.length) return;

    // IntersectionObserver with low thresholds so even full-viewport pages fire.
    const observer = new IntersectionObserver(
      (entries) => {
        let bestPage: number | null = null;
        let maxRatio = 0;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const page = Number((entry.target as HTMLElement).dataset.pageNumber);
          if (!Number.isFinite(page)) continue;
          if (entry.intersectionRatio > maxRatio) { maxRatio = entry.intersectionRatio; bestPage = page; }
        }
        if (bestPage !== null) onVisiblePageChange(bestPage);
      },
      { root: viewerRef.current, threshold: [0.01, 0.1, 0.25, 0.5] }
    );
    for (const page of renderedPages) {
      const node = pageRefs.current.get(page);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [onVisiblePageChange, renderedPages]);

  // ── Spacer heights for full-document scrollbar ────────────────────────────
  const avgH = avgPageHRef.current + PAGE_GAP;
  const spacerBeforeH = Math.max(0, windowStart - 1) * avgH;
  const spacerAfterH  = Math.max(0, numPages - windowEnd) * avgH;

  return (
    <Document
      key={docKey}
      file={url}
      loading={null}
      onLoadSuccess={({ numPages: total }) => {
        const initTarget = Math.min(Math.max(targetPage, 1), total);
        prevTargetRef.current = initTarget;
        const initStart = Math.max(1, initTarget - RENDER_BEHIND);
        const initEnd   = Math.min(total, initTarget + RENDER_AHEAD);
        setNumPages(total);
        setWindowStart(initStart);
        setWindowEnd(initEnd);
        if (initTarget > 1) pendingScrollRef.current = initTarget;
        onPageCount(total);
        setError(null);
        onReady();
      }}
      onLoadError={(err) => {
        setNumPages(0);
        setWindowStart(1);
        setWindowEnd(0);
        setError(err instanceof Error ? err.message : 'Unable to load PDF.');
        onReady();
      }}
      className="h-full w-full"
    >
      <div ref={viewerRef} onScroll={handleScroll} className="h-full w-full overflow-auto py-3">
        {error ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-rose-300">
            {error}
          </div>
        ) : (
          <>
            {/* Spacer representing pages above the render window */}
            <div aria-hidden="true" style={{ height: spacerBeforeH }} />
            <div className="flex flex-col items-center gap-3">
              {renderedPages.map((pageNumber) => (
                <div
                  key={`page-${pageNumber}`}
                  ref={(node) => {
                    if (node) pageRefs.current.set(pageNumber, node);
                    else pageRefs.current.delete(pageNumber);
                  }}
                  data-page-number={pageNumber}
                  className="w-full max-w-fit"
                >
                  <Page
                    pageNumber={pageNumber}
                    scale={zoom / 100}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                    loading={null}
                  />
                </div>
              ))}
            </div>
            {/* Spacer representing pages below the render window */}
            <div aria-hidden="true" style={{ height: spacerAfterH }} />
          </>
        )}
      </div>
    </Document>
  );
}
