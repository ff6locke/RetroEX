export interface P2pIncomingFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  sha256: string;
  receivedAt: number;
  blobUrl: string;
  blob: Blob;
}

export interface P2pOutgoingProgress {
  id: string;
  name: string;
  size: number;
  sentBytes: number;
  status: 'queued' | 'sending' | 'sent' | 'error';
  error?: string;
}

export interface P2pIncomingProgress {
  id: string;
  name: string;
  size: number;
  receivedBytes: number;
}

export type P2pConnectionState =
  | 'initializing'
  | 'waiting'
  | 'pairing'
  | 'connected'
  | 'error';

export interface P2pSessionCallbacks {
  onStateChange: (state: P2pConnectionState, detail?: string) => void;
  onOutgoingUpdate: (items: P2pOutgoingProgress[]) => void;
  onIncomingProgress: (progress: P2pIncomingProgress | null) => void;
  onFileReceived: (file: P2pIncomingFile) => void;
}

const MQTT_WSS_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

const CHUNK_SIZE = 32 * 1024; // 32 KB safe across Chrome, Safari, and Android WebView

function randomHex(bytes = 6): string {
  const arr = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateRoomCode(): string {
  const arr = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
    return String(100000 + (arr[0] % 900000));
  }
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function computeFileSha256(file: File): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle || file.size > 120 * 1024 * 1024) {
    return `size-${file.size}`;
  }
  try {
    const buf = await file.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return `size-${file.size}`;
  }
}

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

class MqttWssClient {
  private ws: WebSocket | null = null;
  private rxBuf = new Uint8Array(0);
  private brokerIdx = 0;
  private closed = false;
  private subscribed = false;
  private keepAliveTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private connectTimeoutTimer: number | null = null;
  private readonly clientId = `np_${randomHex(6)}`;

  constructor(
    private readonly topic: string,
    private readonly onMessage: (payloadText: string) => void,
    private readonly onReady: () => void,
    private readonly onBrokerFail: (msg: string) => void
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  publish(payloadText: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.subscribed) return;
    const topicBytes = encodeMqttString(this.topic);
    const payloadBytes = new TextEncoder().encode(payloadText);
    this.ws.send(buildMqttPacket(0x30, [topicBytes, payloadBytes]));
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(new Uint8Array([0xe0, 0x00]).buffer);
        }
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  private clearTimers(): void {
    if (this.keepAliveTimer !== null) {
      window.clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectTimeoutTimer !== null) {
      window.clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
  }

  private connect(): void {
    if (this.closed) return;
    this.clearTimers();
    this.subscribed = false;
    this.rxBuf = new Uint8Array(0);

    const url = MQTT_WSS_BROKERS[this.brokerIdx % MQTT_WSS_BROKERS.length];
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, 'mqtt');
    } catch {
      this.scheduleNextBroker('Signaling WebSocket failed to initialize.');
      return;
    }

    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    this.connectTimeoutTimer = window.setTimeout(() => {
      if (!this.subscribed && !this.closed) {
        try {
          ws.close();
        } catch {
          // Ignore
        }
        this.scheduleNextBroker('Signaling connection timed out.');
      }
    }, 6000);

    ws.onopen = () => {
      if (this.closed || this.ws !== ws) return;
      const proto = encodeMqttString('MQTT');
      const headerTail = new Uint8Array([0x04, 0x02, 0x00, 0x1e]); // v3.1.1, CleanSession, KeepAlive 30s
      const cid = encodeMqttString(this.clientId);
      ws.send(buildMqttPacket(0x10, [proto, headerTail, cid]));
    };

    ws.onmessage = (evt) => {
      if (this.closed || this.ws !== ws) return;
      if (!(evt.data instanceof ArrayBuffer)) return;
      const incoming = new Uint8Array(evt.data);
      const merged = new Uint8Array(this.rxBuf.length + incoming.length);
      merged.set(this.rxBuf, 0);
      merged.set(incoming, this.rxBuf.length);
      this.rxBuf = merged;
      this.drainFrames();
    };

    ws.onerror = () => {
      // Handled via onclose
    };

