"""papersplainer: builds real HDF5 files from the plain descriptions a
sandboxed generator wrote with papertoy.write_h5.

Usage: python build_h5.py <directory>
For every <name>.h5spec.json in the directory, writes <name> with h5py and
removes the description. Prints one JSON line:
PAPERSPLAINER_H5 {"built": [...], "problems": [...]}

This is trusted code reading untrusted JSON: every path, type and size is
checked, and nothing in the description is executed.
"""
import json
import os
import re
import sys

MAX_SPEC_BYTES = 2 * 1024 * 1024
MAX_ELEMENTS = 200_000
TARGET = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,90}\.(h5|hdf5|h5ad|loom)$")
NODE = re.compile(r"^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$")
NUMERIC = {"float32", "float64", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64", "bool"}


def count(value):
    if isinstance(value, list):
        return sum(count(v) for v in value)
    return 1


def build(spec_path, target):
    import h5py
    import numpy as np

    if os.path.getsize(spec_path) > MAX_SPEC_BYTES:
        raise ValueError("the description is larger than 2 MB")
    with open(spec_path, encoding="utf-8") as handle:
        spec = json.load(handle)
    datasets = spec.get("datasets")
    attrs = spec.get("attrs") or {}
    if not isinstance(datasets, dict) or not datasets:
        raise ValueError("no datasets described")
    if not isinstance(attrs, dict):
        raise ValueError("attrs must be an object")
    with h5py.File(target, "w") as out:
        for name, entry in datasets.items():
            if not NODE.match(name) or ".." in name.split("/"):
                raise ValueError("bad dataset path %r" % name)
            if not isinstance(entry, dict) or "data" not in entry:
                raise ValueError("dataset %r needs data" % name)
            if count(entry["data"]) > MAX_ELEMENTS:
                raise ValueError("dataset %r is too large for a toy file" % name)
            dtype = entry.get("dtype", "float64")
            if dtype == "str":
                array = np.array(entry["data"], dtype=object)
                if not all(isinstance(v, str) for v in array.ravel().tolist()):
                    raise ValueError("dataset %r: dtype str needs strings" % name)
                out.create_dataset(name, data=array, dtype=h5py.string_dtype())
            elif dtype in NUMERIC:
                out.create_dataset(name, data=np.array(entry["data"], dtype=dtype))
            else:
                raise ValueError("dataset %r: unsupported dtype %r" % (name, dtype))
        for name, values in attrs.items():
            if name != "" and (not NODE.match(name) or ".." in name.split("/")):
                raise ValueError("bad attribute path %r" % name)
            if not isinstance(values, dict):
                raise ValueError("attributes of %r must be an object" % name)
            node = out if name == "" else out.require_group(name) if name not in out else out[name]
            for key, value in values.items():
                if not isinstance(key, str) or not isinstance(value, (str, int, float, bool, list)):
                    raise ValueError("attribute %r of %r must be text, a number or a list" % (key, name))
                node.attrs[key] = value


def main():
    directory = sys.argv[1]
    built, problems = [], []
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".h5spec.json"):
            continue
        target = name[: -len(".h5spec.json")]
        spec_path = os.path.join(directory, name)
        if not TARGET.match(target):
            problems.append("%s: the target must be a plain file name ending in .h5, .hdf5, .h5ad or .loom" % target)
        else:
            try:
                build(spec_path, os.path.join(directory, target))
                built.append(target)
            except Exception as err:  # reported to the maker, never raised
                problems.append("%s: %s" % (target, err))
                try:
                    os.remove(os.path.join(directory, target))
                except OSError:
                    pass
        os.remove(spec_path)
    print("PAPERSPLAINER_H5 " + json.dumps({"built": built, "problems": problems}))


if __name__ == "__main__":
    main()
