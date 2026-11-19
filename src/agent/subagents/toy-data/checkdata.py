"""papersplainer: checks a toy dataset by parsing every file back.

Usage: python checkdata.py <directory>
Prints one JSON line: {"files": [{name, format, bytes, checked, summary, preview, problems}]}

A file passes when it parses as its format and its internal consistency
rules hold (record shapes, matching lengths, declared counts). Unknown
extensions are reported as "unchecked", not as failures.
"""
import csv
import gzip
import io
import json
import os
import re
import sys

# Find papertoy beside this file even in Python's isolated mode (-I), which
# does not put the script's folder on the import path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from papertoy import read_bam  # noqa: E402

PREVIEW_LINES = 14
PREVIEW_WIDTH = 160
MAX_PROBLEMS = 6

TEXT_FORMATS = {
    ".fa": "fasta", ".fasta": "fasta", ".fna": "fasta", ".faa": "fasta", ".ffn": "fasta",
    ".fq": "fastq", ".fastq": "fastq",
    ".vcf": "vcf",
    ".bed": "bed", ".bedgraph": "bed", ".narrowpeak": "bed", ".broadpeak": "bed",
    ".gff": "gff", ".gff3": "gff", ".gtf": "gtf",
    ".sam": "sam",
    ".csv": "csv", ".tsv": "tsv", ".tab": "tsv", ".txt": "text", ".mtx": "mtx",
    ".pdb": "pdb", ".ent": "pdb", ".cif": "mmcif", ".mmcif": "mmcif",
    ".json": "json", ".newick": "newick", ".nwk": "newick", ".tree": "newick",
    ".aln": "text", ".clustal": "text", ".sto": "text", ".phy": "text", ".md": "text", ".yaml": "text", ".yml": "text",
}
BINARY_FORMATS = {".bam": "bam", ".h5": "hdf5", ".hdf5": "hdf5", ".h5ad": "h5ad", ".loom": "hdf5", ".npy": "npy", ".npz": "npz"}


def preview_text(text):
    lines = text.splitlines()
    shown = [line if len(line) <= PREVIEW_WIDTH else line[:PREVIEW_WIDTH] + "…" for line in lines[:PREVIEW_LINES]]
    if len(lines) > PREVIEW_LINES:
        shown.append("… (%d more lines)" % (len(lines) - PREVIEW_LINES))
    return "\n".join(shown)


def plural(n, word):
    return "%d %s%s" % (n, word, "" if n == 1 else "s")


def check_fasta(text, problems):
    records, length, name = 0, 0, None
    for i, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        if line.startswith(">"):
            if name is not None and length == 0:
                problems.append("record %r has no sequence" % name)
            name, length = line[1:].strip(), 0
            records += 1
            if not name:
                problems.append("line %d: empty header" % i)
        else:
            if name is None:
                problems.append("line %d: sequence before the first '>' header" % i)
                break
            if not re.fullmatch(r"[A-Za-z*\-.]+", line.strip()):
                problems.append("line %d: characters that are not sequence letters" % i)
            length += len(line.strip())
    if name is not None and length == 0:
        problems.append("record %r has no sequence" % name)
    if records == 0:
        problems.append("no '>' records")
    return plural(records, "sequence")


def check_fastq(text, problems):
    lines = [l for l in text.splitlines()]
    while lines and not lines[-1].strip():
        lines.pop()
    if len(lines) % 4 != 0:
        problems.append("%d lines: FASTQ records are 4 lines each" % len(lines))
    records = 0
    for i in range(0, len(lines) - 3, 4):
        head, seq, plus, qual = lines[i:i + 4]
        records += 1
        if not head.startswith("@"):
            problems.append("line %d: record header must start with '@'" % (i + 1))
        if not plus.startswith("+"):
            problems.append("line %d: third line of a record must start with '+'" % (i + 3))
        if len(seq) != len(qual):
            problems.append("line %d: sequence (%d) and quality (%d) lengths differ" % (i + 2, len(seq), len(qual)))
        if any(not 33 <= ord(c) <= 126 for c in qual):
            problems.append("line %d: quality characters outside Phred+33 range" % (i + 4))
        if not re.fullmatch(r"[A-Za-z.]*", seq):
            problems.append("line %d: sequence has non-letter characters" % (i + 2))
    if records == 0:
        problems.append("no records")
    return plural(records, "read")