    ws.onclose = () => {
      if (this.closed || this.ws !== ws) return;
      this.clearTimers();
      this.subscribed = false;
      this.scheduleNextBroker('Signaling connection closed.');
    };
  }

  private scheduleNextBroker(reason: string): void {
    if (this.closed) return;
    this.brokerIdx += 1;
    if (this.brokerIdx >= MQTT_WSS_BROKERS.length * 2) {
      this.onBrokerFail(reason);
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.connect();
    }, 1500);
  }

  private drainFrames(): void {
    while (this.rxBuf.length >= 2) {
      let multiplier = 1;
      let remainingLen = 0;
      let lenBytes = 0;
      let incomplete = false;

      for (let i = 1; i < 5; i++) {
        if (i >= this.rxBuf.length) {
          incomplete = true;
          break;
        }
        const encoded = this.rxBuf[i];
        remainingLen += (encoded & 0x7f) * multiplier;
        lenBytes += 1;
        if ((encoded & 0x80) === 0) break;
        multiplier *= 128;
      }

      if (incomplete) return;
      const totalLen = 1 + lenBytes + remainingLen;
      if (this.rxBuf.length < totalLen) return;

      const firstByte = this.rxBuf[0];
      const body = this.rxBuf.slice(1 + lenBytes, totalLen);
      this.rxBuf = this.rxBuf.slice(totalLen);

      this.handlePacket(firstByte, body);
    }
  }

  private handlePacket(firstByte: number, body: Uint8Array): void {
    const packetType = (firstByte >> 4) & 0x0f;

    if (packetType === 2) {
      // CONNACK
      if (body.length >= 2 && body[1] === 0 && this.ws?.readyState === WebSocket.OPEN) {
        const packetId = new Uint8Array([0x00, 0x01]);
        const topicBytes = encodeMqttString(this.topic);
        const qos = new Uint8Array([0x00]);
        this.ws.send(buildMqttPacket(0x82, [packetId, topicBytes, qos]));
      }
      return;
    }

    if (packetType === 9) {
      // SUBACK
      if (this.connectTimeoutTimer !== null) {
        window.clearTimeout(this.connectTimeoutTimer);
        this.connectTimeoutTimer = null;
      }
      this.subscribed = true;
      this.keepAliveTimer = window.setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(new Uint8Array([0xc0, 0x00]).buffer);
        }
      }, 20000);
      this.onReady();
      return;
    }

    if (packetType === 3) {
      // PUBLISH
      if (body.length < 2) return;
      const topicLen = (body[0] << 8) | body[1];
      let offset = 2 + topicLen;
      const qos = (firstByte >> 1) & 0x03;
      if (qos > 0) offset += 2;
      if (offset > body.length) return;
      const payload = body.slice(offset);
      try {
        const text = new TextDecoder().decode(payload);
        this.onMessage(text);
      } catch {
        // Ignore invalid UTF-8
      }
    }
  }
}

type SignalMessage =
  | { t: 'hello'; from: string }
  | { t: 'hello-ack'; from: string; to: string }
  | { t: 'offer'; from: string; to: string; sdp: string }
  | { t: 'answer'; from: string; to: string; sdp: string }
  | { t: 'ice'; from: string; to: string; candidate: RTCIceCandidateInit };

type ControlFrame =
  | { kind: 'file-start'; id: string; name: string; size: number; mimeType: string; sha256: string }
  | { kind: 'file-end'; id: string }
  | { kind: 'file-ack'; id: string };

export class P2pTransferSession {
  private readonly peerId = randomHex(6);
  private readonly mqtt: MqttWssClient;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private remotePeerId: string | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private helloTimer: number | null = null;
  private destroyed = false;

  private pendingFiles: Array<{ id: string; file: File }> = [];
  private outgoingItems: P2pOutgoingProgress[] = [];
  private sendingLoopActive = false;

  private receivingMeta: {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    sha256: string;
    receivedBytes: number;
    chunks: BlobPart[];
  } | null = null;

  constructor(
    public readonly roomCode: string,
    private readonly callbacks: P2pSessionCallbacks
  ) {
    const topic = `netpulse/p2p/v1/room/${roomCode}`;
    this.callbacks.onStateChange('initializing', 'Connecting pairing relay...');

    this.mqtt = new MqttWssClient(
      topic,
      (text) => this.handleSignalText(text),
      () => {
        if (this.destroyed) return;
        if (!this.isChannelOpen()) {
          this.callbacks.onStateChange('waiting', `Waiting for second device on code ${roomCode}...`);
        }
        this.startHelloBeacon();
      },
      (errMsg) => {
        if (this.destroyed || this.isChannelOpen()) return;
        this.callbacks.onStateChange(
          'error',
          `${errMsg} Check internet access to pair with the 6-digit code.`
        );
      }
    );
    this.mqtt.start();
  }

