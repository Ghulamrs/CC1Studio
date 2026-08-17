# x86_64-windows — the LAN machine

Microsoft x64, PE, **LLP64** — `long` is 32 bits here and 64 on the other two,
which is the single most common cause of a difference between this target and
the others.

| | |
| --- | --- |
| builds cc1 with | MSBuild, driving `cl`, from the checkout's `msvc\cc1.vcxproj` |
| reaches | assembly from cc1; `ml64` and `link` finish the program |
| build the compiler | `.\build-cc1.ps1` |

## cc1 stops at -S here, whatever it is targeting

This is a fact about the **host**, not the target, and it surprises people who
know the cross-compiling rule. cc1 has no assembler and no linker; it writes
assembly and calls the host's `cc`. On Windows there is no such `cc` to call,
and cc1's driver builds those command lines for a POSIX shell besides — it
writes its temporary assembly to `/tmp`, a path that does not exist here. So a
Windows cc1 asked for an object fails on the path before anything else:

```
cc1.exe: cannot write /tmp/cc1-4400-0.s
```

The extension finishes the job with the tools the platform ships: `ml64`
assembles the MASM, `link` produces the executable, both after `vcvars64.bat`
has set `PATH` and `LIB`. Five libraries are needed because `link` driven
directly is told nothing a compiler driver would have embedded —
`legacy_stdio_definitions.lib` least obviously, because the UCRT made
`sprintf`, the v-family and the scanf family inline wrappers in its own
`<stdio.h>`, and cc1 correctly declares them as the ordinary functions C says
they are.

## MASM, and why the default matters

`ml64` reads MASM and that is what cc1 writes here. The objects carry **unwind
data** — each function is a `PROC FRAME` with its prologue described — and on
x64 that is not a nicety: the platform has no frame-pointer walk to fall back
on, so a function with no unwind entry is a wall that `RtlUnwindEx` stops at
and a debugger cannot see past.

`cc1.masm: "gnu"` writes the GNU spelling for clang instead, and **carries no
unwind data at all**, because GAS built for ELF rejects `.seh_*` directives
outright.

## Being hosted on Windows is a separate axis from targeting it

Two bugs of 2026-08-17 were host-only and invisible to every suite, because
Linux and macOS agree with themselves: `directoryOf` cut paths at `/` alone, so
a backslash path made `#include "beside.h"` silently mean the working
directory; and the MASM `$` mangling escaped onto imported symbols. When
something is wrong only here, ask whether it is the target's widths or the
host's filesystem before suspecting the backend.
