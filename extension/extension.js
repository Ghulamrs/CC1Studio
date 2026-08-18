'use strict';

// CC1 Studio - the editor half of the Compiler-C project.
//
// The whole extension is one idea: cc1 is the authority on this C, so
// everything the editor claims about a file comes from having run cc1 on it.
// The Problems panel is cc1's stderr, the assembly pane is cc1 -S, and the
// build commands are cc1 driving the host's assembler and linker, which is how
// cc1 already works. Nothing here re-implements a judgement the compiler makes.

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const cc1 = require('./lib/cc1');
const diag = require('./lib/diagnostics');
const windows = require('./lib/windows');
const { AssemblyProvider, SCHEME } = require('./lib/assembly');

let output;
let diagnostics;
let status;
let assembly;

function isC(doc) {
  return doc && doc.languageId === 'c' && doc.uri.scheme === 'file';
}

function activeC() {
  const ed = vscode.window.activeTextEditor;
  if (ed && isC(ed.document)) return ed.document;
  return null;
}

// The C file a command should act on. The active editor when it is one, else
// a visible one, else an open one - so the build keystroke still works when
// focus sits in the terminal, the Problems panel, or the assembly pane.
function subjectC() {
  const active = activeC();
  if (active) return active;
  const visible = vscode.window.visibleTextEditors.find((ed) => isC(ed.document));
  if (visible) return visible.document;
  return vscode.workspace.textDocuments.find(isC) || null;
}

// Settings written from a command go to the workspace when there is one, and
// to the user otherwise - updating workspace configuration in a window with
// no folder open throws rather than falling back.
function configTarget() {
  return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

// cc1's own refusal, reported before the command line is built rather than
// after, so the message names the way forward instead of the failure.
async function requireNative() {
  if (cc1.canReachExecutable()) return true;
  const host = cc1.hostTarget() || process.platform + '-' + process.arch;
  const pick = await vscode.window.showWarningMessage(
    'cc1 cannot assemble ' + cc1.effectiveTarget() + ' code on this machine, which is ' +
      host + '. Assembly is as far as this target goes here.',
    'Show Assembly Beside',
    'Switch to Host'
  );
  if (pick === 'Show Assembly Beside') vscode.commands.executeCommand('cc1.showAssembly');
  if (pick === 'Switch to Host') {
    await cc1.config().update('arch', 'host', configTarget());
  }
  return false;
}

function compilerFor(doc) {
  const exe = cc1.findCompiler(doc.uri);
  if (!exe) {
    vscode.window
      .showErrorMessage('cc1 was not found beside this file, in the workspace, or on PATH.', 'Locate It')
      .then((pick) => {
        if (pick === 'Locate It') vscode.commands.executeCommand('cc1.locateCompiler');
      });
  }
  return exe;
}

function cwdFor(doc) {
  return cc1.folderFor(doc.uri) || path.dirname(doc.uri.fsPath);
}

// ---------------------------------------------------------------- diagnostics

// Checks and builds are serialized through one chain, so two saves in quick
// succession (Save All fires one per file) cannot interleave their updates -
// the unserialized version lost one file's squiggle to the other's clear.
let chain = Promise.resolve();

function enqueue(fn) {
  const job = chain.then(fn);
  chain = job.then(() => undefined, () => undefined);
  return job;
}

// What each source's last run reported on, by uri string. cc1 stops at the
// first error, so a re-check of a source must clear whatever that source
// blamed last time - a fixed error in a header has to vanish - but it must
// not clear what a *different* source reported, or checking one file wipes
// another's squiggles.
const reportedBy = new Map();

// Turn one cc1 run's stderr into Problems panel entries, replacing exactly
// what an earlier run of the same source put there. Returns the parse so the
// caller can also speak about it.
async function publish(sourceKey, said, cwd) {
  const { entries, notices } = diag.parse(said);
  const groups = await diag.toDiagnostics(entries, cwd);
  const now = new Set(groups.map((g) => g.uri.toString()));
  const before = reportedBy.get(sourceKey);
  if (before) {
    for (const key of before) {
      if (!now.has(key)) diagnostics.delete(vscode.Uri.parse(key));
    }
  }
  for (const group of groups) diagnostics.set(group.uri, group.list);
  reportedBy.set(sourceKey, now);
  return { entries, notices };
}

// A check compiles to a scratch file and throws the assembly away; the only
// thing wanted is what cc1 said on the way.
function check(doc) {
  return enqueue(() => checkNow(doc));
}

async function checkNow(doc) {
  if (!isC(doc)) return;
  const exe = cc1.findCompiler(doc.uri);
  if (!exe) return;

  const out = cc1.scratchFile(cc1.assemblySuffix());
  const args = [doc.uri.fsPath].concat(cc1.commonArgs(doc.uri), ['-S', '-o', out]);
  const cwd = cwdFor(doc);
  const result = await cc1.run(exe, args, cwd);
  cc1.discard(out);

  const { entries, notices } = await publish(doc.uri.fsPath, result.stderr + result.stdout, cwd);

  // Anything cc1 said that carried no position is about the command line, not
  // the code. It has no gutter to live in, so it goes to the output channel.
  if (result.code !== 0 && entries.length === 0 && notices.length) {
    output.appendLine('$ ' + exe + ' ' + args.join(' '));
    for (const n of notices) output.appendLine(n);
  }
  updateStatus();
}

// -------------------------------------------------------------------- builds

// Every translation unit of the program, for the commands that link. Left
// unset, a program is just the file in front of you.
async function sourcesFor(doc) {
  const globs = cc1.config(doc.uri).get('sources', []);
  if (!globs.length) return [doc.uri.fsPath];
  const folder = cc1.folderFor(doc.uri);
  if (!folder) return [doc.uri.fsPath];
  const found = new Set();
  for (const glob of globs) {
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob));
    for (const f of files) found.add(f.fsPath);
  }
  if (!found.size) return [doc.uri.fsPath];
  return Array.from(found).sort();
}

