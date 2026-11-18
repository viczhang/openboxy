import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;

export const TTS_VOICES: Array<{ id: string; label: string }> = [
  { id: "auto", label: "Auto (Detect Language)" },
  { id: "en-US-EmmaMultilingualNeural", label: "Emma (US Female)" },
  { id: "en-US-AndrewMultilingualNeural", label: "Andrew (US Male)" },
  { id: "en-US-AriaNeural", label: "Aria (US Female)" },
  { id: "en-GB-SoniaNeural", label: "Sonia (UK Female)" },
  { id: "zh-CN-XiaoxiaoNeural", label: "Xiaoxiao (中文女声)" },
  { id: "zh-CN-YunxiNeural", label: "Yunxi (中文男声)" },
];

const VALID_VOICE_IDS = new Set(TTS_VOICES.map((v) => v.id));

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a,
  0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba,
  0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
  0xd258b060, 0x72766564,
];
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;

const CS64_COEFFICIENTS: Array<[number, number]> = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}
function rol16(v: number): number {
  return (((v & 0xffff) << 16) | (v >>> 16)) >>> 0;
}
function sigma0(v: number): number {
  return (rotr(v, 7) ^ rotr(v, 18) ^ (v >>> 3)) >>> 0;
}
function sigma1(v: number): number {
  return (rotr(v, 17) ^ rotr(v, 19) ^ (v >>> 10)) >>> 0;
}
function bigSigma0(v: number): number {
  return (rotr(v, 2) ^ rotr(v, 13) ^ rotr(v, 22)) >>> 0;
}
function bigSigma1(v: number): number {
  return (rotr(v, 6) ^ rotr(v, 11) ^ rotr(v, 25)) >>> 0;
}

