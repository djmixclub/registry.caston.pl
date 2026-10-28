/**
 * A small QR code encoder (ISO/IEC 18004, model 2) for the one-time code enrolment link, so
 * that the panel can show a QR code without a library. It encodes bytes with error correction
 * level M in versions 1 to 10 (up to 213 bytes), which is plenty for an `otpauth://` URI, and
 * renders the symbol as an inline SVG.
 */

/** Error correction level M: data codewords and the block structure of versions 1 to 10. */
interface Layout {
  /** Error correction codewords of every block. */
  ec: number;
  /** `[number of blocks, data codewords per block]` groups, in order. */
  groups: [number, number][];
}

const LAYOUTS: Record<number, Layout> = {
  1: { ec: 10, groups: [[1, 16]] },
  2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] },
  6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] },
  8: {
    ec: 22,
    groups: [
      [2, 38],
      [2, 39],
    ],
  },
  9: {
    ec: 22,
    groups: [
      [3, 36],
      [2, 37],
    ],
  },
  10: {
    ec: 26,
    groups: [
      [4, 43],
      [1, 44],
    ],
  },
};

/** Centres of the alignment patterns, by version. */
const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const MAX_VERSION = 10;

function dataCodewords(version: number): number {
  const layout = LAYOUTS[version] as Layout;
  return layout.groups.reduce((sum, [blocks, size]) => sum + blocks * size, 0);
}

/** The most bytes a symbol of `version` holds in byte mode. */
function byteCapacity(version: number): number {
  const countBits = version < 10 ? 8 : 16;
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits) / 8);
}

// ---------------------------------------------------------------------------------------------
// Reed-Solomon over GF(256), polynomial 0x11D
// ---------------------------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] ?? 0;
}

function multiply(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : (EXP[(LOG[a] ?? 0) + (LOG[b] ?? 0)] ?? 0);
}

/** The generator polynomial of `degree` (without its leading 1), highest power first. */
function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    poly.forEach((coefficient, j) => {
      next[j] = (next[j] ?? 0) ^ coefficient;
      next[j + 1] = (next[j + 1] ?? 0) ^ multiply(coefficient, EXP[i] ?? 0);
    });
    poly = next;
  }
  return poly.slice(1);
}

/** The error correction codewords of `data`. */
function remainder(data: readonly number[], degree: number): number[] {
  const divisor = generator(degree);
  const result = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    divisor.forEach((coefficient, i) => {
      result[i] = (result[i] ?? 0) ^ multiply(coefficient, factor);
    });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// The codeword sequence
// ---------------------------------------------------------------------------------------------

function appendBits(bits: number[], value: number, count: number): void {
  for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

/** The data codewords of `bytes` in byte mode, padded to `version`'s capacity. */
function encodeData(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) appendBits(bits, byte, 8);
  const capacity = dataCodewords(version) * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  for (let pad = 0xec; codewords.length < dataCodewords(version); pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return codewords;
}

/** Splits the data into blocks, appends each block's error correction and interleaves them. */
function interleave(data: readonly number[], version: number): number[] {
  const layout = LAYOUTS[version] as Layout;
  const blocks: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (const [count, size] of layout.groups) {
    for (let i = 0; i < count; i++) {
      const part = data.slice(offset, offset + size);
      offset += size;
      blocks.push({ data: part, ec: remainder(part, layout.ec) });
    }
  }
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i] ?? 0);
  }
  for (let i = 0; i < layout.ec; i++) for (const block of blocks) out.push(block.ec[i] ?? 0);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The module matrix
// ---------------------------------------------------------------------------------------------

/** A symbol: `modules[row][column]` is dark when `true`. */
export type Matrix = boolean[][];

class Canvas {
  readonly size: number;
  readonly modules: Matrix;
  /** Modules that belong to function patterns and are never masked or filled with data. */
  readonly reserved: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.reserved = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.drawFunctionPatterns();
  }

  private set(row: number, column: number, dark: boolean): void {
    const line = this.modules[row];
    const flags = this.reserved[row];
    if (line === undefined || flags === undefined) return;
    line[column] = dark;
    flags[column] = true;
  }

  private drawFinder(centerRow: number, centerColumn: number): void {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const row = centerRow + dr;
        const column = centerColumn + dc;
        if (row < 0 || row >= this.size || column < 0 || column >= this.size) continue;
        const distance = Math.max(Math.abs(dr), Math.abs(dc));
        this.set(row, column, distance !== 2 && distance !== 4);
      }
    }
  }

  private drawAlignment(centerRow: number, centerColumn: number): void {
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        this.set(centerRow + dr, centerColumn + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }
    }
  }

  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(3, this.size - 4);
    this.drawFinder(this.size - 4, 3);
    const centres = ALIGNMENT[this.version] ?? [];
    const last = centres.length - 1;
    centres.forEach((row, i) => {
      centres.forEach((column, j) => {
        const corner = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
        if (!corner) this.drawAlignment(row, column);
      });
    });
    // Reserve the format areas (written by drawFormat) and the version areas.
    this.drawFormat(0);
    this.drawVersion();
  }

  /** Writes the 15 format bits (error correction level M and `mask`). */
  drawFormat(mask: number): void {
    const data = (0b00 << 3) | mask;
    let remainderBits = data;
    for (let i = 0; i < 10; i++)
      remainderBits = (remainderBits << 1) ^ ((remainderBits >>> 9) * 0x537);
    const bits = ((data << 10) | remainderBits) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.set(i, 8, bit(i));
    this.set(7, 8, bit(6));
    this.set(8, 8, bit(7));
    this.set(8, 7, bit(8));
    for (let i = 9; i < 15; i++) this.set(8, 14 - i, bit(i));
    for (let i = 0; i < 8; i++) this.set(8, this.size - 1 - i, bit(i));
    for (let i = 8; i < 15; i++) this.set(this.size - 15 + i, 8, bit(i));
    this.set(this.size - 8, 8, true);
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    let remainderBits = this.version;
    for (let i = 0; i < 12; i++)
      remainderBits = (remainderBits << 1) ^ ((remainderBits >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainderBits;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(b, a, dark);
      this.set(a, b, dark);
    }
  }

  /** Places the codewords in the zigzag order of the standard. */
  drawCodewords(codewords: readonly number[]): void {
    let index = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < this.size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const column = right - j;
          const upward = ((right + 1) & 2) === 0;
          const row = upward ? this.size - 1 - vertical : vertical;
          if (this.reserved[row]?.[column] === true) continue;
          const byte = codewords[index >>> 3] ?? 0;
          const dark = index < codewords.length * 8 && ((byte >>> (7 - (index & 7))) & 1) !== 0;
          (this.modules[row] as boolean[])[column] = dark;
          index++;
        }
      }
    }
  }

  /** Flips the modules that `mask` selects (data modules only). */
  applyMask(mask: number): void {
    for (let row = 0; row < this.size; row++) {
      for (let column = 0; column < this.size; column++) {
        if (this.reserved[row]?.[column] === true) continue;
        if (maskBit(mask, row, column)) {
          (this.modules[row] as boolean[])[column] = !this.modules[row]?.[column];
        }
      }
    }
  }
}