// cc1 reads disk, so every translation unit going into the program is saved
// first - not just the active file. Without this a multi-file build quietly
// compiles the stale on-disk copy of any other file being edited.
async function saveSources(sources) {
  const wanted = new Set(sources);
  for (const open of vscode.workspace.textDocuments) {
    if (open.isDirty && wanted.has(open.uri.fsPath)) await open.save();
  }
}

function programPath(doc) {
  const dir = path.dirname(doc.uri.fsPath);
  const base = path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath));
  return path.join(dir, base + (process.platform === 'win32' ? '.exe' : ''));
}

// Run cc1 for a command the user asked for, reporting through the same
// Problems panel a check uses so a failed build reads the same as a failed
// check. The progress lives in a notification with a cancel button, and
// cancelling kills the compiler rather than abandoning it. Returns true when
// cc1 succeeded.
// The environment a build needs, or null if it needs one that is not there.
//
// Only work going past -S needs anything: a Windows cc1 that assembles and
// links for itself calls ml64 and link by bare name, and they reach PATH only
// after vcvars64.bat. Checking and assembly stop short of that and want
// nothing. Undefined means "inherit ours", which is every other case.
async function toolchainEnvFor(needed) {
  if (!needed) return undefined;
  if (process.platform !== 'win32') return undefined;
  if (!cc1.cc1CanLink()) return undefined;
  const env = await windows.toolchainEnv();
  return env || null;
}

async function build(doc, extraArgs, description, needsToolchain) {
  const exe = compilerFor(doc);
  if (!exe) return false;
  const cwd = cwdFor(doc);
  const args = extraArgs.slice();

  const env = await toolchainEnvFor(needsToolchain);
  if (env === null) {
    output.appendLine(windows.noVcvars());
    vscode.window
      .showErrorMessage(
        'cc1 assembles and links through ml64 and link, and vcvars64.bat was ' +
          'not found, so neither can be reached.',
        'Details'
      )
      .then((pick) => { if (pick === 'Details') output.show(true); });
    return false;
  }
  output.appendLine('$ ' + exe + ' ' + args.join(' '));

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'cc1: ' + description,
      cancellable: true,
    },
    (progress, token) => cc1.run(exe, args, cwd, token, env || undefined)
  );
  if (result.cancelled) {
    output.appendLine('cc1: cancelled');
    return false;
  }

  const said = result.stderr + result.stdout;
  if (said.trim()) output.appendLine(said.trimEnd());

  const { entries, notices } = await enqueue(() => publish(doc.uri.fsPath, said, cwd));

  if (result.code !== 0) {
    if (entries.length) {
      const first = entries[0];
      vscode.window.showErrorMessage('cc1: ' + first.message + '  (' + path.basename(first.file) + ':' + first.line + ')');
    } else {
      vscode.window.showErrorMessage('cc1: ' + (notices[0] || 'exited ' + result.code), 'Details').then((p) => {
        if (p === 'Details') output.show(true);
      });
    }
    return false;
  }
  return true;
}

