import { useCallback, useEffect, useRef, useState } from 'react';
import { Nostalgist } from 'nostalgist';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bluetooth,
  ExternalLink,
  Gamepad2,
  Keyboard,
  Loader2,
  Maximize2,
  Play,
  QrCode,
  Radio,
  RotateCcw,
  Save,
  Settings,
  SlidersHorizontal,
  Smartphone,
  Upload,
  Volume2,
  VolumeX,
  X,
  Zap,
} from 'lucide-react';
import { QrCodeSvg } from './QrCodeSvg';
import { getPublicAppOrigin, isNativeCapacitorOrigin } from '../utils/apiUrl';

interface SnesEmulatorPanelProps {
  roomCode?: string;
  externalRom?: { id: string; name: string; blob: Blob } | null;
}

type SnesCoreId = 'snes9x2005' | 'snes9x2002' | 'snes9x';

interface SnesSettings {
  frameskip: 'auto' | 'disabled';
  audioLatencyMs: 64 | 128 | 192 | 256;
  videoSmooth: boolean;
  vsync: boolean;
  audioResampler: 'nearest' | 'sinc';
  lowPassFilter: boolean;
}

const CORE_LABELS: Record<SnesCoreId, string> = {
  snes9x2005: 'Fast TV (Snes9x 2005)',
  snes9x2002: 'Ultra-Fast (Snes9x 2002)',
  snes9x: 'High Accuracy (Snes9x)',
};

const CORE_STORAGE_KEY = 'retroex_snes_core_v1';
const TV_PERF_STORAGE_KEY = 'retroex_tv_perf_mode_v1';
const SNES_SETTINGS_STORAGE_KEY = 'retroex_snes_settings_v1';
const TOUCH_OVERLAY_STORAGE_KEY = 'retroex_touch_overlay_v1';
const SAMPLE_HOMEBREW_ROM_URL =
  'https://cdn.jsdelivr.net/gh/retrobrews/snes-games@master/astrohawk.smc';
const SAMPLE_HOMEBREW_ROM_NAME = 'Astrohawk_Homebrew.smc';

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

const PHONE_BTN_TO_RETRO: Record<string, string> = {
  Up: 'up',
  Down: 'down',
  Left: 'left',
  Right: 'right',
  A: 'a',
  B: 'b',
  X: 'x',
  Y: 'y',
  L: 'l',
  R: 'r',
  Start: 'start',
  Select: 'select',
};

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

