"""papersplainer: a static check on a model-written Manim scene, run BEFORE
the scene is executed.

Usage: python scene_check.py <scene.py>
Prints one JSON line: PAPERSPLAINER_SCENE {"problems": ["line N: ..."]}

It allows what an animation needs (manim, numpy, maths, pure-data standard
library modules, reading example data from data/) and rejects the ways a
script reaches the file system, the network, other processes, or Python's
internals.

This is a filter, NOT a sandbox: it stops mistakes and plain attempts, and
it narrows what a manipulated model can do, but a determined script could
find a path it does not cover. The scene still runs as an ordinary process.
"""
import ast
import json
import sys

ALLOWED_MODULES = {
    "manim", "numpy", "math", "cmath", "random", "itertools", "functools", "collections", "typing", "dataclasses",
    "colorsys", "fractions", "decimal", "string", "re", "json", "csv", "enum", "operator", "statistics", "textwrap",
    "copy", "bisect", "heapq", "abc", "__future__",
}

# Builtins and leaked module names that open a way out.
BANNED_NAMES = {
    "eval", "exec", "compile", "__import__", "getattr", "setattr", "delattr", "globals", "locals", "vars",
    "breakpoint", "input", "exit", "quit", "__builtins__", "__loader__", "__spec__",
    "os", "sys", "subprocess", "shutil", "pathlib", "Path", "socket", "importlib", "ctypes", "builtins", "pickle",
    "urllib", "requests", "tempfile", "glob", "io", "signal", "threading", "multiprocessing", "inspect", "gc",
}

# Attribute names that reach processes, the file system, the network or other modules,
# whatever object they are looked up on. Kept clear of names Manim itself uses
# (Scene.remove, re.compile, str.replace, Mobject.save_state, ...).
BANNED_ATTRIBUTES = {
    "os", "sys", "subprocess", "shutil", "pathlib", "socket", "importlib", "ctypes", "builtins", "pickle",
    "urllib", "requests", "tempfile", "glob", "signal", "threading", "multiprocessing", "inspect", "gc",
    "system", "popen", "Popen", "spawnl", "spawnv", "fork", "startfile", "execv", "execl",
    "check_output", "check_call", "unlink", "rmdir", "rmtree", "removedirs", "renames",
    "chmod", "chown", "makedirs", "symlink", "environ", "getenv", "putenv",
    "urlopen", "urlretrieve", "import_module", "load_module", "ctypeslib",
    "savez", "savez_compressed", "savetxt", "tofile", "fromfile", "memmap", "loadtxt", "genfromtxt",
    "write_text", "write_bytes", "read_text", "read_bytes",
}
# numpy's file readers and writers, banned only as np.<name> / numpy.<name>.
BANNED_NUMPY = {"save", "load", "open_memmap"}

ALLOWED_DUNDERS = {"__init__", "__name__", "__len__", "__str__", "__repr__", "__iter__", "__next__", "__eq__", "__hash__", "__lt__", "__post_init__"}
READ_MODES = {"r", "rt", "rb"}


def data_path_problem(node):
    """Why this open() call is not a plain read of an example data file (None = fine)."""
    if not node.args:
        return "open() needs a file path"
    first = node.args[0]
    if not (isinstance(first, ast.Constant) and isinstance(first.value, str)):
        return "open() is only allowed with a literal path under data/, for example open(\"data/reads.fastq\")"
    path = first.value.replace("\\", "/")
    if not path.startswith("data/") or ".." in path.split("/") or path.startswith("/"):
        return "open() may only read example data files under data/ (got %r)" % first.value
    mode = None
    if len(node.args) > 1:
        mode = node.args[1]
    for keyword in node.keywords:
        if keyword.arg == "mode":
            mode = keyword.value
    if mode is not None and not (isinstance(mode, ast.Constant) and mode.value in READ_MODES):
        return "data files may only be opened for reading"
    return None


def check(source):
    try:
        tree = ast.parse(source)
    except SyntaxError as err:
        return ["line %s: syntax error: %s" % (err.lineno, err.msg)]
    problems = []
    allowed_opens = set()
    reported_opens = set()

    def bad(node, text):
        problems.append("line %d: %s" % (getattr(node, "lineno", 0), text))

    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "open":
            problem = data_path_problem(node)
            if problem:
                bad(node, problem)
                reported_opens.add(id(node.func))
            else:
                allowed_opens.add(id(node.func))

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] not in ALLOWED_MODULES:
                    bad(node, "import of %r is not allowed in a scene (allowed: manim, numpy, math and pure-data standard library modules)" % alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.level or (node.module or "").split(".")[0] not in ALLOWED_MODULES:
                bad(node, "import from %r is not allowed in a scene" % (node.module or "."))
        elif isinstance(node, ast.Name):
            if node.id == "open":
                if id(node) not in allowed_opens and id(node) not in reported_opens:
                    bad(node, "open may only be called directly, to read a file under data/")
            elif node.id in BANNED_NAMES:
                bad(node, "%r is not allowed in a scene" % node.id)
        elif isinstance(node, ast.Attribute):
            name = node.attr
            if name.startswith("__") and name.endswith("__") and name not in ALLOWED_DUNDERS:
                bad(node, "access to %r is not allowed in a scene" % name)
            elif name in BANNED_NUMPY and isinstance(node.value, ast.Name) and node.value.id in ("np", "numpy"):
                bad(node, "numpy file reading and writing is not allowed in a scene; read example data with open(\"data/<name>\")")
            elif name in BANNED_ATTRIBUTES:
                bad(node, "%r is not allowed in a scene (no file, network or process access; read example data with open(\"data/<name>\"))" % ("." + name))
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            continue
    seen, unique = set(), []
    for problem in sorted(problems, key=lambda p: int(p.split(":")[0].split()[1])):
        if problem not in seen:
            seen.add(problem)
            unique.append(problem)
    return unique[:12]


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as handle:
        print("PAPERSPLAINER_SCENE " + json.dumps({"problems": check(handle.read())}))