// ------------------------------------------------------------------ commands

async function commandShowAssembly() {
  const doc = subjectC();
  if (!doc) {
    vscode.window.showInformationMessage('Open a C file first.');
    return;
  }
  if (doc.isDirty) await doc.save();
  const uri = assembly.uriFor(doc.uri.fsPath);
  assembly.refreshFor(doc.uri.fsPath);
  const shown = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(shown, 'cc1-asm');
  await vscode.window.showTextDocument(shown, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: true,
    preview: false,
  });
}

// On Windows the compile and the assemble are two commands run by two
// programs, so the failure of either has to be reported as one outcome.
async function reportToolchain(result, what) {
  if (result.code === 0) return true;
  const said = ((result.stderr || '') + (result.stdout || '')).trim();
  if (said) output.appendLine(said);
  vscode.window.showErrorMessage('cc1: ' + what + ' failed.', 'Details').then((p) => {
    if (p === 'Details') output.show(true);
  });
  return false;
}

// ml64 reads MASM and nothing else. That holds whoever calls it - the
// extension over cc1's assembly, or a current cc1 calling it for itself - so
// the question is whether this host assembles with ml64 at all, not who drives
// it. Asking cc1CanLink here was right only while a Windows cc1 always stopped
// at -S; once one could finish the job, that test began answering "no need to
// check" for exactly the builds that need checking.
function requireMasmSyntax() {
  if (process.platform !== 'win32') return true;
  if (cc1.config().get('masm', 'masm') !== 'gnu') return true;
  vscode.window
    .showErrorMessage(
      'cc1.masm is set to the GNU spelling, which ml64 cannot read. ' +
        'Switch it back to masm to build on this machine.',
      'Use masm'
    )
    .then((pick) => {
      if (pick === 'Use masm') cc1.config().update('masm', 'masm', configTarget());
    });
  return false;
}

async function commandBuildObject() {
  const doc = subjectC();
  if (!doc) return;
  if (!(await requireNative())) return;
  await cc1.learnCapabilities(compilerFor(doc));
  if (!requireMasmSyntax()) return;
  if (doc.isDirty) await doc.save();
  const stem = path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath));
  const dir = path.dirname(doc.uri.fsPath);

  if (!cc1.cc1CanLink()) {
    // Windows: cc1 writes the MASM, ml64 turns it into the object.
    const asm = path.join(dir, stem + '.asm');
    const obj = path.join(dir, stem + '.obj');
    const args = [doc.uri.fsPath].concat(cc1.commonArgs(doc.uri), ['-S', '-o', asm]);
    if (!(await build(doc, args, 'compiling to assembly'))) return;
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'cc1: assembling with ml64' },
      () => windows.assemble(asm, obj, dir, output)
    );
    if (await reportToolchain(result, 'ml64')) {
      vscode.window.showInformationMessage('ml64 wrote ' + path.basename(obj));
    }
    return;
  }

  // .obj on a Windows host, .o elsewhere: the same command producing one or
  // the other depending on which cc1 answered would be its own small puzzle.
  const obj = path.join(dir, stem + (process.platform === 'win32' ? '.obj' : '.o'));
  const args = [doc.uri.fsPath].concat(cc1.commonArgs(doc.uri), ['-c', '-o', obj]);
  if (await build(doc, args, 'compiling to an object', true)) {
    vscode.window.showInformationMessage('cc1 wrote ' + path.basename(obj));
  }
}

async function commandBuildExecutable() {
  const doc = subjectC();
  if (!doc) return null;
  if (!(await requireNative())) return null;
  await cc1.learnCapabilities(compilerFor(doc));
  if (!requireMasmSyntax()) return null;
  const sources = await sourcesFor(doc);
  await saveSources(sources.concat([doc.uri.fsPath]));
  const program = programPath(doc);

  if (!cc1.cc1CanLink()) {
    // Windows: one cc1 -S per translation unit, then ml64 over each and link
    // over all of them - the sequence help/command-lines.md sets out by hand.
    // Each unit's .asm and .obj land beside their own source: naming them all
    // after their stems in one directory silently merged src/a/util.c and
    // src/b/util.c into a single util.obj.
    const dir = path.dirname(doc.uri.fsPath);
    const units = [];
    for (const source of sources) {
      const stem = path.basename(source, path.extname(source));
      const asm = path.join(path.dirname(source), stem + '.asm');
      const args = [source].concat(cc1.commonArgs(doc.uri), ['-S', '-o', asm]);
      if (!(await build(doc, args, 'compiling ' + path.basename(source)))) return null;
      units.push({ asm, obj: path.join(path.dirname(source), stem + '.obj') });
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'cc1: ml64 and link' },
      () => windows.assembleAndLink(units, program, dir, output)
    );
    if (!(await reportToolchain(result, 'ml64/link'))) return null;
    return program;
  }

  const args = sources.concat(cc1.commonArgs(doc.uri), ['-o', program]);
  if (await build(doc, args, 'building ' + path.basename(program), true)) return program;
  return null;
}

