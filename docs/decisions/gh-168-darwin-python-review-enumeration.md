# GH-168: Python 3 for Darwin review dependency enumeration

Status: approved by owner (review loop 7, 2026-10-04).

## Decision

Python 3.8+ is a macOS runtime prerequisite for installed Perkins review
recovery. `install.sh` resolves and probes a stable absolute interpreter
before setup/update/service mutation; launchd receives that pinned path in
`GRU_COMMAND_REVIEW_PYTHON`. Help, print and uninstall do not probe Python.
There is no npm dependency. Linux continues to enumerate a held descriptor
through procfs.

## Why

Node's Darwin `readdirSync(path)` can race a directory swap and restore;
`/dev/fd/<held directory FD>` returns `ENOTDIR` on the tested host.
Surrounding pathname inode checks cannot authenticate the directory listing.
Python's `os.scandir(fd)` binds enumeration to an inherited checked directory
FD, including during pathname swaps. The child receives numeric fd 3 for
its held scan directory and, for package scans, fd 4 for the held installed
root; it verifies the package descriptor belongs to that root by no-follow
relative traversal. It never receives the original pathname. The fixed
inline script runs via the pinned native Mach-O interpreter with `-I -S`, no
shell, a minimal environment, bounded
time/output and entry count. The parent validates all names before hashing;
source file reads remain bounded no-follow descriptor reads. Missing or
unusable Python fails closed, never a pathname fallback.

## Consequences

macOS installers must ensure this interpreter remains available to launchd.
Direct unmanaged runs discover a real absolute Python executable from PATH
unless `GRU_COMMAND_REVIEW_PYTHON` is explicitly set; a bad explicit path is
an error, not permission to use another interpreter. An in-service update
whose existing unit does not pin the verified interpreter refuses to roll;
update from a terminal to refresh the unit. This prerequisite affects
installed review identity/recovery, not interactive Pi or web features.
