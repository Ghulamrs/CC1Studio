# CC1 Studio

An editing and build environment for [Compiler-C](https://github.com/Ghulamrs/Compiler-C),
built as a VS Code extension. VS Code is the front end; `cc1` is the only
compiler, and the host's assembler and linker finish the job — which is how cc1
already works, since it has neither of its own.

One idea runs through all of it: **cc1 is the authority on this C.** Everything
the editor claims about a file comes from having run cc1 on it. The Problems
panel is cc1's stderr. The assembly pane is `cc1 -S`. The build commands are
cc1 driving `cc`. Nothing here re-implements a judgement the compiler makes, so
nothing here can disagree with it.

## What it gives you

| | |
| --- | --- |
| **Diagnostics** | cc1's errors as squiggles, on the right line *and column*, in the right file — including errors inside a header, which land in the header. |
| **Assembly beside the source** | `⌘⌥A` opens a live pane of `cc1 -S` output that follows the file as you save it, and re-renders when you change target. |
| **Three targets, one click** | The status bar names the target and says whether it is native here. Switching re-renders every open assembly pane. |
| **Build and run** | `⌘⌥R` links through the host toolchain and runs the program in a terminal, so a program that reads `stdin` behaves like one. |
| **Tasks** | `cc1: assembly`, `object`, `executable` and `build and run` are contributed, so `⌘⇧B` works without a `tasks.json`. |
| **Assembly highlighting** | A grammar covering GAS and MASM both, since cc1 writes both. |
| **Phase timings** | `cc1: Report Phase Timings` runs `-time` and shows read+pp / lex / parse / codegen. |

## Installing

On the machine itself:

```bash
./install.sh                      # finds cc1, packages, installs, sets cc1.path
```

Then open a **`.c` file** and **trust the folder** when VS Code asks. The status
bar will name the target.

`install.sh` does four things: points `cc/` and `source/` at this machine's
cc1 and checkout, builds the `.vsix`, installs it through whichever VS Code
command exists here, and writes the **`cc1.path` setting**. That last step is
not optional — see below.

### On a machine you reach over Remote-SSH

A remote window is a different installation from the desktop one, and gets
neither the extension nor the settings by default:

| | desktop window | remote window |
| --- | --- | --- |
| extensions | `~/.vscode/extensions` | `~/.vscode-server/extensions` |
| settings | user settings | `~/.vscode-server/data/Machine/settings.json` |
| install with | `code` | `~/.vscode-server/cli/servers/Stable-<commit>/server/bin/code-server` |

Run `./install.sh` **on the remote machine** and it handles all three. Add
`--server` to seed the directory before the first connection.

The Mac also needs the host named in `~/.ssh/config` — Remote-SSH has nowhere
to type an `-i` flag, so a key outside `~/.ssh` is invisible to it — and
`remote.SSH.remotePlatform` set for that host.

`package.sh` needs only `zip` — a `.vsix` is a zip of the JavaScript, and no
npm, node or `vsce` is involved. The package is 27 KB of text: no compiler and
no binary of any kind travels in it.

Copying the extension folder into `~/.vscode/extensions` by hand *looks* like
it works — the editor lists it, `--list-extensions` prints it — and it does not
load. Install the `.vsix`.

The installer refuses a cc1 that does not support `-S`. That is not a
formality — see below.

## The `cc/` slot, and why it holds no compiler

`cc/` records where **this machine's** cc1 is, in one line of text. It never
contains a copy of the compiler, and `cc/README.md` explains at length why a
copy would be worse than useless. The short version:

cc1 has its header directory compiled in as an **absolute path** (`INCDIR =
$(CURDIR)/lib` in the Compiler-C `Makefile`, with a comment saying why). A
copied cc1 therefore reads the *original's* headers, and a `lib/` copied beside
it is read by nothing at all. Meanwhile the binary is Mach-O on the Mac, ELF on
the EC2 box and PE on Windows, so it could not travel even if it wanted to.

What is left is the real risk: **two cc1s on one machine answer differently and
neither says which one replied.** So the status bar tooltip names the compiler
it resolved, and the symlink's target beside it.

### This is not hypothetical

While this was being written, the test suite found a **second cc1 in the home
directory of this Mac**, built 2026-08-15, with a different hash from the
repository's. It has no `-S`, no `-c`, no `-D`, no `-U` and no `-masm`; it
writes assembly and stops. It had been silently winning the search, because
the search walked up past the project into `$HOME`.

Two changes came out of that, and both are tested:

- the walk up towards the project root **stops at the workspace root**, since
  past that an executable is a coincidence rather than a choice;
- every candidate is **asked what it can do** — cc1 with no arguments prints
  its usage, and one that does not mention `-S` is refused. A weaker check
  passes the stale binary, which announces "arch picks the architecture"
  exactly like the current one.

`~/cc1` has since been deleted. Looking for what else answered to the name
turned up a **third** one, in an older checkout at
`~/_NEW_/_Final_/Compiler-C++/` — built 2026-08-14, also without `-S`, and
sitting at the root of its own working tree at commit `2291c91`. That one is
left alone: it belongs to its checkout rather than being a stray, and the two
changes above already handle it. Open a file in that tree and the walk up finds
it, asks what it can do, is told it has no `-S`, and falls through to the slot.

Which is the point of asking rather than assuming. Binaries named `cc1`
accumulate; the defence is that each one is made to say what it can do before
it is believed.

## One toolchain, and no second opinion

This environment carries **no third-party C extension**, on purpose. The
Microsoft C/C++ pack is not installed on any of the three machines, and VS Code
is configured not to recommend or auto-install it — which it otherwise does,
unprompted, the first time it opens a folder of `.c` files.

The reason is not licensing but correctness. cpptools parses C as *its own*
compiler understands it, while cc1 accepts C89 plus a few additions and refuses
several things by name. Its squiggles therefore disagree with the compiler that
will actually build the code — squiggles under code that compiles, silence over
code that does not. One authority is better than two that differ, and the
authority here is cc1.

Nothing in this extension consults another compiler either. It runs cc1, and on
Windows the platform's own `ml64` and `link`. It does not check cc1's answers
against gcc or clang, and it does not compare the output of a program cc1 built
against anything else.

The settings that hold this in place live in each machine's user settings, and
`Compiler-C/.vscode/c_cpp_properties.json` — which existed only to configure
cpptools — has been removed.

## Settings

All under `cc1.` — `path`, `arch`, `masm`, `includePaths`, `defines`,
`undefines`, `jobs`, `sources`, `diagnostics`, `diagnosticsDelay`,
`assemblyRefresh`, `extraArgs`. `${workspaceFolder}` and `~` are expanded in
paths.

`cc1.sources` is the one worth knowing about: set it to the globs naming every
translation unit (`["src/**/*.c"]`) and the link and run commands build the
whole program. Left empty, they build the file in front of you.

## What cc1 refuses, and why that is not this extension's doing

**cc1 has no assembler and no linker.** It writes assembly and calls the host's
`cc`. So on the Mac and the Linux box, `arm64-darwin` and `x86_64-linux`
compile, assemble, link and run in one command, while any other target stops at
assembly and says so. The extension reports that rule up front rather than
letting you press Run and read a failure.

**Windows is the exception, and it is not a target question but a host one.**
A cc1 running on Windows stops at `-S` *whatever* it is targeting, because its
driver builds the assemble and link command lines for a POSIX shell and puts
its temporaries in `/tmp`. Asked for an object there, it fails on the path
before anything else:

```
cc1.exe: cannot write /tmp/cc1-4400-0.s
```

So on Windows the extension finishes the job itself with the tools the platform
ships: `ml64` assembles the MASM cc1 writes, and `link` produces the executable
— the same sequence `help/command-lines.md` sets out by hand, including the
five libraries `link` needs when driven directly. `vcvars64.bat` is found
through `vswhere`, or named with `cc1.vcvars`.

The status bar says which of the three situations you are in, because "native"
would be true and useless on Windows.

**cc1 stops at the first error.** There is at most one diagnostic per file per
run, which is why a check clears every file it previously reported on before
setting the new one.

## Testing

```bash
./extension/test/run.sh             # the source directory
./extension/test/run-installed.sh   # the files install.sh actually put in place
```

Twenty-one checks, run inside a real VS Code against the real compiler — the
parser against known cc1 output, and the rest against cc1 itself: diagnostics
landing on the right line and column, an error in a header landing in the
header, a missing include, settings reaching the command line, two targets
producing different assembly, and a linked program printing what it should.

There is **no framework and no `npm install`**, on purpose. VS Code ships its
own node, and neither the Mac this was written on nor the 419 MB EC2 box has
node or npm at all. A test runner that needs installing is a test runner that
will not be run.

**The suite passed while the editor did nothing, and that is worth dwelling on.**
Twenty-one green checks said the extension worked; opening a folder in VS Code
showed no status bar, no diagnostics and no assembly pane, and *no error
anywhere* — the extension was installed, listed, registered, and never
activated.

The cause was **Workspace Trust**. A folder VS Code has not been told to trust
opens in Restricted Mode, which silently disables every extension that is not
built in. The test runners pass `--disable-workspace-trust`, so they never met
it. A minimal two-file extension behaved identically, which is what finally
separated "our code is broken" from "nothing loads here".

So the extension now **declares** `capabilities.untrustedWorkspaces` as
unsupported, with a reason. It still will not run in a restricted window — it
compiles and runs the workspace's code, so that is the right answer — but VS
Code now says so on screen instead of doing nothing.

## If the status bar is missing

Four things account for every case of this seen so far, in the order worth
checking.

**Is it activated?** `Developer: Show Running Extensions`. Absent there means
it never started, which is a different problem from a broken extension and the
logs do not distinguish them. **Open a `.c` file** — `onLanguage:c` is the
trigger that reliably works. `workspaceContains:**/*.c` did not fire even with
`.c` files in an open, trusted folder, which cost hours; `onStartupFinished` is
in the manifest now so activation no longer depends on it.

**Does the window have a folder open?** `code --remote host /path` can leave a
folder-less window. Nothing fires there, and an empty window is trusted by
default so no prompt appears to tell you.

**Is the folder trusted?** Restricted Mode disables every third-party
extension silently. There is no prompt once one has been dismissed —
`Workspaces: Manage Workspace Trust` and click Trust.

**Is `cc1.path` set?** If the extension runs but says cc1 is missing, this is
why. The `.vsix` deliberately carries no path, so an installed copy cannot find
the slot; `install.sh` writes the setting instead. On a remote window it must
be in that machine's `Machine/settings.json`, not your user settings.

Three things learned the hard way, all now written into the scripts:

- `--extensionTestsPath` **without** `--extensionDevelopmentPath` starts the
  editor, starts the extension host, and never runs the tests — printing
  nothing to say so.
- a test launch **must** pass `--disable-extensions`. Without it VS Code loads
  its built-in GitHub and agent extensions, which open a browser asking to be
  signed in, and auto-installs the C/C++ pack while you wait.

## Layout

```
CC1Studio/
  package.sh                 builds cc1-studio-1.0.0.vsix with zip alone
  install.sh / install.ps1   point cc/ and source/ at this machine, install the .vsix
  use.sh                     apply an architecture's config to a workspace

  arch/                      three directories, one per architecture
    arm64-darwin/            settings.json, tasks.json, build-cc1.sh, README
    x86_64-linux/            settings.json, tasks.json, build-cc1.sh, README
    x86_64-windows/          settings.json, tasks.json, build-cc1.ps1, README

  source/source.path         where the Compiler-C checkout is. A pointer, never a copy
  cc/cc1.path                where this machine's cc1 is. A pointer, never a binary

  extension/
    extension.js             commands, diagnostics wiring, status bar, task provider
    lib/cc1.js               finding cc1 and building its command lines
    lib/diagnostics.js       cc1's two report formats -> Problems panel entries
    lib/assembly.js          the virtual document behind the assembly pane
    lib/windows.js           ml64 and link, which finish what cc1 starts on Windows
    syntaxes/                a GAS and MASM grammar
    test/                    the twenty-one checks, and the two runners
```

Two pointers and no copies, which is the whole shape of it. The compiler has
one source of truth — the checkout — and each machine builds its own cc1 from
it with its own compiler: `make` and clang on the Mac, `make` and gcc on the
box, MSBuild and `cl` on Windows. Nothing but text ever moves between them.