// The program is run in a terminal rather than captured, so that a program
// which reads stdin behaves like one. The exit code is echoed after it, since
// a terminal otherwise swallows it and a program that only computes a status
// looks the same succeeding and failing.
//
// Two honest limitations. The command line is written for the default shells
// (POSIX sh-family, PowerShell on Windows) - a cmd.exe terminal profile will
// not read it. And if the previous program is still running in the reused
// terminal, the new command line lands on that program's stdin; there is no
// API that says whether a terminal is busy.
async function commandRun() {
  const program = await commandBuildExecutable();
  if (!program) return;
  const term =
    vscode.window.terminals.find((t) => t.name === 'cc1') ||
    vscode.window.createTerminal({ name: 'cc1', cwd: path.dirname(program) });
  term.show(true);
  let line;
  if (process.platform === 'win32') {
    // PowerShell: single quotes are literal, an embedded one is doubled.
    line = '& \'' + program.replace(/'/g, "''") + '\'; echo "exit $LASTEXITCODE"';
  } else {
    // POSIX: single quotes are literal, an embedded one is spelled '\''.
    line = "'" + program.replace(/'/g, "'\\''") + "'; echo \"exit $?\"";
  }
  term.sendText(line);
}

async function commandSelectArch() {
  const host = cc1.hostTarget();
  const items = [
    {
      label: 'host',
      description: host ? host + ' - compiles, assembles, links and runs' : 'this machine is not one of cc1\'s three targets',
    },
  ].concat(
    cc1.TARGETS.map((t) => ({
      label: t,
      description: t === host ? 'native here - reaches an executable' : 'cross - reaches assembly only',
    }))
  );
  const pick = await vscode.window.showQuickPick(items, { title: 'cc1: target architecture' });
  if (!pick) return;
  await cc1.config().update('arch', pick.label, configTarget());
}

async function commandSelectMasm() {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'masm', description: 'what ml64 reads - the default, and the only one carrying unwind data' },
      { label: 'gnu', description: 'what gcc and clang read - no .seh_* directives' },
    ],
    { title: 'cc1: assembly syntax for x86_64-windows' }
  );
  if (!pick) return;
  await cc1.config().update('masm', pick.label, configTarget());
}

async function commandShowTiming() {
  const doc = subjectC();
  if (!doc) return;
  const exe = compilerFor(doc);
  if (!exe) return;
  if (doc.isDirty) await doc.save();
  const out = cc1.scratchFile(cc1.assemblySuffix());
  const args = [doc.uri.fsPath].concat(cc1.commonArgs(doc.uri), ['-S', '-time', '-o', out]);
  const result = await cc1.run(exe, args, cwdFor(doc));
  cc1.discard(out);
  output.appendLine('$ ' + exe + ' ' + args.join(' '));
  output.appendLine((result.stderr + result.stdout).trimEnd());
  output.show(true);
}

async function commandLocateCompiler() {
  const found = cc1.findCompiler(activeC() ? activeC().uri : undefined);
  const picked = await vscode.window.showOpenDialog({
    title: 'Where is cc1?',
    canSelectMany: false,
    defaultUri: found ? vscode.Uri.file(path.dirname(found)) : undefined,
    openLabel: 'Use this cc1',
  });
  if (!picked || !picked.length) return;
  await cc1.config().update('path', picked[0].fsPath, configTarget());
  cc1.forgetCompiler();
  updateStatus();
  vscode.window.showInformationMessage('cc1: using ' + picked[0].fsPath);
}

// -------------------------------------------------------------- status bar

