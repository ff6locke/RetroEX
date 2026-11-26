import { useState } from 'react';
import { Plus, Play, RotateCcw, Trash2 } from 'lucide-react';
import type { MultiTargetRow } from '../types/network';
import {
  formatMs,
  measureBrowserPing,
  normalizeBrowserProbeUrl,
} from '../utils/networkProbes';

const INITIAL_TARGETS: MultiTargetRow[] = [
  {
    id: 'server-edge',
    label: 'App Server Edge (/api/ping)',
    url: '/api/ping',
    category: 'Edge',
    probing: false,
    samples: [],
    failures: 0,
    lastStatus: 'idle',
    lastRttMs: null,
    avgMs: null,
    minMs: null,
    maxMs: null,
    jitterMs: null,
    lastCheckedAt: null,
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare DNS (1.1.1.1)',
    url: 'https://1.1.1.1/cdn-cgi/trace',
    category: 'DNS',
    probing: false,
    samples: [],
    failures: 0,
    lastStatus: 'idle',
    lastRttMs: null,
    avgMs: null,
    minMs: null,
    maxMs: null,
    jitterMs: null,
    lastCheckedAt: null,
  },
  {
    id: 'google-dns',
    label: 'Google Public DNS (dns.google)',
    url: 'https://dns.google/resolve?name=example.com&type=A',
    category: 'DNS',
    probing: false,
    samples: [],
    failures: 0,
    lastStatus: 'idle',
    lastRttMs: null,
    avgMs: null,
    minMs: null,
    maxMs: null,
    jitterMs: null,
    lastCheckedAt: null,
  },
  {
    id: 'github',
    label: 'GitHub (github.com)',
    url: 'https://github.com/favicon.ico',
    category: 'Cloud',
    probing: false,
    samples: [],
    failures: 0,
    lastStatus: 'idle',
    lastRttMs: null,
    avgMs: null,
    minMs: null,
    maxMs: null,
    jitterMs: null,
    lastCheckedAt: null,
  },
  {
    id: 'wikipedia',
    label: 'Wikimedia (wikipedia.org)',
    url: 'https://www.wikipedia.org/favicon.ico',
    category: 'Cloud',
    probing: false,
    samples: [],
    failures: 0,
    lastStatus: 'idle',
    lastRttMs: null,
    avgMs: null,
    minMs: null,
    maxMs: null,
    jitterMs: null,
    lastCheckedAt: null,
  },
  {
    id: 'local-gw',
    label: 'Local Gateway (192.168.1.1)',
    url: 'http://192.168.1.1/',
    category: 'Local',
    probing: false,
    samples: [],
    failures: 0,
    lastStatus: 'idle',
    lastRttMs: null,
    avgMs: null,
    minMs: null,
    maxMs: null,
    jitterMs: null,
    lastCheckedAt: null,
  },
];

function computeRowStats(samples: number[]) {
  if (samples.length === 0) {
    return { avgMs: null, minMs: null, maxMs: null, jitterMs: null };
  }
  const minMs = Math.min(...samples);
  const maxMs = Math.max(...samples);
  const avgMs = Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 100) / 100;
  let jitterMs = 0;
  if (samples.length > 1) {
    let diff = 0;
    for (let i = 1; i < samples.length; i++) {
      diff += Math.abs(samples[i] - samples[i - 1]);
    }
    jitterMs = Math.round((diff / (samples.length - 1)) * 100) / 100;
  }
  return { avgMs, minMs, maxMs, jitterMs };
}

