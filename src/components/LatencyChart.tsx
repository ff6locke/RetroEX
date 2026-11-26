import { useMemo, useState } from 'react';
import type { PingSample } from '../types/network';
import { formatMs } from '../utils/networkProbes';

interface LatencyChartProps {
  samples: PingSample[];
  avgMs: number | null;
  isRunning: boolean;
}

export function LatencyChart({ samples, avgMs, isRunning }: LatencyChartProps) {
  const [hoveredSeq, setHoveredSeq] = useState<number | null>(null);

  const visibleSamples = useMemo(() => samples.slice(-60), [samples]);

  const width = 920;
  const height = 240;
  const padLeft = 52;
  const padRight = 18;
  const padTop = 20;
  const padBottom = 32;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const { yMax, yTicks } = useMemo(() => {
    const validRtts = visibleSamples
      .filter((s) => s.status === 'ok' && s.rttMs !== null)
      .map((s) => s.rttMs as number);
    const peak = validRtts.length ? Math.max(...validRtts) : 50;
    const rawMax = Math.max(20, peak * 1.25);
    const step =
      rawMax <= 40 ? 10 : rawMax <= 100 ? 25 : rawMax <= 250 ? 50 : rawMax <= 600 ? 100 : 250;
    const roundedMax = Math.ceil(rawMax / step) * step;
    const ticks = [0, roundedMax * 0.25, roundedMax * 0.5, roundedMax * 0.75, roundedMax];
    return { yMax: roundedMax, yTicks: ticks };
  }, [visibleSamples]);

  const points = useMemo(() => {
    const count = visibleSamples.length;
    if (count === 0) return [];
    const xStep = count > 1 ? plotW / (count - 1) : 0;

    return visibleSamples.map((sample, idx) => {
      const x = count === 1 ? padLeft + plotW / 2 : padLeft + idx * xStep;
      const clampedRtt =
        sample.status === 'ok' && sample.rttMs !== null
          ? Math.min(yMax, Math.max(0, sample.rttMs))
          : null;
      const y = clampedRtt !== null ? padTop + plotH - (clampedRtt / yMax) * plotH : null;
      return { sample, x, y };
    });
  }, [visibleSamples, plotW, plotH, padLeft, padTop, yMax]);

  const polylineSegments = useMemo(() => {
    const segments: string[] = [];
    let current: string[] = [];
    for (const pt of points) {
      if (pt.y !== null) {
        current.push(`${pt.x.toFixed(1)},${pt.y.toFixed(1)}`);
      } else if (current.length > 0) {
        segments.push(current.join(' '));
        current = [];
      }
    }
    if (current.length > 0) {
      segments.push(current.join(' '));
    }
    return segments;
  }, [points]);

  const areaPaths = useMemo(() => {
    const paths: string[] = [];
    let run: Array<{ x: number; y: number }> = [];
    const baseY = padTop + plotH;

    const flush = () => {
      if (run.length >= 2) {
        const line = run.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
        paths.push(
          `M ${run[0].x.toFixed(1)} ${baseY.toFixed(1)} ${line} L ${run[run.length - 1].x.toFixed(1)} ${baseY.toFixed(1)} Z`
        );
      }
      run = [];
    };

    for (const pt of points) {
      if (pt.y !== null) {
        run.push({ x: pt.x, y: pt.y });
      } else {
        flush();
      }
    }
    flush();
    return paths;
  }, [points, padTop, plotH]);

  const avgY =
    avgMs !== null && yMax > 0
      ? padTop + plotH - (Math.min(yMax, Math.max(0, avgMs)) / yMax) * plotH
      : null;

  const hoveredPoint = useMemo(
    () => points.find((p) => p.sample.seq === hoveredSeq) ?? null,
    [points, hoveredSeq]
  );

  if (samples.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[240px] border border-dashed border-slate-200 rounded-lg bg-slate-50/60 px-6 text-center">
        <p className="text-sm font-medium text-slate-700">No latency samples recorded yet</p>
        <p className="mt-1 text-xs text-slate-500 max-w-md">
          {isRunning
            ? 'Waiting for the first probe response...'
            : 'Click Run Ping in the header or press Enter in the target bar to start measuring real-time round-trip latency.'}
        </p>
      </div>
    );
  }

  return (
    <div className="relative w-full select-none">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-[240px] overflow-visible"
        role="img"
        aria-label="Real-time network latency chart"
      >
        <defs>
          <linearGradient id="netpulseAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2563EB" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#2563EB" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* Horizontal grid lines */}
        {yTicks.map((tick) => {
          const y = padTop + plotH - (tick / yMax) * plotH;
          return (
            <g key={tick}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke="#E2E8F0"
                strokeWidth="1"
              />
              <text
                x={padLeft - 10}
                y={y + 4}
                textAnchor="end"
                className="fill-slate-400 text-[11px] font-mono tabular-nums"
              >
                {Math.round(tick)}ms
              </text>
            </g>
          );
        })}

        {/* Average baseline */}
        {avgY !== null && (
          <g>
            <line
              x1={padLeft}
              y1={avgY}
              x2={width - padRight}
              y2={avgY}
              stroke="#0F172A"
              strokeWidth="1"
              strokeDasharray="4 4"
              strokeOpacity="0.35"
            />
            <text
              x={width - padRight}
              y={avgY - 6}
              textAnchor="end"
              className="fill-slate-500 text-[10px] font-mono tabular-nums"
            >
              Avg {formatMs(avgMs)}
            </text>
          </g>
        )}

        {/* Area fill */}
        {areaPaths.map((d, i) => (
          <path key={`area-${i}`} d={d} fill="url(#netpulseAreaGrad)" />
        ))}

        {/* Latency line */}
        {polylineSegments.map((pts, i) => (
          <polyline
            key={`line-${i}`}
            fill="none"
            stroke="#2563EB"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={pts}
          />
        ))}

        {/* Failure / timeout markers */}
        {points.map((pt) =>
          pt.y === null ? (
            <g key={`err-${pt.sample.seq}`}>
              <line
                x1={pt.x}
                y1={padTop}
                x2={pt.x}
                y2={padTop + plotH}
                stroke="#DC2626"
                strokeWidth="1.25"
                strokeDasharray="3 3"
                strokeOpacity="0.6"
              />
              <circle cx={pt.x} cy={padTop + plotH - 6} r="3.5" fill="#DC2626" />
            </g>
          ) : null
        )}

        {/* Hovered crosshair */}
        {hoveredPoint && (
          <line
            x1={hoveredPoint.x}
            y1={padTop}
            x2={hoveredPoint.x}
            y2={padTop + plotH}
            stroke="#94A3B8"
            strokeWidth="1"
          />
        )}

        {/* Data nodes + invisible hit targets */}
        {points.map((pt) => {
          const isHovered = hoveredSeq === pt.sample.seq;
          const isLatest = pt.sample.seq === visibleSamples[visibleSamples.length - 1]?.seq;
          return (
            <g
              key={pt.sample.seq}
              onMouseEnter={() => setHoveredSeq(pt.sample.seq)}
              onMouseLeave={() => setHoveredSeq(null)}
              className="cursor-crosshair"
            >
              <rect
                x={pt.x - 8}
                y={padTop}
                width={16}
                height={plotH + 10}
                fill="transparent"
              />
              {pt.y !== null && (
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={isHovered ? 5 : isLatest ? 4 : visibleSamples.length > 35 ? 2 : 3}
                  fill={isHovered ? '#1D4ED8' : '#2563EB'}
                  stroke="#FFFFFF"
                  strokeWidth="1.5"
                />
              )}
            </g>
          );
        })}

        {/* X-axis sequence labels */}
        {points.length > 0 && (
          <>
            <text
              x={points[0].x}
              y={height - 8}
              textAnchor="start"
              className="fill-slate-400 text-[11px] font-mono tabular-nums"
            >
              #{points[0].sample.seq}
            </text>
            {points.length > 2 && (
              <text
                x={points[Math.floor(points.length / 2)].x}
                y={height - 8}
                textAnchor="middle"
                className="fill-slate-400 text-[11px] font-mono tabular-nums"
              >
                #{points[Math.floor(points.length / 2)].sample.seq}
              </text>
            )}
            {points.length > 1 && (
              <text
                x={points[points.length - 1].x}
                y={height - 8}
                textAnchor="end"
                className="fill-slate-400 text-[11px] font-mono tabular-nums"
              >
                #{points[points.length - 1].sample.seq}
              </text>
            )}
          </>
        )}
      </svg>

      {hoveredPoint && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2 text-xs text-slate-600">
          <div className="flex items-center gap-2 font-mono tabular-nums">
            <span className="font-semibold text-slate-900">Seq #{hoveredPoint.sample.seq}</span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span>{new Date(hoveredPoint.sample.timestamp).toLocaleTimeString()}</span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span>{hoveredPoint.sample.protocol}</span>
          </div>
          <div className="flex items-center gap-2 font-mono tabular-nums">
            {hoveredPoint.sample.status === 'ok' ? (
              <span className="font-semibold text-emerald-700">
                OK — {formatMs(hoveredPoint.sample.rttMs)}
              </span>
            ) : (
              <span className="font-semibold text-red-700">
                {hoveredPoint.sample.status.toUpperCase()}
                {hoveredPoint.sample.note ? ` — ${hoveredPoint.sample.note}` : ''}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
