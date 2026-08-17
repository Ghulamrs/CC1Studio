# arm64-darwin — the Mac

AAPCS64 as Apple writes it, Mach-O, LP64.

**Native here.** cc1 compiles, assembles, links and runs in one command,
because it hands the assembly to this machine's own `cc`.

| | |
| --- | --- |
| builds cc1 with | `make`, driving Apple clang, from the checkout's `Makefile` |
| reaches | assembly, object, executable, and running it |
| build the compiler | `./build-cc1.sh` |

## Worth knowing about this target

Apple's stack argument layout is **not** the one AAPCS64 describes, and it
takes three rules rather than one — a named scalar keeps its own size and
alignment, a named aggregate is padded to a multiple of 8 with alignment at
least 8, and anything variadic occupies 8 whatever it is. A 12-byte struct
placed after a `char` therefore starts at 8 and occupies 16.

A **homogeneous float aggregate** — one to four members of the same floating
type — travels in that many vector registers whatever its size, so three
doubles go in `d0`–`d2`. That is why `tour.c` in the demo folder shows
something different here than on either x86 target.

`long double` is plain `double` on this platform.
