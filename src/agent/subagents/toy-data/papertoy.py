"""papersplainer toy-data helpers, importable by generator scripts.

    from papertoy import sam_to_bam, read_bam

Pure standard library. Writes real BAM files (BGZF-compressed, per the
SAM/BAM specification) from SAM text, so a toy dataset can include the
binary format a study actually used without needing samtools or pysam.
"""
import gzip
import re
import struct
import zlib

_CIGAR_OPS = "MIDNSHP=X"
_SEQ_CODES = "=ACMGRSVTWYHKDBN"
_CIGAR_RE = re.compile(r"(\d+)([MIDNSHP=X])")
_BGZF_EOF = bytes.fromhex("1f8b08040000000000ff0600424302001b0003000000000000000000")
_BLOCK = 0xFF00


def _reg2bin(beg, end):
    end -= 1
    if beg >> 14 == end >> 14:
        return ((1 << 15) - 1) // 7 + (beg >> 14)
    if beg >> 17 == end >> 17:
        return ((1 << 12) - 1) // 7 + (beg >> 17)
    if beg >> 20 == end >> 20:
        return ((1 << 9) - 1) // 7 + (beg >> 20)
    if beg >> 23 == end >> 23:
        return ((1 << 6) - 1) // 7 + (beg >> 23)
    if beg >> 26 == end >> 26:
        return ((1 << 3) - 1) // 7 + (beg >> 26)
    return 0


def _int_tag(value):
    for code, fmt, lo, hi in (("c", "<b", -128, 127), ("C", "<B", 0, 255), ("s", "<h", -32768, 32767),
                              ("S", "<H", 0, 65535), ("i", "<i", -2147483648, 2147483647), ("I", "<I", 0, 4294967295)):
        if lo <= value <= hi:
            return code.encode() + struct.pack(fmt, value)
    raise ValueError("integer tag out of range: %d" % value)


def _encode_tag(field):
    parts = field.split(":", 2)
    if len(parts) != 3 or len(parts[0]) != 2:
        raise ValueError("bad optional field: %r" % field)
    tag, kind, value = parts
    out = tag.encode()
    if kind == "A":
        return out + b"A" + value.encode()[:1]
    if kind == "i":
        return out + _int_tag(int(value))
    if kind == "f":
        return out + b"f" + struct.pack("<f", float(value))
    if kind == "Z":
        return out + b"Z" + value.encode() + b"\0"
    if kind == "H":
        return out + b"H" + value.encode() + b"\0"
    if kind == "B":
        items = value.split(",")
        sub = items[0]
        fmt = {"c": "b", "C": "B", "s": "h", "S": "H", "i": "i", "I": "I", "f": "f"}[sub]
        numbers = [float(x) if sub == "f" else int(x) for x in items[1:]]
        return out + b"B" + sub.encode() + struct.pack("<i", len(numbers)) + struct.pack("<%d%s" % (len(numbers), fmt), *numbers)
    raise ValueError("unsupported optional field type %r in %r" % (kind, field))


def _encode_record(fields, ref_ids):
    if len(fields) < 11:
        raise ValueError("a SAM record needs 11 mandatory fields, got %d" % len(fields))
    qname, flag, rname, pos, mapq, cigar, rnext, pnext, tlen, seq, qual = fields[:11]
    ref_id = -1 if rname == "*" else ref_ids[rname]
    next_id = -1 if rnext == "*" else (ref_id if rnext == "=" else ref_ids[rnext])
    pos0, pnext0 = int(pos) - 1, int(pnext) - 1
    ops = [] if cigar == "*" else [(int(n), _CIGAR_OPS.index(op)) for n, op in _CIGAR_RE.findall(cigar)]
    if cigar != "*" and "".join("%d%s" % (n, _CIGAR_OPS[op]) for n, op in ops) != cigar:
        raise ValueError("bad CIGAR: %r" % cigar)
    ref_len = sum(n for n, op in ops if _CIGAR_OPS[op] in "MDN=X")
    end = pos0 + ref_len if ref_len else pos0 + 1
    seq = "" if seq == "*" else seq.upper()
    packed = bytearray()
    for i in range(0, len(seq), 2):
        hi = _SEQ_CODES.index(seq[i]) if seq[i] in _SEQ_CODES else 15
        lo = (_SEQ_CODES.index(seq[i + 1]) if seq[i + 1] in _SEQ_CODES else 15) if i + 1 < len(seq) else 0
        packed.append(hi << 4 | lo)
    if qual == "*":
        quals = b"\xff" * len(seq)
    else:
        if len(qual) != len(seq):
            raise ValueError("%s: SEQ and QUAL lengths differ" % qname)
        quals = bytes(ord(c) - 33 for c in qual)
    name = qname.encode() + b"\0"
    body = struct.pack("<iiBBHHHiiii", ref_id, pos0, len(name), int(mapq), _reg2bin(pos0, end), len(ops), int(flag),
                       len(seq), next_id, pnext0, int(tlen))
    body += name + b"".join(struct.pack("<I", n << 4 | op) for n, op in ops) + bytes(packed) + quals
    body += b"".join(_encode_tag(f) for f in fields[11:])
    return struct.pack("<i", len(body)) + body


def _bgzf_block(data):
    comp = zlib.compressobj(6, zlib.DEFLATED, -15)
    deflated = comp.compress(data) + comp.flush()
    size = len(deflated) + 25
    return (b"\x1f\x8b\x08\x04\x00\x00\x00\x00\x00\xff\x06\x00BC\x02\x00" + struct.pack("<H", size) + deflated +
            struct.pack("<II", zlib.crc32(data) & 0xFFFFFFFF, len(data)))