def check_vcf(text, problems):
    lines = text.splitlines()
    if not lines or not lines[0].startswith("##fileformat=VCF"):
        problems.append("first line must be ##fileformat=VCFv4.x")
    header, records, samples = None, 0, 0
    for i, line in enumerate(lines, 1):
        if line.startswith("##") or not line.strip():
            continue
        cols = line.split("\t")
        if line.startswith("#"):
            header = cols
            if cols[:8] != ["#CHROM", "POS", "ID", "REF", "ALT", "QUAL", "FILTER", "INFO"]:
                problems.append("line %d: column header must be #CHROM POS ID REF ALT QUAL FILTER INFO (tab-separated)" % i)
            if len(cols) > 8 and (len(cols) < 10 or cols[8] != "FORMAT"):
                problems.append("line %d: genotype columns need FORMAT followed by at least one sample" % i)
            samples = max(0, len(cols) - 9)
            continue
        if header is None:
            problems.append("line %d: data before the #CHROM header line" % i)
            break
        records += 1
        if len(cols) != len(header):
            problems.append("line %d: %d columns, header has %d" % (i, len(cols), len(header)))
            continue
        if not cols[1].isdigit():
            problems.append("line %d: POS is not an integer" % i)
        if not re.fullmatch(r"[ACGTNacgtn]+", cols[3]):
            problems.append("line %d: REF must be bases" % i)
        if len(cols) > 9:
            keys = cols[8].split(":")
            for sample in cols[9:]:
                if len(sample.split(":")) > len(keys):
                    problems.append("line %d: a sample has more fields than FORMAT" % i)
                    break
    if header is None:
        problems.append("no #CHROM header line")
    return "%s, %s" % (plural(records, "variant"), plural(samples, "sample"))


def check_bed(text, problems):
    records = 0
    for i, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.startswith(("#", "track", "browser")):
            continue
        cols = line.split("\t")
        records += 1
        if len(cols) < 3:
            problems.append("line %d: needs at least chrom, start, end (tab-separated)" % i)
            continue
        if not (cols[1].isdigit() and cols[2].isdigit()):
            problems.append("line %d: start and end must be integers" % i)
        elif int(cols[1]) > int(cols[2]):
            problems.append("line %d: start is after end" % i)
        if len(cols) >= 6 and cols[5] not in "+-.":
            problems.append("line %d: strand must be +, - or ." % i)
    if records == 0:
        problems.append("no intervals")
    return plural(records, "interval")


def check_gff(text, problems, gtf=False):
    records = 0
    for i, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        cols = line.split("\t")
        records += 1
        if len(cols) != 9:
            problems.append("line %d: %d tab-separated columns, need 9" % (i, len(cols)))
            continue
        if not (cols[3].isdigit() and cols[4].isdigit()) or int(cols[3]) > int(cols[4]):
            problems.append("line %d: start/end must be integers with start <= end" % i)
        if cols[6] not in ("+", "-", ".", "?"):
            problems.append("line %d: strand must be +, -, . or ?" % i)
        if cols[7] not in (".", "0", "1", "2"):
            problems.append("line %d: phase must be ., 0, 1 or 2" % i)
        if gtf and 'gene_id "' not in cols[8]:
            problems.append("line %d: GTF attributes need gene_id \"…\";" % i)
        if not gtf and cols[8] != "." and "=" not in cols[8]:
            problems.append("line %d: GFF3 attributes are key=value pairs separated by ';'" % i)
    if records == 0:
        problems.append("no features")
    return plural(records, "feature")


CIGAR = re.compile(r"(\d+)([MIDNSHP=X])")


def check_sam(text, problems):
    refs, records = set(), 0
    for i, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        if line.startswith("@"):
            if line.startswith("@SQ"):
                m = re.search(r"\tSN:([^\t]+)", line)
                if m:
                    refs.add(m.group(1))
                if not re.search(r"\tLN:\d+", line):
                    problems.append("line %d: @SQ needs LN:<length>" % i)
            continue
        cols = line.split("\t")
        records += 1
        if len(cols) < 11:
            problems.append("line %d: %d tab-separated fields, need at least 11" % (i, len(cols)))
            continue
        for at, label in ((1, "FLAG"), (3, "POS"), (4, "MAPQ"), (7, "PNEXT")):
            if not cols[at].isdigit():
                problems.append("line %d: %s is not a non-negative integer" % (i, label))
        if cols[2] != "*" and refs and cols[2] not in refs:
            problems.append("line %d: RNAME %r has no @SQ header line" % (i, cols[2]))
        if cols[5] != "*":
            ops = CIGAR.findall(cols[5])
            if "".join(n + op for n, op in ops) != cols[5]:
                problems.append("line %d: malformed CIGAR %r" % (i, cols[5]))
            elif cols[9] != "*":
                query = sum(int(n) for n, op in ops if op in "MIS=X")
                if query != len(cols[9]):
                    problems.append("line %d: CIGAR covers %d query bases, SEQ has %d" % (i, query, len(cols[9])))
        if cols[9] != "*" and cols[10] != "*" and len(cols[9]) != len(cols[10]):
            problems.append("line %d: SEQ and QUAL lengths differ" % i)
    if records == 0:
        problems.append("no alignment records")
    return "%s, %s" % (plural(records, "alignment"), plural(len(refs), "reference"))


