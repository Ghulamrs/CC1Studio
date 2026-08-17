# source — where cc1 comes from

This directory holds **one line of text** naming the Compiler-C checkout on
this machine, and no source code.

- **`source.path`** — the absolute path of the checkout. Written by
  `../install.sh`, or by hand.

## Why a pointer and not a copy

The compiler has one source of truth, and it is the git checkout. A second
copy of `src/` sitting here would be a second answer to "what does cc1 do",
kept in step by nothing, and the project has already paid for that mistake
twice — once with two cc1 binaries on this Mac and once with three on the
Windows machine, each answering confidently and none of them saying which one
had replied.

So: the checkout is the source, this file says where it is, and every
`build-cc1` script under `../arch/` reads it.

## Why the project files live under `arch/` and not here

Because they are not one thing. The compiler is built by a different program
on each machine:

| architecture | built by | project file |
| --- | --- | --- |
| `arm64-darwin` | `make`, driving Apple clang | the checkout's `Makefile` |
| `x86_64-linux` | `make`, driving gcc | the same `Makefile` |
| `x86_64-windows` | MSBuild, driving `cl` | the checkout's `msvc/cc1.vcxproj` |

Each of those belongs beside the configuration for the machine that runs it,
which is what `arch/<target>/` is for. Both files already exist in the
checkout; the scripts under `arch/` invoke them rather than reimplementing
them.

## Moving the checkout

Edit `source.path`, or re-run `../install.sh`. Nothing else refers to the
location.
