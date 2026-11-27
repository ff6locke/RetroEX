import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bluetooth,
  CheckCircle2,
  ExternalLink,
  Gamepad2,
  Keyboard,
  Maximize2,
  Play,
  QrCode,
  Radio,
  Smartphone,
  Upload,
  Volume2,
  VolumeX,
  X,
  Zap,
} from 'lucide-react';
import { QrCodeSvg } from './QrCodeSvg';
import { getPublicAppOrigin } from '../utils/apiUrl';

interface SnesEmulatorPanelProps {
  roomCode?: string;
}

const SNES_KEY_MAP: Record<string, { snes: string; label: string }> = {
  ArrowUp: { snes: 'Up', label: 'D-Pad Up' },
  ArrowDown: { snes: 'Down', label: 'D-Pad Down' },
  ArrowLeft: { snes: 'Left', label: 'D-Pad Left' },
  ArrowRight: { snes: 'Right', label: 'D-Pad Right' },
  KeyX: { snes: 'A', label: 'Button A' },
  x: { snes: 'A', label: 'Button A' },
  X: { snes: 'A', label: 'Button A' },
  KeyZ: { snes: 'B', label: 'Button B' },
  z: { snes: 'B', label: 'Button B' },
  Z: { snes: 'B', label: 'Button B' },
  KeyS: { snes: 'X', label: 'Button X' },
  s: { snes: 'X', label: 'Button X' },
  S: { snes: 'X', label: 'Button X' },
  KeyA: { snes: 'Y', label: 'Button Y' },
  a: { snes: 'Y', label: 'Button Y' },
  A: { snes: 'Y', label: 'Button Y' },
  KeyQ: { snes: 'L', label: 'L Bumper' },
  q: { snes: 'L', label: 'L Bumper' },
  KeyW: { snes: 'R', label: 'R Bumper' },
  w: { snes: 'R', label: 'R Bumper' },
  Enter: { snes: 'Start', label: 'Start' },
  ShiftRight: { snes: 'Select', label: 'Select' },
  ShiftLeft: { snes: 'Select', label: 'Select' },
  Space: { snes: 'Select', label: 'Select' },
};

const BUTTON_TO_KEY_EVENT: Record<string, { key: string; code: string; keyCode: number }> = {
  Up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  Down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  Right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  A: { key: 'x', code: 'KeyX', keyCode: 88 },
  B: { key: 'z', code: 'KeyZ', keyCode: 90 },
  X: { key: 's', code: 'KeyS', keyCode: 83 },
  Y: { key: 'a', code: 'KeyA', keyCode: 65 },
  L: { key: 'q', code: 'KeyQ', keyCode: 81 },
  R: { key: 'w', code: 'KeyW', keyCode: 87 },
  Start: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Select: { key: 'Shift', code: 'ShiftRight', keyCode: 16 },
};

// MQTT brokers for P2P phone gamepad connection
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

const TV_PERF_STORAGE_KEY = 'retroex_tv_perf_mode_v1';