function sha256Rounds(state: number[], words: number[], firstRound = 0): number[] {
  let [a, b, c, d, e, f, g, h] = state.map((x) => x >>> 0);
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  for (let i = firstRound; i < 64; i++) {
    const t1 = (h + bigSigma1(e) + ((g ^ (e & (f ^ g))) >>> 0) + constants[i]! + words[i]!) >>> 0;
    const t2 = (bigSigma0(a) + (((a & b) | (c & (a | b))) >>> 0)) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

function expandSha256Schedule(words: number[], firstWord = 16): void {
  for (let i = firstWord; i < 64; i++) {
    words.push((sigma1(words[i - 2]!) + words[i - 7]! + sigma0(words[i - 15]!) + words[i - 16]!) >>> 0);
  }
}

function sha256Init(data7: Buffer): number[] {
  const w0 = (data7[0]! << 16) | (data7[1]! << 8) | data7[2]!;
  const w1 = data7.readUInt32BE(3);
  const words: number[] = [...new Array(14).fill(0), w0 >>> 0, w1 >>> 0];
  for (let index = 16; index < 30; index++) {
    let value = SHA256_SCHEDULE[index - 16]!;
    if (index - 2 >= 14) {
      const s1 = sigma1(words[index - 2]!);
      value = (value + (index === 16 ? (s1 ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0 : s1)) >>> 0;
    }
    if (index - 7 >= 14) {
      value = (value + words[index - 7]!) >>> 0;
    }
    if (index - 15 >= 14) {
      const s0 = sigma0(words[index - 15]!);
      value = (value + (index === 29 ? (s0 ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0 : s0)) >>> 0;
    }
    words.push(value >>> 0);
  }
  words.push(
    (sigma1(words[28]!) + words[23]! + sigma0(words[15]!) + words[14]! + SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]!) >>> 0,
  );
  expandSha256Schedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, idx) => (x + working[idx]!) >>> 0);
}

function sha256Digest(data: Buffer): Buffer {
  const length = 57 + data.length;
  const padZeroes = (((55 - length) % 64) + 64) % 64;
  const tail = data.subarray(7);
  const padded = Buffer.alloc(tail.length + 1 + padZeroes + 8);
  tail.copy(padded, 0);
  padded[tail.length] = 0x80;
  padded.writeBigUInt64BE(BigInt(length * 8), padded.length - 8);
  let state = sha256Init(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words: number[] = [];
    for (let i = 0; i < 16; i++) {
      words.push(padded.readUInt32BE(offset + i * 4));
    }
    expandSha256Schedule(words, 16);
    const working = sha256Rounds(state, words, 0);
    state = state.map((x, idx) => (x + working[idx]!) >>> 0);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) out.writeUInt32BE(state[i]!, i * 4);
  return out;
}

function wordsLe4Even(data: Buffer): number[] {
  const rem = (4 - (data.length % 4)) % 4;
  const padded = rem ? Buffer.concat([data, Buffer.alloc(rem)]) : data;
  const words: number[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    words.push(padded.readUInt32LE(i));
  }
  if (words.length % 2 === 1) words.push(0);
  return words;
}

function cs64Digest(data: Buffer, digest: Buffer): Buffer {
  const keyA = (digest.readUInt32LE(0) | 1) >>> 0;
  const keyB = (digest.readUInt32LE(4) | 1) >>> 0;
  const factors: [number, number] = [
    Math.imul(keyA, CS64_FACTOR) >>> 0,
    Math.imul(keyB, CS64_FACTOR) >>> 0,
  ];
  const terms: number[] = CS64_COEFFICIENTS.map(([coeff], idx) => Math.imul(coeff, factors[idx % 2]!) >>> 0);
  const offsets: number[] = CS64_COEFFICIENTS.map(([, off]) => off >>> 0);
  const words = wordsLe4Even(Buffer.concat([Buffer.from([0]), data]));
  for (let idx = 0; idx < words.length; idx++) {
    const word = words[idx]!;
    let term = Math.imul(word, idx % 2 === 0 ? keyA : keyB) >>> 0;
    let offset = Math.imul(rol16(word), idx % 2 === 0 ? 0xef0569fb : 0xc31713db) >>> 0;
    if (idx === 0) {
      term = (term + Math.imul(CS64_ADJUSTMENT0, factors[0])) >>> 0;
      offset = (offset + CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  }
  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let idx = 0; idx < terms.length; idx += 2) {
    const x = terms[idx]!;
    const y = terms[idx + 1]!;
    let t = rol16((offsets[idx]! + x) >>> 0);
    let q = Math.imul(t, 0x76f50f34) >>> 0;
    swapAcc = (swapAcc + ((Math.imul(rol16(q), 0xc3efea97) + q) >>> 0)) >>> 0;
    t = rol16((offsets[idx + 1]! + y) >>> 0);
    q = Math.imul(t, 0x1881ce3c) >>> 0;
    swapLast = (Math.imul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (Math.imul(state, keyA) + x) >>> 0;
    state = Math.imul(rol16(state), 0xcf98b111) >>> 0;
    state = Math.imul(rol16(state), 0x87085b9f) >>> 0;
    state = Math.imul(rol16(state), 0x12ceb96d) >>> 0;
    state = Math.imul(rol16(state), 0x257e1d83) >>> 0;
    acc = (acc + state) >>> 0;
    t = (Math.imul(state, keyB) + y) >>> 0;
    t = Math.imul(rol16(t), 0xa27416f5) >>> 0;
    t = Math.imul(rol16(t), 0xd38396ff) >>> 0;
    state = Math.imul(rol16(Math.imul(rol16(t), 0x7c932b89) >>> 0), 0xbfa49f69) >>> 0;
    acc = (acc + state) >>> 0;
  }
  const out = Buffer.alloc(8);
  out.writeUInt32LE((swapLast ^ state) >>> 0, 0);
  out.writeUInt32LE((swapAcc ^ acc) >>> 0, 4);
  return out;
}

let clockSkewSeconds = 0;

function generateSecMsGecV2(): string {
  let ticks = Math.floor(Date.now() / 1000 + clockSkewSeconds) + 11644473600;
  ticks -= ticks % 300;
  const data = Buffer.from(`${ticks}0000000${TRUSTED_CLIENT_TOKEN}`, "ascii");
  const digest = sha256Digest(data);
  const cs64 = cs64Digest(data, digest);
  return `${cs64.toString("hex").toUpperCase()}-${digest.toString("hex").toUpperCase()}`;
}

async function syncClockSkew(): Promise<void> {
  try {
    const res = await fetch(
      `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`,
      { method: "HEAD", signal: AbortSignal.timeout(4000) },
    );
    const dateHdr = res.headers.get("date");
    if (dateHdr) {
      const serverSec = Math.floor(new Date(dateHdr).getTime() / 1000);
      if (Number.isFinite(serverSec)) {
        clockSkewSeconds = serverSec - Math.floor(Date.now() / 1000);
      }
    }
  } catch {}
}

function escapeSsml(text: string): string {
  return text
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatEdgeVoiceName(shortVoice: string): string {
  const m = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(shortVoice.trim());
  if (!m) return shortVoice;
  return `Microsoft Server Speech Text to Speech Voice (${m[1]}-${m[2]}, ${m[3]})`;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
    })
    .replaceAll("&nbsp;", " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&ldquo;", '"')
    .replaceAll("&rdquo;", '"')
    .replaceAll("&lsquo;", "'")
    .replaceAll("&rsquo;", "'")
    .replaceAll("&mdash;", " — ")
    .replaceAll("&ndash;", " - ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function extractSpeakableText(rawContent: string, ext: string): string {
  let text = rawContent;
  const lowerExt = ext.toLowerCase();
  if (lowerExt === "html" || lowerExt === "htm") {
    text = text
      .replace(/<head[\s\S]*?<\/head>/gi, " ")
      .replace(/<(script|style|noscript|iframe|svg|pre|code|nav|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<div[^>]*class=["'][^"']*obx-meta[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, " ")
      .replace(/<\/(h[1-6]|p|li|blockquote|div|section|article|tr)>/gi, ". \n")
      .replace(/<br\s*\/?>/gi, ". \n")
      .replace(/<[^>]+>/g, " ");
    text = decodeHtmlEntities(text);
  } else if (lowerExt === "md" || lowerExt === "markdown") {
    text = text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]+`/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^#+\s+/gm, "");
  }
  text = text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s*\.\s*\.\s*/g, ". ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return text.slice(0, 40_000);
}

export function resolveVoice(text: string, requestedVoice?: string): string {
  const req = (requestedVoice || "auto").trim();
  if (req && req !== "auto" && VALID_VOICE_IDS.has(req)) {
    return req;
  }
  const cjkMatches = text.match(/[\u4e00-\u9fff]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  if (cjkCount > 20 || (text.length > 0 && cjkCount / text.length > 0.08)) {
    return "zh-CN-XiaoxiaoNeural";
  }
  return "en-US-EmmaMultilingualNeural";
}

export function splitTextIntoChunks(text: string, maxChars = 320): string[] {
  const sentences = text
    .split(/(?<=[.!?。！？\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (s.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < s.length; i += maxChars) {
        chunks.push(s.slice(i, i + maxChars));
      }
      continue;
    }
    if (current.length + s.length + 1 > maxChars) {
      if (current) chunks.push(current);
      current = s;
    } else {
      current = current ? `${current} ${s}` : s;
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, 48);
}

function synthesizeSingleChunk(chunk: string, voice: string, timeoutMs = 45_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const connId = randomBytes(16).toString("hex");
    const secMsGec = generateSecMsGecV2();
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connId}`;

    const ws = new WebSocket(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Cookie: `muid=${randomBytes(16).toString("hex").toUpperCase()};`,
      },
    } as unknown as string[]);
    ws.binaryType = "arraybuffer";

    const audioChunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
      reject(new Error("Edge TTS timed out"));
    }, timeoutMs);

    ws.onopen = () => {
      const cfgMsg =
        `X-Timestamp:${new Date().toUTCString()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;
      ws.send(cfgMsg);

      const reqId = randomBytes(16).toString("hex");
      const fullVoice = formatEdgeVoiceName(voice);
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${fullVoice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeSsml(chunk)}</prosody></voice></speak>`;
      const ssmlMsg =
        `X-RequestId:${reqId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${new Date().toUTCString()}Z\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml;
      ws.send(ssmlMsg);
    };

    function finishOk() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      const out = Buffer.concat(audioChunks);
      if (out.length === 0) {
        reject(new Error("Edge TTS returned empty audio"));
      } else {
        resolve(out);
      }
    }

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        if (ev.data.includes("Path:turn.end")) {
          finishOk();
        }
      } else {
        const buf = Buffer.from(ev.data as ArrayBuffer);
        if (buf.length < 2) return;
        const headerLen = buf.readUInt16BE(0);
        if (buf.length <= 2 + headerLen) return;
        const header = buf.subarray(2, 2 + headerLen).toString("utf8");
        if (header.includes("Path:audio")) {
          audioChunks.push(buf.subarray(2 + headerLen));
        }
      }
    };

    ws.onclose = () => {
      finishOk();
    };

    ws.onerror = () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error("Edge TTS WebSocket connection failed"));
    };
  });
}

async function synthesizeChunkWithRetry(chunk: string, voice: string): Promise<Buffer> {
  try {
    return await synthesizeSingleChunk(chunk, voice);
  } catch {
    await syncClockSkew();
    return await synthesizeSingleChunk(chunk, voice);
  }
}

const inFlight = new Map<string, Promise<string>>();

export async function getOrSynthesizeArticleAudio(params: {
  dataDir: string;
  userId: string;
  fullPath: string;
  ext: string;
  voice?: string;
}): Promise<string> {
  const raw = await readFile(params.fullPath, "utf8");
  const text = extractSpeakableText(raw, params.ext);
  if (!text) {
    throw new Error("No readable text found in this file");
  }
  const voice = resolveVoice(text, params.voice);
  const hash = createHash("sha256")
    .update(`${voice}\n${text}`, "utf8")
    .digest("hex")
    .slice(0, 28);
  const cacheDir = path.join(params.dataDir, "users", params.userId, "tts-cache");
  mkdirSync(cacheDir, { recursive: true });
  const mp3Path = path.join(cacheDir, `${hash}.mp3`);
  if (existsSync(mp3Path)) {
    return mp3Path;
  }

  const existing = inFlight.get(mp3Path);
  if (existing) {
    return await existing;
  }

  const job = (async () => {
    try {
      const chunks = splitTextIntoChunks(text);
      const buffers: Buffer[] = new Array(chunks.length);
      const concurrency = 10;
      let nextIdx = 0;
      async function worker() {
        while (nextIdx < chunks.length) {
          const i = nextIdx++;
          buffers[i] = await synthesizeChunkWithRetry(chunks[i]!, voice);
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()),
      );
      const combined = Buffer.concat(buffers);
      await writeFile(mp3Path, combined);
      return mp3Path;
    } finally {
      inFlight.delete(mp3Path);
    }
  })();

  inFlight.set(mp3Path, job);
  return await job;
}

export function serveAudioFileWithRange(req: Request, mp3Path: string): Response {
  const fileHandle = Bun.file(mp3Path);
  const total = fileHandle.size;
  const rangeHeader = req.headers.get("range");
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(total - 1, Number(m[2])) : total - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && end < total) {
        return new Response(fileHandle.slice(start, end + 1), {
          status: 206,
          headers: {
            "Content-Type": "audio/mpeg",
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=3600",
          },
        });
      }
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
  }
  return new Response(fileHandle, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(total),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
