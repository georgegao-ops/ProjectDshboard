'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ============================================================
// Types (mirror backend response shapes)
// ============================================================

interface IndexingProgress {
  total: number;
  pending: number;
  processing: number;
  indexed: number;
  failed: number;
  completionPercent: number;
  categoryBreakdown: Record<string, number>;
  recentErrors: Array<{
    fileName: string;
    stage: string;
    errorMessage: string;
    createdAt: string;
  }>;
}

interface ProjectOption {
  id: string;
  name: string;
  status: string;
}

// ============================================================
// Constants
// ============================================================

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const CATEGORY_LABELS: Record<string, string> = {
  drawing:        '📐 Drawings',
  rfi:            '❓ RFIs',
  submittal:      '📋 Submittals',
  change_order:   '🔄 Change Orders',
  contract:       '📝 Contracts',
  schedule:       '📅 Schedules',
  spec:           '📖 Specifications',
  meeting_minutes:'🗒️ Meeting Minutes',
  permit:         '🏛️ Permits',
  invoice:        '💰 Invoices',
  safety:         '⛑️ Safety Docs',
  photo:          '📷 Photos',
  report:         '📊 Reports',
  correspondence: '✉️ Correspondence',
  unknown:        '❔ Unclassified',
};

const CATEGORY_COLORS: Record<string, string> = {
  drawing:        '#3b82f6',
  rfi:            '#ef4444',
  submittal:      '#f59e0b',
  change_order:   '#8b5cf6',
  contract:       '#10b981',
  schedule:       '#06b6d4',
  spec:           '#6366f1',
  meeting_minutes:'#ec4899',
  permit:         '#84cc16',
  invoice:        '#f97316',
  safety:         '#e11d48',
  photo:          '#0ea5e9',
  report:         '#14b8a6',
  correspondence: '#a855f7',
  unknown:        '#6b7280',
};

const POLL_INTERVAL_MS = 4000;

// ============================================================
// API helpers
// ============================================================

async function apiFetch<T>(path: string, token: string | null): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ============================================================
// Sub-components
// ============================================================

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max === 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div style={{ background: '#e5e7eb', borderRadius: 6, height: 8, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, background: color, height: '100%', transition: 'width 0.4s ease', borderRadius: 6 }} />
    </div>
  );
}

function StatCard({ label, value, color, sublabel }: { label: string; value: number | string; color: string; sublabel?: string }) {
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #e5e7eb',
      borderRadius: 12,
      padding: '20px 24px',
      minWidth: 140,
      flex: '1 1 140px',
    }}>
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginTop: 4 }}>{label}</div>
      {sublabel && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sublabel}</div>}
    </div>
  );
}

function CategoryBar({ category, count, total }: { category: string; count: number; total: number }) {
  const label = CATEGORY_LABELS[category] ?? category;
  const color = CATEGORY_COLORS[category] ?? '#6b7280';
  const pct = total === 0 ? 0 : Math.round((count / total) * 100);

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: '#374151' }}>{label}</span>
        <span style={{ fontSize: 12, color: '#6b7280' }}>{count} ({pct}%)</span>
      </div>
      <div style={{ background: '#f3f4f6', borderRadius: 4, height: 6, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, background: color, height: '100%', transition: 'width 0.4s ease', borderRadius: 4 }} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    indexed:    { bg: '#d1fae5', text: '#065f46' },
    processing: { bg: '#dbeafe', text: '#1e40af' },
    pending:    { bg: '#fef3c7', text: '#92400e' },
    failed:     { bg: '#fee2e2', text: '#991b1b' },
  };
  const style = colors[status] ?? { bg: '#f3f4f6', text: '#374151' };
  return (
    <span style={{
      background: style.bg,
      color: style.text,
      borderRadius: 99,
      padding: '2px 10px',
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'capitalize',
    }}>
      {status}
    </span>
  );
}

// ============================================================
// Main Dashboard Component
// ============================================================

