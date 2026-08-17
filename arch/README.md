# arch — one directory per architecture

Three directories, one for each target cc1 knows, each holding the
configuration for a machine of that kind and the means of building cc1 there.

```
arm64-darwin/     the Mac        — clang, through the checkout's Makefile
x86_64-linux/     the EC2 box    — gcc, through the same Makefile
x86_64-windows/   the LAN box    — cl, through msvc/cc1.vcxproj
```

Each contains:

| file | what it is |
| --- | --- |
| `settings.json` | the `cc1.*` settings for this target |
| `tasks.json` | the build tasks, with cc1's two problem matchers |
| `build-cc1.sh` (`.ps1` on Windows) | builds cc1 from the checkout with **that machine's own compiler**, then points `../../cc/cc1.path` at the result |
| `README.md` | what this machine can and cannot reach |

Apply one to a workspace with `../use.sh <target> <folder>`, which copies the
two JSON files into that folder's `.vscode/`.

## No binary is ever carried between these

Each directory describes how its machine builds cc1 **from source, locally**.
Nothing here contains a compiler, an object file or an executable, and nothing
copies one from anywhere else. `arm64-darwin` is Mach-O, `x86_64-linux` is ELF,
`x86_64-windows` is PE; a binary built for one is meaningless on the others,
and even on a machine of the same kind a copied cc1 keeps the header directory
of the tree that built it — see `../cc/README.md`.

The only thing that travels between machines is text: this configuration, and
the extension's JavaScript.

## The one asymmetry

`arm64-darwin` and `x86_64-linux` both build with `make` and both reach a
running program in one command. `x86_64-windows` differs twice over: it builds
with MSBuild, and a cc1 **running** on Windows stops at `-S` whatever it
targets, because its driver writes temporaries to `/tmp`. There, `ml64` and
`link` finish the job. Its `README.md` says so at length.
