# cc — the toolchain slot

This directory records where **this machine's** `cc1` is. It contains no
compiler and no headers, and that is deliberate rather than an omission.

`install.sh` (or `install.ps1`) writes:

- **`cc1.path`** — one line, the absolute path of the cc1 to use. This is what
  the extension reads.
- **`cc1`** — a symlink to the same binary, on machines where symlinks are free,
  so the directory is convenient from a shell too. The extension does not
  depend on it.

Neither file is committed; both are per-machine.

## Why there is no cc1 in here

**cc1 has its header directory compiled in, as an absolute path.** The
Compiler-C `Makefile` sets `INCDIR = $(CURDIR)/lib` and says why in a comment
beside it: so that a cc1 copied somewhere else finds its own `lib/` and not the
one belonging to the tree it came from.

Three things follow, and each of them makes a copy here worse than no copy.

1. **A copied cc1 would still read the original's headers.** Put a `lib/` in
   this directory and nothing would ever open it. It would sit there looking
   authoritative, and every question would be answered by a `lib/` somewhere
   else entirely.

2. **The binary cannot travel anyway.** It is Mach-O arm64 on the Mac, ELF
   x86-64 on the EC2 box, PE on the Windows machine. Each of those has to build
   its own from source; there is nothing to share but the path.

3. **Two cc1s on one machine is the failure this project already knows.** The
   repository's own notes record hours lost to a green test suite that was
   running against a binary nobody had rebuilt. A second compiler in a second
   directory answers just as confidently as the first and nothing on screen
   says which one replied.

So: one binary of record, one line of text pointing at it. The extension shows
the path it resolved — and the symlink's target — in the status bar tooltip, so
the question "which cc1 just answered that" always has an answer on screen.

## Moving or rebuilding cc1

Re-run `install.sh`. It re-points the slot and checks that whatever it is
pointed at really is cc1 before writing anything.