export default function IndexingDashboard() {
  const [token, setToken] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [progress, setProgress] = useState<IndexingProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Retrieve stored access token
  useEffect(() => {
    const stored = sessionStorage.getItem('accessToken') ?? localStorage.getItem('accessToken');
    setToken(stored);
  }, []);

  // Load projects list
  useEffect(() => {
    if (!token) return;
    apiFetch<{ projects: ProjectOption[] }>('/api/projects', token).then((data) => {
      if (data?.projects) setProjects(data.projects);
    });
  }, [token]);

  const fetchProgress = useCallback(async (projectId: string) => {
    if (!projectId || !token) return;
    setLoading(true);
    const data = await apiFetch<IndexingProgress>(
      `/api/projects/${projectId}/indexing/progress`,
      token
    );
    if (data) {
      setProgress(data);
      setLastUpdated(new Date());
    }
    setLoading(false);
  }, [token]);

  // Auto-poll when a project is selected
  useEffect(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    if (!selectedProjectId || !isPolling) return;

    void fetchProgress(selectedProjectId);
    pollingRef.current = setInterval(() => void fetchProgress(selectedProjectId), POLL_INTERVAL_MS);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [selectedProjectId, isPolling, fetchProgress]);

  const handleProjectChange = (id: string) => {
    setSelectedProjectId(id);
    setProgress(null);
    if (id) {
      setIsPolling(true);
      void fetchProgress(id);
    } else {
      setIsPolling(false);
    }
  };

  const totalIndexed = progress?.indexed ?? 0;
  const totalCount = progress?.total ?? 0;
  const sortedCategories = progress
    ? Object.entries(progress.categoryBreakdown).sort((a, b) => b[1] - a[1])
    : [];

  // Estimate completion time
  function estimateCompletion(): string {
    if (!progress || progress.completionPercent >= 100) return '—';
    if (progress.pending + progress.processing === 0) return 'Complete';
    // rough: if X% done in POLL seconds, estimate remaining
    const remaining = progress.pending + progress.processing;
    const minutesLeft = Math.ceil(remaining * 0.4); // ~0.4 min per file at batch=5
    if (minutesLeft < 60) return `~${minutesLeft} min`;
    return `~${Math.ceil(minutesLeft / 60)} hrs`;
  }

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', maxWidth: 1100, margin: '0 auto', padding: '32px 24px', color: '#111827' }}>

      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: '#111827' }}>
          🗂️ Document Indexing Dashboard
        </h1>
        <p style={{ fontSize: 14, color: '#6b7280', marginTop: 6 }}>
          Track indexing progress, document categories, and pipeline health.
        </p>
      </div>

      {/* Project Selector */}
      <div style={{ marginBottom: 28 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
          Project
        </label>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <select
            value={selectedProjectId}
            onChange={(e) => handleProjectChange(e.target.value)}
            style={{
              border: '1px solid #d1d5db',
              borderRadius: 8,
              padding: '8px 14px',
              fontSize: 14,
              color: '#111827',
              background: '#fff',
              minWidth: 260,
            }}
          >
            <option value="">Select a project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {selectedProjectId && (
            <button
              onClick={() => void fetchProgress(selectedProjectId)}
              style={{
                background: '#3b82f6',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '8px 18px',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {loading ? 'Refreshing…' : '↺ Refresh'}
            </button>
          )}
          {lastUpdated && (
            <span style={{ fontSize: 12, color: '#9ca3af' }}>
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {!selectedProjectId && (
        <div style={{ textAlign: 'center', color: '#9ca3af', padding: '60px 0', fontSize: 15 }}>
          Select a project to view indexing status.
        </div>
      )}

      {selectedProjectId && !progress && loading && (
        <div style={{ textAlign: 'center', color: '#9ca3af', padding: '60px 0', fontSize: 15 }}>
          Loading…
        </div>
      )}

      {progress && (
        <>
          {/* Overall Progress */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '24px 28px', marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontWeight: 700, fontSize: 16, color: '#111827' }}>Overall Indexing Progress</span>
              <span style={{ fontSize: 28, fontWeight: 800, color: progress.completionPercent === 100 ? '#10b981' : '#3b82f6' }}>
                {progress.completionPercent}%
              </span>
            </div>
            <ProgressBar value={progress.completionPercent} max={100} color={progress.completionPercent === 100 ? '#10b981' : '#3b82f6'} />
            <div style={{ display: 'flex', gap: 24, marginTop: 12, fontSize: 12, color: '#6b7280' }}>
              <span>📁 {totalCount} total files</span>
              <span>⏱️ Est. completion: {estimateCompletion()}</span>
              {progress.failed > 0 && <span style={{ color: '#ef4444' }}>⚠️ {progress.failed} failed</span>}
            </div>
          </div>

          {/* Stat Cards */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
            <StatCard label="Indexed" value={progress.indexed} color="#10b981" sublabel="✓ Fully processed" />
            <StatCard label="Processing" value={progress.processing} color="#3b82f6" sublabel="⚙️ In pipeline" />
            <StatCard label="Pending" value={progress.pending} color="#f59e0b" sublabel="⏳ In queue" />
            <StatCard label="Failed" value={progress.failed} color="#ef4444" sublabel="✗ Check errors" />
          </div>

          {/* Two-column lower section */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>

            {/* Category Breakdown */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '24px 28px' }}>
              <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 18px 0', color: '#111827' }}>
                📊 Document Categories
              </h2>
              {sortedCategories.length === 0 && (
                <p style={{ color: '#9ca3af', fontSize: 13 }}>No documents indexed yet.</p>
              )}
              {sortedCategories.map(([cat, count]) => (
                <CategoryBar key={cat} category={cat} count={count} total={totalIndexed} />
              ))}
            </div>

            {/* Indexing Stage Breakdown */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '24px 28px' }}>
              <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 18px 0', color: '#111827' }}>
                ⚙️ Pipeline Status
              </h2>
              {[
                { label: 'Indexed', value: progress.indexed, color: '#10b981' },
                { label: 'Processing', value: progress.processing, color: '#3b82f6' },
                { label: 'Pending', value: progress.pending, color: '#f59e0b' },
                { label: 'Failed', value: progress.failed, color: '#ef4444' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: '#374151' }}>{label}</span>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>{value} files</span>
                  </div>
                  <ProgressBar value={value} max={totalCount || 1} color={color} />
                </div>
              ))}

              <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 16, marginTop: 16 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 10px 0', color: '#374151' }}>
                  First Value Timeline
                </h3>
                {[
                  { time: '≤ 30 min', label: 'Metadata scan + high-priority docs', done: progress.completionPercent > 5 },
                  { time: '2–6 hrs',  label: 'Core docs indexed, chat active',      done: progress.completionPercent > 40 },
                  { time: 'Overnight', label: 'Full index + relationship graph',    done: progress.completionPercent >= 100 },
                ].map(({ time, label, done }) => (
                  <div key={time} style={{ display: 'flex', gap: 10, marginBottom: 8, alignItems: 'flex-start' }}>
                    <span style={{ fontSize: 16, lineHeight: 1.2 }}>{done ? '✅' : '⬜'}</span>
                    <div>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>{time}: </span>
                      <span style={{ fontSize: 12, color: '#6b7280' }}>{label}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Recent Errors */}
          {progress.recentErrors.length > 0 && (
            <div style={{ background: '#fff5f5', border: '1px solid #fecaca', borderRadius: 12, padding: '20px 28px' }}>
              <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 14px 0', color: '#991b1b' }}>
                ⚠️ Recent Indexing Errors
              </h2>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: '#9ca3af', textAlign: 'left' }}>
                    <th style={{ paddingBottom: 8, fontWeight: 600, paddingRight: 16 }}>File</th>
                    <th style={{ paddingBottom: 8, fontWeight: 600, paddingRight: 16 }}>Stage</th>
                    <th style={{ paddingBottom: 8, fontWeight: 600, paddingRight: 16 }}>Error</th>
                    <th style={{ paddingBottom: 8, fontWeight: 600 }}>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {progress.recentErrors.map((err, i) => (
                    <tr key={i} style={{ borderTop: '1px solid #fecaca' }}>
                      <td style={{ padding: '7px 16px 7px 0', color: '#374151', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{err.fileName}</td>
                      <td style={{ padding: '7px 16px 7px 0' }}><StatusBadge status={err.stage} /></td>
                      <td style={{ padding: '7px 16px 7px 0', color: '#6b7280', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{err.errorMessage}</td>
                      <td style={{ padding: '7px 0', color: '#9ca3af', whiteSpace: 'nowrap' }}>
                        {new Date(err.createdAt).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