function detectAndroidTvBox(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  try {
    const saved = localStorage.getItem(TV_PERF_STORAGE_KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
  } catch {
    // ignore storage errors
  }
  const ua = navigator.userAgent || '';
  if (/Android.*(TV|AFT|BRAVIA|SHIELD|RockTek|GX1|MIBOX|Chromecast|Leanback|SmartTV|GoogleTV)/i.test(ua)) {
    return true;
  }
  // Android device without touch points (typically TV boxes / HDMI sticks)
  if (/Android/i.test(ua) && (navigator.maxTouchPoints ?? 0) === 0) {
    return true;
  }
  return false;
}

export function SnesEmulatorPanel({ roomCode = '123456' }: SnesEmulatorPanelProps) {
  const [romLoaded, setRomLoaded] = useState(false);
  const [romName, setRomName] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [tvPerfMode, setTvPerfMode] = useState<boolean>(() => detectAndroidTvBox());
  const [romBlobUrl, setRomBlobUrl] = useState<string | null>(null);
  const [showMappingModal, setShowMappingModal] = useState(false);
  const [modalTab, setModalTab] = useState<'bluetooth' | 'phone-pad' | 'keys'>('bluetooth');

  // Input & Controller Detection States
  const [connectedGamepads, setConnectedGamepads] = useState<Array<{ id: string; index: number }>>([]);
  const [lastDetectedInput, setLastDetectedInput] = useState<{
    key: string;
    code: string;
    label: string;
    source: 'keyboard' | 'bluetooth' | 'gamepad';
    timestamp: number;
  } | null>(null);
  const [phonePadLinked, setPhonePadLinked] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const lastInputLabelRef = useRef<HTMLSpanElement | null>(null);
  const showMappingModalRef = useRef(showMappingModal);
  const mutedRef = useRef(muted);

  useEffect(() => {
    showMappingModalRef.current = showMappingModal;
  }, [showMappingModal]);

  useEffect(() => {
    mutedRef.current = muted;
    try {
      const win = iframeRef.current?.contentWindow as
        | (Window & { EJS_emulator?: { setVolume?: (v: number) => void } })
        | null;
      win?.EJS_emulator?.setVolume?.(muted ? 0 : 1.0);
    } catch {
      // ignore if iframe not initialized
    }
  }, [muted]);

  const toggleTvPerfMode = () => {
    setTvPerfMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(TV_PERF_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  };

  const reportDetectedInput = useCallback(
    (key: string, code: string, label: string, source: 'keyboard' | 'bluetooth' | 'gamepad') => {
      // Update header badge directly via DOM ref so gameplay never triggers React re-renders
      if (lastInputLabelRef.current) {
        lastInputLabelRef.current.textContent = label;
        lastInputLabelRef.current.className = 'text-emerald-400 font-bold';
      }
      if (showMappingModalRef.current) {
        setLastDetectedInput({
          key,
          code,
          label,
          source,
          timestamp: Date.now(),
        });
      }
    },
    []
  );

  useEffect(() => {
    return () => {
      if (romBlobUrl && romBlobUrl.startsWith('blob:')) {
        URL.revokeObjectURL(romBlobUrl);
      }
    };
  }, [romBlobUrl]);

  // Dispatch key event into EmulatorJS iframe
  const dispatchKeyToEmulator = useCallback(
    (type: 'keydown' | 'keyup', key: string, code: string, keyCode: number) => {
      const iframe = iframeRef.current;
      if (!iframe) return;
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        const targetWindow = iframe.contentWindow;
        if (doc && targetWindow) {
          const evt = new KeyboardEvent(type, {
            key,
            code,
            keyCode,
            which: keyCode,
            bubbles: true,
            cancelable: true,
          });
          doc.dispatchEvent(evt);
          targetWindow.dispatchEvent(evt);
        }
      } catch {
        // Cross-origin fallback
      }
    },
    []
  );

  // 1. Listen for Bluetooth Virtual Keyboard and Physical Keyboard input globally
  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in form inputs
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) {
        return;
      }

      if (e.type === 'keydown' && !e.repeat) {
        const mapped = SNES_KEY_MAP[e.code] || SNES_KEY_MAP[e.key];
        const label = mapped ? `${mapped.label} (${mapped.snes})` : e.code || e.key;
        reportDetectedInput(e.key, e.code, label, 'bluetooth');
      }

      // Forward into emulator iframe so Bluetooth virtual keyboards work without iframe focus!
      dispatchKeyToEmulator(e.type as 'keydown' | 'keyup', e.key, e.code, e.keyCode);
    };

    window.addEventListener('keydown', handleGlobalKey);
    window.addEventListener('keyup', handleGlobalKey);
    return () => {
      window.removeEventListener('keydown', handleGlobalKey);
      window.removeEventListener('keyup', handleGlobalKey);
    };
  }, [dispatchKeyToEmulator, reportDetectedInput]);

  // 2. Listen for Bluetooth Gamepads via Web Gamepad API
  useEffect(() => {
    const updateGamepads = () => {
      if (typeof navigator !== 'undefined' && navigator.getGamepads) {
        const pads = Array.from(navigator.getGamepads())
          .filter((p): p is Gamepad => p !== null && p.connected)
          .map((p) => ({ id: p.id, index: p.index }));

        setConnectedGamepads((prev) => {
          if (
            prev.length === pads.length &&
            prev.every((item, idx) => item.index === pads[idx].index && item.id === pads[idx].id)
          ) {
            return prev;
          }
          return pads;
        });
      }
    };

    window.addEventListener('gamepadconnected', updateGamepads);
    window.addEventListener('gamepaddisconnected', updateGamepads);
    const interval = window.setInterval(updateGamepads, 2500);

    return () => {
      window.removeEventListener('gamepadconnected', updateGamepads);
      window.removeEventListener('gamepaddisconnected', updateGamepads);
      window.clearInterval(interval);
    };
  }, []);

  // 3. Listen for Phone Touch Gamepad over P2P (MQTT + BroadcastChannel)
  useEffect(() => {
    const handleGamepadMsg = (raw: string) => {
      try {
        const data = JSON.parse(raw);
        if (data.type === 'snes-key' && data.button) {
          setPhonePadLinked((prev) => (prev ? prev : true));
          const keyInfo = BUTTON_TO_KEY_EVENT[data.button];
          if (keyInfo) {
            const eventType = data.action === 'down' ? 'keydown' : 'keyup';
            if (eventType === 'keydown') {
              reportDetectedInput(keyInfo.key, keyInfo.code, `SNES Button ${data.button}`, 'gamepad');
            }
            dispatchKeyToEmulator(eventType, keyInfo.key, keyInfo.code, keyInfo.keyCode);
          }
        }
      } catch {
        // ignore
      }
    };

    // BroadcastChannel for same origin tabs
    const bc = new BroadcastChannel(`retroex-pad-${roomCode}`);
    bc.onmessage = (evt) => {
      if (typeof evt.data === 'string') handleGamepadMsg(evt.data);
    };

    // MQTT WSS for external phone connections over Wi-Fi
    const topic = `retroex/gamepad/${roomCode}`;
    const clientId = `tv_${Math.random().toString(16).slice(2, 8)}`;
    let ws: WebSocket;

    try {
      ws = new WebSocket(MQTT_BROKERS[0], 'mqtt');
      ws.binaryType = 'arraybuffer';

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
          // SUB
          const packetId = new Uint8Array([0x00, 0x01]);
          const topicBytes = encodeMqttString(topic);
          const qos = new Uint8Array([0x00]);
          ws.send(buildMqttPacket(0x82, [packetId, topicBytes, qos]));
        } else if (packetType === 3) {
          // PUBLISH message from phone controller
          if (bytes.length < 2) return;
          const topicLen = (bytes[0] << 8) | bytes[1];
          let offset = 2 + topicLen;
          const qos = (bytes[0] >> 1) & 0x03;
          if (qos > 0) offset += 2;
          if (offset > bytes.length) return;
          const payload = bytes.slice(offset);
          const text = new TextDecoder().decode(payload);
          handleGamepadMsg(text);
        }
      };
    } catch {
      // fallback
    }

    return () => {
      bc.close();
      if (ws) ws.close();
    };
  }, [roomCode, dispatchKeyToEmulator, reportDetectedInput]);

  // Build emulator iframe when playing
  useEffect(() => {
    if (!isPlaying || !romBlobUrl) return;

    const container = document.getElementById('ejs-game-container');
    if (!container) return;
    container.innerHTML = '';

    const iframe = document.createElement('iframe');
    iframeRef.current = iframe;
    iframe.id = 'ejs-game-iframe';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.style.backgroundColor = '#0f172a';
    iframe.allow = 'autoplay; fullscreen; gamepad; pointer-lock';
    container.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return;

    const defaultOpts = tvPerfMode
      ? {
          vsync: 'disabled',
          shader: 'disabled',
          rewindEnabled: 'disabled',
          webgl2Enabled: 'disabled',
          snes9x_audio_interpolation: 'none',
          snes9x_blargg: 'disabled',
          snes9x_hires_blend: 'disabled',
          snes9x_overclock_cycles: 'disabled',
          snes9x_reduce_sprite_flicker: 'disabled',
          'save-state-location': 'browser',
        }
      : {
          vsync: 'enabled',
          shader: 'disabled',
          rewindEnabled: 'disabled',
          snes9x_blargg: 'disabled',
          snes9x_hires_blend: 'disabled',
          'save-state-location': 'browser',
        };

    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body, html {
              margin: 0;
              padding: 0;
              width: 100%;
              height: 100%;
              background: #0f172a;
              overflow: hidden;
            }
            #game {
              width: 100%;
              height: 100%;
            }
            canvas {
              image-rendering: pixelated;
              image-rendering: crisp-edges;
            }
          </style>
        </head>
        <body>
          <div id="game"></div>
          <script>
            (function() {
              var tvPerf = ${tvPerfMode ? 'true' : 'false'};
              if (tvPerf) {
                // Prevent 2x/3x HiDPI framebuffer scaling on 4K/1080p Android TV boxes (RockTek GX1)
                try {
                  Object.defineProperty(window, 'devicePixelRatio', {
                    get: function() { return 1; },
                    configurable: true
                  });
                } catch (e) {}

                // Increase AudioContext playback buffer latency for HDMI TV output so audio never crackles or warps
                try {
                  var OrigAudioCtx = window.AudioContext || window.webkitAudioContext;
                  if (OrigAudioCtx) {
                    var PatchedAudioCtx = function(opts) {
                      var merged = Object.assign({ latencyHint: 'playback' }, opts || {});
                      merged.latencyHint = 'playback';
                      return new OrigAudioCtx(merged);
                    };
                    PatchedAudioCtx.prototype = OrigAudioCtx.prototype;
                    if (window.AudioContext) window.AudioContext = PatchedAudioCtx;
                    if (window.webkitAudioContext) window.webkitAudioContext = PatchedAudioCtx;
                  }
                } catch (e) {}

                // Disable expensive WebGL MSAA / alpha compositing on TV WebView Mali GPU
                try {
                  var origGetContext = HTMLCanvasElement.prototype.getContext;
                  HTMLCanvasElement.prototype.getContext = function(type, attrs) {
                    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
                      var fastAttrs = Object.assign({}, attrs || {}, {
                        alpha: false,
                        antialias: false,
                        desynchronized: true,
                        powerPreference: 'high-performance',
                        preserveDrawingBuffer: false
                      });
                      return origGetContext.call(this, type, fastAttrs);
                    }
                    return origGetContext.call(this, type, attrs);
                  };
                } catch (e) {}
              }

              // Suppress WakeLock permission errors inside sandbox
              if (navigator.wakeLock && navigator.wakeLock.request) {
                var origWakeLock = navigator.wakeLock.request.bind(navigator.wakeLock);
                navigator.wakeLock.request = function(type) {
                  return origWakeLock(type).catch(function() { return null; });
                };
              }
            })();

            window.EJS_player = '#game';
            window.EJS_core = 'snes';
            window.EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/';
            window.EJS_gameUrl = ${JSON.stringify(romBlobUrl)};
            window.EJS_mouse = false;
            window.EJS_multitap = false;
            window.EJS_volume = ${mutedRef.current ? 0 : 1.0};
            window.EJS_color = '#0f172a';
            window.EJS_forceLegacyCores = ${tvPerfMode ? 'true' : 'false'};
            window.EJS_defaultOptions = ${JSON.stringify(defaultOpts)};
            window.EJS_onGameStart = function() {
              try {
                if (${tvPerfMode ? 'true' : 'false'} && window.EJS_emulator && window.EJS_emulator.gameManager) {
                  window.EJS_emulator.gameManager.setVSync(false);
                }
              } catch (e) {}
            };
          </script>
          <script src="https://cdn.emulatorjs.org/stable/data/loader.js"></script>
        </body>
      </html>
    `);
    doc.close();

    // Auto-focus iframe so keyboard input hits it directly
    const focusTimer = window.setTimeout(() => {
      iframe.focus();
    }, 500);

    return () => {
      window.clearTimeout(focusTimer);
      if (container) container.innerHTML = '';
      iframeRef.current = null;
    };
  }, [isPlaying, romBlobUrl, tvPerfMode]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (romBlobUrl && romBlobUrl.startsWith('blob:')) {
      URL.revokeObjectURL(romBlobUrl);
    }
    const arrayBuffer = await file.arrayBuffer();
    const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    setRomBlobUrl(url);
    setRomName(file.name);
    setRomLoaded(true);
    setIsPlaying(true);
  };

  const loadBuiltinDemo = () => {
    if (romBlobUrl && romBlobUrl.startsWith('blob:')) {
      URL.revokeObjectURL(romBlobUrl);
    }
    const demoUrl = 'https://cdn.emulatorjs.org/roms/snes/super-mario-world.zip';
    setRomBlobUrl(demoUrl);
    setRomName('Super_Mario_World.zip');
    setRomLoaded(true);
    setIsPlaying(true);
  };

  const handleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else if (el.requestFullscreen) {
      void el.requestFullscreen().catch(() => {});
    }
  };

  const publicOrigin = getPublicAppOrigin();
  const phoneControllerUrl = publicOrigin ? `${publicOrigin}/?pad=${roomCode}` : '';

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-slate-200">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 flex items-center gap-2">
            <Gamepad2 className="w-6 h-6 text-indigo-600" />
            RetroEX Real HTML5 SNES Emulator
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Play Super Nintendo ROMs with automatic Bluetooth virtual keyboard, USB gamepad &amp; phone controller support.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowMappingModal(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors"
          >
            <Bluetooth className="w-4 h-4 text-indigo-600" />
            Controllers &amp; Bluetooth
          </button>
          <label className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 transition-colors cursor-pointer whitespace-nowrap">
            <Upload className="w-4 h-4" />
            Load SNES ROM
            <input
              type="file"
              accept=".smc,.sfc,.zip"
              className="hidden"
              onChange={(e) => void handleFileUpload(e)}
            />
          </label>
        </div>
      </div>

      {/* Live Bluetooth & Controller Input Detector Bar */}
      <div className="bg-slate-900 text-white rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Radio className={`w-4 h-4 text-emerald-400 ${!isPlaying ? 'animate-pulse' : ''}`} />
            <span className="font-semibold text-slate-200">Input Listener:</span>
            <span className="text-emerald-400 font-mono">Active (Global Forwarding)</span>
          </div>

          <div className="flex items-center gap-2 border-l border-slate-700 pl-4">
            <Bluetooth className="w-3.5 h-3.5 text-blue-400" />
            <span>Bluetooth Virtual Keyboard:</span>
            <span className="text-slate-300">Supported via Android TV Settings</span>
          </div>

          {connectedGamepads.length > 0 && (
            <div className="flex items-center gap-1.5 text-emerald-400 border-l border-slate-700 pl-4 font-mono">
              <Gamepad2 className="w-3.5 h-3.5" />
              <span>{connectedGamepads.length} Gamepad Connected</span>
            </div>
          )}

          {phonePadLinked && (
            <div className="flex items-center gap-1.5 text-indigo-400 border-l border-slate-700 pl-4 font-mono">
              <Smartphone className="w-3.5 h-3.5" />
              <span>Phone Touchpad Linked</span>
            </div>
          )}
        </div>

        {/* Real-time Last Key Pressed Badge (updated via ref during gameplay to avoid re-renders) */}
        <div className="flex items-center gap-2 font-mono bg-slate-950 px-3 py-1.5 rounded border border-slate-800">
          <span className="text-slate-400 text-[11px]">Last Input:</span>
          <span ref={lastInputLabelRef} className="text-slate-500 italic">
            Press any key/button to test
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Emulator Screen Container */}
        <div className="lg:col-span-8 space-y-4">
          <div
            ref={containerRef}
            className="relative aspect-[4/3] bg-slate-950 rounded-xl overflow-hidden border border-slate-800 shadow-inner flex items-center justify-center"
          >
            <div id="ejs-game-container" className="w-full h-full flex items-center justify-center"></div>

            {!isPlaying && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-slate-950/95 backdrop-blur-xs z-10">
                <Gamepad2 className="w-16 h-16 text-indigo-500 mb-3 animate-pulse" />
                <h3 className="text-lg font-semibold text-white">RetroEX Emulator Ready</h3>
                <p className="mt-1 text-xs text-slate-400 max-w-md">
                  Select any legitimate Super Nintendo ROM file (.smc, .sfc, or .zip) from your device to start playing.
                </p>
                <button
                  type="button"
                  onClick={loadBuiltinDemo}
                  className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-500 shadow-lg"
                >
                  <Play className="w-4 h-4" />
                  Load Sample Homebrew ROM
                </button>
              </div>
            )}
          </div>

          {/* Controls Bar */}
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setIsPlaying((p) => !p)}
                disabled={!romLoaded}
                className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-50"
              >
                {isPlaying ? 'Stop / Restart' : 'Start Emulator'}
              </button>
              <button
                type="button"
                onClick={() => setMuted((m) => !m)}
                aria-label={muted ? 'Unmute audio' : 'Mute audio'}
                className="p-2 text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100"
              >
                {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={handleFullscreen}
                aria-label="Toggle fullscreen"
                className="p-2 text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={toggleTvPerfMode}
                title="Optimizes audio buffering, 1x pixel scaling & WebGL1 for RockTek GX1 and Android TV boxes"
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded border transition-colors ${
                  tvPerfMode
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <Zap className={`w-3.5 h-3.5 ${tvPerfMode ? 'text-emerald-600' : 'text-slate-400'}`} />
                TV Speed Mode: {tvPerfMode ? 'On' : 'Off'}
              </button>
            </div>

            <div className="text-xs text-slate-500 font-mono">
              {romName ? `Active: ${romName}` : 'No ROM loaded'}
            </div>
          </div>
        </div>

        {/* Sidebar Info & SNES Buttons Reference */}
        <div className="lg:col-span-4 space-y-4">
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">SNES Input Controls</h3>
              <button
                type="button"
                onClick={() => {
                  setModalTab('bluetooth');
                  setShowMappingModal(true);
                }}
                className="text-xs text-indigo-600 hover:underline flex items-center gap-1 font-medium"
              >
                Setup Guide
                <ExternalLink className="w-3 h-3" />
              </button>
            </div>
            <div className="space-y-2 text-xs text-slate-600">
              <div className="flex justify-between border-b border-slate-200/60 pb-1.5">
                <span className="font-medium text-slate-700">D-Pad:</span>
                <span className="font-mono text-slate-900 bg-white px-2 py-0.5 rounded border border-slate-200">
                  Arrow Keys
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-200/60 pb-1.5">
                <span className="font-medium text-slate-700">Button A:</span>
                <span className="font-mono text-slate-900 bg-white px-2 py-0.5 rounded border border-slate-200">
                  Key X
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-200/60 pb-1.5">
                <span className="font-medium text-slate-700">Button B:</span>
                <span className="font-mono text-slate-900 bg-white px-2 py-0.5 rounded border border-slate-200">
                  Key Z
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-200/60 pb-1.5">
                <span className="font-medium text-slate-700">Button X:</span>
                <span className="font-mono text-slate-900 bg-white px-2 py-0.5 rounded border border-slate-200">
                  Key S
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-200/60 pb-1.5">
                <span className="font-medium text-slate-700">Button Y:</span>
                <span className="font-mono text-slate-900 bg-white px-2 py-0.5 rounded border border-slate-200">
                  Key A
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-200/60 pb-1.5">
                <span className="font-medium text-slate-700">Start / Select:</span>
                <span className="font-mono text-slate-900 bg-white px-2 py-0.5 rounded border border-slate-200">
                  Enter / Shift
                </span>
              </div>
              <div className="flex justify-between">
                <span className="font-medium text-slate-700">L / R Triggers:</span>
                <span className="font-mono text-slate-900 bg-white px-2 py-0.5 rounded border border-slate-200">
                  Key Q / Key W
                </span>
              </div>
            </div>
          </div>

          {/* Second Phone as Gamepad Card */}
          <div className="p-4 bg-indigo-50 border border-indigo-200 rounded-xl space-y-3">
            <div className="flex items-center gap-2 text-indigo-950 font-semibold text-sm">
              <Smartphone className="w-4 h-4 text-indigo-600" />
              Use Another Phone as Controller
            </div>
            <p className="text-xs text-indigo-900 leading-relaxed">
              You can pair another phone via <strong>Bluetooth Virtual Keyboard</strong> or simply scan the QR code to open an on-screen touchscreen SNES gamepad!
            </p>
            <button
              type="button"
              onClick={() => {
                setModalTab('phone-pad');
                setShowMappingModal(true);
              }}
              className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
            >
              <QrCode className="w-3.5 h-3.5" />
              Open Phone Controller QR Code
            </button>
          </div>
        </div>
      </div>

      {/* Controller & Bluetooth Mapping Modal */}
      {showMappingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
          <div className="w-full max-w-lg bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Gamepad2 className="w-5 h-5 text-indigo-600" />
                <h3 className="text-base font-semibold text-slate-900">Controller &amp; Bluetooth Setup</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowMappingModal(false)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Tabs */}
            <div className="flex border-b border-slate-200 bg-slate-50 text-xs font-medium">
              <button
                type="button"
                onClick={() => setModalTab('bluetooth')}
                className={`flex-1 py-3 border-b-2 text-center transition-colors flex items-center justify-center gap-1.5 ${
                  modalTab === 'bluetooth'
                    ? 'border-indigo-600 text-indigo-600 bg-white font-semibold'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                <Bluetooth className="w-3.5 h-3.5" />
                Bluetooth Virtual Keyboard
              </button>
              <button
                type="button"
                onClick={() => setModalTab('phone-pad')}
                className={`flex-1 py-3 border-b-2 text-center transition-colors flex items-center justify-center gap-1.5 ${
                  modalTab === 'phone-pad'
                    ? 'border-indigo-600 text-indigo-600 bg-white font-semibold'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5" />
                Phone Touch Gamepad
              </button>
              <button
                type="button"
                onClick={() => setModalTab('keys')}
                className={`flex-1 py-3 border-b-2 text-center transition-colors flex items-center justify-center gap-1.5 ${
                  modalTab === 'keys'
                    ? 'border-indigo-600 text-indigo-600 bg-white font-semibold'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                <Keyboard className="w-3.5 h-3.5" />
                Keymap
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 overflow-y-auto space-y-4 text-xs text-slate-600">
              {modalTab === 'bluetooth' && (
                <div className="space-y-4">
                  <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3.5 text-indigo-950 space-y-1.5">
                    <div className="font-semibold flex items-center gap-1.5 text-sm">
                      <Bluetooth className="w-4 h-4 text-indigo-600" />
                      Can Android TV detect a Bluetooth virtual keyboard from another phone?
                    </div>
                    <p className="leading-relaxed">
                      <strong>Yes!</strong> Android TV natively supports standard Bluetooth HID virtual keyboard apps.
                      Once paired in your TV settings, RetroEX automatically intercepts all keystrokes and forwards them directly into the SNES emulator.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <h4 className="font-semibold text-slate-900 text-sm">How to Connect:</h4>
                    <ol className="list-decimal list-inside space-y-2 text-slate-700 leading-relaxed bg-slate-50 p-3.5 rounded-lg border border-slate-200">
                      <li>
                        On your second phone, install a virtual Bluetooth keyboard app such as{' '}
                        <strong>"Serverless Bluetooth Keyboard &amp; Mouse"</strong> or <strong>"Bluetooth Remote PC/TV"</strong> from Google Play.
                      </li>
                      <li>
                        Open your Android TV (or device) <strong>Settings &gt; Remotes &amp; Accessories &gt; Add Accessory / Pair Bluetooth</strong>.
                      </li>
                      <li>
                        Put the virtual keyboard app on your other phone in <em>Discoverable / Pairing Mode</em> and pair with your TV.
                      </li>
                      <li>
                        Once paired, return to RetroEX. Every key or D-Pad press on your phone is automatically forwarded to the game!
                      </li>
                    </ol>
                  </div>

                  {/* Live Input Test Box */}
                  <div className="bg-slate-900 text-white p-3.5 rounded-lg space-y-2 border border-slate-800">
                    <div className="text-slate-300 font-semibold flex items-center justify-between">
                      <span>Live Key Detector &amp; Test:</span>
                      <span className="text-[11px] text-emerald-400 font-mono">Listening now</span>
                    </div>
                    <div className="p-2.5 bg-slate-950 rounded border border-slate-800 text-center font-mono">
                      {lastDetectedInput ? (
                        <span className="text-emerald-400 font-bold text-sm">
                          Detected: {lastDetectedInput.label} ({lastDetectedInput.code})
                        </span>
                      ) : (
                        <span className="text-slate-500 italic">Press any key on your virtual keyboard to test...</span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {modalTab === 'phone-pad' && (
                <div className="space-y-4">
                  <div className="text-center space-y-1">
                    <h4 className="font-semibold text-slate-900 text-sm">Scan with Your Phone</h4>
                    <p className="text-slate-500">
                      Instantly turns any phone into a touchscreen SNES controller over local Wi-Fi without installing any app.
                    </p>
                  </div>

                  {phoneControllerUrl && (
                    <div className="flex flex-col items-center justify-center p-4 bg-slate-50 rounded-lg border border-slate-200 gap-3">
                      <QrCodeSvg value={phoneControllerUrl} size={160} label="Phone Controller QR Code" />
                      <div className="text-center space-y-1">
                        <div className="font-mono text-xs text-indigo-700 font-semibold break-all">
                          {phoneControllerUrl}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          Room Code: <span className="font-mono font-bold text-slate-900">{roomCode}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="text-xs text-slate-600 bg-indigo-50 p-3 rounded-lg border border-indigo-200">
                    <strong>Features:</strong> Full SNES D-Pad, colored action buttons (A, B, X, Y), L &amp; R triggers, Start, Select, and haptic vibration feedback.
                  </div>
                </div>
              )}

              {modalTab === 'keys' && (
                <div className="space-y-3">
                  <h4 className="font-semibold text-slate-900 text-sm">Default SNES Keyboard Controls</h4>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="p-2 bg-slate-50 rounded border border-slate-200 flex justify-between">
                      <span className="text-slate-600">D-Pad:</span>
                      <span className="font-mono font-bold text-slate-900">Arrow Keys</span>
                    </div>
                    <div className="p-2 bg-slate-50 rounded border border-slate-200 flex justify-between">
                      <span className="text-slate-600">Button A:</span>
                      <span className="font-mono font-bold text-slate-900">Key X</span>
                    </div>
                    <div className="p-2 bg-slate-50 rounded border border-slate-200 flex justify-between">
                      <span className="text-slate-600">Button B:</span>
                      <span className="font-mono font-bold text-slate-900">Key Z</span>
                    </div>
                    <div className="p-2 bg-slate-50 rounded border border-slate-200 flex justify-between">
                      <span className="text-slate-600">Button X:</span>
                      <span className="font-mono font-bold text-slate-900">Key S</span>
                    </div>
                    <div className="p-2 bg-slate-50 rounded border border-slate-200 flex justify-between">
                      <span className="text-slate-600">Button Y:</span>
                      <span className="font-mono font-bold text-slate-900">Key A</span>
                    </div>
                    <div className="p-2 bg-slate-50 rounded border border-slate-200 flex justify-between">
                      <span className="text-slate-600">Start / Select:</span>
                      <span className="font-mono font-bold text-slate-900">Enter / Shift</span>
                    </div>
                    <div className="p-2 bg-slate-50 rounded border border-slate-200 flex justify-between">
                      <span className="text-slate-600">L Trigger:</span>
                      <span className="font-mono font-bold text-slate-900">Key Q</span>
                    </div>
                    <div className="p-2 bg-slate-50 rounded border border-slate-200 flex justify-between">
                      <span className="text-slate-600">R Trigger:</span>
                      <span className="font-mono font-bold text-slate-900">Key W</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => setShowMappingModal(false)}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