def sam_to_bam(sam_path, bam_path):
    """Convert a SAM text file to a BAM file. Returns the number of records.

    The SAM file must have @SQ header lines for every reference its records use.
    """
    header_lines, records, refs = [], [], []
    with open(sam_path) as handle:
        for line in handle:
            line = line.rstrip("\r\n")
            if not line:
                continue
            if line.startswith("@"):
                header_lines.append(line)
                if line.startswith("@SQ"):
                    tags = dict(f.split(":", 1) for f in line.split("\t")[1:] if ":" in f)
                    refs.append((tags["SN"], int(tags["LN"])))
            else:
                records.append(line.split("\t"))
    ref_ids = {name: i for i, (name, _) in enumerate(refs)}
    text = ("\n".join(header_lines) + "\n").encode() if header_lines else b""
    raw = bytearray(b"BAM\1" + struct.pack("<i", len(text)) + text + struct.pack("<i", len(refs)))
    for name, length in refs:
        encoded = name.encode() + b"\0"
        raw += struct.pack("<i", len(encoded)) + encoded + struct.pack("<i", length)
    for fields in records:
        if fields[2] != "*" and fields[2] not in ref_ids:
            raise ValueError("record %s uses reference %r, which has no @SQ header line" % (fields[0], fields[2]))
        raw += _encode_record(fields, ref_ids)
    with open(bam_path, "wb") as out:
        for start in range(0, len(raw), _BLOCK):
            out.write(_bgzf_block(bytes(raw[start:start + _BLOCK])))
        out.write(_BGZF_EOF)
    return len(records)


def read_bam(bam_path):
    """Read a BAM file back. Returns (header_text, references, records) with
    records as SAM-style field lists (mandatory fields only)."""
    with open(bam_path, "rb") as handle:
        data = gzip.decompress(handle.read())
    if data[:4] != b"BAM\1":
        raise ValueError("not a BAM file (bad magic)")
    at = 4
    (l_text,) = struct.unpack_from("<i", data, at); at += 4
    header = data[at:at + l_text].decode(); at += l_text
    (n_ref,) = struct.unpack_from("<i", data, at); at += 4
    refs = []
    for _ in range(n_ref):
        (l_name,) = struct.unpack_from("<i", data, at); at += 4
        name = data[at:at + l_name - 1].decode(); at += l_name
        (l_ref,) = struct.unpack_from("<i", data, at); at += 4
        refs.append((name, l_ref))
    records = []
    while at < len(data):
        (block,) = struct.unpack_from("<i", data, at); at += 4
        end = at + block
        ref_id, pos, l_name, mapq, _bin, n_cigar, flag, l_seq, next_id, next_pos, tlen = struct.unpack_from("<iiBBHHHiiii", data, at)
        p = at + 32
        qname = data[p:p + l_name - 1].decode(); p += l_name
        cigar = ""
        for _ in range(n_cigar):
            (value,) = struct.unpack_from("<I", data, p); p += 4
            cigar += "%d%s" % (value >> 4, _CIGAR_OPS[value & 15])
        seq = "".join(_SEQ_CODES[data[p + i // 2] >> 4 if i % 2 == 0 else data[p + i // 2] & 15] for i in range(l_seq))
        p += (l_seq + 1) // 2
        qual_bytes = data[p:p + l_seq]
        qual = "*" if l_seq == 0 or qual_bytes[:1] == b"\xff" else "".join(chr(b + 33) for b in qual_bytes)
        rname = "*" if ref_id < 0 else refs[ref_id][0]
        rnext = "*" if next_id < 0 else ("=" if next_id == ref_id else refs[next_id][0])
        records.append([qname, str(flag), rname, str(pos + 1), str(mapq), cigar or "*", rnext, str(next_pos + 1), str(tlen), seq or "*", qual])
        at = end
    return header, refs, records


_H5_DTYPES = {"float32", "float64", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64", "bool", "str"}


def write_h5(path, datasets, attrs=None):
    """Describe an HDF5 file (.h5, .hdf5, .h5ad, .loom) to be written.

    The script runs in a sandbox with no native libraries, so it cannot write
    HDF5 itself. This writes a plain description next to the target name; the
    app then builds the real HDF5 file from it with h5py.

        write_h5("toy_cells.h5ad", {
            "X": {"data": [[1, 0, 2], [0, 3, 1]], "dtype": "float32"},
            "obs/_index": {"data": ["cell_1", "cell_2"], "dtype": "str"},
            "var/_index": {"data": ["gene_1", "gene_2", "gene_3"], "dtype": "str"},
        }, attrs={"obs": {"encoding-type": "dataframe"}, "var": {"encoding-type": "dataframe"}})

    datasets: path inside the file -> {"data": nested lists, "dtype": one of
    float32/float64/int8..int64/uint8..uint64/bool/str}. A "/" in the path
    makes groups. attrs: path ("" for the file itself) -> {name: value}.
    """
    import json

    for name, spec in datasets.items():
        if not isinstance(spec, dict) or "data" not in spec:
            raise ValueError("dataset %r must be {'data': ..., 'dtype': ...}" % name)
        if spec.get("dtype", "float64") not in _H5_DTYPES:
            raise ValueError("dataset %r: dtype must be one of %s" % (name, ", ".join(sorted(_H5_DTYPES))))
    with open(path + ".h5spec.json", "w") as handle:
        json.dump({"datasets": datasets, "attrs": attrs or {}}, handle)
