// png-squeeze: a lossless PNG recompressor for 1280x720 RGBA screenshots.
//
// For every instance it decodes the stored input PNG to raw RGBA, picks the
// smallest faithful representation it can find, and writes that:
//
//   1. Colour reduction. An image with at most 256 colours is written as a
//      palette PNG (by count and by luminance); a grey image as grey (or grey
//      + alpha); an opaque one as RGB; an image whose only transparency is a
//      single fully transparent colour is keyed with tRNS; anything else
//      stays RGBA. Fully transparent pixels keep their exact RGB everywhere:
//      the checker compares all four channels, so no colour is ever invented.
//   2. Filtering. Each form's rows are filtered several ways — unfiltered,
//      per-row "fewest distinct byte pairs", and a brute-force per-row choice
//      that deflates every trial row against the previous 32 KiB — and every
//      candidate stream is weighed by zlib at level 9 (the filtered streams
//      also with the filtered strategy). The smallest stream wins. Flat
//      screenshots favour no filtering at all (long exact repeats for the
//      matcher); photo-like ones favour the per-row choices.
//   3. Deflate. The winning stream is compressed by zlib, and — for the
//      largest filtered winners, inside a fixed total work budget — also by
//      an optimal-parse deflater written for this entry (hash-chain match
//      finding with inheritance, shortest-path parsing under a symbol-cost
//      model refined from the previous parse, package-merge length-limited
//      Huffman codes). Whichever output is smaller is shipped.
//
// Deterministic: every budget is a count of bytes or candidates, never a
// clock, so two runs write byte-identical files.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PNG bits
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
function pngOf(chunks) {
  let size = 8;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}
function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Decode a contest-format PNG (8-bit, non-interlaced, colour types 0/2/3/4/6)
// to RGBA. The inputs are stored type-6 files, but the decoder is general.
function decodeToRgba(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0, height = 0, colourType = 6;
  let palette = null, trns = null;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      colourType = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  const stride = width * channels;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: height * (stride + 1) + 1 });
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= channels ? samples[o + i - channels] : 0);
    else if (ft === 2) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    else if (ft === 3) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= channels ? samples[o + i - channels] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    else for (let i = 0; i < stride; i++) {
      const a = i >= channels ? samples[o + i - channels] : 0;
      const b = y > 0 ? samples[p + i] : 0;
      const c = y > 0 && i >= channels ? samples[p + i - channels] : 0;
      samples[o + i] = raw[src + i] + paeth(a, b, c);
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- filters
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  if (type === 1) { for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0); return; }
  if (type === 2) { for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]); return; }
  if (type === 3) { for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1); return; }
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    out[i] = cur[i] - paeth(a, b, c);
  }
}
const pairSeen = new Uint32Array(65536);
let pairStamp = 0;
function pairsCost(row) {
  pairStamp++;
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const p = (row[i - 1] << 8) | row[i];
    if (pairSeen[p] !== pairStamp) { pairSeen[p] = pairStamp; n++; }
  }
  return n;
}
// strategy: 0..4 fixed, 'pairs' per-row fewest-distinct-pairs,
// 'brute' per-row smallest deflate (level 4) against the previous 32 KiB.
function filteredData(samples, width, height, bpp, strategy) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  if (typeof strategy === 'number') {
    for (let y = 0; y < height; y++) {
      const at = y * (stride + 1);
      raw[at] = strategy;
      filterRow(strategy, samples.subarray(y * stride, (y + 1) * stride), y === 0 ? null : samples.subarray((y - 1) * stride, y * stride), bpp, raw.subarray(at + 1, at + 1 + stride));
    }
    return raw;
  }
  const trials = [];
  for (let t = 0; t < 5; t++) { const r = new Uint8Array(stride + 1); r[0] = t; trials.push(r); }
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trials[t].subarray(1));
      let cost;
      if (strategy === 'pairs') cost = pairsCost(trials[t].subarray(1));
      else {
        const before = raw.subarray(Math.max(0, at - 32768), at);
        cost = deflateSync(trials[t], before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) { best = cost; type = t; }
    }
    raw.set(trials[type], at);
  }
  return raw;
}

