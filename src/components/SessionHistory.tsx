import { useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import type { SavedSessionRun } from '../types/network';
import { exportSamplesCsv, formatMs } from '../utils/networkProbes';

interface SessionHistoryProps {
  runs: SavedSessionRun[];
  onClearAll: () => void;
  onLoadTarget: (run: SavedSessionRun) => void;
}

export function SessionHistory({ runs, onClearAll, onLoadTarget }: SessionHistoryProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <section className="bg-white border border-slate-200 rounded-lg p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-slate-200">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Session History &amp; Exports</h2>
          <p className="mt-1 text-sm text-slate-600">
            Completed ping sessions are saved locally in your browser for latency comparison and CSV export.
          </p>
        </div>
        {runs.length > 0 && (
          <button
            type="button"
            onClick={onClearAll}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-700 bg-white border border-slate-200 rounded-md hover:bg-red-50 transition-colors whitespace-nowrap shrink-0"
          >
            <Trash2 className="w-4 h-4" />
            Clear History
          </button>
        )}
      </div>

      {runs.length === 0 ? (
        <div className="mt-6 py-12 border border-dashed border-slate-200 rounded-lg text-center">
          <p className="text-sm font-medium text-slate-700">No completed ping sessions yet</p>
          <p className="mt-1 text-xs text-slate-500">
            Run a ping test in Live Ping and stop or complete it to record the summary here.
          </p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                <th className="py-2.5 pr-4">Target &amp; Mode</th>
                <th className="py-2.5 px-3">Timestamp</th>
                <th className="py-2.5 px-3 text-right">Packets</th>
                <th className="py-2.5 px-3 text-right">Loss</th>
                <th className="py-2.5 px-3 text-right">Avg RTT</th>
                <th className="py-2.5 px-3 text-right">Jitter</th>
                <th className="py-2.5 pl-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {runs.map((run) => {
                const isExpanded = expandedId === run.id;
                return (
                  <tr key={run.id} className="hover:bg-slate-50/70 align-top transition-colors">
                    <td className="py-3 pr-4">
                      <div className="font-medium text-slate-900 font-mono">
                        {run.target}
                        {run.port ? `:${run.port}` : ''}
                      </div>
                      <div className="text-xs text-slate-500">
                        {run.mode === 'browser' ? 'My Network (Browser)' : 'Cloud Probe (Server TCP)'}
                      </div>
                      {isExpanded && (
                        <div className="mt-2 pt-2 border-t border-slate-100 text-xs text-slate-600 font-mono tabular-nums">
                          Min {formatMs(run.stats.minMs)} · Median {formatMs(run.stats.medianMs)} · P95{' '}
                          {formatMs(run.stats.p95Ms)} · Max {formatMs(run.stats.maxMs)}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-3 text-xs text-slate-600 font-mono tabular-nums whitespace-nowrap">
                      {new Date(run.startedAt).toLocaleString()}
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                      {run.stats.received}/{run.stats.sent}
                    </td>
                    <td
                      className={`py-3 px-3 text-right font-mono tabular-nums whitespace-nowrap ${
                        run.stats.lossPct > 0 ? 'text-red-700 font-medium' : 'text-emerald-700'
                      }`}
                    >
                      {run.stats.lossPct}%
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900 whitespace-nowrap">
                      {formatMs(run.stats.avgMs)}
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                      {formatMs(run.stats.jitterMs)}
                    </td>
                    <td className="py-3 pl-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setExpandedId(isExpanded ? null : run.id)}
                          className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 transition-colors"
                        >
                          {isExpanded ? 'Hide' : 'Details'}
                        </button>
                        <button
                          type="button"
                          onClick={() => onLoadTarget(run)}
                          className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 transition-colors"
                        >
                          Retest
                        </button>
                        <button
                          type="button"
                          onClick={() => exportSamplesCsv(run.samples, `netpulse-${run.target.replace(/[^a-z0-9]/gi, '_')}`)}
                          aria-label={`Export CSV for ${run.target}`}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-white border border-slate-200 rounded hover:bg-blue-50 transition-colors"
                        >
                          <Download className="w-3.5 h-3.5" />
                          CSV
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