function updateStatus() {
  const target = cc1.effectiveTarget();
  const label = target || 'no target';
  status.text = '$(chip) cc1: ' + label + (cc1.canReachExecutable() ? '' : ' $(link-external)');

  // Naming the binary is not decoration. Two cc1s on one machine answer
  // differently and neither says so; the tooltip is where that gets settled,
  // and it shows the link's target as well as the path taken.
  //
  // Only the compiler already resolved is named - the tooltip never goes
  // looking. The search probes each candidate with a synchronous spawn, and
  // paying that on every editor switch froze the window; the first check or
  // build resolves the compiler and refreshes this.
  const exe = cc1.resolvedCompiler();
  let provenance = '_cc1 not resolved yet - it is found by the first check or build, or named by `cc1.path`._';
  if (exe) {
    const real = cc1.realPathOf(exe);
    provenance = '**compiler:** `' + exe + '`';
    if (real !== exe) provenance += '\n\n**resolves to:** `' + real + '`';
  }

  // On Windows "native" and "reaches a program" are different answers: cc1
  // stops at -S there whatever the target, and ml64 and link carry it the rest
  // of the way. Saying "native" would be true and useless.
  let reach;
  if (!cc1.canReachExecutable()) {
    reach = 'Cross - reaches assembly only on this machine.';
  } else if (cc1.cc1CanLink() && process.platform === 'win32') {
    reach = 'Native here - cc1 drives ml64 and link itself.';
  } else if (cc1.cc1CanLink()) {
    reach = 'Native here - cc1 compiles, assembles, links and runs.';
  } else {
    reach = 'cc1 writes MASM here and stops; ml64 and link finish the program.';
  }

  status.tooltip = new vscode.MarkdownString(
    '**cc1 target:** ' + label + '\n\n' + reach +
      '\n\n' + provenance +
      '\n\nClick to change the target.'
  );
  vscode.commands.executeCommand('setContext', 'cc1.targetIsNative', cc1.canReachExecutable());
  vscode.commands.executeCommand('setContext', 'cc1.targetIsWindows', target === 'x86_64-windows');
  status.show();
}

// ------------------------------------------------------------- task provider

// Contributing tasks rather than asking for a tasks.json means the build
// keystroke works in any directory holding a cc1 and a .c file. The subject
// is the visible C file, not the focused one - the keystroke should still
// work with focus in the terminal or the assembly pane.
const taskProvider = {
  provideTasks() {
    const doc = subjectC();
    if (!doc) return [];
    // On Windows only the assembly task is offered, and the reason survived a
    // current cc1 learning to assemble and link for itself. A task runs in the
    // user's own terminal, and that terminal has not had vcvars64.bat run in
    // it - so cc1 would call ml64 by name and not find it. The commands hand
    // the compiler that environment; a ShellExecution cannot, short of writing
    // a batch file the user did not ask for. Assembly needs no toolchain and
    // is safe to offer anywhere.
    const modes = tasksCanGoPastAssembly()
      ? [['assembly', 'assembly'], ['object', 'object'],
         ['executable', 'executable'], ['run', 'build and run']]
      : [['assembly', 'assembly']];
    return modes.map(([mode, title]) => makeTask({ type: 'cc1', mode }, title, doc));
  },
  resolveTask(task) {
    const doc = subjectC();
    if (!doc) return undefined;
    return makeTask(task.definition, task.definition.mode, doc);
  },
};

// One POSIX shell word. Only the run task builds a command line by hand -
// everything else hands VS Code the words and lets it do the quoting.
function shellWord(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Whether a task may do more than write assembly. Not the same question as
// whether cc1 can: a Windows cc1 that finishes the job still needs ml64 on
// PATH, and a task's terminal has no vcvars environment to give it.
function tasksCanGoPastAssembly() {
  return process.platform !== 'win32' && cc1.cc1CanLink();
}

function makeTask(definition, title, doc) {
  // A tasks.json may name its own target; the settings answer otherwise.
  const arch = definition.arch || null;
  const target = arch && arch !== 'host' ? arch : cc1.effectiveTarget();
  const exe = cc1.findCompiler(doc.uri) || 'cc1';
  const base = cc1.commonArgs(doc.uri, arch || undefined);
  const stem = path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath));
  const dir = path.dirname(doc.uri.fsPath);

  if (!tasksCanGoPastAssembly() && definition.mode !== 'assembly') return undefined;

  let execution;
  if (definition.mode === 'assembly') {
    const args = [doc.uri.fsPath].concat(base, ['-S', '-o', path.join(dir, stem + cc1.suffixFor(target))]);
    execution = new vscode.ShellExecution(exe, args, { cwd: cwdFor(doc) });
  } else if (definition.mode === 'object') {
    const args = [doc.uri.fsPath].concat(base, ['-c', '-o', path.join(dir, stem + '.o')]);
    execution = new vscode.ShellExecution(exe, args, { cwd: cwdFor(doc) });
  } else {
    const program = path.join(dir, stem);
    const args = [doc.uri.fsPath].concat(base, ['-o', program]);
    if (definition.mode === 'run') {
      // Build and then actually run - the task called "build and run" used
      // to produce the same command as "executable" and never ran anything.
      // This branch is POSIX-only (see tasksCanGoPastAssembly above), so the
      // quoting can be too.
      const line = [exe].concat(args).map(shellWord).join(' ') + ' && ' + shellWord(program);
      execution = new vscode.ShellExecution(line, { cwd: cwdFor(doc) });
    } else {
      execution = new vscode.ShellExecution(exe, args, { cwd: cwdFor(doc) });
    }
  }

  const task = new vscode.Task(
    definition,
    vscode.TaskScope.Workspace,
    'cc1: ' + title,
    'cc1',
    execution,
    ['$cc1', '$cc1-include']
  );
  task.group =
    definition.mode === 'run' ? vscode.TaskGroup.Test : vscode.TaskGroup.Build;
  return task;
}