export function MultiTargetMatrix() {
  const [rows, setRows] = useState<MultiTargetRow[]>(INITIAL_TARGETS);
  const [customInput, setCustomInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [isProbingAll, setIsProbingAll] = useState(false);

  const probeSingleRow = async (row: MultiTargetRow, burstCount = 3) => {
    setRows((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, probing: true, errorNote: undefined } : r))
    );

    const newSamples: number[] = [...row.samples];
    let failures = row.failures;
    let lastStatus: MultiTargetRow['lastStatus'] = row.lastStatus;
    let lastRttMs: number | null = row.lastRttMs;
    let errorNote: string | undefined;

    for (let i = 1; i <= burstCount; i++) {
      const sample = await measureBrowserPing(row.url, row.label, newSamples.length + i, 3000);
      lastStatus = sample.status;
      if (sample.status === 'ok' && sample.rttMs !== null) {
        newSamples.push(sample.rttMs);
        lastRttMs = sample.rttMs;
      } else {
        failures += 1;
        errorNote = sample.note;
      }
      const stats = computeRowStats(newSamples);
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id
            ? {
                ...r,
                samples: [...newSamples],
                failures,
                lastStatus,
                lastRttMs,
                ...stats,
                lastCheckedAt: sample.timestamp,
                errorNote,
              }
            : r
        )
      );
      if (i < burstCount) {
        await new Promise((res) => setTimeout(res, 180));
      }
    }

    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, probing: false } : r)));
  };

  const handleProbeAll = async () => {
    if (isProbingAll) return;
    setIsProbingAll(true);
    await Promise.all(rows.map((row) => probeSingleRow(row, 3)));
    setIsProbingAll(false);
  };

  const handleAddTarget = (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeBrowserProbeUrl(customInput);
    if (!normalized.ok) {
      setInputError(normalized.error);
      return;
    }
    setInputError(null);
    const id = `custom-${Date.now()}`;
    const newRow: MultiTargetRow = {
      id,
      label: normalized.displayTarget,
      url: normalized.url,
      category: 'Custom',
      probing: false,
      samples: [],
      failures: 0,
      lastStatus: 'idle',
      lastRttMs: null,
      avgMs: null,
      minMs: null,
      maxMs: null,
      jitterMs: null,
      lastCheckedAt: null,
    };
    setRows((prev) => [...prev, newRow]);
    setCustomInput('');
    void probeSingleRow(newRow, 3);
  };

  const handleResetStats = () => {
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        samples: [],
        failures: 0,
        lastStatus: 'idle',
        lastRttMs: null,
        avgMs: null,
        minMs: null,
        maxMs: null,
        jitterMs: null,
        lastCheckedAt: null,
        errorNote: undefined,
      }))
    );
  };

  const handleRemoveRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <section className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Multi-Target Browser Network Matrix
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Probes each endpoint directly from your browser connection (3-sample burst) to isolate
              local ISP congestion versus destination latency.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={handleResetStats}
              disabled={isProbingAll}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-4 h-4" />
              Clear Results
            </button>
            <button
              type="button"
              onClick={handleProbeAll}
              disabled={isProbingAll || rows.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Play className="w-4 h-4" />
              {isProbingAll ? 'Probing Targets...' : 'Probe All Targets'}
            </button>
          </div>
        </div>

        <form onSubmit={handleAddTarget} className="mt-5 flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <label htmlFor="custom-multi-target" className="sr-only">
              Add custom domain or URL
            </label>
            <input
              id="custom-multi-target"
              type="text"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              placeholder="Add custom domain or URL (e.g. apple.com, https://api.github.com)"
              className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600 font-mono"
            />
            {inputError && <p className="mt-1.5 text-xs text-red-600">{inputError}</p>}
          </div>
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-2 h-10 px-4 text-sm font-medium text-slate-800 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200/70 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" />
            Add &amp; Probe
          </button>
        </form>

        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                <th className="py-2.5 pr-4">Target</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3 text-right">Latest</th>
                <th className="py-2.5 px-3 text-right">Average</th>
                <th className="py-2.5 px-3 text-right">Min / Max</th>
                <th className="py-2.5 px-3 text-right">Jitter</th>
                <th className="py-2.5 px-3 text-right">Samples</th>
                <th className="py-2.5 pl-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50/70 transition-colors">
                  <td className="py-3 pr-4">
                    <div className="font-medium text-slate-900">{row.label}</div>
                    <div className="text-xs text-slate-500 font-mono truncate max-w-xs">
                      {row.category} · {row.url}
                    </div>
                    {row.errorNote && (
                      <div className="mt-0.5 text-xs text-amber-700">{row.errorNote}</div>
                    )}
                  </td>
                  <td className="py-3 px-3 whitespace-nowrap">
                    {row.probing ? (
                      <span className="text-xs font-medium text-blue-700">Probing</span>
                    ) : row.lastStatus === 'idle' ? (
                      <span className="text-xs text-slate-400">Ready</span>
                    ) : row.lastStatus === 'ok' ? (
                      <span className="text-xs font-medium text-emerald-700">Reachable</span>
                    ) : row.lastStatus === 'blocked' ? (
                      <span className="text-xs font-medium text-amber-700">Blocked</span>
                    ) : (
                      <span className="text-xs font-medium text-red-700">Unreachable</span>
                    )}
                  </td>
                  <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900 whitespace-nowrap">
                    {formatMs(row.lastRttMs)}
                  </td>
                  <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                    {formatMs(row.avgMs)}
                  </td>
                  <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                    {row.minMs !== null && row.maxMs !== null
                      ? `${row.minMs.toFixed(1)} / ${row.maxMs.toFixed(1)}`
                      : '—'}
                  </td>
                  <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                    {formatMs(row.jitterMs)}
                  </td>
                  <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                    {row.samples.length}/{row.samples.length + row.failures}
                  </td>
                  <td className="py-3 pl-3 text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => probeSingleRow(row, 3)}
                        disabled={row.probing}
                        className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 transition-colors"
                      >
                        Ping
                      </button>
                      {row.category === 'Custom' && (
                        <button
                          type="button"
                          onClick={() => handleRemoveRow(row.id)}
                          aria-label={`Remove ${row.label}`}
                          className="p-1.5 text-slate-400 hover:text-red-600 rounded transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
