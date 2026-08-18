'use strict';

// Finding cc1, and building the command lines it understands.
//
// Every flag spelling here was read off `cc1` with no arguments and then
// confirmed by running it, rather than taken from the documentation: `-I dir`
// and `-Idir` are both accepted, as are `-arch a` and `-arch=a`. The joined
// forms are used below, since they survive being copied into a shell.

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const TARGETS = ['x86_64-linux', 'x86_64-windows', 'arm64-darwin'];

// What cc1 would call this machine if it were asked. cc1 knows three targets
// and nothing else, so a machine outside that set - an Intel Mac, an arm64
// Linux box - has no host target, and answering null here is what stops the
// extension from promising a native build it cannot deliver.
function hostTarget() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'arm64-darwin';
  if (process.platform === 'linux' && process.arch === 'x64') return 'x86_64-linux';
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-windows';
  return null;
}

// Pass the document's uri where one is to hand: in a multi-root workspace the
// folder-level values of resource-scoped settings only apply when the
// configuration is read against a resource. Read without a scope, the
// window-level answer comes back - which is still the right answer for the
// status bar and the target picker, since they speak for the window.
function config(scope) {
  return vscode.workspace.getConfiguration('cc1', scope || null);
}

// The target actually in force, with 'host' resolved. Null when the setting
// says 'host' and this machine is not one of the three.
function effectiveTarget() {
  const arch = config().get('arch', 'host');
  return arch === 'host' ? hostTarget() : arch;
}

// Whether cc1 can go past -S here. This is cc1's own rule - it has no
// assembler and no linker, it calls the host's cc - so anything but the host
// target stops at assembly.
function targetIsNative() {
  const arch = config().get('arch', 'host');
  return arch === 'host' || arch === hostTarget();
}

// Whether *cc1 itself* can go past -S here, which is a narrower question than
// whether the target is native.
//
// This used to be a fact about the platform: cc1 called the host's cc, Windows
// has none, and its driver wrote POSIX command lines and put temporaries in a
// /tmp that does not exist there, so a Windows cc1 asked for an object failed
// on the path before anything else:
//
//     cc1.exe: cannot write /tmp/cc1-4400-0.s
//
// It is now a fact about the *binary*. Compiler-C 48af909 taught the driver to
// call ml64 and link where a POSIX host calls cc, so a current cc1.exe
// finishes the job and an older one still stops at -S - and both may be
// installed on the same machine. Asking the platform would get one of them
// wrong, so the question goes to whichever compiler actually answered.
//
// Unknown means no. A binary that has not yet been asked is treated as one
// that cannot finish, which routes the build through the extension's own
// ml64 and link - the path that worked before any of this and still does.
function cc1CanLink() {
  if (!targetIsNative()) return false;
  if (process.platform !== 'win32') return true;
  const exe = resolvedCompiler();
  return !!(exe && finishes.get(exe));
}

// Whether a program can be produced here at all, by any route.
// What the probe concluded about one binary: true, false, or undefined for
// one that has not been asked.
function cc1Finishes(exe) {
  return finishes.get(exe);
}

// Ask, if this binary has not been asked yet.
//
// cc1CanLink has to be synchronous - the status bar and the task provider both
// call it - so it can only read what is already known, and treats unknown as
// no. That is the safe default and it would also be a permanent one: a
// configured cc1.path is used as named without being probed, so nothing would
// ever fill the answer in and a current Windows cc1 would be driven forever
// through a path it no longer needs. So the commands ask first, here, where
// waiting is allowed and the spawn is asynchronous.
async function learnCapabilities(exe) {
  if (!exe || finishes.has(exe)) return finishes.get(exe);
  const r = await run(exe, [], undefined);
  const usage = String(r.stdout || '') + String(r.stderr || '');
  const usable = /(^|\s)-S(\s|,)/.test(usage) && /<file\.c>/.test(usage);
  if (!capable.has(exe)) capable.set(exe, usable);
  finishes.set(exe, usable && /a\.exe/.test(usage));
  return finishes.get(exe);
}

function canReachExecutable() {
  if (process.platform === 'win32') return effectiveTarget() === 'x86_64-windows';
  return targetIsNative();
}

function expand(value, folder) {
  if (!value) return value;
  let out = value;
  if (folder) out = out.split('${workspaceFolder}').join(folder);
  if (out === '~') out = os.homedir();
  else if (out.startsWith('~' + path.sep) || out.startsWith('~/')) {
    out = path.join(os.homedir(), out.slice(2));
  }
  return out;
}

function folderFor(uri) {
  if (uri) {
    const f = vscode.workspace.getWorkspaceFolder(uri);
    if (f) return f.uri.fsPath;
  }
  const all = vscode.workspace.workspaceFolders;
  return all && all.length ? all[0].uri.fsPath : undefined;
}