// ------------------------------------------------------------------ lifecycle

function activate(context) {
  // CC1Studio/cc/ - the per-machine toolchain slot.
  //
  // This is the *last* way the compiler gets found, not the first. An
  // installed .vsix is unpacked into VS Code's own extensions directory, far
  // from this project, so neither the guess below nor slot.txt can reach the
  // slot from there - which is why install.sh writes the `cc1.path` setting,
  // and why that is what actually resolves cc1 on a real installation.
  //
  // The slot still matters when the extension is loaded straight from the
  // source tree, as the tests do through --extensionDevelopmentPath, and it is
  // what the build-cc1 scripts under arch/ update. See cc/README.md for what
  // lives there and why no binary does.
  let slot = path.join(context.extensionPath, '..', 'cc');
  try {
    const named = fs.readFileSync(path.join(context.extensionPath, 'slot.txt'), 'utf8').trim();
    if (named) slot = named;
  } catch (e) { /* not installed through the script; the guess above stands */ }
  cc1.setSlot(slot);

  output = vscode.window.createOutputChannel('cc1');
  diagnostics = vscode.languages.createDiagnosticCollection('cc1');
  assembly = new AssemblyProvider(output);
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'cc1.selectArch';

  context.subscriptions.push(
    output,
    diagnostics,
    status,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, assembly),
    vscode.tasks.registerTaskProvider('cc1', taskProvider),
    vscode.commands.registerCommand('cc1.checkNow', () => {
      const doc = subjectC();
      if (doc) check(doc);
    }),
    vscode.commands.registerCommand('cc1.showAssembly', commandShowAssembly),
    vscode.commands.registerCommand('cc1.buildObject', commandBuildObject),
    vscode.commands.registerCommand('cc1.buildExecutable', commandBuildExecutable),
    vscode.commands.registerCommand('cc1.run', commandRun),
    vscode.commands.registerCommand('cc1.selectArch', commandSelectArch),
    vscode.commands.registerCommand('cc1.selectMasm', commandSelectMasm),
    vscode.commands.registerCommand('cc1.showTiming', commandShowTiming),
    vscode.commands.registerCommand('cc1.locateCompiler', commandLocateCompiler),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!isC(doc)) return;
      if (cc1.config().get('diagnostics', 'save') !== 'off') check(doc);
      if (cc1.config().get('assemblyRefresh', true)) assembly.refreshFor(doc.uri.fsPath);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (isC(doc)) diagnostics.delete(doc.uri);
      // A closed assembly pane must also stop being refreshed, or the map of
      // open panes only ever grows and every save re-renders ghosts.
      if (doc.uri.scheme === SCHEME) assembly.forget(doc.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('cc1')) return;
      cc1.forgetCompiler();
      windows.forgetVcvars();
      updateStatus();
      assembly.refreshAll();
      const doc = activeC();
      if (doc && cc1.config().get('diagnostics', 'save') !== 'off') check(doc);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => updateStatus())
  );

  updateStatus();
  const doc = activeC();
  if (doc && cc1.config().get('diagnostics', 'save') !== 'off') check(doc);

  // Exposed for the integration test, which drives the same code the editor
  // does rather than a copy of it.
  return { check, parse: diag.parse, cc1, windows, assembly, diagnostics, makeTask };
}

function deactivate() {}

module.exports = { activate, deactivate };