def check_table(text, problems, delimiter):
    rows = [r for r in csv.reader(io.StringIO(text), delimiter=delimiter) if r]
    rows = [r for r in rows if not (r[0].startswith("#") and len(r) == 1)]
    if not rows:
        problems.append("no rows")
        return "empty"
    width = len(rows[0])
    for i, row in enumerate(rows[1:], 2):
        if len(row) != width:
            problems.append("row %d has %d columns, the first row has %d" % (i, len(row), width))
    if width < 2:
        problems.append("only one column: is the delimiter right for this extension?")
    return "%d rows × %d columns (including the header row)" % (len(rows), width)


def check_mtx(text, problems):
    lines = [l for l in text.splitlines() if l.strip()]
    if not lines or not lines[0].startswith("%%MatrixMarket"):
        problems.append("first line must be the %%MatrixMarket banner")
        return "not Matrix Market"
    body = [l for l in lines[1:] if not l.startswith("%")]
    if not body:
        problems.append("no size line")
        return "empty"
    size = body[0].split()
    if len(size) != 3 or not all(x.isdigit() for x in size):
        problems.append("size line must be: rows columns entries")
        return "bad size line"
    rows, cols, entries = map(int, size)
    if len(body) - 1 != entries:
        problems.append("size line declares %d entries, file has %d" % (entries, len(body) - 1))
    for i, line in enumerate(body[1:], 1):
        parts = line.split()
        if len(parts) < 2 or not (parts[0].isdigit() and parts[1].isdigit()) or not (1 <= int(parts[0]) <= rows and 1 <= int(parts[1]) <= cols):
            problems.append("entry %d: indices outside the declared %d × %d shape" % (i, rows, cols))
    return "%d × %d sparse matrix, %s" % (rows, cols, plural(entries, "entry").replace("entrys", "entries"))


def check_pdb(text, problems):
    atoms = 0
    for i, line in enumerate(text.splitlines(), 1):
        if line.startswith(("ATOM", "HETATM")):
            atoms += 1
            try:
                float(line[30:38]); float(line[38:46]); float(line[46:54])
            except ValueError:
                problems.append("line %d: coordinates are not in the fixed PDB columns (31-54)" % i)
    if atoms == 0:
        problems.append("no ATOM/HETATM records")
    return plural(atoms, "atom")


def check_mmcif(text, problems):
    if not re.search(r"^data_", text, re.M):
        problems.append("no data_ block")
    atoms = len(re.findall(r"^(?:ATOM|HETATM)\s", text, re.M))
    if "_atom_site." not in text:
        problems.append("no _atom_site loop")
    return plural(atoms, "atom")


def check_json(text, problems):
    try:
        value = json.loads(text)
    except ValueError as err:
        problems.append("not valid JSON: %s" % err)
        return "invalid"
    return "JSON %s" % type(value).__name__


def check_newick(text, problems):
    tree = text.strip()
    if not tree.endswith(";"):
        problems.append("a Newick tree ends with ';'")
    if tree.count("(") != tree.count(")"):
        problems.append("unbalanced parentheses")
    return plural(tree.count(",") + 1, "leaf").replace("leafs", "leaves")


def check_bam(path, problems):
    header, refs, records = read_bam(path)
    for fields in records[:2000]:
        if fields[5] != "*" and fields[9] != "*":
            query = sum(int(n) for n, op in CIGAR.findall(fields[5]) if op in "MIS=X")
            if query != len(fields[9]):
                problems.append("%s: CIGAR covers %d query bases, SEQ has %d" % (fields[0], query, len(fields[9])))
    if not records:
        problems.append("no alignment records")
    shown = ["(binary BAM; shown as the SAM text it decodes to)"] + header.splitlines()[:6] + ["\t".join(r) for r in records[:8]]
    return "%s, %s" % (plural(len(records), "alignment"), plural(len(refs), "reference")), preview_text("\n".join(shown))


