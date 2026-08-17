# x86_64-linux — the EC2 box

System V, ELF, LP64. The machine the compiler is written on: real gcc, bison
3.7.4, native x86-64, and the ABI the literature assumes.

**Native there.** cc1 compiles, assembles, links and runs in one command.

| | |
| --- | --- |
| builds cc1 with | `make`, driving gcc, from the checkout's `Makefile` |
| reaches | assembly, object, executable, and running it |
| build the compiler | `./build-cc1.sh` |

## Worth knowing about this machine

It has **419 MB of memory and two cores**, and runs httpd, mysqld and php-fpm
beside whatever you are doing. `build-cc1.sh` therefore caps `make` at one job
and warns when free memory is low; raise it with `CC1_BUILD_JOBS=2` if the box
is otherwise idle.

`/tmp` is a **210 MB tmpfs**, which is to say it is memory. A large file left
there is not disk usage, it is a smaller machine — a 192 MB download parked in
`/tmp` once took available memory from 289 MB to 98 MB. Put big things in
`$HOME`, which is xfs.

## Worth knowing about this target

`long double` here is x87 80-bit in 16 bytes, and it is the only one of the
three targets that needed a code generator for it. Its ABI class is X87/X87UP:
never in a register, always 16-aligned on the stack, `st(0)` for the return,
and an aggregate containing one is MEMORY whatever its size.

System V passes a struct by cutting it into eightbytes and classifying each.