function maskBit(mask: number, row: number, column: number): boolean {
  switch (mask) {
    case 0:
      return (row + column) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return column % 3 === 0;
    case 3:
      return (row + column) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5:
      return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6:
      return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    default:
      return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Choosing the mask
// ---------------------------------------------------------------------------------------------

/** The penalty of a symbol by the four rules of the standard; lower is better. */
function penalty(modules: Matrix): number {
  const size = modules.length;
  const at = (row: number, column: number) => modules[row]?.[column] === true;
  let result = 0;

  // Runs of five or more modules of one colour, in rows and columns.
  for (const horizontal of [true, false]) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        const same = horizontal ? at(a, b) === at(a, b - 1) : at(b, a) === at(b - 1, a);
        if (same) {
          run++;
          if (run === 5) result += 3;
          else if (run > 5) result += 1;
        } else {
          run = 1;
        }
      }
    }
  }

  // 2x2 blocks of one colour.
  for (let row = 0; row < size - 1; row++) {
    for (let column = 0; column < size - 1; column++) {
      const colour = at(row, column);
      if (
        colour === at(row, column + 1) &&
        colour === at(row + 1, column) &&
        colour === at(row + 1, column + 1)
      ) {
        result += 3;
      }
    }
  }

  // Finder-like patterns 1:1:3:1:1 with four light modules on one side.
  const finder = [true, false, true, true, true, false, true];
  for (const horizontal of [true, false]) {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b + 7 <= size; b++) {
        const match = finder.every((dark, k) =>
          horizontal ? at(a, b + k) === dark : at(b + k, a) === dark,
        );
        if (!match) continue;
        const light = (from: number, to: number) => {
          for (let k = from; k < to; k++) {
            const inside = k >= 0 && k < size;
            if (inside && (horizontal ? at(a, k) : at(k, a))) return false;
          }
          return true;
        };
        if (light(b - 4, b)) result += 40;
        if (light(b + 7, b + 11)) result += 40;
      }
    }
  }

  // The balance of dark and light modules.
  let dark = 0;
  for (const line of modules) for (const module of line) if (module) dark++;
  const total = size * size;
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return result;
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/** Options of {@link encodeQr}. */
export interface QrOptions {
  /** Force a mask (0 to 7) instead of choosing the one with the lowest penalty (tests). */
  mask?: number;
}

/**
 * The module matrix of `text` (UTF-8, byte mode, error correction M) in the smallest version
 * that holds it, or `null` when it does not fit in version 10 (213 bytes).
 */
export function encodeQr(text: string, options: QrOptions = {}): Matrix | null {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= MAX_VERSION && bytes.length > byteCapacity(version)) version++;
  if (version > MAX_VERSION) return null;

  const codewords = interleave(encodeData(bytes, version), version);
  const candidates = options.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.mask];
  let best: Matrix | null = null;
  let bestPenalty = Infinity;
  for (const mask of candidates) {
    const canvas = new Canvas(version);
    canvas.drawCodewords(codewords);
    canvas.applyMask(mask);
    canvas.drawFormat(mask);
    const score = penalty(canvas.modules);
    if (score < bestPenalty) {
      best = canvas.modules;
      bestPenalty = score;
    }
  }
  return best;
}

/** The modules of a symbol as an SVG path: one `M x y h1 v1 h-1 z` square per dark module. */
function modulesPath(matrix: Matrix, quiet: number): string {
  const parts: string[] = [];
  matrix.forEach((line, row) => {
    let column = 0;
    while (column < line.length) {
      if (line[column] !== true) {
        column++;
        continue;
      }
      let end = column;
      while (line[end] === true) end++;
      parts.push(`M${column + quiet} ${row + quiet}h${end - column}v1h-${end - column}z`);
      column = end;
    }
  });
  return parts.join("");
}

/**
 * `text` as a QR code in an SVG with a white background and a four-module quiet zone, or `null`
 * when it is too long. The SVG has no script, style or external reference.
 */
export function qrSvg(text: string, label: string): string | null {
  const matrix = encodeQr(text);
  if (matrix === null) return null;
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  const title = label.replace(/[&<>"]/g, "");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" ` +
    `aria-label="${title}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${modulesPath(matrix, quiet)}" fill="#000"/></svg>`
  );
}
