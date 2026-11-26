import { useMemo } from 'react';
import QRCode from 'qrcode';

interface QrCodeSvgProps {
  value: string;
  size?: number;
  label?: string;
}

export function QrCodeSvg({ value, size = 168, label = 'QR Code' }: QrCodeSvgProps) {
  const matrix = useMemo(() => {
    try {
      const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
      const count = qr.modules.size;
      const cells: Array<{ x: number; y: number }> = [];
      for (let y = 0; y < count; y++) {
        for (let x = 0; x < count; x++) {
          if (qr.modules.get(x, y)) {
            cells.push({ x, y });
          }
        }
      }
      return { count, cells };
    } catch {
      return null;
    }
  }, [value]);

  if (!matrix) {
    return (
      <div
        style={{ width: size, height: size }}
        className="flex items-center justify-center bg-slate-100 border border-slate-200 rounded text-xs text-slate-500 text-center p-3"
      >
        QR unavailable
      </div>
    );
  }

  const quietZone = 2;
  const viewBoxSize = matrix.count + quietZone * 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      role="img"
      aria-label={label}
      className="bg-white rounded border border-slate-200 shrink-0"
      shapeRendering="crispEdges"
    >
      <rect width={viewBoxSize} height={viewBoxSize} fill="#ffffff" />
      {matrix.cells.map((cell) => (
        <rect
          key={`${cell.x}-${cell.y}`}
          x={cell.x + quietZone}
          y={cell.y + quietZone}
          width={1}
          height={1}
          fill="#0f172a"
        />
      ))}
    </svg>
  );
}
