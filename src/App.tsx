import { useMemo, useState } from 'react';
import { Tv } from 'lucide-react';
import { TvReceiverView } from './components/TvReceiverView';
import { TvTransferPanel } from './components/TvTransferPanel';

function getInitialRouteState(): {
  tvMode: boolean;
  tvCode?: string;
} {
  if (typeof window === 'undefined') {
    return { tvMode: false };
  }
  const params = new URLSearchParams(window.location.search);
  const tvParam = params.get('tv');
  const roomParam = params.get('room');

  if (tvParam !== null) {
    const cleanCode = /^\d{6}$/.test(tvParam) ? tvParam : undefined;
    return { tvMode: true, tvCode: cleanCode };
  }

  const cleanRoom = roomParam && /^\d{6}$/.test(roomParam) ? roomParam : undefined;
  return { tvMode: false, tvCode: cleanRoom };
}

export default function App() {
  const initialRoute = useMemo(() => getInitialRouteState(), []);
  const [tvReceiverMode, setTvReceiverMode] = useState(initialRoute.tvMode);
  const [tvRoomCode, setTvRoomCode] = useState<string | undefined>(initialRoute.tvCode);

  const openTvReceiver = (code?: string) => {
    const targetCode = code ?? tvRoomCode;
    setTvRoomCode(targetCode);
    setTvReceiverMode(true);
    if (typeof window !== 'undefined' && targetCode) {
      window.history.replaceState(null, '', `/?tv=${targetCode}`);
    }
  };

  if (tvReceiverMode) {
    return (
      <TvReceiverView
        initialCode={tvRoomCode}
        onExitTvMode={(activeCode) => {
          setTvReceiverMode(false);
          if (activeCode) {
            setTvRoomCode(activeCode);
            if (typeof window !== 'undefined') {
              window.history.replaceState(null, '', `/?room=${activeCode}`);
            }
          } else if (typeof window !== 'undefined') {
            window.history.replaceState(null, '', '/');
          }
        }}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur-sm border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-6">
          <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            NetPulse
          </span>

          <button
            type="button"
            onClick={() => openTvReceiver()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
          >
            <Tv className="w-4 h-4" />
            TV Receiver Screen
          </button>
        </div>
      </header>

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <TvTransferPanel
          initialRoomCode={tvRoomCode}
          onOpenTvReceiver={(code) => openTvReceiver(code)}
        />
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-slate-500">
          <span>NetPulse · Direct Peer-to-Peer File &amp; APK Transfer for Android TV</span>
          <span>No local server required · Pair with a 6-digit code</span>
        </div>
      </footer>
    </div>
  );
}