  isChannelOpen(): boolean {
    return this.dc !== null && this.dc.readyState === 'open';
  }

  queueFiles(files: File[]): void {
    if (this.destroyed || files.length === 0) return;
    const added = files.map((file) => ({
      id: `${Date.now()}_${randomHex(4)}`,
      file,
    }));
    this.pendingFiles.push(...added);
    this.outgoingItems = [
      ...this.outgoingItems,
      ...added.map(({ id, file }) => ({
        id,
        name: file.name,
        size: file.size,
        sentBytes: 0,
        status: 'queued' as const,
      })),
    ];
    this.callbacks.onOutgoingUpdate([...this.outgoingItems]);

    if (this.isChannelOpen()) {
      void this.flushOutgoingQueue();
    }
  }

  clearCompletedOutgoing(): void {
    this.outgoingItems = this.outgoingItems.filter(
      (item) => item.status === 'queued' || item.status === 'sending'
    );
    this.callbacks.onOutgoingUpdate([...this.outgoingItems]);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.helloTimer !== null) {
      window.clearInterval(this.helloTimer);
      this.helloTimer = null;
    }
    this.cleanupPeer();
    this.mqtt.close();
  }

  private startHelloBeacon(): void {
    if (this.helloTimer !== null) {
      window.clearInterval(this.helloTimer);
    }
    const sendHello = () => {
      if (this.destroyed || this.isChannelOpen()) return;
      this.publishSignal({ t: 'hello', from: this.peerId });
    };
    sendHello();
    this.helloTimer = window.setInterval(sendHello, 2200);
  }

  private publishSignal(msg: SignalMessage): void {
    this.mqtt.publish(JSON.stringify(msg));
  }

  private cleanupPeer(): void {
    if (this.dc) {
      try {
        this.dc.close();
      } catch {
        // Ignore
      }
      this.dc = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        // Ignore
      }
      this.pc = null;
    }
    this.remotePeerId = null;
    this.pendingIce = [];
  }

  private handleSignalText(text: string): void {
    if (this.destroyed) return;
    let msg: SignalMessage;
    try {
      msg = JSON.parse(text) as SignalMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || msg.from === this.peerId) return;
    if ('to' in msg && msg.to && msg.to !== this.peerId) return;

    if (msg.t === 'hello') {
      if (this.isChannelOpen() && this.remotePeerId === msg.from) return;
      this.publishSignal({ t: 'hello-ack', from: this.peerId, to: msg.from });
      this.considerPeer(msg.from);
      return;
    }

    if (msg.t === 'hello-ack') {
      this.considerPeer(msg.from);
      return;
    }

    if (msg.t === 'offer') {
      void this.handleOffer(msg.from, msg.sdp);
      return;
    }

    if (msg.t === 'answer') {
      void this.handleAnswer(msg.from, msg.sdp);
      return;
    }

    if (msg.t === 'ice') {
      void this.handleRemoteIce(msg.from, msg.candidate);
    }
  }

  private considerPeer(remoteId: string): void {
    if (this.isChannelOpen()) return;
    if (this.remotePeerId === remoteId && this.pc) return;

    // Deterministic tie-breaker: smaller peerId initiates the WebRTC offer
    if (this.peerId < remoteId) {
      void this.startOffer(remoteId);
    } else {
      this.callbacks.onStateChange('pairing', 'Peer found — establishing direct link...');
    }
  }

  private createPeerConnection(remoteId: string): RTCPeerConnection {
    this.cleanupPeer();
    this.remotePeerId = remoteId;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;

    pc.onicecandidate = (evt) => {
      if (evt.candidate && !this.destroyed) {
        this.publishSignal({
          t: 'ice',
          from: this.peerId,
          to: remoteId,
          candidate: evt.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.destroyed || this.pc !== pc) return;
      if (pc.connectionState === 'connected') {
        this.callbacks.onStateChange('connected', 'Direct P2P link ready (no server used)');
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (!this.destroyed) {
          this.cleanupPeer();
          this.callbacks.onStateChange('waiting', 'Peer disconnected — waiting to re-pair...');
        }
      }
    };

    return pc;
  }

  private attachDataChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;

    dc.onopen = () => {
      if (this.destroyed || this.dc !== dc) return;
      this.callbacks.onStateChange('connected', 'Direct P2P link active (device-to-device)');
      if (this.pendingFiles.length > 0) {
        void this.flushOutgoingQueue();
      }
    };

    dc.onclose = () => {
      if (this.destroyed || this.dc !== dc) return;
      this.dc = null;
      this.callbacks.onIncomingProgress(null);
      this.callbacks.onStateChange('waiting', 'Connection closed — waiting for peer...');
    };

    dc.onmessage = (evt) => {
      if (this.destroyed) return;
      if (typeof evt.data === 'string') {
        this.handleControlFrame(evt.data);
      } else if (evt.data instanceof ArrayBuffer) {
        this.handleBinaryChunk(evt.data);
      }
    };
  }

  private async startOffer(remoteId: string): Promise<void> {
    this.callbacks.onStateChange('pairing', 'Connecting directly to peer...');
    const pc = this.createPeerConnection(remoteId);
    const dc = pc.createDataChannel('netpulse-files', { ordered: true });
    this.attachDataChannel(dc);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.destroyed || this.pc !== pc || !offer.sdp) return;
      this.publishSignal({
        t: 'offer',
        from: this.peerId,
        to: remoteId,
        sdp: offer.sdp,
      });
    } catch (err) {
      this.callbacks.onStateChange(
        'error',
        err instanceof Error ? err.message : 'Unable to start WebRTC connection.'
      );
    }
  }

  private async handleOffer(remoteId: string, sdp: string): Promise<void> {
    if (this.isChannelOpen() && this.remotePeerId === remoteId) return;
    this.callbacks.onStateChange('pairing', 'Accepting direct connection...');
    const pc = this.createPeerConnection(remoteId);
    pc.ondatachannel = (evt) => {
      this.attachDataChannel(evt.channel);
    };

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      for (const c of this.pendingIce) {
        await pc.addIceCandidate(c).catch(() => undefined);
      }
      this.pendingIce = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (this.destroyed || this.pc !== pc || !answer.sdp) return;
      this.publishSignal({
        t: 'answer',
        from: this.peerId,
        to: remoteId,
        sdp: answer.sdp,
      });
    } catch {
      this.cleanupPeer();
    }
  }

  private async handleAnswer(remoteId: string, sdp: string): Promise<void> {
    if (!this.pc || this.remotePeerId !== remoteId) return;
    if (this.pc.signalingState !== 'have-local-offer') return;
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
      for (const c of this.pendingIce) {
        await this.pc.addIceCandidate(c).catch(() => undefined);
      }
      this.pendingIce = [];
    } catch {
      this.cleanupPeer();
    }
  }

  private async handleRemoteIce(remoteId: string, candidate: RTCIceCandidateInit): Promise<void> {
    if (this.remotePeerId !== remoteId || !this.pc) return;
    if (!this.pc.remoteDescription) {
      this.pendingIce.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(candidate).catch(() => undefined);
  }

  private handleControlFrame(raw: string): void {
    let frame: ControlFrame;
    try {
      frame = JSON.parse(raw) as ControlFrame;
    } catch {
      return;
    }

    if (frame.kind === 'file-start') {
      this.receivingMeta = {
        id: frame.id,
        name: frame.name,
        size: frame.size,
        mimeType: frame.mimeType || 'application/octet-stream',
        sha256: frame.sha256,
        receivedBytes: 0,
        chunks: [],
      };
      this.callbacks.onIncomingProgress({
        id: frame.id,
        name: frame.name,
        size: frame.size,
        receivedBytes: 0,
      });
      return;
    }

    if (frame.kind === 'file-end') {
      const meta = this.receivingMeta;
      this.receivingMeta = null;
      this.callbacks.onIncomingProgress(null);
      if (!meta || meta.id !== frame.id) return;

      const blob = new Blob(meta.chunks, { type: meta.mimeType });
      const blobUrl = URL.createObjectURL(blob);
      this.callbacks.onFileReceived({
        id: meta.id,
        name: meta.name,
        size: blob.size || meta.size,
        mimeType: meta.mimeType,
        sha256: meta.sha256,
        receivedAt: Date.now(),
        blobUrl,
        blob,
      });

      if (this.dc?.readyState === 'open') {
        this.dc.send(JSON.stringify({ kind: 'file-ack', id: meta.id } satisfies ControlFrame));
      }
      return;
    }

    if (frame.kind === 'file-ack') {
      this.outgoingItems = this.outgoingItems.map((item) =>
        item.id === frame.id
          ? { ...item, sentBytes: item.size, status: 'sent' }
          : item
      );
      this.callbacks.onOutgoingUpdate([...this.outgoingItems]);
    }
  }

  private handleBinaryChunk(buf: ArrayBuffer): void {
    const meta = this.receivingMeta;
    if (!meta) return;
    meta.chunks.push(buf);
    meta.receivedBytes += buf.byteLength;
    this.callbacks.onIncomingProgress({
      id: meta.id,
      name: meta.name,
      size: meta.size,
      receivedBytes: meta.receivedBytes,
    });
  }

  private async waitForBufferDrain(dc: RTCDataChannel): Promise<void> {
    if (dc.bufferedAmount <= 512 * 1024) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        dc.removeEventListener('bufferedamountlow', finish);
        window.clearTimeout(timer);
        resolve();
      };
      dc.addEventListener('bufferedamountlow', finish, { once: true });
      const timer = window.setTimeout(finish, 80);
    });
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.sendingLoopActive) return;
    this.sendingLoopActive = true;

    try {
      while (this.pendingFiles.length > 0 && this.isChannelOpen() && !this.destroyed) {
        const next = this.pendingFiles[0];
        const dc = this.dc;
        if (!dc || dc.readyState !== 'open') break;

        this.updateOutgoingItem(next.id, { status: 'sending', sentBytes: 0 });

        try {
          const sha256 = await computeFileSha256(next.file);
          if (!this.isChannelOpen() || this.destroyed) break;

          const startFrame: ControlFrame = {
            kind: 'file-start',
            id: next.id,
            name: next.file.name,
            size: next.file.size,
            mimeType: next.file.type || 'application/octet-stream',
            sha256,
          };
          dc.send(JSON.stringify(startFrame));

          let offset = 0;
          while (offset < next.file.size) {
            if (!this.isChannelOpen() || this.destroyed) {
              throw new Error('Peer disconnected mid-transfer');
            }
            if (dc.bufferedAmount > 512 * 1024) {
              await this.waitForBufferDrain(dc);
            }
            const slice = next.file.slice(offset, offset + CHUNK_SIZE);
            const buf = await slice.arrayBuffer();
            dc.send(buf);
            offset += buf.byteLength;
            this.updateOutgoingItem(next.id, { sentBytes: offset });
          }

          const endFrame: ControlFrame = { kind: 'file-end', id: next.id };
          dc.send(JSON.stringify(endFrame));
          this.pendingFiles.shift();
          this.updateOutgoingItem(next.id, { status: 'sent', sentBytes: next.file.size });
        } catch (err) {
          this.pendingFiles.shift();
          this.updateOutgoingItem(next.id, {
            status: 'error',
            error: err instanceof Error ? err.message : 'Transfer interrupted',
          });
        }
      }
    } finally {
      this.sendingLoopActive = false;
    }
  }

  private updateOutgoingItem(id: string, patch: Partial<P2pOutgoingProgress>): void {
    this.outgoingItems = this.outgoingItems.map((item) =>
      item.id === id ? { ...item, ...patch } : item
    );
    this.callbacks.onOutgoingUpdate([...this.outgoingItems]);
  }
}

export async function saveOrShareReceivedFile(file: P2pIncomingFile): Promise<void> {
  // Prefer native share sheet on Android when available so APK users can Save/Install directly
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      const fileObj = new File([file.blob], file.name, {
        type: file.mimeType || 'application/octet-stream',
      });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [fileObj] })) {
        await navigator.share({
          files: [fileObj],
          title: file.name,
        });
        return;
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      // Fall through to standard anchor download
    }
  }

  const a = document.createElement('a');
  a.href = file.blobUrl;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