const EXE = process.platform === 'win32' ? 'cc1.exe' : 'cc1';

// The toolchain slot: CC1Studio/cc/, which records where this machine's cc1
// is and deliberately never contains one.
//
// cc1 has its header directory baked in as an absolute path at build time -
// the Makefile spells the intent out, so that "a cc1 copied somewhere else
// finds its own lib/ and not the one belonging to the tree this came from".
// A copied compiler therefore reads the original's headers while a copied lib/
// beside it is read by nothing, and a second cc1 on a machine becomes a second
// answer to every question with nothing on screen saying which one replied.
//
// So the slot holds `cc1.path`, one line of text naming the real binary. A
// text file rather than a symlink because Windows wants an administrator for
// those and the other two machines do not; where a symlink is free, the
// installer makes one too, purely so the directory is useful from a shell.
let slotDir = null;

function setSlot(dir) {
  slotDir = dir;
  cached = null;
}

function slotPointer() {
  if (!slotDir) return null;
  try {
    const named = fs.readFileSync(path.join(slotDir, 'cc1.path'), 'utf8').trim();
    return named || null;
  } catch (e) {
    return null;
  }
}

function isRunnable(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (e) {
    return false;
  }
}

// Being named cc1 and being executable is not enough, and this is not a
// hypothetical. A cc1 built on 2026-08-15 was found sitting in the home
// directory of the machine this was written on, three months of flags behind
// the one in the repository: no -S, no -c, no -D, no -masm. It writes assembly
// and nothing else. Every candidate is therefore asked what it can do before
// it is believed.
//
// -S is the right question. It is the flag the whole extension rests on - the
// diagnostics run through it and so does the assembly pane - so a cc1 without
// it is not an older compiler this could get by with, it is the wrong tool.
//
// Note that a weaker check passes the stale binary: it prints "arch picks the
// architecture" just as the current one does.
const capable = new Map();

// Whether that same binary finishes the job past -S on this host. Keyed the
// same way and filled by the same probe, so the two answers can never come
// from different compilers.
const finishes = new Map();

function isUsable(p) {
  if (!isRunnable(p)) return false;
  const key = p;
  if (capable.has(key)) return capable.get(key);
  let ok = false;
  try {
    // cc1 given no input prints its usage and exits; that text is the answer.
    // stdin is closed up front: a binary that answers to the name cc1 but
    // reads standard input (gcc's own internal cc1 does) would otherwise sit
    // on the timeout instead of failing at once.
    const r = cp.spawnSync(p, [], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const usage = String(r.stdout || '') + String(r.stderr || '');
    ok = /(^|\s)-S(\s|,)/.test(usage) && /<file\.c>/.test(usage);
    // The same text answers the second question. A driver that finishes the
    // job on Windows says so in its own usage - "a.out - a.exe on a Windows
    // host" - because it has to explain the name it will give the program.
    // The compiler describing itself is the cheapest honest source there is,
    // and it is exactly the text already in hand.
    finishes.set(key, ok && /a\.exe/.test(usage));
  } catch (e) {
    ok = false;
    finishes.set(key, false);
  }
  capable.set(key, ok);
  return ok;
}

let cached = null;

function forgetCompiler() {
  cached = null;
  capable.clear();
  finishes.clear();
}

// Look for cc1 in the order someone would look for it themselves: where they
// said it was, then beside the file, then up towards the repository root that
// built it, then the workspace, then PATH.
function findCompiler(uri) {
  const folder = folderFor(uri);
  const configured = expand(config().get('path', ''), folder);
  if (configured) {
    // An explicitly named compiler is used as named. Saying so is the point of
    // saying so, and a setting that silently resolved to something else would
    // be worse than one that fails.
    return isRunnable(configured) ? configured : null;
  }
  if (cached && isUsable(cached)) return cached;

  const seen = [];
  // Walking up finds the cc1 that belongs to the tree being edited. It stops
  // at the workspace root, because past that the walk leaves the project and
  // an executable it meets there is a coincidence, not a choice - which is how
  // a compiler in the home directory came to answer for a file in a
  // repository that has its own.
  if (uri && uri.scheme === 'file') {
    const stopAt = folder ? path.resolve(folder) : null;
    let dir = path.dirname(uri.fsPath);
    for (;;) {
      seen.push(path.join(dir, EXE));
      if (stopAt && path.resolve(dir) === stopAt) break;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  for (const f of vscode.workspace.workspaceFolders || []) {
    seen.push(path.join(f.uri.fsPath, EXE));
  }
  const pointed = slotPointer();
  if (pointed) seen.push(pointed);
  if (slotDir) seen.push(path.join(slotDir, EXE));
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) seen.push(path.join(dir, EXE));
  }
  for (const candidate of seen) {
    if (isUsable(candidate)) {
      cached = candidate;
      return candidate;
    }
  }
  return null;
}

// The flags every invocation carries, whatever it is being asked to produce.
// archOverride lets a task definition name its own target; everything else
// still comes from the settings.
function commonArgs(uri, archOverride) {
  const c = config(uri);
  const folder = folderFor(uri);
  const args = [];

  const arch = archOverride || c.get('arch', 'host');
  if (arch !== 'host') args.push('-arch=' + arch);

  // -masm only means anything for the Windows target, and 'masm' is already
  // cc1's default, so the flag is written only when it changes something.
  const target = arch === 'host' ? hostTarget() : arch;
  if (target === 'x86_64-windows' && c.get('masm', 'masm') === 'gnu') {
    args.push('-masm=gnu');
  }

  for (const dir of c.get('includePaths', [])) args.push('-I' + expand(dir, folder));
  for (const d of c.get('defines', [])) args.push('-D' + d);
  for (const u of c.get('undefines', [])) args.push('-U' + u);

  const jobs = c.get('jobs', 0);
  if (jobs > 0) args.push('-j', String(jobs));

  for (const extra of c.get('extraArgs', [])) args.push(expand(extra, folder));
  return args;
}

// token, when given, is a vscode.CancellationToken: cancelling kills the
// child rather than leaving it to run to completion behind a spinner that
// nothing can dismiss. stdin is closed so a tool that reads it fails fast
// instead of waiting forever on input nobody can type.
// env is for the one case that needs it: a Windows cc1 that calls ml64 and
// link itself, which finds them only in the environment vcvars64.bat sets.
// Handing that environment to an ordinary spawn keeps the diagnostics, the
// cancellation and the exit code that wrapping the call in a batch file would
// have cost. Everywhere else it is undefined and the child inherits ours.
function run(exe, args, cwd, token, env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = cp.spawn(exe, args, {
        cwd,
        env: env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e && e.message), spawnFailed: true });
      return;
    }
    let listener;
    if (token) {
      listener = token.onCancellationRequested(() => {
        try { child.kill(); } catch (e) { /* already gone */ }
      });
    }
    const done = (result) => {
      if (listener) listener.dispose();
      resolve(result);
    };
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      done({ code: -1, stdout, stderr: String(e && e.message), spawnFailed: true });
    });
    child.on('close', (code) => done({
      code,
      stdout,
      stderr,
      cancelled: !!(token && token.isCancellationRequested),
    }));
  });
}