// ---------------------------------------------------------------- forms
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true, grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3];
      const k = counts.get(c);
      if (k === undefined) { if (counts.size === 256) many = true; else counts.set(c, 1); }
      else counts.set(c, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.entries()].map(([word, count]) => ({
      rgba: [(word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255], word, count,
    }));
  }
  return { opaque, grey, colours };
}
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v; else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    indices[i] = index.get((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]);
  }
  return { plte, trns, indices };
}
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null && !grey) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ name: 'palette-' + order, colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns });
    }
    return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct, trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, (key >>> 16) & 255, 0, (key >>> 8) & 255, 0, key & 255);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ name: 'ct' + ct, colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns });
  return forms;
}
function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}
const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length) + 57;

// ---------------------------------------------------------------- deflater
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const LEN_CODE = new Int32Array(259);
for (let c = 0; c < 29; c++) {
  const hi = c === 28 ? 258 : LEN_BASE[c] + (1 << LEN_EXTRA[c]) - 1;
  for (let l = LEN_BASE[c]; l <= hi; l++) LEN_CODE[l] = c;
}
const DIST_CODE = new Int32Array(32769);
for (let d = 1; d <= 32768; d++) {
  let lo = 0, hi = 29;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (DIST_BASE[mid] <= d) lo = mid; else hi = mid - 1; }
  DIST_CODE[d] = lo;
}
const EVAL_LENS = [];
for (let len = 0; len <= 258; len++) {
  const arr = [];
  if (len >= 3) {
    for (let c = 0; c < 29; c++) {
      const base = LEN_BASE[c];
      if (base > len) break;
      arr.push(Math.min(len, base + (1 << LEN_EXTRA[c]) - 1));
    }
    if (arr[arr.length - 1] !== len) arr.push(len);
  }
  EVAL_LENS.push(Int32Array.from(arr));
}
// Length-limited Huffman code lengths by package-merge (Moffat–Turpin):
// exact optimum for the given frequencies under the length limit.
function limitedLengths(freq, maxBits) {
  const n = freq.length;
  const lengths = new Int32Array(n);
  const syms = [];
  for (let s = 0; s < n; s++) if (freq[s] > 0) syms.push(s);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
  syms.sort((a, b) => freq[a] - freq[b] || a - b);
  const m = syms.length;
  const leaf = (i) => { const c = new Float64Array(m); c[i] = 1; return { w: freq[syms[i]], c }; };
  let cur = syms.map((_, i) => leaf(i));
  for (let level = 1; level < maxBits; level++) {
    const pkgs = [];
    for (let i = 0; i + 1 < cur.length; i += 2) {
      const a = cur[i], b = cur[i + 1];
      const c = new Float64Array(m);
      for (let j = 0; j < m; j++) c[j] = a.c[j] + b.c[j];
      pkgs.push({ w: a.w + b.w, c });
    }
    const merged = [];
    let li = 0, pi = 0;
    const leaves = syms.map((_, i) => leaf(i));
    while (li < leaves.length || pi < pkgs.length) {
      if (pi >= pkgs.length || (li < leaves.length && leaves[li].w <= pkgs[pi].w)) merged.push(leaves[li++]);
      else merged.push(pkgs[pi++]);
    }
    cur = merged;
  }
  const take = 2 * m - 2;
  const total = new Float64Array(m);
  for (let i = 0; i < Math.min(take, cur.length); i++) {
    const c = cur[i].c;
    for (let j = 0; j < m; j++) total[j] += c[j];
  }
  for (let i = 0; i < m; i++) lengths[syms[i]] = Math.round(total[i]);
  return lengths;
}
function canonicalCodes(lengths) {
  const maxBits = Math.max(...lengths, 0);
  const blCount = new Int32Array(maxBits + 1);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Int32Array(maxBits + 1);
  let code = 0;
  for (let b = 1; b <= maxBits; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
  const codes = new Int32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) if (lengths[s] > 0) codes[s] = nextCode[lengths[s]]++;
  return codes;
}
function reverseBits(v, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | (v & 1); v >>= 1; }
  return r;
}
class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.accBits = 0; }
  bits(value, len) {
    this.acc |= value << this.accBits;
    this.accBits += len;
    while (this.accBits >= 8) { this.bytes.push(this.acc & 255); this.acc >>>= 8; this.accBits -= 8; }
  }
  finish() {
    if (this.accBits > 0) { this.bytes.push(this.acc & 255); this.acc = 0; this.accBits = 0; }
    return Uint8Array.from(this.bytes);
  }
}
function tokenStats(toks) {
  const litFreq = new Float64Array(288);
  const distFreq = new Float64Array(30);
  for (const t of toks) {
    if (t.len === 1) litFreq[t.b]++;
    else { litFreq[257 + LEN_CODE[t.len]]++; distFreq[DIST_CODE[t.dist]]++; }
  }
  litFreq[256]++;
  return { litFreq, distFreq };
}
function costsFromStats(litFreq, distFreq) {
  const litCost = new Float64Array(288);
  const distCost = new Float64Array(30);
  let lt = 0, dt = 0;
  for (const f of litFreq) lt += f;
  for (const f of distFreq) dt += f;
  for (let s = 0; s < 288; s++) litCost[s] = -Math.log2((litFreq[s] + 1) / (lt + 288));
  for (let s = 0; s < 30; s++) distCost[s] = -Math.log2((distFreq[s] + 1) / (dt + 30));
  return { litCost, distCost };
}
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
function hash3(data, i) {
  return (((data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2]) * 0x1e35a7bd) >>> (32 - HASH_BITS);
}
// One shortest-path parse under the given symbol costs. Match candidates come
// from hash chains (at most maxChain per position, cut short once a match of
// goodLen is in hand); the best match at i-1 also seeds position i with the
// match one byte shorter at the same distance, which always exists.
function dpPass(data, litCost, distCost, maxChain, goodLen) {
  const n = data.length;
  const costs = new Float64Array(n + 1).fill(Infinity);
  const fromLen = new Int32Array(n + 1);
  const fromDist = new Int32Array(n + 1);
  costs[0] = 0;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const tierLen = new Int32Array(30);
  const tierDist = new Int32Array(30);
  const touched = new Int32Array(30);
  let inhLen = 0, inhDist = 0;
  for (let i = 0; i < n; i++) {
    const ci = costs[i];
    const lc = ci + litCost[data[i]];
    if (lc < costs[i + 1]) { costs[i + 1] = lc; fromLen[i + 1] = 1; fromDist[i + 1] = 0; }
    if (i + 2 < n) {
      let nt = 0;
      let myBestLen = 0, myBestDist = 0;
      if (inhLen >= 3) {
        const s = DIST_CODE[inhDist];
        tierLen[s] = inhLen; tierDist[s] = inhDist; touched[nt++] = s;
        myBestLen = inhLen; myBestDist = inhDist;
      }
      const maxLen = Math.min(258, n - i);
      let bestLen = myBestLen;
      let chain = maxChain;
      let p = head[hash3(data, i)];
      while (p >= 0 && chain > 0) {
        const d = i - p;
        if (d > 32768) break;
        chain--;
        let len;
        if (bestLen >= 3) {
          if (data[p + bestLen] === data[i + bestLen] && data[p + bestLen - 1] === data[i + bestLen - 1]) {
            len = 0;
            while (len < maxLen && data[p + len] === data[i + len]) len++;
          } else {
            len = 0;
            const cap = bestLen;
            while (len < cap && data[p + len] === data[i + len]) len++;
            if (len >= 3) {
              const s = DIST_CODE[d];
              if (len > tierLen[s]) { if (tierLen[s] === 0) touched[nt++] = s; tierLen[s] = len; tierDist[s] = d; }
            }
            p = prev[p];
            continue;
          }
        } else {
          len = 0;
          while (len < maxLen && data[p + len] === data[i + len]) len++;
        }
        if (len >= 3) {
          const s = DIST_CODE[d];
          if (len > tierLen[s]) { if (tierLen[s] === 0) touched[nt++] = s; tierLen[s] = len; tierDist[s] = d; }
          if (len > bestLen) {
            bestLen = len; myBestLen = len; myBestDist = d;
            if (len >= maxLen) break;
            if (len >= goodLen) chain = Math.min(chain, 3);
          }
        }
        p = prev[p];
      }
      for (let k = 0; k < nt; k++) {
        const s = touched[k];
        const len = tierLen[s];
        const d = tierDist[s];
        tierLen[s] = 0;
        const dcost = distCost[s] + DIST_EXTRA[s];
        const evals = EVAL_LENS[len];
        for (let e = 0; e < evals.length; e++) {
          const L = evals[e];
          const c = LEN_CODE[L];
          const total = ci + litCost[257 + c] + LEN_EXTRA[c] + dcost;
          if (total < costs[i + L]) { costs[i + L] = total; fromLen[i + L] = L; fromDist[i + L] = d; }
        }
      }
      inhLen = myBestLen > 0 ? myBestLen - 1 : 0;
      inhDist = myBestDist;
    } else {
      inhLen = 0; inhDist = 0;
    }
    if (i + 2 < n) {
      const h = hash3(data, i);
      prev[i] = head[h];
      head[h] = i;
    }
  }
  const toks = [];
  let j = n;
  while (j > 0) {
    const L = fromLen[j];
    if (L === 1) { toks.push({ b: data[j - 1], len: 1, dist: 0 }); j -= 1; }
    else { toks.push({ b: -1, len: L, dist: fromDist[j] }); j -= L; }
  }
  toks.reverse();
  return toks;
}
function emitTokens(toks) {
  const { litFreq, distFreq } = tokenStats(toks);
  const dynLitLen = limitedLengths(litFreq, 15);
  const dynDistLen = limitedLengths(distFreq, 15);
  if (Math.max(...dynDistLen) === 0) dynDistLen[0] = 1;
  const fixLitLen = new Int32Array(288);
  for (let s = 0; s < 144; s++) fixLitLen[s] = 8;
  for (let s = 144; s < 256; s++) fixLitLen[s] = 9;
  for (let s = 256; s < 280; s++) fixLitLen[s] = 7;
  for (let s = 280; s < 288; s++) fixLitLen[s] = 8;
  const fixDistLen = new Int32Array(30).fill(5);
  const costOf = (litLen, distLen) => {
    let bits = 0;
    for (const t of toks) {
      if (t.len === 1) bits += litLen[t.b];
      else { const c = LEN_CODE[t.len]; bits += litLen[257 + c] + LEN_EXTRA[c] + distLen[DIST_CODE[t.dist]] + DIST_EXTRA[DIST_CODE[t.dist]]; }
    }
    return bits + litLen[256];
  };
  let hlit = 287;
  while (hlit > 257 && dynLitLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && dynDistLen[hdist - 1] === 0) hdist--;
  const seq = [];
  for (let s = 0; s < hlit; s++) seq.push(dynLitLen[s]);
  for (let s = 0; s < hdist; s++) seq.push(dynDistLen[s]);
  const rle = [];
  let i = 0;
  while (i < seq.length) {
    const v = seq[i];
    let run = 1;
    while (i + run < seq.length && seq[i + run] === v) run++;
    if (v === 0) {
      let z = run; i += run;
      while (z >= 11) { const take = Math.min(z, 138); rle.push({ sym: 18, extra: take - 11, extraBits: 7 }); z -= take; }
      if (z >= 3) { rle.push({ sym: 17, extra: z - 3, extraBits: 3 }); z = 0; }
      while (z > 0) { rle.push({ sym: 0, extra: 0, extraBits: 0 }); z--; }
    } else {
      rle.push({ sym: v, extra: 0, extraBits: 0 });
      let rep = run - 1; i += run;
      while (rep >= 3) { const take = Math.min(rep, 6); rle.push({ sym: 16, extra: take - 3, extraBits: 2 }); rep -= take; }
      while (rep > 0) { rle.push({ sym: v, extra: 0, extraBits: 0 }); rep--; }
    }
  }
  const clFreq = new Float64Array(19);
  for (const r of rle) clFreq[r.sym]++;
  const clLen = limitedLengths(clFreq, 7);
  const usedCl = [];
  for (let s = 0; s < 19; s++) if (clLen[s] > 0) usedCl.push(s);
  if (usedCl.length === 1) clLen[usedCl[0] === 18 ? 17 : 18] = 1;
  const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  let hclen = 19;
  while (hclen > 4 && clLen[ORDER[hclen - 1]] === 0) hclen--;
  let dynHeaderBits = 3 + 5 + 5 + 4 + hclen * 3;
  for (const r of rle) dynHeaderBits += clLen[r.sym] + r.extraBits;
  const dynBits = dynHeaderBits + costOf(dynLitLen, dynDistLen);
  const fixBits = 3 + costOf(fixLitLen, fixDistLen);
  const useDyn = dynBits <= fixBits;
  const litLen = useDyn ? dynLitLen : fixLitLen;
  const distLen = useDyn ? dynDistLen : fixDistLen;
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  const litRev = new Int32Array(288), distRev = new Int32Array(30);
  for (let s = 0; s < 288; s++) if (litLen[s]) litRev[s] = reverseBits(litCode[s], litLen[s]);
  for (let s = 0; s < 30; s++) if (distLen[s]) distRev[s] = reverseBits(distCode[s], distLen[s]);
  const w = new BitWriter();
  if (useDyn) {
    w.bits(1, 1); w.bits(2, 2);
    w.bits(hlit - 257, 5); w.bits(hdist - 1, 5); w.bits(hclen - 4, 4);
    for (let k = 0; k < hclen; k++) w.bits(clLen[ORDER[k]], 3);
    const clCode = canonicalCodes(clLen);
    const clRev = new Int32Array(19);
    for (let s = 0; s < 19; s++) if (clLen[s]) clRev[s] = reverseBits(clCode[s], clLen[s]);
    for (const r of rle) { w.bits(clRev[r.sym], clLen[r.sym]); if (r.extraBits) w.bits(r.extra, r.extraBits); }
  } else {
    w.bits(1, 1); w.bits(1, 2);
  }
  for (const t of toks) {
    if (t.len === 1) w.bits(litRev[t.b], litLen[t.b]);
    else {
      const c = LEN_CODE[t.len];
      w.bits(litRev[257 + c], litLen[257 + c]);
      if (LEN_EXTRA[c]) w.bits(t.len - LEN_BASE[c], LEN_EXTRA[c]);
      const ds = DIST_CODE[t.dist];
      w.bits(distRev[ds], distLen[ds]);
      if (DIST_EXTRA[ds]) w.bits(t.dist - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  w.bits(litRev[256], litLen[256]);
  return w.finish();
}
function zlibWrap(deflateBytes, raw) {
  const out = new Uint8Array(deflateBytes.length + 6);
  out[0] = 0x78; out[1] = 0xda;
  out.set(deflateBytes, 2);
  new DataView(out.buffer).setUint32(out.length - 4, adler32(raw));
  return out;
}
// The optimal-parse deflater: two shortest-path passes (the first priced from
// the byte histogram, the second from the first parse's own symbol counts),
// shipped only when it beats the stored-block bound.
function deflateOptimal(data) {
  const n = data.length;
  if (n === 0) return zlibWrap(Uint8Array.of(1, 0, 0, 255, 255), data);
  const hist = new Float64Array(256);
  for (let i = 0; i < n; i++) hist[data[i]]++;
  const litFreq0 = new Float64Array(288);
  for (let s = 0; s < 256; s++) litFreq0[s] = hist[s] * 0.9 + 1;
  for (let s = 257; s < 288; s++) litFreq0[s] = n / 512 + 1;
  litFreq0[256] = 1;
  const distFreq0 = new Float64Array(30).fill(n / 1024 + 1);
  let { litCost, distCost } = costsFromStats(litFreq0, distFreq0);
  let toks = null;
  for (let p = 0; p < 2; p++) {
    toks = dpPass(data, litCost, distCost, 24, 32);
    const st = tokenStats(toks);
    ({ litCost, distCost } = costsFromStats(st.litFreq, st.distFreq));
  }
  let payload = emitTokens(toks);
  const storedBytes = n + 5 * Math.ceil(n / 65535);
  if (storedBytes < payload.length) {
    const parts = [];
    for (let off = 0; off < n;) {
      const len = Math.min(65535, n - off);
      const last = off + len >= n ? 1 : 0;
      parts.push(Uint8Array.of(last, len & 255, len >> 8, ~len & 255, (~len >> 8) & 255), data.subarray(off, off + len));
      off += len;
    }
    let total = 0;
    for (const p of parts) total += p.length;
    const buf = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { buf.set(p, at); at += p.length; }
    payload = buf;
  }
  return zlibWrap(payload, data);
}

// ---------------------------------------------------------------- driver
// Screen one image: returns {form, strategy, stream, idat, total} — the best
// zlib-compressed candidate — keeping the stream when it is a DP candidate.
function squeeze(rgba, width, height) {
  let best = null;
  for (const form of formsOf(rgba)) {
    const strategies = form.colourType === 3 ? [0] : [0, 'pairs', 'brute'];
    for (const strategy of strategies) {
      const data = filteredData(form.samples, width, height, form.bpp, strategy);
      let z = deflateSync(data, { level: 9, memLevel: 8 });
      if (strategy !== 0) {
        const zf = deflateSync(data, { level: 9, memLevel: 8, strategy: constants.Z_FILTERED });
        if (zf.length < z.length) z = zf;
      }
      const total = z.length + chunkBytes(form);
      if (best === null || total < best.total) {
        best = { form, strategy, stream: strategy === 0 ? null : data, idat: new Uint8Array(z.buffer, z.byteOffset, z.length), total };
      }
    }
  }
  return best;
}

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// The optimal-parse stage is spent where it pays: on filtered winners (the
// photo-like instances), largest first, inside a fixed budget of input bytes.
const DP_BYTE_BUDGET = 4500000;
const entries = [];
for (const id of readdirSync(INPUT_DIR).sort()) {
  const img = decodeToRgba(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  const best = squeeze(img.rgba, img.width, img.height);
  entries.push({ id, width: img.width, height: img.height, ...best });
}
const candidates = entries
  .filter((e) => e.stream !== null)
  .sort((a, b) => b.idat.length - a.idat.length);
let spent = 0;
for (const e of candidates) {
  if (spent + e.stream.length > DP_BYTE_BUDGET) continue;
  spent += e.stream.length;
  const custom = deflateOptimal(e.stream);
  if (custom.length < e.idat.length) {
    e.idat = custom;
    e.total = custom.length + chunkBytes(e.form);
  }
}
for (const e of entries) {
  mkdirSync(join(OUTPUT_DIR, e.id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, e.id, 'image.png'), pngOfForm(e.width, e.height, e.form, e.idat));
}
