'use strict';

// Finishing the job on Windows, where cc1 cannot.
//
// On a Windows host cc1 stops at -S, and not as a matter of taste. Its driver
// builds the assemble and link command lines for a POSIX shell and puts its
// temporaries in /tmp, so asking a Windows cc1 for an object or a program
// fails on the path before it fails on anything else:
//
//     cc1.exe: cannot write /tmp/cc1-4400-0.s
//
// So the extension does that half itself, with the tools the platform ships:
// ml64 assembles the MASM cc1 writes, and link produces the executable. This
// is the same sequence help/command-lines.md sets out by hand, and the same
// one tests/masm-native.sh runs over the corpus.
//
// Both tools need vcvars64.bat to have run first - that is what puts them on
// PATH and sets LIB - and a batch file is the only honest way to carry an
// environment from one command into the next.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const cc1 = require('./cc1');

// link.exe driven directly is told nothing, where a compiler driver would have
// embedded -defaultlib directives in the object. libcmt brings in
// mainCRTStartup; legacy_stdio_definitions is not optional for anything that
// formats into a buffer, because the UCRT made sprintf and the whole v- and
// scanf families inline wrappers over __stdio_common_* in its own <stdio.h>,
// and a compiler that declares them as the ordinary functions C says they are -
// which cc1 does, correctly - has nothing to link against without it.
const LIBRARIES = [
  'libcmt.lib',
  'libucrt.lib',
  'libvcruntime.lib',
  'kernel32.lib',
  'legacy_stdio_definitions.lib',
];

let cachedVcvars;

function forgetVcvars() {
  cachedVcvars = undefined;
  cachedEnv = undefined;
}

// The environment ml64 and link live in, taken once and kept.
//
// A cc1 new enough to assemble and link for itself still calls those two by
// bare name, so vcvars64.bat must have run - the same requirement that made
// this file necessary when the extension did that work itself. Deferring the
// work to cc1 does not retire the problem; it moves it to one place.
//
// The environment is captured rather than the command wrapped. A batch file
// around every cc1 call would work and would cost the things that make the
// call worth making: the exit code, the cancellation, and cc1's diagnostics
// arriving on the stream the parser reads.
let cachedEnv;

async function toolchainEnv() {
  if (cachedEnv !== undefined) return cachedEnv;
  const vcvars = await findVcvars();
  if (!vcvars) {
    cachedEnv = null;
    return cachedEnv;
  }
  const file = path.join(os.tmpdir(),
                         'cc1-studio-env-' + process.pid + '.bat');
  const body = [
    '@echo off',
    'chcp 65001 >nul',
    'call ' + quote(vcvars) + ' >nul',
    'if errorlevel 1 exit /b 1',
    'set',
    '',
  ].join('\r\n');
  let out;
  try {
    fs.writeFileSync(file, body, 'utf8');
    out = await cc1.run('cmd.exe', ['/c', file], undefined);
  } catch (e) {
    cachedEnv = null;
    return cachedEnv;
  } finally {
    try { fs.unlinkSync(file); } catch (e) { /* nothing to remove */ }
  }
  if (!out || out.code !== 0) {
    cachedEnv = null;
    return cachedEnv;
  }
  const env = {};
  for (const line of String(out.stdout).split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  // A `set` that produced no PATH did not run vcvars, whatever it exited with.
  cachedEnv = (env.PATH || env.Path) ? env : null;
  return cachedEnv;
}

async function findVcvars() {
  const configured = cc1.expand(cc1.config().get('vcvars', ''), undefined);
  if (configured) return fs.existsSync(configured) ? configured : null;
  if (cachedVcvars !== undefined) return cachedVcvars;

  const candidates = [];
  const x86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = path.join(x86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (fs.existsSync(vswhere)) {
    const r = await cc1.run(vswhere, ['-latest', '-property', 'installationPath'], undefined);
    const root = String(r.stdout || '').trim().split(/\r?\n/)[0];
    if (root) candidates.push(path.join(root, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'));
  }
  // vswhere is the supported answer, but it is not always installed, so the
  // usual locations are tried too rather than giving up on it.
  for (const base of [process.env.ProgramFiles || 'C:\\Program Files', x86]) {
    for (const version of ['18', '2022', '2019']) {
      for (const edition of ['Enterprise', 'Professional', 'Community', 'BuildTools']) {
        candidates.push(path.join(base, 'Microsoft Visual Studio', version, edition,
          'VC', 'Auxiliary', 'Build', 'vcvars64.bat'));
      }
    }
  }
  cachedVcvars = candidates.find((c) => fs.existsSync(c)) || null;
  return cachedVcvars;
}

function quote(s) {
  return '"' + s + '"';
}

// A batch file rather than a command line. vcvars64.bat sets the environment
// the next two commands need, and nothing carries an environment across a
// spawn - so the three steps have to share one cmd.exe, and writing them down
// is more legible than escaping them into a single /c argument.
function script(vcvars, steps) {
  return [
    '@echo off',
    // The file is written as UTF-8, and cmd parses a batch in the console
    // codepage - so the codepage is switched first, before any line holding a
    // path is read. Without this, a path with a character outside ASCII (a
    // user profile named in Urdu, say) is misread and the tools are handed a
    // file that does not exist.
    'chcp 65001 >nul',
    'call ' + quote(vcvars) + ' >nul',
    'if errorlevel 1 (echo cc1-studio: vcvars64.bat failed & exit /b 1)',
  ].concat(steps).join('\r\n') + '\r\n';
}

async function runScript(body, cwd, output) {
  const file = cc1.scratchFile('.bat');
  // utf8, not ascii: node's 'ascii' masks every byte to seven bits, which
  // silently corrupts any non-ASCII path instead of failing.
  fs.writeFileSync(file, body, 'utf8');
  output.appendLine('--- ml64/link batch ---');
  output.appendLine(body.trim());
  const result = await cc1.run('cmd.exe', ['/c', file], cwd);
  cc1.discard(file);
  return result;
}

// cc1 -S has already run and written `asm`. Assemble it.
async function assemble(asmPath, objPath, cwd, output) {
  const vcvars = await findVcvars();
  if (!vcvars) return { code: -1, stdout: '', stderr: noVcvars() };
  return runScript(script(vcvars, [
    'ml64.exe /nologo /c /Fo ' + quote(objPath) + ' ' + quote(asmPath),
    'if errorlevel 1 exit /b 1',
  ]), cwd, output);
}

// Assemble every object and link them into a program.
async function assembleAndLink(units, exePath, cwd, output) {
  const vcvars = await findVcvars();
  if (!vcvars) return { code: -1, stdout: '', stderr: noVcvars() };
  const steps = [];
  for (const u of units) {
    steps.push('ml64.exe /nologo /c /Fo ' + quote(u.obj) + ' ' + quote(u.asm));
    steps.push('if errorlevel 1 exit /b 1');
  }
  steps.push(
    'link.exe /nologo /subsystem:console /out:' + quote(exePath) + ' ' +
    units.map((u) => quote(u.obj)).join(' ') + ' ' + LIBRARIES.join(' ')
  );
  steps.push('if errorlevel 1 exit /b 1');
  return runScript(script(vcvars, steps), cwd, output);
}

function noVcvars() {
  return 'cc1-studio: vcvars64.bat was not found, so ml64 and link cannot be reached.\n' +
    'Set cc1.vcvars to its path, or install the Visual Studio C++ build tools.';
}

module.exports = {
  assemble,
  assembleAndLink,
  findVcvars,
  forgetVcvars,
  toolchainEnv,
  noVcvars,
  LIBRARIES,
};
