// .gvol reader. Mirrors pipeline/src/gargantua/pack.py:
//   "GVOL" | u32 version | u32 header length | JSON header (space padded) | 16-byte aligned sections.

export type Dtype = "u8" | "u16" | "u32" | "i32" | "f32";
export type Typed = Uint8Array | Uint16Array | Uint32Array | Int32Array | Float32Array;

export interface GvolSection {
  offset: number;
  bytes: number;
  dtype: Dtype;
  shape: number[];
}

export interface GvolPlan {
  start: number;
  duration: number;
  fps: number;
  frames: number;
  width: number;
  height: number;
  tier: string;
  tonemap: boolean;
  notes: string[];
}

export interface GvolHeader {
  format: "gvol";
  version: number;
  sections: Record<string, GvolSection>;
  plan: GvolPlan;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

export interface Gvol {
  header: GvolHeader;
  buffer: ArrayBuffer;
  section(name: string): Typed | undefined;
}

export class GvolError extends Error {}

const CTOR: Record<Dtype, { new (b: ArrayBuffer, o: number, n: number): Typed; BYTES_PER_ELEMENT: number }> = {
  u8: Uint8Array,
  u16: Uint16Array,
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
};

/** Parse only the header from the first bytes of a file (for listings and streaming loads). */
export function parseGvolHeader(buf: ArrayBuffer): { header: GvolHeader; dataStart: number } {
  if (buf.byteLength < 12) throw new GvolError("file too small to be a .gvol");
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "GVOL") throw new GvolError("bad magic: not a .gvol file");
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new GvolError(`unsupported .gvol version ${version}`);
  const len = dv.getUint32(8, true);
  if (12 + len > buf.byteLength) throw new GvolError("header truncated");
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, len))) as GvolHeader;
  return { header, dataStart: 12 + len };
}

export function parseGvol(buf: ArrayBuffer): Gvol {
  const { header } = parseGvolHeader(buf);
  for (const [name, s] of Object.entries(header.sections)) {
    if (s.offset + s.bytes > buf.byteLength) throw new GvolError(`section ${name} truncated (file is incomplete)`);
    if (s.offset % CTOR[s.dtype].BYTES_PER_ELEMENT !== 0) throw new GvolError(`section ${name} misaligned`);
  }
  const cache = new Map<string, Typed>();
  return {
    header,
    buffer: buf,
    section(name: string) {
      const s = header.sections[name];
      if (!s) return undefined;
      let v = cache.get(name);
      if (!v) {
        const C = CTOR[s.dtype];
        v = new C(buf, s.offset, s.bytes / C.BYTES_PER_ELEMENT);
        cache.set(name, v);
      }
      return v;
    },
  };
}
