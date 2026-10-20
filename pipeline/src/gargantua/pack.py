"""The .gvol container: a JSON header plus 16-byte aligned binary sections.

Layout
    0   4  magic b"GVOL"
    4   4  u32 version (little endian)
    8   4  u32 header length H (bytes of UTF-8 JSON, space padded so 12 + H is a multiple of 16)
    12  H  JSON header; header["sections"][name] = {offset, bytes, dtype, shape}
    ... sections, each starting on a 16-byte boundary, little endian, C order

The viewer (viewer/src/gvol.ts) reads the same layout. "volume" is (T, H, W, 4) uint8: RGB raw video
colour, A = evidence. Row 0 is the top of the image, slice 0 is the first frame, which matches the
WebGL texImage3D order directly.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np

MAGIC = b"GVOL"
VERSION = 1
ALIGN = 16
DTYPES = {"u8": np.uint8, "u16": np.uint16, "u32": np.uint32, "i32": np.int32, "f32": np.float32}
CODES = {np.dtype(v): k for k, v in DTYPES.items()}


class GvolError(ValueError):
    pass


def _pad(n: int) -> int:
    return (-n) % ALIGN


def write_gvol(path: str | Path, header: dict, sections: dict[str, np.ndarray]) -> int:
    """Write header + sections. Returns the file size in bytes."""
    arrays = {k: np.ascontiguousarray(v) for k, v in sections.items()}
    for k, a in arrays.items():
        if a.dtype not in CODES:
            raise GvolError(f"section {k}: unsupported dtype {a.dtype}")
    # two passes: the header size depends on the offsets, which depend on the header size
    meta: dict[str, dict] = {}
    hdr_len = 0
    for _ in range(4):
        offset = 12 + hdr_len
        offset += _pad(offset)
        meta = {}
        for k, a in arrays.items():
            meta[k] = {"offset": offset, "bytes": int(a.nbytes), "dtype": CODES[a.dtype], "shape": list(a.shape)}
            offset += a.nbytes + _pad(a.nbytes)
        blob = json.dumps({**header, "format": "gvol", "version": VERSION, "sections": meta}, separators=(",", ":")).encode()
        new_len = len(blob) + _pad(12 + len(blob))
        if new_len == hdr_len:
            break
        hdr_len = new_len
    blob = blob + b" " * (hdr_len - len(blob))
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".part")
    with tmp.open("wb") as f:
        f.write(MAGIC + struct.pack("<II", VERSION, hdr_len) + blob)
        for k, a in arrays.items():
            assert f.tell() == meta[k]["offset"], (k, f.tell(), meta[k]["offset"])
            f.write(memoryview(a).cast("B"))
            f.write(b"\0" * _pad(a.nbytes))
        size = f.tell()
    tmp.replace(path)
    return size


def read_gvol(path: str | Path, mmap: bool = True) -> tuple[dict, dict[str, np.ndarray]]:
    path = Path(path)
    with path.open("rb") as f:
        head = f.read(12)
        if len(head) < 12 or head[:4] != MAGIC:
            raise GvolError(f"{path.name}: bad magic (not a .gvol file)")
        version, hdr_len = struct.unpack("<II", head[4:])
        if version != VERSION:
            raise GvolError(f"{path.name}: unsupported version {version}")
        header = json.loads(f.read(hdr_len).decode())
    sections: dict[str, np.ndarray] = {}
    for k, m in header["sections"].items():
        dt = DTYPES[m["dtype"]]
        if mmap:
            sections[k] = np.memmap(path, dtype=dt, mode="r", offset=m["offset"], shape=tuple(m["shape"]))
        else:
            with path.open("rb") as f:
                f.seek(m["offset"])
                sections[k] = np.frombuffer(f.read(m["bytes"]), dtype=dt).reshape(m["shape"])
    return header, sections
