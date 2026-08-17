'use strict';

// The integration test. VS Code loads this inside its own extension host, so
// `vscode` here is the real API and cc1 below is the real compiler - the test
// drives the extension the way the editor does rather than a copy of it.
//
// Run it with test/run.sh. A non-zero exit means a check failed, and every
// check prints its own line either way.
//
// Written without a test framework on purpose: there is no npm on the machines
// this has to run on, and a runner that needs installing is a runner that will
// not be run on the box with 419 MB of memory.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const fixtures = path.join(__dirname, 'fixtures');
let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    failed += 1;
    console.log('  FAIL ' + name);
    console.log('       ' + (e && e.message ? e.message : String(e)));
    if (e && e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
  }
}

function settle(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function open(file) {
  const doc = await vscode.workspace.openTextDocument(path.join(fixtures, file));
  await vscode.window.showTextDocument(doc);
  return doc;
}

function diagnosticsFor(file) {
  return vscode.languages.getDiagnostics(vscode.Uri.file(path.join(fixtures, file)));
}

async function run() {
  console.log('\ncc1 studio - integration tests\n');

  const ext = vscode.extensions.getExtension('compiler-c.cc1-studio');
  assert.ok(ext, 'the extension was not found by its identifier');
  const api = await ext.activate();
  assert.ok(api && api.check, 'activate() returned no test surface');

  const cc1Path = process.env.CC1_UNDER_TEST;
  assert.ok(cc1Path && fs.existsSync(cc1Path), 'CC1_UNDER_TEST must name a real cc1');

  const config = vscode.workspace.getConfiguration('cc1');
  await config.update('path', cc1Path, vscode.ConfigurationTarget.Workspace);
  await config.update('arch', 'host', vscode.ConfigurationTarget.Workspace);
  await config.update('diagnostics', 'save', vscode.ConfigurationTarget.Workspace);
  api.cc1.forgetCompiler();

  // ---- the parser, which is pure and needs no compiler ---------------------

  await check('parses a positioned error, and swallows the echo and caret', () => {
    const { entries, notices } = api.parse(
      'bad.c:3:13: error: expected an expression\n' +
      '        int x = ;\n' +
      '                ^\n'
    );
    assert.strictEqual(entries.length, 1, 'expected exactly one entry');
    assert.strictEqual(entries[0].file, 'bad.c');
    assert.strictEqual(entries[0].line, 3);
    assert.strictEqual(entries[0].column, 13);
    assert.strictEqual(entries[0].severity, 'error');
    assert.strictEqual(entries[0].message, 'expected an expression');
    assert.deepStrictEqual(notices, [], 'the echoed source became a notice');
  });

  await check('keeps a Windows drive letter out of the line number', () => {
    const { entries } = api.parse('C:\\src\\bad.c:7:2: error: nope\n');
    assert.strictEqual(entries[0].file, 'C:\\src\\bad.c');
    assert.strictEqual(entries[0].line, 7);
    assert.strictEqual(entries[0].column, 2);
  });

  await check('treats a driver refusal as a notice, not a diagnostic', () => {
    const { entries, notices } = api.parse(
      '/path/to/cc1: cannot assemble x86_64-windows code on this machine, ' +
      'which is arm64-darwin - use -S to write the assembly and take it there\n'
    );
    assert.strictEqual(entries.length, 0, 'a command-line refusal became a squiggle');
    assert.strictEqual(notices.length, 1);
  });

  await check('reads two diagnostics without merging them', () => {
    const { entries } = api.parse(
      'a.c:1:1: error: first\n  x\n  ^\n' +
      'b.c:2:2: error: second\n  y\n  ^\n'
    );
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[1].file, 'b.c');
    assert.strictEqual(entries[1].message, 'second');
  });

  // ---- diagnostics, against the real compiler ------------------------------

  await check('a good file leaves the Problems panel empty', async () => {
    const doc = await open('good.c');
    await api.check(doc);
    await settle(150);
    assert.strictEqual(diagnosticsFor('good.c').length, 0);
  });

  await check('a bad file lands on the right line and column', async () => {
    const doc = await open('bad.c');
    await api.check(doc);
    await settle(150);
    const list = diagnosticsFor('bad.c');
    assert.strictEqual(list.length, 1, 'expected one diagnostic, got ' + list.length);
    // Line 3 column 13 of the fixture, which VS Code counts from zero.
    assert.strictEqual(list[0].range.start.line, 2, 'wrong line');
    assert.strictEqual(list[0].range.start.character, 12, 'wrong column');
    assert.strictEqual(list[0].severity, vscode.DiagnosticSeverity.Error);
    assert.strictEqual(list[0].source, 'cc1');
  });

  await check('parses the preprocessor two-line shape and recovers its column', () => {
    const { entries, notices } = api.parse(
      'uses-bad-header.c:1: #include "broken.h"\n' +
      '                      ^ cannot find "broken.h" - looked in ./broken.h\n'
    );
    assert.strictEqual(entries.length, 1, 'the missing include did not become a diagnostic');
    assert.strictEqual(entries[0].file, 'uses-bad-header.c');
    assert.strictEqual(entries[0].line, 1);
    // The prefix is 21 characters wide and the caret sits at offset 22.
    assert.strictEqual(entries[0].column, 2, 'the column was not recovered');
    assert.ok(/cannot find/.test(entries[0].message), 'the message was lost');
    assert.deepStrictEqual(notices, [], 'part of it leaked into the notices');
  });

  await check('an error in a header squiggles the header, not the .c', async () => {
    await config.update('includePaths', [path.join(fixtures, 'include')],
      vscode.ConfigurationTarget.Workspace);
    await settle(100);
    const doc = await open('uses-bad-header.c');
    await api.check(doc);
    await settle(200);
    assert.strictEqual(diagnosticsFor('uses-bad-header.c').length, 0,
      'the .c file was blamed for its header');
    const inHeader = vscode.languages.getDiagnostics(
      vscode.Uri.file(path.join(fixtures, 'include', 'broken.h'))
    );
    assert.strictEqual(inHeader.length, 1, 'the header carried no diagnostic');
    assert.strictEqual(inHeader[0].range.start.line, 0);
    await config.update('includePaths', [], vscode.ConfigurationTarget.Workspace);
    await settle(100);
  });

  await check('a missing include squiggles the #include line itself', async () => {
    const doc = await open('missing-include.c');
    await api.check(doc);
    await settle(200);
    const list = diagnosticsFor('missing-include.c');
    assert.strictEqual(list.length, 1, 'a missing include produced ' + list.length + ' diagnostics');
    assert.strictEqual(list[0].range.start.line, 0, 'it did not land on line 1');
    assert.ok(/cannot find/.test(list[0].message), 'the message was: ' + list[0].message);
  });

  await check('fixing the error clears it again', async () => {
    const doc = await open('bad.c');
    await api.check(doc);
    await settle(150);
    assert.ok(diagnosticsFor('bad.c').length === 1, 'setup: expected the error first');
    const good = await open('good.c');
    await api.check(good);
    await settle(150);
    assert.strictEqual(diagnosticsFor('bad.c').length, 0,
      'a stale diagnostic survived a clean check');
  });

  // ---- the assembly pane ---------------------------------------------------

  await check('the assembly pane holds real assembly for the host', async () => {
    const doc = await open('good.c');
    const uri = api.assembly.uriFor(doc.uri.fsPath);
    const text = await api.assembly.provideTextDocumentContent(uri);
    assert.ok(text.length > 100, 'the pane was suspiciously short');
    assert.ok(/_?main/.test(text), 'no main in the generated assembly');
    assert.ok(/generated by cc1 -S/.test(text), 'the banner is missing');
  });

  await check('a different target generates different assembly', async () => {
    const doc = await open('good.c');
    const host = await api.assembly.provideTextDocumentContent(api.assembly.uriFor(doc.uri.fsPath));
    await config.update('arch', 'x86_64-linux', vscode.ConfigurationTarget.Workspace);
    await settle(100);
    const linux = await api.assembly.provideTextDocumentContent(api.assembly.uriFor(doc.uri.fsPath));
    await config.update('arch', 'host', vscode.ConfigurationTarget.Workspace);
    await settle(100);
    assert.notStrictEqual(host, linux, 'two targets produced identical assembly');
    assert.ok(/\.section|\.text/.test(linux), 'the linux output does not look like GAS');
  });

  await check('a broken file explains itself in the pane instead of going blank', async () => {
    const doc = await open('bad.c');
    const text = await api.assembly.provideTextDocumentContent(api.assembly.uriFor(doc.uri.fsPath));
    assert.ok(/could not compile/.test(text), 'the pane hid the failure');
    assert.ok(/expected an expression/.test(text), 'the pane did not say why');
  });

  // ---- targets -------------------------------------------------------------

  await check('the host target is native and a cross target is not', async () => {
    await config.update('arch', 'host', vscode.ConfigurationTarget.Workspace);
    await settle(80);
    assert.strictEqual(api.cc1.targetIsNative(), true, 'the host was called cross');
    const notHost = api.cc1.TARGETS.filter((t) => t !== api.cc1.hostTarget())[0];
    await config.update('arch', notHost, vscode.ConfigurationTarget.Workspace);
    await settle(80);
    assert.strictEqual(api.cc1.targetIsNative(), false, notHost + ' was called native');
    await config.update('arch', 'host', vscode.ConfigurationTarget.Workspace);
    await settle(80);
  });

  await check('what cc1 can finish is answered per platform, not per target', async () => {
    await config.update('arch', 'host', vscode.ConfigurationTarget.Workspace);
    await settle(80);
    if (process.platform === 'win32') {
      // cc1 on Windows fails before it starts - it writes its temporary
      // assembly to /tmp - so it must never be asked for an object or a
      // program, while ml64 and link still make one reachable.
      assert.strictEqual(api.cc1.cc1CanLink(), false,
        'cc1 was said to link on Windows, where it cannot');
      assert.strictEqual(api.cc1.canReachExecutable(), true,
        'the ml64 and link route was not offered');
    } else {
      assert.strictEqual(api.cc1.cc1CanLink(), true,
        'cc1 was said not to link on a host where it does');
      assert.strictEqual(api.cc1.canReachExecutable(), true);
    }
    // A target this machine is not stops at assembly everywhere.
    const notHost = api.cc1.TARGETS.filter((t) => t !== api.cc1.hostTarget())[0];
    await config.update('arch', notHost, vscode.ConfigurationTarget.Workspace);
    await settle(80);
    assert.strictEqual(api.cc1.cc1CanLink(), false, notHost + ' was said to link here');
    await config.update('arch', 'host', vscode.ConfigurationTarget.Workspace);
    await settle(80);
  });

  await check('settings reach the command line', async () => {
    await config.update('defines', ['LIMIT=7'], vscode.ConfigurationTarget.Workspace);
    await config.update('includePaths', [path.join(fixtures, 'include')], vscode.ConfigurationTarget.Workspace);
    await settle(80);
    const args = api.cc1.commonArgs(vscode.Uri.file(path.join(fixtures, 'good.c')));
    assert.ok(args.includes('-DLIMIT=7'), 'the define was not passed: ' + args.join(' '));
    assert.ok(args.some((a) => a.startsWith('-I')), 'the include path was not passed');

    // and the compiler must actually honour them
    const doc = await open('needs-define.c');
    await api.check(doc);
    await settle(150);
    assert.strictEqual(diagnosticsFor('needs-define.c').length, 0,
      'cc1 did not see -DLIMIT, so the settings are not reaching it');

    await config.update('defines', [], vscode.ConfigurationTarget.Workspace);
    await settle(80);
    await api.check(doc);
    await settle(200);
    assert.strictEqual(diagnosticsFor('needs-define.c').length, 1,
      'removing the define changed nothing, so it was never being used');
    await config.update('includePaths', [], vscode.ConfigurationTarget.Workspace);
  });

  // ---- the whole pipeline --------------------------------------------------

  await check('build and run produces a working program', async () => {
    if (!api.cc1.hostTarget()) {
      console.log('       (skipped: this machine is not one of cc1\'s three targets)');
      return;
    }
    const program = path.join(os.tmpdir(), 'cc1-studio-test-program');
    try { fs.unlinkSync(program); } catch (e) { /* fine */ }
    const result = await api.cc1.run(
      cc1Path,
      [path.join(fixtures, 'good.c'), '-o', program],
      fixtures
    );
    assert.strictEqual(result.code, 0, 'cc1 failed to link: ' + result.stderr);
    assert.ok(fs.existsSync(program), 'no program was written');
    const ran = await api.cc1.run(program, [], fixtures);
    assert.strictEqual(ran.code, 0, 'the program exited ' + ran.code);
    assert.strictEqual(ran.stdout.trim(), 'cc1 studio 42', 'the program printed: ' + ran.stdout);
    fs.unlinkSync(program);
  });

  await check('a cc1 too old to have -S is refused', () => {
    // Modelled on a real one: a cc1 built 2026-08-15 was found in the home
    // directory of the machine this was written on. It writes assembly and
    // nothing else, and it announces itself almost identically to the current
    // compiler - so the check has to be about capability, not about looking
    // the part.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc1-stale-'));
    const fake = path.join(dir, 'cc1');
    fs.writeFileSync(fake,
      '#!/bin/sh\n' +
      'echo "usage: $0 <file.c> [more.c ...] [-o out.s] [-I dir] [-j n] [-arch a] [-time]"\n' +
      'echo "       -arch picks the architecture the code is generated for"\n');
    fs.chmodSync(fake, 0o755);

    assert.strictEqual(api.cc1.isUsable(fake), false,
      'a cc1 with no -S was accepted');
    assert.strictEqual(api.cc1.isUsable(cc1Path), true,
      'the real cc1 was rejected');

    fs.unlinkSync(fake);
    fs.rmdirSync(dir);
  });

  await check('the toolchain slot finds cc1 with nothing configured', async () => {
    // The path setting is what every other check leans on; this is the one
    // that proves an untouched install works, which is how it will actually be
    // used. The fixture directory has no cc1 above it, so a hit here can only
    // have come from cc/cc1.path.
    await config.update('path', '', vscode.ConfigurationTarget.Workspace);
    api.cc1.forgetCompiler();
    await settle(80);
    const found = api.cc1.findCompiler(vscode.Uri.file(path.join(fixtures, 'good.c')));
    assert.ok(found, 'no cc1 was found without cc1.path set - the slot is not being read');
    assert.strictEqual(api.cc1.realPathOf(found), api.cc1.realPathOf(cc1Path),
      'the slot pointed at a different cc1: ' + found);
    await config.update('path', cc1Path, vscode.ConfigurationTarget.Workspace);
    api.cc1.forgetCompiler();
  });

  await check('commands are all registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const name of [
      'cc1.checkNow', 'cc1.showAssembly', 'cc1.buildObject', 'cc1.buildExecutable',
      'cc1.run', 'cc1.selectArch', 'cc1.selectMasm', 'cc1.showTiming', 'cc1.locateCompiler',
    ]) {
      assert.ok(all.includes(name), name + ' was never registered');
    }
  });

  await check('the assembly grammar is loaded and claims the pane', async () => {
    const languages = await vscode.languages.getLanguages();
    assert.ok(languages.includes('cc1-asm'), 'the cc1-asm language is missing');
  });

  console.log('\n  ' + passed + ' passed, ' + failed + ' failed\n');
  if (failed) throw new Error(failed + ' check(s) failed');
}

module.exports = { run };