def check_hdf5(path, problems, h5ad):
    try:
        import h5py
    except ImportError:
        problems.append("h5py is not installed in this environment, so HDF5 files cannot be written or checked")
        return "unreadable", ""
    lines, datasets = [], 0
    with h5py.File(path, "r") as handle:
        def visit(name, obj):
            nonlocal datasets
            depth = name.count("/")
            if isinstance(obj, h5py.Dataset):
                datasets += 1
                lines.append("%s%s  dataset %s %s" % ("  " * depth, name.split("/")[-1], obj.shape, obj.dtype))
            else:
                enc = obj.attrs.get("encoding-type")
                lines.append("%s%s/%s" % ("  " * depth, name.split("/")[-1], "  [%s]" % (enc.decode() if isinstance(enc, bytes) else enc) if enc is not None else ""))
        handle.visititems(visit)
        if h5ad:
            for key in ("X", "obs", "var"):
                if key not in handle:
                    problems.append("an .h5ad file needs %r at the top level" % key)
    if datasets == 0:
        problems.append("no datasets")
    return plural(datasets, "dataset"), preview_text("(binary HDF5; contents listed)\n" + "\n".join(lines))


def check_numpy(path, problems, archive):
    import numpy as np
    if archive:
        with np.load(path) as data:
            parts = ["%s %s %s" % (k, data[k].shape, data[k].dtype) for k in data.files]
        return plural(len(parts), "array"), "(binary NumPy archive)\n" + "\n".join(parts[:PREVIEW_LINES])
    arr = np.load(path)
    return "array %s %s" % (arr.shape, arr.dtype), "(binary NumPy array)\n" + preview_text(np.array2string(arr, threshold=60, edgeitems=3))


def check_file(path):
    name = os.path.basename(path)
    lower = name.lower()
    gz = lower.endswith(".gz")
    ext = os.path.splitext(lower[:-3] if gz else lower)[1]
    entry = {"name": name, "bytes": os.path.getsize(path), "format": "unchecked", "checked": False, "summary": "", "preview": "", "problems": []}
    problems = entry["problems"]
    try:
        if ext in BINARY_FORMATS and not gz:
            entry["format"] = BINARY_FORMATS[ext]
            if ext == ".bam":
                entry["summary"], entry["preview"] = check_bam(path, problems)
            elif ext in (".npy", ".npz"):
                entry["summary"], entry["preview"] = check_numpy(path, problems, ext == ".npz")
            else:
                entry["summary"], entry["preview"] = check_hdf5(path, problems, ext == ".h5ad")
            entry["checked"] = not problems
            return entry
        raw = open(path, "rb").read()
        if gz:
            raw = gzip.decompress(raw)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            entry["summary"] = "binary file of a format the checker does not know"
            entry["preview"] = "(binary, not shown)"
            return entry
        entry["preview"] = ("(gzip-compressed; shown decompressed)\n" if gz else "") + preview_text(text)
        fmt = TEXT_FORMATS.get(ext)
        if fmt is None:
            entry["summary"] = "%s; format not checked" % plural(len(text.splitlines()), "line")
            return entry
        entry["format"] = fmt + (".gz" if gz else "")
        if fmt == "fasta":
            entry["summary"] = check_fasta(text, problems)
        elif fmt == "fastq":
            entry["summary"] = check_fastq(text, problems)
        elif fmt == "vcf":
            entry["summary"] = check_vcf(text, problems)
        elif fmt == "bed":
            entry["summary"] = check_bed(text, problems)
        elif fmt in ("gff", "gtf"):
            entry["summary"] = check_gff(text, problems, gtf=fmt == "gtf")
        elif fmt == "sam":
            entry["summary"] = check_sam(text, problems)
        elif fmt in ("csv", "tsv"):
            entry["summary"] = check_table(text, problems, "," if fmt == "csv" else "\t")
        elif fmt == "mtx":
            entry["summary"] = check_mtx(text, problems)
        elif fmt == "pdb":
            entry["summary"] = check_pdb(text, problems)
        elif fmt == "mmcif":
            entry["summary"] = check_mmcif(text, problems)
        elif fmt == "json":
            entry["summary"] = check_json(text, problems)
        elif fmt == "newick":
            entry["summary"] = check_newick(text, problems)
        else:
            entry["summary"] = plural(len(text.splitlines()), "line")
        entry["checked"] = not problems
    except Exception as err:  # a file that cannot be read at all is a problem to report, not a crash
        problems.append("could not be read as %s: %s" % (entry["format"], err))
        entry["checked"] = False
    if len(problems) > MAX_PROBLEMS:
        more = len(problems) - MAX_PROBLEMS
        del problems[MAX_PROBLEMS:]
        problems.append("… and %d more" % more)
    return entry


def main():
    directory = sys.argv[1]
    files = sorted(f for f in os.listdir(directory) if os.path.isfile(os.path.join(directory, f)) and not f.startswith("."))
    print("PAPERSPLAINER_CHECK " + json.dumps({"files": [check_file(os.path.join(directory, f)) for f in files]}))


if __name__ == "__main__":
    main()
