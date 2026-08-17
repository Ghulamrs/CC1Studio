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

function config() {
  return vscode.workspace.getConfiguration('cc1');
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
// whether the target is native, and the two disagree on exactly one platform.
//
// cc1 has no assembler and no linker; it writes assembly and calls the host's
// cc. On Windows there is no such cc to call, and cc1's driver builds those
// command lines for a POSIX shell besides - it even puts its temporaries in
// /tmp, so a Windows cc1 asked for an object fails on the path first:
//
//     cc1.exe: cannot write /tmp/cc1-4400-0.s
//
// So on Windows the answer is always no, whatever the target, and the
// extension finishes the job through ml64 and link instead. See lib/windows.js.
function cc1CanLink() {
  return process.platform !== 'win32' && targetIsNative();
}

// Whether a program can be produced here at all, by any route.
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

function isUsable(p) {
  if (!isRunnable(p)) return false;
  const key = p;
  if (capable.has(key)) return capable.get(key);
  let ok = false;
  try {
    // cc1 given no input prints its usage and exits; that text is the answer.
    const r = cp.spawnSync(p, [], { timeout: 5000, encoding: 'utf8' });
    const usage = String(r.stdout || '') + String(r.stderr || '');
    ok = /(^|\s)-S(\s|,)/.test(usage) && /<file\.c>/.test(usage);
  } catch (e) {
    ok = false;
  }
  capable.set(key, ok);
  return ok;
}

let cached = null;

function forgetCompiler() {
  cached = null;
  capable.clear();
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
function commonArgs(uri) {
  const c = config();
  const folder = folderFor(uri);
  const args = [];

  const arch = c.get('arch', 'host');
  if (arch !== 'host') args.push('-arch=' + arch);

  // -masm only means anything for the Windows target, and 'masm' is already
  // cc1's default, so the flag is written only when it changes something.
  if (effectiveTarget() === 'x86_64-windows' && c.get('masm', 'masm') === 'gnu') {
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

function run(exe, args, cwd) {
  return new Promise((resolve) => {
    let child;
    try {
      child = cp.spawn(exe, args, { cwd });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e && e.message), spawnFailed: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      resolve({ code: -1, stdout, stderr: String(e && e.message), spawnFailed: true });
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
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
  const windows = effectiveTarget() === 'x86_64-windows';
  return windows && config().get('masm', 'masm') === 'masm' ? '.asm' : '.s';
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
};
