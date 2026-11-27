import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Gamepad2,
  Maximize2,
  SlidersHorizontal,
  Wifi,
} from 'lucide-react';

interface PhoneGamepadViewProps {
  roomCode: string;
  onExit?: () => void;
}

// MQTT broker list matching p2pTransfer
const MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

function encodeMqttString(str: string): Uint8Array {
  const utf8 = new TextEncoder().encode(str);
  const out = new Uint8Array(2 + utf8.length);
  out[0] = (utf8.length >> 8) & 0xff;
  out[1] = utf8.length & 0xff;
  out.set(utf8, 2);
  return out;
}

function encodeMqttVarInt(n: number): Uint8Array {
  const bytes: number[] = [];
  let val = n;
  do {
    let digit = val % 128;
    val = Math.floor(val / 128);
    if (val > 0) digit |= 0x80;
    bytes.push(digit);
  } while (val > 0);
  return new Uint8Array(bytes);
}

function buildMqttPacket(typeAndFlags: number, bodyParts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bodyLen = bodyParts.reduce((sum, p) => sum + p.length, 0);
  const lenBytes = encodeMqttVarInt(bodyLen);
  const buffer = new ArrayBuffer(1 + lenBytes.length + bodyLen);
  const out = new Uint8Array(buffer);
  out[0] = typeAndFlags;
  out.set(lenBytes, 1);
  let offset = 1 + lenBytes.length;
  for (const part of bodyParts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function PhoneGamepadView({ roomCode, onExit }: PhoneGamepadViewProps) {
  const [connected, setConnected] = useState(false);
  const [activeButtons, setActiveButtons] = useState<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const broadcastRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    // Also use local BroadcastChannel for same-origin tabs
    const bc = new BroadcastChannel(`retroex-pad-${roomCode}`);
    broadcastRef.current = bc;

    const topic = `retroex/gamepad/${roomCode}`;
    const clientId = `pad_${Math.random().toString(16).slice(2, 8)}`;
    let ws: WebSocket;

    try {
      ws = new WebSocket(MQTT_BROKERS[0], 'mqtt');
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        const proto = encodeMqttString('MQTT');
        const headerTail = new Uint8Array([0x04, 0x02, 0x00, 0x1e]);
        const cid = encodeMqttString(clientId);
        ws.send(buildMqttPacket(0x10, [proto, headerTail, cid]));
      };

      ws.onmessage = (evt) => {
        if (!(evt.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(evt.data);
        const packetType = (bytes[0] >> 4) & 0x0f;
        if (packetType === 2) {
          // CONNACK
          setConnected(true);
        }
      };

      ws.onclose = () => setConnected(false);
      ws.onerror = () => setConnected(false);
    } catch {
      // Fallback
    }

    return () => {
      bc.close();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [roomCode]);

  const sendButton = (button: string, action: 'down' | 'up') => {
    // Haptic feedback if supported
    if (action === 'down' && typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate(20);
      } catch {
        // ignore
      }
    }

    setActiveButtons((prev) => {
      const next = new Set(prev);
      if (action === 'down') next.add(button);
      else next.delete(button);
      return next;
    });

    const payload = JSON.stringify({ type: 'snes-key', button, action });

    // Send via BroadcastChannel
    if (broadcastRef.current) {
      broadcastRef.current.postMessage(payload);
    }

    // Send via WebSocket MQTT
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const topic = `retroex/gamepad/${roomCode}`;
      const topicBytes = encodeMqttString(topic);
      const payloadBytes = new TextEncoder().encode(payload);
      ws.send(buildMqttPacket(0x30, [topicBytes, payloadBytes]));
    }
  };

  const sendCommand = (command: 'MENU_TOGGLE') => {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate(25);
      } catch {
        // ignore
      }
    }

    const payload = JSON.stringify({ type: 'snes-command', command });

    if (broadcastRef.current) {
      broadcastRef.current.postMessage(payload);
    }

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const topic = `retroex/gamepad/${roomCode}`;
      const topicBytes = encodeMqttString(topic);
      const payloadBytes = new TextEncoder().encode(payload);
      ws.send(buildMqttPacket(0x30, [topicBytes, payloadBytes]));
    }
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950 text-slate-100 flex flex-col justify-between select-none touch-none overflow-hidden font-sans p-4">
      {/* Top Bar */}
      <div className="flex items-center justify-between text-xs text-slate-400 pb-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Gamepad2 className="w-4 h-4 text-indigo-400" />
          <span className="font-semibold text-white">RetroEX Controller</span>
          <span className="font-mono text-indigo-300">#{roomCode}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 font-mono">
            <Wifi className={`w-3.5 h-3.5 ${connected ? 'text-emerald-400' : 'text-amber-400 animate-pulse'}`} />
            {connected ? 'Linked' : 'Ready'}
          </span>
          <button
            type="button"
            onClick={toggleFullscreen}
            className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
            title="Fullscreen"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              className="text-slate-400 hover:text-white px-2 py-0.5 rounded bg-slate-800"
            >
              Exit
            </button>
          )}
        </div>
      </div>

      {/* Shoulder Buttons L & R */}
      <div className="flex justify-between items-center px-4 pt-2">
        <button
          type="button"
          onPointerDown={() => sendButton('L', 'down')}
          onPointerUp={() => sendButton('L', 'up')}
          onPointerCancel={() => sendButton('L', 'up')}
          className={`w-28 h-12 rounded-xl border border-slate-700 font-bold text-sm tracking-wider uppercase transition-transform active:scale-95 shadow-md flex items-center justify-center ${
            activeButtons.has('L') ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300'
          }`}
        >
          L Bumper
        </button>
        <button
          type="button"
          onPointerDown={() => sendButton('R', 'down')}
          onPointerUp={() => sendButton('R', 'up')}
          onPointerCancel={() => sendButton('R', 'up')}
          className={`w-28 h-12 rounded-xl border border-slate-700 font-bold text-sm tracking-wider uppercase transition-transform active:scale-95 shadow-md flex items-center justify-center ${
            activeButtons.has('R') ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300'
          }`}
        >
          R Bumper
        </button>
      </div>

      {/* Main Gamepad Area: D-Pad on Left, Buttons on Right */}
      <div className="flex-1 flex items-center justify-between px-2 sm:px-8 py-4 gap-6">
        {/* D-Pad */}
        <div className="relative w-44 h-44 bg-slate-900/80 rounded-full p-2 border border-slate-800 flex items-center justify-center shadow-inner">
          {/* Up */}
          <button
            type="button"
            onPointerDown={() => sendButton('Up', 'down')}
            onPointerUp={() => sendButton('Up', 'up')}
            onPointerCancel={() => sendButton('Up', 'up')}
            className={`absolute top-2 left-1/2 -translate-x-1/2 w-12 h-14 rounded-t-lg border-t border-x border-slate-600 flex items-center justify-center active:scale-95 transition-colors ${
              activeButtons.has('Up') ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300'
            }`}
          >
            <ArrowUp className="w-5 h-5" />
          </button>
          {/* Down */}
          <button
            type="button"
            onPointerDown={() => sendButton('Down', 'down')}
            onPointerUp={() => sendButton('Down', 'up')}
            onPointerCancel={() => sendButton('Down', 'up')}
            className={`absolute bottom-2 left-1/2 -translate-x-1/2 w-12 h-14 rounded-b-lg border-b border-x border-slate-600 flex items-center justify-center active:scale-95 transition-colors ${
              activeButtons.has('Down') ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300'
            }`}
          >
            <ArrowDown className="w-5 h-5" />
          </button>
          {/* Left */}
          <button
            type="button"
            onPointerDown={() => sendButton('Left', 'down')}
            onPointerUp={() => sendButton('Left', 'up')}
            onPointerCancel={() => sendButton('Left', 'up')}
            className={`absolute left-2 top-1/2 -translate-y-1/2 w-14 h-12 rounded-l-lg border-l border-y border-slate-600 flex items-center justify-center active:scale-95 transition-colors ${
              activeButtons.has('Left') ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300'
            }`}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          {/* Right */}
          <button
            type="button"
            onPointerDown={() => sendButton('Right', 'down')}
            onPointerUp={() => sendButton('Right', 'up')}
            onPointerCancel={() => sendButton('Right', 'up')}
            className={`absolute right-2 top-1/2 -translate-y-1/2 w-14 h-12 rounded-r-lg border-r border-y border-slate-600 flex items-center justify-center active:scale-95 transition-colors ${
              activeButtons.has('Right') ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300'
            }`}
          >
            <ArrowRight className="w-5 h-5" />
          </button>
          {/* Center Pivot */}
          <div className="w-10 h-10 rounded bg-slate-950 border border-slate-800" />
        </div>

        {/* Center Menu, Select & Start */}
        <div className="flex flex-col items-center justify-center gap-5">
          <button
            type="button"
            onClick={() => sendCommand('MENU_TOGGLE')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-indigo-500/60 bg-indigo-600/90 hover:bg-indigo-500 text-white text-[11px] font-bold tracking-wider uppercase shadow-md active:scale-95 transition-transform"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Menu
          </button>

          <div className="flex gap-4">
            <button
              type="button"
              onPointerDown={() => sendButton('Select', 'down')}
              onPointerUp={() => sendButton('Select', 'up')}
              onPointerCancel={() => sendButton('Select', 'up')}
              className={`px-3 py-2 rounded-full border border-slate-700 text-[10px] font-bold tracking-widest uppercase rotate-[-25deg] shadow-sm transition-transform active:scale-90 ${
                activeButtons.has('Select') ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'
              }`}
            >
              Select
            </button>
            <button
              type="button"
              onPointerDown={() => sendButton('Start', 'down')}
              onPointerUp={() => sendButton('Start', 'up')}
              onPointerCancel={() => sendButton('Start', 'up')}
              className={`px-3 py-2 rounded-full border border-slate-700 text-[10px] font-bold tracking-widest uppercase rotate-[-25deg] shadow-sm transition-transform active:scale-90 ${
                activeButtons.has('Start') ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'
              }`}
            >
              Start
            </button>
          </div>
        </div>

        {/* Action Buttons: X (Top), Y (Left), B (Bottom), A (Right) - Authentic SNES Layout */}
        <div className="relative w-44 h-44 bg-slate-900/80 rounded-full p-2 border border-slate-800 flex items-center justify-center shadow-inner">
          {/* X - Top (Blue) */}
          <button
            type="button"
            onPointerDown={() => sendButton('X', 'down')}
            onPointerUp={() => sendButton('X', 'up')}
            onPointerCancel={() => sendButton('X', 'up')}
            className={`absolute top-2 left-1/2 -translate-x-1/2 w-14 h-14 rounded-full font-black text-lg border-2 shadow-md active:scale-90 transition-transform flex items-center justify-center ${
              activeButtons.has('X')
                ? 'bg-blue-400 text-slate-950 border-white'
                : 'bg-blue-600 text-white border-blue-400'
            }`}
          >
            X
          </button>
          {/* Y - Left (Green) */}
          <button
            type="button"
            onPointerDown={() => sendButton('Y', 'down')}
            onPointerUp={() => sendButton('Y', 'up')}
            onPointerCancel={() => sendButton('Y', 'up')}
            className={`absolute left-2 top-1/2 -translate-y-1/2 w-14 h-14 rounded-full font-black text-lg border-2 shadow-md active:scale-90 transition-transform flex items-center justify-center ${
              activeButtons.has('Y')
                ? 'bg-emerald-400 text-slate-950 border-white'
                : 'bg-emerald-600 text-white border-emerald-400'
            }`}
          >
            Y
          </button>
          {/* B - Bottom (Yellow) */}
          <button
            type="button"
            onPointerDown={() => sendButton('B', 'down')}
            onPointerUp={() => sendButton('B', 'up')}
            onPointerCancel={() => sendButton('B', 'up')}
            className={`absolute bottom-2 left-1/2 -translate-x-1/2 w-14 h-14 rounded-full font-black text-lg border-2 shadow-md active:scale-90 transition-transform flex items-center justify-center ${
              activeButtons.has('B')
                ? 'bg-amber-300 text-slate-950 border-white'
                : 'bg-amber-500 text-white border-amber-300'
            }`}
          >
            B
          </button>
          {/* A - Right (Red) */}
          <button
            type="button"
            onPointerDown={() => sendButton('A', 'down')}
            onPointerUp={() => sendButton('A', 'up')}
            onPointerCancel={() => sendButton('A', 'up')}
            className={`absolute right-2 top-1/2 -translate-y-1/2 w-14 h-14 rounded-full font-black text-lg border-2 shadow-md active:scale-90 transition-transform flex items-center justify-center ${
              activeButtons.has('A')
                ? 'bg-rose-400 text-slate-950 border-white'
                : 'bg-rose-600 text-white border-rose-400'
            }`}
          >
            A
          </button>
        </div>
      </div>

      <div className="text-center text-[11px] text-slate-400 pb-1">
        Connected to RetroEX (#{roomCode}) · Menu: D-Pad moves · A confirms · B goes back
      </div>
    </div>
  );
}