function detectAndroidTvBox(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  try {
    const saved = localStorage.getItem(TV_PERF_STORAGE_KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
  } catch {
    // ignore storage errors
  }
  if (isNativeCapacitorOrigin()) return true;
  const ua = navigator.userAgent || '';
  if (
    /Android.*(TV|AFT|BRAVIA|SHIELD|RockTek|GX1|SEI804|MIBOX|Chromecast|Leanback|SmartTV|GoogleTV)/i.test(
      ua
    )
  ) {
    return true;
  }
  if (/Android/i.test(ua)) {
    // Non-touch Android TV boxes, large-screen TV browsers, or remote-controlled Android devices
    if ((navigator.maxTouchPoints ?? 0) === 0) return true;
    if (typeof window.screen?.width === 'number' && window.screen.width >= 1024) return true;
    if (window.matchMedia && !window.matchMedia('(pointer: coarse)').matches) return true;
  }
  return false;
}

function detectTouchScreen(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  try {
    const saved = localStorage.getItem(TOUCH_OVERLAY_STORAGE_KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
  } catch {
    // ignore
  }
  const hasCoarse =
    (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) ||
    (navigator.maxTouchPoints ?? 0) > 0;
  return hasCoarse && !detectAndroidTvBox();
}

function readSavedCore(tvDefault: boolean): SnesCoreId {
  try {
    const saved = localStorage.getItem(CORE_STORAGE_KEY);
    if (saved === 'snes9x2005' || saved === 'snes9x2002' || saved === 'snes9x') {
      return saved;
    }
  } catch {
    // ignore
  }
  return tvDefault ? 'snes9x2005' : 'snes9x2005';
}

function getDefaultSnesSettings(tvMode: boolean): SnesSettings {
  return {
    frameskip: tvMode ? 'auto' : 'disabled',
    audioLatencyMs: tvMode ? 192 : 64,
    videoSmooth: false,
    vsync: !tvMode,
    audioResampler: tvMode ? 'nearest' : 'sinc',
    lowPassFilter: !tvMode,
  };
}

function readSavedSnesSettings(tvDefault: boolean): SnesSettings {
  const defaults = getDefaultSnesSettings(tvDefault);
  try {
    const raw = localStorage.getItem(SNES_SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<SnesSettings>;
    return {
      frameskip: parsed.frameskip === 'disabled' ? 'disabled' : parsed.frameskip === 'auto' ? 'auto' : defaults.frameskip,
      audioLatencyMs:
        parsed.audioLatencyMs === 64 ||
        parsed.audioLatencyMs === 128 ||
        parsed.audioLatencyMs === 192 ||
        parsed.audioLatencyMs === 256
          ? parsed.audioLatencyMs
          : defaults.audioLatencyMs,
      videoSmooth: typeof parsed.videoSmooth === 'boolean' ? parsed.videoSmooth : defaults.videoSmooth,
      vsync: typeof parsed.vsync === 'boolean' ? parsed.vsync : defaults.vsync,
      audioResampler:
        parsed.audioResampler === 'sinc' || parsed.audioResampler === 'nearest'
          ? parsed.audioResampler
          : defaults.audioResampler,
      lowPassFilter:
        typeof parsed.lowPassFilter === 'boolean' ? parsed.lowPassFilter : defaults.lowPassFilter,
    };
  } catch {
    return defaults;
  }
}

async function inflateDeflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot extract .zip ROMs directly. Please upload an unzipped .smc or .sfc ROM.');
  }
  const copy = new Uint8Array(compressed.byteLength);
  copy.set(compressed);
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([copy]).stream().pipeThrough(ds);
  const outBuf = await new Response(stream).arrayBuffer();
  return new Uint8Array(outBuf);
}

async function extractSnesRomFile(
  rawFile: File | { name: string; buffer: ArrayBuffer }
): Promise<{ fileName: string; fileContent: Blob }> {
  const name = rawFile.name;
  const buffer = rawFile instanceof File ? await rawFile.arrayBuffer() : rawFile.buffer;
  const bytes = new Uint8Array(buffer);

  // Detect ZIP magic header PK\x03\x04
  const looksZip =
    name.toLowerCase().endsWith('.zip') ||
    (bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      bytes[2] === 0x03 &&
      bytes[3] === 0x04);

  if (!looksZip) {
    const safeName = /\.(smc|sfc|swc|fig)$/i.test(name) ? name : `${name}.sfc`;
    return {
      fileName: safeName,
      fileContent: new Blob([bytes], { type: 'application/octet-stream' }),
    };
  }

  // Locate ZIP End of Central Directory (PK\x05\x06)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minOffset = Math.max(0, bytes.length - 65557);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid .zip ROM archive.');
  }

  const centralDirSize = view.getUint32(eocdOffset + 12, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  let cursor = centralDirOffset;
  const end = Math.min(bytes.length, centralDirOffset + centralDirSize);
  const decoder = new TextDecoder();

  while (cursor + 46 <= end) {
    if (
      bytes[cursor] !== 0x50 ||
      bytes[cursor + 1] !== 0x4b ||
      bytes[cursor + 2] !== 0x01 ||
      bytes[cursor + 3] !== 0x02
    ) {
      break;
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const entryName = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor += 46 + nameLen + extraLen + commentLen;

    if (!/\.(smc|sfc|swc|fig)$/i.test(entryName)) continue;

    if (
      localHeaderOffset + 30 > bytes.length ||
      bytes[localHeaderOffset] !== 0x50 ||
      bytes[localHeaderOffset + 1] !== 0x4b ||
      bytes[localHeaderOffset + 2] !== 0x03 ||
      bytes[localHeaderOffset + 3] !== 0x04
    ) {
      continue;
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const slice = bytes.subarray(dataStart, dataStart + compressedSize);
    const baseName = entryName.split('/').pop() || 'game.sfc';

    if (method === 0) {
      return {
        fileName: baseName,
        fileContent: new Blob([new Uint8Array(slice)], { type: 'application/octet-stream' }),
      };
    }
    if (method === 8) {
      const inflated = await inflateDeflateRaw(slice);
      const copy = new Uint8Array(inflated.byteLength);
      copy.set(inflated);
      return {
        fileName: baseName,
        fileContent: new Blob([copy], { type: 'application/octet-stream' }),
      };
    }
  }

  throw new Error('No .smc or .sfc SNES ROM found inside that .zip archive.');
}

export function SnesEmulatorPanel({
  roomCode = '123456',
  externalRom = null,
}: SnesEmulatorPanelProps) {
  const [tvPerfMode, setTvPerfMode] = useState<boolean>(() => detectAndroidTvBox());
  const [showTouchOverlay, setShowTouchOverlay] = useState<boolean>(() => detectTouchScreen());
  const [selectedCore, setSelectedCore] = useState<SnesCoreId>(() =>
    readSavedCore(detectAndroidTvBox())
  );
  const [snesSettings, setSnesSettings] = useState<SnesSettings>(() =>
    readSavedSnesSettings(detectAndroidTvBox())
  );
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [draftCore, setDraftCore] = useState<SnesCoreId>(selectedCore);
  const [draftTvPerfMode, setDraftTvPerfMode] = useState<boolean>(tvPerfMode);
  const [draftSettings, setDraftSettings] = useState<SnesSettings>(snesSettings);

  const [romData, setRomData] = useState<{ fileName: string; fileContent: Blob } | null>(null);
  const [romName, setRomName] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBooting, setIsBooting] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [showMappingModal, setShowMappingModal] = useState(false);
  const [modalTab, setModalTab] = useState<'bluetooth' | 'phone-pad' | 'keys'>('bluetooth');
  const [hasQuickSave, setHasQuickSave] = useState(false);
  const [stateFeedback, setStateFeedback] = useState<string | null>(null);
  const [runKey, setRunKey] = useState(0);

  // Input & Controller Detection States
  const [connectedGamepads, setConnectedGamepads] = useState<Array<{ id: string; index: number }>>(
    []
  );
  const [lastDetectedInput, setLastDetectedInput] = useState<{
    key: string;
    code: string;
    label: string;
    source: 'keyboard' | 'bluetooth' | 'gamepad';
    timestamp: number;
  } | null>(null);
  const [phonePadLinked, setPhonePadLinked] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const nostalgistRef = useRef<Nostalgist | null>(null);
  const quickStateRef = useRef<Record<string, Blob>>({});
  const lastInputLabelRef = useRef<HTMLSpanElement | null>(null);
  const showMappingModalRef = useRef(showMappingModal);
  const showSettingsModalRef = useRef(showSettingsModal);
  const isPlayingRef = useRef(isPlaying);
  const mutedRef = useRef(muted);
  const appliedMuteRef = useRef(false);
  const handledExternalRomIdRef = useRef<string | null>(null);
  const activeTouchBtnsRef = useRef<Set<string>>(new Set());
  const touchPressTimeRef = useRef<Record<string, number>>({});
  const touchReleaseTimersRef = useRef<Record<string, number>>({});

  useEffect(() => {
    showMappingModalRef.current = showMappingModal;
  }, [showMappingModal]);

  useEffect(() => {
    showSettingsModalRef.current = showSettingsModal;
  }, [showSettingsModal]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    mutedRef.current = muted;
    const inst = nostalgistRef.current;
    if (inst && appliedMuteRef.current !== muted) {
      try {
        inst.sendCommand('MUTE');
        appliedMuteRef.current = muted;
      } catch {
        // ignore if still booting
      }
    }
  }, [muted]);

  const toggleTvPerfMode = () => {
    setTvPerfMode((prev) => {
      const next = !prev;
      const nextDefaults = getDefaultSnesSettings(next);
      setSnesSettings(nextDefaults);
      try {
        localStorage.setItem(TV_PERF_STORAGE_KEY, next ? '1' : '0');
        localStorage.setItem(SNES_SETTINGS_STORAGE_KEY, JSON.stringify(nextDefaults));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const handleCoreChange = (nextCore: SnesCoreId) => {
    setSelectedCore(nextCore);
    try {
      localStorage.setItem(CORE_STORAGE_KEY, nextCore);
    } catch {
      // ignore
    }
  };

  const openSettingsModal = useCallback(() => {
    setDraftCore(selectedCore);
    setDraftTvPerfMode(tvPerfMode);
    setDraftSettings(snesSettings);
    setShowSettingsModal(true);
  }, [selectedCore, snesSettings, tvPerfMode]);

  const openSettingsModalRef = useRef(openSettingsModal);
  useEffect(() => {
    openSettingsModalRef.current = openSettingsModal;
  }, [openSettingsModal]);

  const applySettingsFromModal = () => {
    setSelectedCore(draftCore);
    setTvPerfMode(draftTvPerfMode);
    setSnesSettings(draftSettings);
    try {
      localStorage.setItem(CORE_STORAGE_KEY, draftCore);
      localStorage.setItem(TV_PERF_STORAGE_KEY, draftTvPerfMode ? '1' : '0');
      localStorage.setItem(SNES_SETTINGS_STORAGE_KEY, JSON.stringify(draftSettings));
    } catch {
      // ignore
    }
    setShowSettingsModal(false);
    if (isPlaying && romData) {
      setRunKey((k) => k + 1);
    }
  };

  const handleOpenInGameMenu = () => {
    const inst = nostalgistRef.current;
    if (!inst) return;
    try {
      inst.sendCommand('MENU_TOGGLE');
      setShowSettingsModal(false);
    } catch {
      // ignore if booting
    }
  };

  const toggleTouchOverlay = () => {
    setShowTouchOverlay((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(TOUCH_OVERLAY_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  };

  const dispatchGamepadPress = useCallback((retroBtn: string, action: 'down' | 'up') => {
    const inst = nostalgistRef.current;
    if (!inst) return;
    if (action === 'down') {
      const pendingTimer = touchReleaseTimersRef.current[retroBtn];
      if (pendingTimer) {
        window.clearTimeout(pendingTimer);
        delete touchReleaseTimersRef.current[retroBtn];
      }
      if (activeTouchBtnsRef.current.has(retroBtn)) return;
      activeTouchBtnsRef.current.add(retroBtn);
      touchPressTimeRef.current[retroBtn] = Date.now();
      inst.pressDown(retroBtn);
    } else {
      if (!activeTouchBtnsRef.current.has(retroBtn)) return;
      activeTouchBtnsRef.current.delete(retroBtn);
      const elapsed = Date.now() - (touchPressTimeRef.current[retroBtn] || 0);
      const minHoldMs = 85;
      if (elapsed < minHoldMs) {
        touchReleaseTimersRef.current[retroBtn] = window.setTimeout(() => {
          delete touchReleaseTimersRef.current[retroBtn];
          nostalgistRef.current?.pressUp(retroBtn);
        }, minHoldMs - elapsed);
      } else {
        inst.pressUp(retroBtn);
      }
    }
  }, []);

  const handleTouchButton = (retroBtn: string, label: string, action: 'down' | 'up') => {
    if (action === 'down') {
      if (activeTouchBtnsRef.current.has(retroBtn)) return;
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        try {
          navigator.vibrate(15);
        } catch {
          // ignore
        }
      }
      reportDetectedInput(retroBtn, retroBtn, `Touch ${label}`, 'gamepad');
    }
    dispatchGamepadPress(retroBtn, action);
  };

  const reportDetectedInput = useCallback(
    (key: string, code: string, label: string, source: 'keyboard' | 'bluetooth' | 'gamepad') => {
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

  // Accept ROMs handed off directly from TV File Transfer / TV Receiver
  useEffect(() => {
    if (!externalRom || handledExternalRomIdRef.current === externalRom.id) return;
    handledExternalRomIdRef.current = externalRom.id;
    let cancelled = false;
    void (async () => {
      try {
        setBootError(null);
        const buf = await externalRom.blob.arrayBuffer();
        const extracted = await extractSnesRomFile({ name: externalRom.name, buffer: buf });
        if (cancelled) return;
        setRomData(extracted);
        setRomName(extracted.fileName);
        setHasQuickSave(Boolean(quickStateRef.current[extracted.fileName]));
        setIsPlaying(true);
        setRunKey((k) => k + 1);
      } catch (err) {
        if (!cancelled) {
          setBootError(err instanceof Error ? err.message : 'Unable to load transferred ROM.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [externalRom]);

  // 1. Listen for Bluetooth Virtual Keyboard & Physical Keyboard input globally
  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      if (e.type === 'keydown' && e.code === 'Escape') {
        if (showSettingsModalRef.current) {
          setShowSettingsModal(false);
          return;
        }
        if (showMappingModalRef.current) {
          setShowMappingModal(false);
          return;
        }
      }

      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) {
        return;
      }

      if (e.type === 'keydown' && !e.repeat) {
        const mapped = SNES_KEY_MAP[e.code] || SNES_KEY_MAP[e.key];
        const label = mapped ? `${mapped.label} (${mapped.snes})` : e.code || e.key;
        reportDetectedInput(e.key, e.code, label, 'bluetooth');
      }

      // Bridge Space or Left Shift onto RetroArch Select ('ShiftRight') seamlessly
      if ((e.code === 'Space' || e.code === 'ShiftLeft') && isPlaying && nostalgistRef.current) {
        e.preventDefault();
        if (e.type === 'keydown' && !e.repeat) {
          nostalgistRef.current.pressDown('select');
        } else if (e.type === 'keyup') {
          nostalgistRef.current.pressUp('select');
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKey);
    window.addEventListener('keyup', handleGlobalKey);
    return () => {
      window.removeEventListener('keydown', handleGlobalKey);
      window.removeEventListener('keyup', handleGlobalKey);
    };
  }, [isPlaying, reportDetectedInput]);

  // 2. Listen for Bluetooth Gamepads via Web Gamepad API (low-overhead polling)
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
    const navigateUiWithPhone = (button: string) => {
      if (button === 'B') {
        if (showSettingsModalRef.current) {
          setShowSettingsModal(false);
          return;
        }
        if (showMappingModalRef.current) {
          setShowMappingModal(false);
          return;
        }
      }

      const activeModal = document.querySelector<HTMLElement>('[data-retroex-modal="true"]');
      const scope: ParentNode = activeModal || document;
      const focusables = Array.from(
        scope.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), input:not([disabled]):not([type="hidden"]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);

      if (focusables.length === 0) return;

      const current = document.activeElement as HTMLElement | null;
      const currentIdx = current ? focusables.indexOf(current) : -1;

      if (button === 'Down' || button === 'Right') {
        const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % focusables.length : 0;
        focusables[nextIdx]?.focus();
        focusables[nextIdx]?.scrollIntoView({ block: 'nearest' });
      } else if (button === 'Up' || button === 'Left') {
        const prevIdx =
          currentIdx >= 0
            ? (currentIdx - 1 + focusables.length) % focusables.length
            : focusables.length - 1;
        focusables[prevIdx]?.focus();
        focusables[prevIdx]?.scrollIntoView({ block: 'nearest' });
      } else if (button === 'A' || button === 'Start') {
        const target = currentIdx >= 0 ? focusables[currentIdx] : focusables[0];
        if (target) {
          target.focus();
          target.click();
        }
      }
    };

    const handleGamepadMsg = (raw: string) => {
      try {
        const data = JSON.parse(raw);
        if (data.type === 'snes-command' && data.command === 'MENU_TOGGLE') {
          setPhonePadLinked((prev) => (prev ? prev : true));
          if (
            isPlayingRef.current &&
            nostalgistRef.current &&
            !showSettingsModalRef.current &&
            !showMappingModalRef.current
          ) {
            nostalgistRef.current.sendCommand('MENU_TOGGLE');
          } else if (showSettingsModalRef.current) {
            setShowSettingsModal(false);
          } else {
            openSettingsModalRef.current();
          }
          return;
        }

        if (data.type === 'snes-key' && data.button) {
          setPhonePadLinked((prev) => (prev ? prev : true));

          const isUiMode =
            !isPlayingRef.current ||
            showSettingsModalRef.current ||
            showMappingModalRef.current;

          if (isUiMode) {
            if (data.action === 'down') {
              reportDetectedInput(
                data.button,
                data.button,
                `Phone ${data.button}`,
                'gamepad'
              );
              navigateUiWithPhone(data.button);
            }
            return;
          }

          const retroBtn = PHONE_BTN_TO_RETRO[data.button];
          if (retroBtn) {
            if (data.action === 'down') {
              reportDetectedInput(retroBtn, retroBtn, `SNES Button ${data.button}`, 'gamepad');
              dispatchGamepadPress(retroBtn, 'down');
            } else {
              dispatchGamepadPress(retroBtn, 'up');
            }
          }
        }
      } catch {
        // ignore
      }
    };

    const bc = new BroadcastChannel(`retroex-pad-${roomCode}`);
    bc.onmessage = (evt) => {
      if (typeof evt.data === 'string') handleGamepadMsg(evt.data);
    };

    const topic = `retroex/gamepad/${roomCode}`;
    const clientId = `tv_${Math.random().toString(16).slice(2, 8)}`;
    let ws: WebSocket | undefined;

    try {
      ws = new WebSocket(MQTT_BROKERS[0], 'mqtt');
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        if (!ws) return;
        const proto = encodeMqttString('MQTT');
        const headerTail = new Uint8Array([0x04, 0x02, 0x00, 0x1e]);
        const cid = encodeMqttString(clientId);
        ws.send(buildMqttPacket(0x10, [proto, headerTail, cid]));
      };

      ws.onmessage = (evt) => {
        if (!ws || !(evt.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(evt.data);
        const packetType = (bytes[0] >> 4) & 0x0f;

        if (packetType === 2) {
          const packetId = new Uint8Array([0x00, 0x01]);
          const topicBytes = encodeMqttString(topic);
          const qos = new Uint8Array([0x00]);
          ws.send(buildMqttPacket(0x82, [packetId, topicBytes, qos]));
        } else if (packetType === 3) {
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
  }, [roomCode, reportDetectedInput, dispatchGamepadPress]);

  // 4. Launch / Tear down Nostalgist RetroArch instance cleanly
  useEffect(() => {
    if (!isPlaying || !romData) return;
    const host = canvasHostRef.current;
    if (!host) return;

    let cancelled = false;
    const abortController = new AbortController();
    let instance: Nostalgist | null = null;

    host.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.objectFit = 'contain';
    canvas.style.imageRendering = snesSettings.videoSmooth ? 'auto' : 'pixelated';
    canvas.style.backgroundColor = '#020617';
    host.appendChild(canvas);

    // Patch AudioContext & WebGL attributes temporarily during RetroArch core startup
    const winWithAudio = window as Window & {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const OrigAudioContext = winWithAudio.AudioContext;
    const OrigWebkitAudioContext = winWithAudio.webkitAudioContext;
    const origGetContext = canvas.getContext.bind(canvas);

    if (tvPerfMode) {
      if (OrigAudioContext) {
        const PatchedAudioCtx = function (opts?: AudioContextOptions) {
          return new OrigAudioContext({ ...(opts || {}), latencyHint: 'playback' });
        } as unknown as typeof AudioContext;
        PatchedAudioCtx.prototype = OrigAudioContext.prototype;
        winWithAudio.AudioContext = PatchedAudioCtx;
      }
      if (OrigWebkitAudioContext) {
        const PatchedWebkitCtx = function (opts?: AudioContextOptions) {
          return new OrigWebkitAudioContext({ ...(opts || {}), latencyHint: 'playback' });
        } as unknown as typeof AudioContext;
        PatchedWebkitCtx.prototype = OrigWebkitAudioContext.prototype;
        winWithAudio.webkitAudioContext = PatchedWebkitCtx;
      }
      canvas.getContext = ((type: string, attrs?: Record<string, unknown>) => {
        if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
          return origGetContext(type, {
            ...(attrs || {}),
            alpha: false,
            antialias: false,
            desynchronized: true,
            powerPreference: 'high-performance',
            preserveDrawingBuffer: false,
          });
        }
        return origGetContext(type, attrs);
      }) as typeof canvas.getContext;
    }

    const restorePatches = () => {
      if (OrigAudioContext) winWithAudio.AudioContext = OrigAudioContext;
      if (OrigWebkitAudioContext) winWithAudio.webkitAudioContext = OrigWebkitAudioContext;
      canvas.getContext = origGetContext;
    };

    const coreConfig: Record<string, string> =
      selectedCore === 'snes9x2005'
        ? {
            snes9x_2005_frameskip: snesSettings.frameskip,
            snes9x_2005_frameskip_threshold: '33',
            snes9x_2005_low_pass_filter: snesSettings.lowPassFilter ? 'enabled' : 'disabled',
          }
        : selectedCore === 'snes9x2002'
          ? {
              snes9x_2002_frameskip: snesSettings.frameskip,
            }
          : {
              snes9x_audio_interpolation: snesSettings.lowPassFilter ? 'gaussian' : 'none',
              snes9x_hires_blend: 'disabled',
              snes9x_blargg: 'disabled',
              snes9x_reduce_sprite_flicker: 'disabled',
              snes9x_overclock_cycles: 'disabled',
            };

    setIsBooting(true);
    setBootError(null);
    appliedMuteRef.current = false;

    void (async () => {
      try {
        const launched = await Nostalgist.launch({
          element: canvas,
          core: selectedCore,
          rom: {
            fileName: romData.fileName,
            fileContent: romData.fileContent,
          },
          size: tvPerfMode ? { width: 512, height: 448 } : { width: 800, height: 600 },
          style: {
            width: '100%',
            height: '100%',
            display: 'block',
            backgroundColor: '#020617',
            imageRendering: snesSettings.videoSmooth ? 'auto' : 'pixelated',
          },
          respondToGlobalEvents: true,
          cache: { core: true, rom: false },
          signal: abortController.signal,
          resolveCoreJs: (core) =>
            `https://cdn.jsdelivr.net/gh/arianrhodsandlot/retroarch-emscripten-build@v1.21.0/retroarch/${core}_libretro.js`,
          resolveCoreWasm: (core) =>
            `https://cdn.jsdelivr.net/gh/arianrhodsandlot/retroarch-emscripten-build@v1.21.0/retroarch/${core}_libretro.wasm`,
          retroarchConfig: {
            video_vsync: snesSettings.vsync,
            video_smooth: snesSettings.videoSmooth,
            video_shader_enable: false,
            audio_latency: snesSettings.audioLatencyMs,
            audio_resampler: snesSettings.audioResampler,
            audio_sync: true,
            audio_rate_control: true,
            audio_rate_control_delta: 0.02,
            savestate_thumbnail_enable: false,
            savestate_auto_load: false,
            notification_show_when_menu_is_alive: false,
            menu_swap_ok_cancel_buttons: false,
            menu_unified_controls: true,
            menu_pointer_enable: true,
            menu_mouse_enable: true,
            input_menu_toggle: 'f1',
            input_player1_up: 'up',
            input_player1_down: 'down',
            input_player1_left: 'left',
            input_player1_right: 'right',
            input_player1_a: 'x',
            input_player1_b: 'z',
            input_player1_x: 's',
            input_player1_y: 'a',
            input_player1_l: 'q',
            input_player1_r: 'w',
            input_player1_start: 'enter',
            input_player1_select: 'rshift',
          },
          retroarchCoreConfig: coreConfig,
          onLaunch: (inst) => {
            restorePatches();
            if (mutedRef.current) {
              try {
                inst.sendCommand('MUTE');
                appliedMuteRef.current = true;
              } catch {
                // ignore
              }
            }
          },
        });

        restorePatches();
        if (cancelled) {
          launched.exit({ removeCanvas: false });
          return;
        }
        instance = launched;
        nostalgistRef.current = launched;
        setIsBooting(false);
        canvas.focus();
      } catch (err) {
        restorePatches();
        if (cancelled || (err instanceof Error && err.message === 'Launch aborted')) return;
        setIsBooting(false);
        setBootError(
          err instanceof Error
            ? err.message
            : 'Unable to boot SNES core. Check internet connection or switch core.'
        );
      }
    })();

    return () => {
      cancelled = true;
      abortController.abort();
      restorePatches();
      const target = instance || nostalgistRef.current;
      nostalgistRef.current = null;
      if (target) {
        try {
          target.exit({ removeCanvas: false });
        } catch {
          // ignore exit errors
        }
      }
      if (host) host.innerHTML = '';
    };
  }, [isPlaying, romData, selectedCore, tvPerfMode, snesSettings, runKey]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setBootError(null);
      const extracted = await extractSnesRomFile(file);
      setRomData(extracted);
      setRomName(extracted.fileName);
      setHasQuickSave(Boolean(quickStateRef.current[extracted.fileName]));
      setIsPlaying(true);
      setRunKey((k) => k + 1);
    } catch (err) {
      setBootError(err instanceof Error ? err.message : 'Unable to read ROM file.');
    }
  };

  const loadBuiltinDemo = async () => {
    try {
      setIsBooting(true);
      setBootError(null);
      const res = await fetch(SAMPLE_HOMEBREW_ROM_URL);
      if (!res.ok) {
        throw new Error(`Failed to fetch sample homebrew ROM (HTTP ${res.status}).`);
      }
      const buffer = await res.arrayBuffer();
      const extracted = await extractSnesRomFile({ name: SAMPLE_HOMEBREW_ROM_NAME, buffer });
      setRomData(extracted);
      setRomName(extracted.fileName);
      setHasQuickSave(Boolean(quickStateRef.current[extracted.fileName]));
      setIsPlaying(true);
      setRunKey((k) => k + 1);
    } catch (err) {
      setIsBooting(false);
      setBootError(
        err instanceof Error ? err.message : 'Unable to load sample homebrew ROM.'
      );
    }
  };

  const handleSaveQuickState = async () => {
    const inst = nostalgistRef.current;
    if (!inst || !romName) return;
    try {
      const { state } = await inst.saveState();
      quickStateRef.current[romName] = state;
      setHasQuickSave(true);
      setStateFeedback('State saved');
      window.setTimeout(() => setStateFeedback(null), 2000);
    } catch {
      setStateFeedback('Save state failed');
      window.setTimeout(() => setStateFeedback(null), 2500);
    }
  };

  const handleLoadQuickState = async () => {
    const inst = nostalgistRef.current;
    if (!inst || !romName) return;
    const saved = quickStateRef.current[romName];
    if (!saved) return;
    try {
      await inst.loadState(saved);
      setStateFeedback('State loaded');
      window.setTimeout(() => setStateFeedback(null), 2000);
    } catch {
      setStateFeedback('Load state failed');
      window.setTimeout(() => setStateFeedback(null), 2500);
    }
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
            RetroEX HTML5 SNES Emulator
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Hardware-tuned for Android TV boxes (RockTek GX1) with automatic Bluetooth keyboard, USB gamepad &amp; phone controller support.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={openSettingsModal}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors"
          >
            <Settings className="w-4 h-4 text-slate-700" />
            SNES Settings
          </button>
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
              accept=".smc,.sfc,.swc,.fig,.zip"
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
            <span className="text-emerald-400 font-mono">Active</span>
          </div>

          <div className="flex items-center gap-2 border-l border-slate-700 pl-4">
            <Bluetooth className="w-3.5 h-3.5 text-blue-400" />
            <span>Bluetooth Virtual Keyboard:</span>
            <span className="text-slate-300">Auto-Forwarded</span>
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

        {/* Real-time Last Key Pressed Badge (updated via DOM ref so gameplay never re-renders) */}
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
            <div ref={canvasHostRef} className="w-full h-full flex items-center justify-center" />

            {isPlaying && isBooting && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-slate-950/90 z-10">
                <Loader2 className="w-10 h-10 text-indigo-400 animate-spin mb-3" />
                <div className="text-sm font-semibold text-white">
                  Starting {CORE_LABELS[selectedCore]}...
                </div>
                <div className="mt-1 text-xs text-slate-400">{romName}</div>
              </div>
            )}

            {bootError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-slate-950/95 z-20 space-y-3">
                <div className="text-sm font-semibold text-red-400">Emulator Load Issue</div>
                <p className="text-xs text-slate-300 max-w-md">{bootError}</p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setBootError(null);
                      setIsPlaying(true);
                      setRunKey((k) => k + 1);
                    }}
                    className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-500"
                  >
                    Retry Boot
                  </button>
                  {selectedCore !== 'snes9x2002' && (
                    <button
                      type="button"
                      onClick={() => {
                        setBootError(null);
                        handleCoreChange('snes9x2002');
                        setIsPlaying(true);
                        setRunKey((k) => k + 1);
                      }}
                      className="px-4 py-2 text-xs font-semibold text-slate-200 bg-slate-800 border border-slate-700 rounded-md hover:bg-slate-700"
                    >
                      Try Ultra-Fast Core (2002)
                    </button>
                  )}
                </div>
              </div>
            )}

            {!isPlaying && !bootError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-slate-950/95 z-10">
                <Gamepad2 className="w-16 h-16 text-indigo-500 mb-3" />
                <h3 className="text-lg font-semibold text-white">RetroEX Emulator Ready</h3>
                <p className="mt-1 text-xs text-slate-400 max-w-md">
                  Load any SNES ROM (.smc, .sfc, or .zip) from your device or via TV File Transfer. Uses{' '}
                  <span className="text-emerald-400 font-medium">{CORE_LABELS[selectedCore]}</span> for full-speed TV playback.
                </p>
                <button
                  type="button"
                  disabled={isBooting}
                  onClick={() => void loadBuiltinDemo()}
                  className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-500 shadow-lg disabled:opacity-60"
                >
                  {isBooting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  Load Sample Homebrew ROM
                </button>
              </div>
            )}

            {/* Built-in On-Screen Touchpad Overlay (for phones & tablets) */}
            {showTouchOverlay && isPlaying && !isBooting && !bootError && (
              <div className="absolute inset-0 z-10 pointer-events-none flex flex-col justify-between p-2.5 sm:p-4 select-none touch-none">
                {/* Top L / R Bumpers */}
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      handleTouchButton('l', 'L Bumper', 'down');
                    }}
                    onPointerUp={() => handleTouchButton('l', 'L Bumper', 'up')}
                    onPointerLeave={() => handleTouchButton('l', 'L Bumper', 'up')}
                    onPointerCancel={() => handleTouchButton('l', 'L Bumper', 'up')}
                    className="pointer-events-auto px-4 py-1.5 rounded-lg bg-slate-900/75 border border-white/20 text-white/90 text-[11px] font-bold active:bg-indigo-600/90 touch-none"
                  >
                    L
                  </button>
                  <button
                    type="button"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      handleTouchButton('r', 'R Bumper', 'down');
                    }}
                    onPointerUp={() => handleTouchButton('r', 'R Bumper', 'up')}
                    onPointerLeave={() => handleTouchButton('r', 'R Bumper', 'up')}
                    onPointerCancel={() => handleTouchButton('r', 'R Bumper', 'up')}
                    className="pointer-events-auto px-4 py-1.5 rounded-lg bg-slate-900/75 border border-white/20 text-white/90 text-[11px] font-bold active:bg-indigo-600/90 touch-none"
                  >
                    R
                  </button>
                </div>

                {/* Bottom D-Pad, Menu/Select/Start, and A/B/X/Y */}
                <div className="flex items-end justify-between gap-2">
                  {/* Touch D-Pad */}
                  <div className="pointer-events-auto relative w-28 h-28 sm:w-32 sm:h-32 rounded-full bg-slate-900/65 border border-white/15 backdrop-blur-xs touch-none">
                    <button
                      type="button"
                      aria-label="D-Pad Up"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleTouchButton('up', 'Up', 'down');
                      }}
                      onPointerUp={() => handleTouchButton('up', 'Up', 'up')}
                      onPointerLeave={() => handleTouchButton('up', 'Up', 'up')}
                      onPointerCancel={() => handleTouchButton('up', 'Up', 'up')}
                      className="absolute top-1 left-1/2 -translate-x-1/2 w-9 h-9 rounded-t-md bg-slate-800/85 border border-white/20 text-white flex items-center justify-center active:bg-indigo-600 touch-none"
                    >
                      <ArrowUp className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="D-Pad Down"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleTouchButton('down', 'Down', 'down');
                      }}
                      onPointerUp={() => handleTouchButton('down', 'Down', 'up')}
                      onPointerLeave={() => handleTouchButton('down', 'Down', 'up')}
                      onPointerCancel={() => handleTouchButton('down', 'Down', 'up')}
                      className="absolute bottom-1 left-1/2 -translate-x-1/2 w-9 h-9 rounded-b-md bg-slate-800/85 border border-white/20 text-white flex items-center justify-center active:bg-indigo-600 touch-none"
                    >
                      <ArrowDown className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="D-Pad Left"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleTouchButton('left', 'Left', 'down');
                      }}
                      onPointerUp={() => handleTouchButton('left', 'Left', 'up')}
                      onPointerLeave={() => handleTouchButton('left', 'Left', 'up')}
                      onPointerCancel={() => handleTouchButton('left', 'Left', 'up')}
                      className="absolute left-1 top-1/2 -translate-y-1/2 w-9 h-9 rounded-l-md bg-slate-800/85 border border-white/20 text-white flex items-center justify-center active:bg-indigo-600 touch-none"
                    >
                      <ArrowLeft className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="D-Pad Right"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleTouchButton('right', 'Right', 'down');
                      }}
                      onPointerUp={() => handleTouchButton('right', 'Right', 'up')}
                      onPointerLeave={() => handleTouchButton('right', 'Right', 'up')}
                      onPointerCancel={() => handleTouchButton('right', 'Right', 'up')}
                      className="absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9 rounded-r-md bg-slate-800/85 border border-white/20 text-white flex items-center justify-center active:bg-indigo-600 touch-none"
                    >
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Select / Menu / Start */}
                  <div className="pointer-events-auto flex items-center gap-1.5 mb-1 touch-none">
                    <button
                      type="button"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleTouchButton('select', 'Select', 'down');
                      }}
                      onPointerUp={() => handleTouchButton('select', 'Select', 'up')}
                      onPointerLeave={() => handleTouchButton('select', 'Select', 'up')}
                      onPointerCancel={() => handleTouchButton('select', 'Select', 'up')}
                      className="px-2.5 py-1 rounded-full bg-slate-900/80 border border-white/20 text-white text-[10px] font-bold uppercase active:bg-indigo-600 touch-none"
                    >
                      Sel
                    </button>
                    <button
                      type="button"
                      onClick={handleOpenInGameMenu}
                      className="px-2.5 py-1 rounded-full bg-indigo-600/85 border border-indigo-300/40 text-white text-[10px] font-bold uppercase active:bg-indigo-500 touch-none"
                    >
                      Menu
                    </button>
                    <button
                      type="button"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleTouchButton('start', 'Start', 'down');
                      }}
                      onPointerUp={() => handleTouchButton('start', 'Start', 'up')}
                      onPointerLeave={() => handleTouchButton('start', 'Start', 'up')}
                      onPointerCancel={() => handleTouchButton('start', 'Start', 'up')}
                      className="px-2.5 py-1 rounded-full bg-slate-900/80 border border-white/20 text-white text-[10px] font-bold uppercase active:bg-indigo-600 touch-none"
                    >
                      Start
                    </button>
                  </div>

                  {/* Touch X / Y / B / A */}
                  <div className="pointer-events-auto relative w-28 h-28 sm:w-32 sm:h-32 rounded-full bg-slate-900/65 border border-white/15 backdrop-blur-xs touch-none">
                    <button
                      type="button"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleTouchButton('x', 'X', 'down');
                      }}
                      onPointerUp={() => handleTouchButton('x', 'X', 'up')}
                      onPointerLeave={() => handleTouchButton('x', 'X', 'up')}
                      onPointerCancel={() => handleTouchButton('x', 'X', 'up')}
                      className="absolute top-1 left-1/2 -translate-x-1/2 w-9 h-9 rounded-full bg-blue-600/85 border border-blue-300/60 text-white font-bold text-xs flex items-center justify-center active:scale-90 touch-none"
                    >
                      X
                    </button>
                    <button
                      type="button"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleTouchButton('y', 'Y', 'down');
                      }}
                      onPointerUp={() => handleTouchButton('y', 'Y', 'up')}
                      onPointerLeave={() => handleTouchButton('y', 'Y', 'up')}
                      onPointerCancel={() => handleTouchButton('y', 'Y', 'up')}
                      className="absolute left-1 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-emerald-600/85 border border-emerald-300/60 text-white font-bold text-xs flex items-center justify-center active:scale-90 touch-none"
                    >
                      Y
                    </button>
                    <button
                      type="button"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleTouchButton('b', 'B', 'down');
                      }}
                      onPointerUp={() => handleTouchButton('b', 'B', 'up')}
                      onPointerLeave={() => handleTouchButton('b', 'B', 'up')}
                      onPointerCancel={() => handleTouchButton('b', 'B', 'up')}
                      className="absolute bottom-1 left-1/2 -translate-x-1/2 w-9 h-9 rounded-full bg-amber-500/85 border border-amber-200/60 text-white font-bold text-xs flex items-center justify-center active:scale-90 touch-none"
                    >
                      B
                    </button>
                    <button
                      type="button"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleTouchButton('a', 'A', 'down');
                      }}
                      onPointerUp={() => handleTouchButton('a', 'A', 'up')}
                      onPointerLeave={() => handleTouchButton('a', 'A', 'up')}
                      onPointerCancel={() => handleTouchButton('a', 'A', 'up')}
                      className="absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-rose-600/85 border border-rose-300/60 text-white font-bold text-xs flex items-center justify-center active:scale-90 touch-none"
                    >
                      A
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Controls Bar */}
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (isPlaying) {
                    setIsPlaying(false);
                  } else if (romData) {
                    setIsPlaying(true);
                    setRunKey((k) => k + 1);
                  }
                }}
                disabled={!romData}
                className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-50"
              >
                {isPlaying ? 'Stop' : 'Start Emulator'}
              </button>

              {isPlaying && (
                <button
                  type="button"
                  onClick={() => nostalgistRef.current?.restart()}
                  title="Reset game"
                  className="p-2 text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
              )}

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

              {isPlaying && !isBooting && (
                <>
                  <button
                    type="button"
                    onClick={() => void handleSaveQuickState()}
                    className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100"
                  >
                    <Save className="w-3.5 h-3.5" />
                    Quick Save
                  </button>
                  {hasQuickSave && (
                    <button
                      type="button"
                      onClick={() => void handleLoadQuickState()}
                      className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded hover:bg-indigo-100"
                    >
                      Load Save
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleOpenInGameMenu}
                    title="Open RetroArch In-Game Menu (or press F1)"
                    className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100"
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    In-Game Menu
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={toggleTvPerfMode}
                title="Uses 512x448 low-fillrate WebGL canvas, auto frameskip, and HDMI playback audio buffering for RockTek GX1 / Android TV"
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded border transition-colors ${
                  tvPerfMode
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <Zap className={`w-3.5 h-3.5 ${tvPerfMode ? 'text-emerald-600' : 'text-slate-400'}`} />
                TV Speed Mode: {tvPerfMode ? 'On' : 'Off'}
              </button>

              <button
                type="button"
                onClick={toggleTouchOverlay}
                title="Show or hide on-screen touchscreen gamepad buttons"
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded border transition-colors ${
                  showTouchOverlay
                    ? 'bg-indigo-50 text-indigo-800 border-indigo-300 hover:bg-indigo-100'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <Smartphone className={`w-3.5 h-3.5 ${showTouchOverlay ? 'text-indigo-600' : 'text-slate-400'}`} />
                Touchpad: {showTouchOverlay ? 'On' : 'Off'}
              </button>

              <select
                aria-label="SNES Core Engine"
                value={selectedCore}
                onChange={(e) => handleCoreChange(e.target.value as SnesCoreId)}
                className="h-8 px-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              >
                <option value="snes9x2005">Fast TV (Snes9x 2005)</option>
                <option value="snes9x2002">Ultra-Fast (Snes9x 2002)</option>
                <option value="snes9x">High Accuracy (Snes9x)</option>
              </select>

              <button
                type="button"
                onClick={openSettingsModal}
                aria-label="Open SNES Settings"
                title="SNES Settings (Core, Frameskip, Audio Latency, Video & In-Game Menu)"
                className="inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100"
              >
                <Settings className="w-3.5 h-3.5" />
                Settings
              </button>
            </div>

            <div className="text-xs text-slate-500 font-mono">
              {stateFeedback ? (
                <span className="text-emerald-700 font-semibold">{stateFeedback}</span>
              ) : romName ? (
                `Active: ${romName}`
              ) : (
                'No ROM loaded'
              )}
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

          {/* RockTek GX1 / TV Optimization Tip */}
          <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl space-y-2 text-xs text-emerald-950">
            <div className="font-semibold flex items-center gap-1.5">
              <Zap className="w-4 h-4 text-emerald-600" />
              Android TV &amp; RockTek GX1 Engine
            </div>
            <p className="leading-relaxed text-emerald-900">
              <strong>Fast TV (Snes9x 2005)</strong> runs ~4x faster on ARM Cortex-A55 TV boxes than standard desktop Snes9x, with auto-frameskip and 192ms HDMI audio buffering. For heavy SuperFX games, switch the selector above to <strong>Ultra-Fast (Snes9x 2002)</strong>.
            </p>
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
          <div
            data-retroex-modal="true"
            className="w-full max-w-lg bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]"
          >
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Gamepad2 className="w-5 h-5 text-indigo-600" />
                <h3 className="text-base font-semibold text-slate-900">
                  Controller &amp; Bluetooth Setup
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowMappingModal(false)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

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

            <div className="p-6 overflow-y-auto space-y-4 text-xs text-slate-600">
              {modalTab === 'bluetooth' && (
                <div className="space-y-4">
                  <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3.5 text-indigo-950 space-y-1.5">
                    <div className="font-semibold flex items-center gap-1.5 text-sm">
                      <Bluetooth className="w-4 h-4 text-indigo-600" />
                      Can Android TV detect a Bluetooth virtual keyboard from another phone?
                    </div>
                    <p className="leading-relaxed">
                      <strong>Yes!</strong> Android TV natively supports standard Bluetooth HID virtual keyboard apps. Once paired in your TV settings, RetroEX intercepts keystrokes and feeds them directly into the SNES engine.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <h4 className="font-semibold text-slate-900 text-sm">How to Connect:</h4>
                    <ol className="list-decimal list-inside space-y-2 text-slate-700 leading-relaxed bg-slate-50 p-3.5 rounded-lg border border-slate-200">
                      <li>
                        On your second phone, install a virtual Bluetooth keyboard app such as{' '}
                        <strong>&quot;Serverless Bluetooth Keyboard &amp; Mouse&quot;</strong> or{' '}
                        <strong>&quot;Bluetooth Remote PC/TV&quot;</strong> from Google Play.
                      </li>
                      <li>
                        Open your Android TV <strong>Settings &gt; Remotes &amp; Accessories &gt; Add Accessory / Pair Bluetooth</strong>.
                      </li>
                      <li>
                        Put the virtual keyboard app on your other phone in <em>Discoverable / Pairing Mode</em> and pair with your TV.
                      </li>
                      <li>
                        Once paired, return to RetroEX. Every key or D-Pad press on your phone works automatically!
                      </li>
                    </ol>
                  </div>

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
                        <span className="text-slate-500 italic">
                          Press any key on your virtual keyboard to test...
                        </span>
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

      {/* SNES Settings Modal */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
          <div
            data-retroex-modal="true"
            className="w-full max-w-lg bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]"
          >
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Settings className="w-5 h-5 text-indigo-600" />
                <h3 className="text-base font-semibold text-slate-900">SNES Emulator Settings</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowSettingsModal(false)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-5 text-xs text-slate-700">
              {/* RetroArch In-Game Menu Shortcut */}
              <div className="p-3.5 bg-indigo-50 border border-indigo-200 rounded-lg flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <div className="font-semibold text-indigo-950 text-sm">
                    RetroArch In-Game Menu (F1)
                  </div>
                  <p className="text-indigo-900/80 mt-0.5">
                    Access shaders, cheats, rewind, and per-game core options while playing.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!isPlaying || isBooting}
                  onClick={handleOpenInGameMenu}
                  className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-50 whitespace-nowrap"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  {isPlaying && !isBooting ? 'Open In-Game Menu' : 'Start a ROM First'}
                </button>
              </div>

              {/* Core Engine */}
              <div className="space-y-1.5">
                <label className="block font-semibold text-slate-900">SNES Core Engine</label>
                <select
                  value={draftCore}
                  onChange={(e) => setDraftCore(e.target.value as SnesCoreId)}
                  className="w-full h-9 px-3 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                >
                  <option value="snes9x2005">Fast TV — Snes9x 2005 (Recommended for TV Box)</option>
                  <option value="snes9x2002">Ultra-Fast — Snes9x 2002 (Heavy SuperFX / Slow CPUs)</option>
                  <option value="snes9x">High Accuracy — Snes9x (Desktop / Fast Phones)</option>
                </select>
              </div>

              {/* TV Speed Preset */}
              <div className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-lg">
                <div>
                  <div className="font-semibold text-slate-900">TV Speed Mode Preset</div>
                  <div className="text-slate-500 mt-0.5">
                    512x448 low-fillrate WebGL canvas &amp; Android TV playback timing
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const next = !draftTvPerfMode;
                    setDraftTvPerfMode(next);
                    setDraftSettings(getDefaultSnesSettings(next));
                  }}
                  className={`px-3 py-1.5 text-xs font-semibold rounded border transition-colors ${
                    draftTvPerfMode
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'bg-white text-slate-700 border-slate-300'
                  }`}
                >
                  {draftTvPerfMode ? 'On' : 'Off'}
                </button>
              </div>

              {/* Frameskip & Audio Latency */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block font-semibold text-slate-900">
                    Frameskip (2005 / 2002)
                  </label>
                  <select
                    value={draftSettings.frameskip}
                    onChange={(e) =>
                      setDraftSettings((s) => ({
                        ...s,
                        frameskip: e.target.value as 'auto' | 'disabled',
                      }))
                    }
                    className="w-full h-9 px-3 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md"
                  >
                    <option value="auto">Auto (Prevent Audio Crackle)</option>
                    <option value="disabled">Disabled (Full 60fps)</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="block font-semibold text-slate-900">Audio Buffer Latency</label>
                  <select
                    value={draftSettings.audioLatencyMs}
                    onChange={(e) =>
                      setDraftSettings((s) => ({
                        ...s,
                        audioLatencyMs: Number(e.target.value) as 64 | 128 | 192 | 256,
                      }))
                    }
                    className="w-full h-9 px-3 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md"
                  >
                    <option value={64}>64 ms (Low Latency / Desktop)</option>
                    <option value={128}>128 ms (Balanced)</option>
                    <option value={192}>192 ms (HDMI TV Recommended)</option>
                    <option value={256}>256 ms (Max Stutter Protection)</option>
                  </select>
                </div>
              </div>

              {/* Video & Sync Toggles */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer">
                  <div>
                    <div className="font-semibold text-slate-900">Video Smoothing</div>
                    <div className="text-[11px] text-slate-500">
                      {draftSettings.videoSmooth ? 'Bilinear Soft' : 'Sharp Retro Pixels'}
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={draftSettings.videoSmooth}
                    onChange={(e) =>
                      setDraftSettings((s) => ({ ...s, videoSmooth: e.target.checked }))
                    }
                    className="h-4 w-4 text-indigo-600 rounded"
                  />
                </label>

                <label className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer">
                  <div>
                    <div className="font-semibold text-slate-900">Browser VSync</div>
                    <div className="text-[11px] text-slate-500">
                      {draftSettings.vsync ? 'Enabled' : 'Off (Faster on TV)'}
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={draftSettings.vsync}
                    onChange={(e) =>
                      setDraftSettings((s) => ({ ...s, vsync: e.target.checked }))
                    }
                    className="h-4 w-4 text-indigo-600 rounded"
                  />
                </label>

                <label className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer sm:col-span-2">
                  <div>
                    <div className="font-semibold text-slate-900">Audio Resampler &amp; Low-Pass Filter</div>
                    <div className="text-[11px] text-slate-500">
                      {draftSettings.audioResampler === 'sinc'
                        ? 'High-quality Sinc + Warm Filter'
                        : 'Fast Nearest Resampler (Best TV Speed)'}
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={draftSettings.audioResampler === 'sinc'}
                    onChange={(e) =>
                      setDraftSettings((s) => ({
                        ...s,
                        audioResampler: e.target.checked ? 'sinc' : 'nearest',
                        lowPassFilter: e.target.checked,
                      }))
                    }
                    className="h-4 w-4 text-indigo-600 rounded"
                  />
                </label>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => {
                  const tvDefault = detectAndroidTvBox();
                  setDraftCore('snes9x2005');
                  setDraftTvPerfMode(tvDefault);
                  setDraftSettings(getDefaultSnesSettings(tvDefault));
                }}
                className="px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                Reset Defaults
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowSettingsModal(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={applySettingsFromModal}
                  className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-700"
                >
                  {isPlaying && romData ? 'Apply & Restart ROM' : 'Save Settings'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
