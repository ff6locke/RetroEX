import { useMemo, useState } from 'react';
import { Gamepad2, Hammer, Tv } from 'lucide-react';
import { BuildApkModal } from './components/BuildApkModal';
import { PhoneGamepadView } from './components/PhoneGamepadView';
import { SnesEmulatorPanel } from './components/SnesEmulatorPanel';
import { TvReceiverView } from './components/TvReceiverView';
import { TvTransferPanel } from './components/TvTransferPanel';
import { isNativeCapacitorOrigin } from './utils/apiUrl';

function getInitialRouteState(): {
  tvMode: boolean;
  tvCode?: string;
  padMode: boolean;
  padCode?: string;
} {
  if (typeof window === 'undefined') {
    return { tvMode: false, padMode: false };
  }
  const params = new URLSearchParams(window.location.search);
  const tvParam = params.get('tv');
  const roomParam = params.get('room');
  const padParam = params.get('pad') || params.get('controller');

  if (padParam !== null) {
    const cleanPad = /^\d{6}$/.test(padParam) ? padParam : '123456';
    return { tvMode: false, tvCode: undefined, padMode: true, padCode: cleanPad };
  }

  if (tvParam !== null) {
    const cleanCode = /^\d{6}$/.test(tvParam) ? tvParam : undefined;
    return { tvMode: true, tvCode: cleanCode, padMode: false };
  }

  const cleanRoom = roomParam && /^\d{6}$/.test(roomParam) ? roomParam : undefined;
  return { tvMode: false, tvCode: cleanRoom, padMode: false };
}

export default function App() {
  const initialRoute = useMemo(() => getInitialRouteState(), []);
  const [padMode, setPadMode] = useState(initialRoute.padMode);
  const [tvReceiverMode, setTvReceiverMode] = useState(initialRoute.tvMode);
  const [tvRoomCode, setTvRoomCode] = useState<string | undefined>(
    initialRoute.tvCode || initialRoute.padCode || '123456'
  );
  const [showBuildModal, setShowBuildModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'emulator' | 'transfer'>('emulator');
  const isNativeApk = isNativeCapacitorOrigin();

  const openTvReceiver = (code?: string) => {
    const targetCode = code ?? tvRoomCode;
    setTvRoomCode(targetCode);
    setTvReceiverMode(true);
    if (typeof window !== 'undefined' && targetCode) {
      window.history.replaceState(null, '', `/?tv=${targetCode}`);
    }
  };

  if (padMode) {
    return (
      <PhoneGamepadView
        roomCode={initialRoute.padCode || tvRoomCode || '123456'}
        onExit={() => {
          setPadMode(false);
          if (typeof window !== 'undefined') {
            window.history.replaceState(null, '', '/');
          }
        }}
      />
    );
  }

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
          <div className="flex items-center gap-4">
            <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
              RetroEX
            </span>
            <nav className="hidden sm:flex items-center gap-1 bg-slate-100 p-1 rounded-lg text-xs font-medium">
              <button
                type="button"
                onClick={() => setActiveTab('emulator')}
                className={`px-3 py-1.5 rounded-md transition-colors ${
                  activeTab === 'emulator'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                SNES Emulator
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('transfer')}
                className={`px-3 py-1.5 rounded-md transition-colors ${
                  activeTab === 'transfer'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                TV File Transfer
              </button>
            </nav>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {!isNativeApk && (
              <button
                type="button"
                onClick={() => setShowBuildModal(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Hammer className="w-4 h-4" />
                Build APK
              </button>
            )}
            <button
              type="button"
              onClick={() => openTvReceiver()}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
            >
              <Tv className="w-4 h-4" />
              TV Receiver Screen
            </button>
          </div>
        </div>
      </header>

      <div className="sm:hidden flex items-center justify-center gap-2 bg-slate-100 p-2 border-b border-slate-200">
        <button
          type="button"
          onClick={() => setActiveTab('emulator')}
          className={`flex-1 py-1.5 text-xs font-medium rounded-md ${
            activeTab === 'emulator' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
          }`}
        >
          SNES Emulator
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('transfer')}
          className={`flex-1 py-1.5 text-xs font-medium rounded-md ${
            activeTab === 'transfer' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
          }`}
        >
          TV File Transfer
        </button>
      </div>

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {activeTab === 'emulator' ? (
          <SnesEmulatorPanel roomCode={tvRoomCode || '123456'} />
        ) : (
          <TvTransferPanel
            initialRoomCode={tvRoomCode}
            onOpenTvReceiver={(code) => openTvReceiver(code)}
          />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-slate-500">
          <span>RetroEX · SNES Emulator &amp; Direct File Transfer for Android TV</span>
          <span>No local server required · Pair with a 6-digit code</span>
        </div>
      </footer>

      {!isNativeApk && (
        <BuildApkModal open={showBuildModal} onClose={() => setShowBuildModal(false)} />
      )}
    </div>
  );
}
