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
let pending; // debounce handle for the as-you-type check

function isC(doc) {
  return doc && doc.languageId === 'c' && doc.uri.scheme === 'file';
}

function activeC() {
  const ed = vscode.window.activeTextEditor;
  if (ed && isC(ed.document)) return ed.document;
  return null;
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
    await cc1.config().update('arch', 'host', vscode.ConfigurationTarget.Workspace);
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

// A check compiles to a scratch file and throws the assembly away; the only
// thing wanted is what cc1 said on the way. Because cc1 stops at the first
// error, this clears every file it previously reported on before setting the
// new result - otherwise a fixed error in a header would stay on screen.
async function check(doc) {
  if (!isC(doc)) return;
  const exe = cc1.findCompiler(doc.uri);
  if (!exe) return;

  const out = cc1.scratchFile(cc1.assemblySuffix());
  const args = [doc.uri.fsPath].concat(cc1.commonArgs(doc.uri), ['-S', '-o', out]);
  const cwd = cwdFor(doc);
  const result = await cc1.run(exe, args, cwd);
  cc1.discard(out);

  const said = result.stderr + result.stdout;
  const { entries, notices } = diag.parse(said);

  diagnostics.clear();
  for (const group of await diag.toDiagnostics(entries, cwd)) {
    diagnostics.set(group.uri, group.list);
  }

  // Anything cc1 said that carried no position is about the command line, not
  // the code. It has no gutter to live in, so it goes to the output channel.
  if (result.code !== 0 && entries.length === 0 && notices.length) {
    output.appendLine('$ ' + exe + ' ' + args.join(' '));
    for (const n of notices) output.appendLine(n);
  }
}

function scheduleCheck(doc) {
  const when = cc1.config().get('diagnostics', 'save');
  if (when !== 'type') return;
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    // The file on disk is what cc1 reads, so an unsaved buffer is checked
    // against its last saved state. Saying so beats silently checking stale
    // text; the honest fix is to save, which 'save' mode already waits for.
    check(doc);
    if (cc1.config().get('assemblyRefresh', true)) assembly.refreshFor(doc.uri.fsPath);
  }, cc1.config().get('diagnosticsDelay', 400));
}

// -------------------------------------------------------------------- builds

// Every translation unit of the program, for the commands that link. Left
// unset, a program is just the file in front of you.
async function sourcesFor(doc) {
  const globs = cc1.config().get('sources', []);
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

function programPath(doc) {
  const dir = path.dirname(doc.uri.fsPath);
  const base = path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath));
  return path.join(dir, base + (process.platform === 'win32' ? '.exe' : ''));
}

// Run cc1 for a command the user asked for, reporting through the same
// Problems panel a check uses so a failed build reads the same as a failed
// check. Returns true when cc1 succeeded.
async function build(doc, extraArgs, description) {
  const exe = compilerFor(doc);
  if (!exe) return false;
  const cwd = cwdFor(doc);
  const args = extraArgs.slice();
  output.appendLine('$ ' + exe + ' ' + args.join(' '));

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'cc1: ' + description },
    () => cc1.run(exe, args, cwd)
  );

  const said = result.stderr + result.stdout;
  if (said.trim()) output.appendLine(said.trimEnd());

  const { entries, notices } = diag.parse(said);
  diagnostics.clear();
  for (const group of await diag.toDiagnostics(entries, cwd)) {
    diagnostics.set(group.uri, group.list);
  }

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
  const doc = activeC();
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

async function commandBuildObject() {
  const doc = activeC();
  if (!doc) return;
  if (!(await requireNative())) return;
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

  const obj = path.join(dir, stem + '.o');
  const args = [doc.uri.fsPath].concat(cc1.commonArgs(doc.uri), ['-c', '-o', obj]);
  if (await build(doc, args, 'compiling to an object')) {
    vscode.window.showInformationMessage('cc1 wrote ' + path.basename(obj));
  }
}