let counter = 0;

// cc1 always writes its output somewhere; a check that only wants the
// diagnostics still needs a destination for the assembly it would have
// produced. A real temporary file rather than /dev/null, because the Windows
// host has no such thing and the null device there is spelled differently.
function scratchFile(ext) {
  counter += 1;
  const name = 'cc1-studio-' + process.pid + '-' + counter + ext;
  return path.join(os.tmpdir(), name);
}

function discard(file) {
  try { fs.unlinkSync(file); } catch (e) { /* it may never have been written */ }
}

// The extension name cc1 gives assembly for the target in force. MASM output
// is .asm by convention and everything else is .s; this only decides what the
// assembly pane is called, and through that how it is coloured.
function assemblySuffix() {
  return suffixFor(effectiveTarget());
}

function suffixFor(target) {
  const windows = target === 'x86_64-windows';
  return windows && config().get('masm', 'masm') === 'masm' ? '.asm' : '.s';
}

// The compiler already resolved, without going looking. findCompiler probes
// candidates with a synchronous spawn, which is the right price for a build
// and the wrong one for a status bar repaint on every editor switch - this
// answers from what is already known and never blocks.
function resolvedCompiler() {
  const configured = expand(config().get('path', ''), folderFor(undefined));
  if (configured) return isRunnable(configured) ? configured : null;
  return cached;
}

// Which cc1 actually answered. The slot is a symlink, so the path the editor
// used and the binary that ran are two different strings; a build that reports
// the first and not the second is the one that lets a stale compiler go
// unnoticed. Both are shown.
function realPathOf(exe) {
  try {
    return fs.realpathSync(exe);
  } catch (e) {
    return exe;
  }
}

module.exports = {
  TARGETS,
  setSlot,
  isUsable,
  realPathOf,
  hostTarget,
  effectiveTarget,
  targetIsNative,
  cc1CanLink,
  canReachExecutable,
  cc1Finishes,
  learnCapabilities,
  config,
  expand,
  folderFor,
  findCompiler,
  forgetCompiler,
  commonArgs,
  run,
  scratchFile,
  discard,
  assemblySuffix,
  suffixFor,
  resolvedCompiler,
};