async function commandBuildExecutable() {
  const doc = activeC();
  if (!doc) return null;
  if (!(await requireNative())) return null;
  if (doc.isDirty) await doc.save();
  const program = programPath(doc);
  const sources = await sourcesFor(doc);

  if (!cc1.cc1CanLink()) {
    // Windows: one cc1 -S per translation unit, then ml64 over each and link
    // over all of them - the sequence help/command-lines.md sets out by hand.
    const dir = path.dirname(doc.uri.fsPath);
    const units = [];
    for (const source of sources) {
      const stem = path.basename(source, path.extname(source));
      const asm = path.join(dir, stem + '.asm');
      const args = [source].concat(cc1.commonArgs(doc.uri), ['-S', '-o', asm]);
      if (!(await build(doc, args, 'compiling ' + path.basename(source)))) return null;
      units.push({ asm, obj: path.join(dir, stem + '.obj') });
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'cc1: ml64 and link' },
      () => windows.assembleAndLink(units, program, dir, output)
    );
    if (!(await reportToolchain(result, 'ml64/link'))) return null;
    return program;
  }

  const args = sources.concat(cc1.commonArgs(doc.uri), ['-o', program]);
  if (await build(doc, args, 'building ' + path.basename(program))) return program;
  return null;
}

// The program is run in a terminal rather than captured, so that a program
// which reads stdin behaves like one.
async function commandRun() {
  const program = await commandBuildExecutable();
  if (!program) return;
  const term =
    vscode.window.terminals.find((t) => t.name === 'cc1') ||
    vscode.window.createTerminal({ name: 'cc1', cwd: path.dirname(program) });
  term.show(true);
  const quoted = '"' + program + '"';
  term.sendText(process.platform === 'win32' ? '& ' + quoted : quoted);
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
  await cc1.config().update('arch', pick.label, vscode.ConfigurationTarget.Workspace);
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
  await cc1.config().update('masm', pick.label, vscode.ConfigurationTarget.Workspace);
}

async function commandShowTiming() {
  const doc = activeC();
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
  await cc1.config().update('path', picked[0].fsPath, vscode.ConfigurationTarget.Workspace);
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
  const doc = activeC();
  const exe = cc1.findCompiler(doc ? doc.uri : undefined);
  let provenance = '_cc1 not found - set `cc1.path`._';
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
// keystroke works in any directory holding a cc1 and a .c file.
const taskProvider = {
  provideTasks() {
    const doc = activeC();
    if (!doc) return [];
    // A task is a single cc1 command line, so on Windows only the assembly one
    // is truthful - the others need ml64 and link after it, which is two more
    // programs and an environment to carry between them. Those live behind the
    // commands instead, where a task cannot misrepresent them as one step.
    const modes = cc1.cc1CanLink()
      ? [['assembly', 'assembly'], ['object', 'object'],
         ['executable', 'executable'], ['run', 'build and run']]
      : [['assembly', 'assembly']];
    return modes.map(([mode, title]) => makeTask({ type: 'cc1', mode }, title, doc));
  },
  resolveTask(task) {
    const doc = activeC();
    if (!doc) return undefined;
    return makeTask(task.definition, task.definition.mode, doc);
  },
};

function makeTask(definition, title, doc) {
  const exe = cc1.findCompiler(doc.uri) || 'cc1';
  const base = cc1.commonArgs(doc.uri);
  const stem = path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath));
  const dir = path.dirname(doc.uri.fsPath);
  let args;
  if (definition.mode === 'assembly') {
    args = [doc.uri.fsPath].concat(base, ['-S', '-o', path.join(dir, stem + cc1.assemblySuffix())]);
  } else if (definition.mode === 'object') {
    args = [doc.uri.fsPath].concat(base, ['-c', '-o', path.join(dir, stem + '.o')]);
  } else {
    args = [doc.uri.fsPath].concat(base, ['-o', path.join(dir, stem)]);
  }
  const task = new vscode.Task(
    definition,
    vscode.TaskScope.Workspace,
    'cc1: ' + title,
    'cc1',
    new vscode.ShellExecution(exe, args, { cwd: cwdFor(doc) }),
    '$cc1'
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
      const doc = activeC();
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
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isC(e.document)) scheduleCheck(e.document);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (isC(doc)) diagnostics.delete(doc.uri);
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
  return { check, parse: diag.parse, cc1, windows, assembly, diagnostics };
}

function deactivate() {
  if (pending) clearTimeout(pending);
}

module.exports = { activate, deactivate };
