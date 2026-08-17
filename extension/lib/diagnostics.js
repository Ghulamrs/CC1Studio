'use strict';

// Turning what cc1 says into what the Problems panel shows.
//
// cc1 reports in three lines - the position and the message on the first, the
// offending source line echoed on the second, a caret under the column on the
// third:
//
//     inc/broken.h:1:11: error: expected an expression
//         int bad = ;
//                   ^
//
// Only the first line carries anything a diagnostic needs. The other two are
// consumed so they cannot be mistaken for messages of their own.
//
// The preprocessor reports in a second shape, and this was found by testing
// rather than by reading - a missing include says:
//
//     uses-bad-header.c:1: #include "broken.h"
//                           ^ cannot find "broken.h" - looked in ./broken.h, ...
//
// There is no severity word, no column, and the message has moved onto the
// caret line. The column is still recoverable: the caret is aligned against
// the echo, so subtracting the width of the "file:line: " prefix from the
// caret's own offset gives the column in the source. That subtraction is why
// the repository's old tasks.json gave up on columns for this format - a
// problem matcher is a regex and cannot do arithmetic, but this can.
//
// The two shapes are told apart by the caret line: a bare "^" ends a
// positioned diagnostic, a "^ text" carries the message of a preprocessor one.
//
// Two things about cc1 shape the code below.
//
// It stops at the first error, so there is at most one diagnostic per file per
// run. Clearing the whole collection before each check is therefore right, and
// a file that had an error and now has none must be cleared rather than left.
//
// And it reports the path as it was reached, which for a header found through
// -I is relative to the directory cc1 ran in. Resolving against that same
// directory is what puts the squiggle in the header rather than nowhere.

const path = require('path');
const vscode = require('vscode');

const WITH_COLUMN = /^(.*?):(\d+):(\d+):\s+(error|warning|note):\s+(.*)$/;
const WITHOUT_COLUMN = /^(.*?):(\d+):\s+(error|warning|note):\s+(.*)$/;
const CARET = /^\s*\^/;

// The preprocessor's shape: a position and the echoed source on one line, the
// caret and the message on the next.
const ECHO = /^(.*?):(\d+):\s(.*)$/;
const CARET_WITH_MESSAGE = /^(\s*)\^\s+(\S.*)$/;

function positionOf(line) {
  return WITH_COLUMN.exec(line) || WITHOUT_COLUMN.exec(line);
}

// Pure, so it can be tested without an editor. Returns the positioned
// diagnostics and, separately, whatever cc1 said that had no position at all -
// the driver's own refusals, which are about the command line rather than the
// code and belong in a notification, not the gutter.
function parse(text) {
  const entries = [];
  const notices = [];
  const lines = String(text || '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;

    // The preprocessor's two-line shape, recognised by what follows rather
    // than by the line itself, since "file:line: text" is too weak a pattern
    // to claim on its own.
    const echo = ECHO.exec(line);
    const next = i + 1 < lines.length ? CARET_WITH_MESSAGE.exec(lines[i + 1]) : null;
    if (echo && next && !positionOf(line)) {
      const prefixWidth = line.length - echo[3].length;
      entries.push({
        file: echo[1],
        line: parseInt(echo[2], 10),
        column: Math.max(1, next[1].length - prefixWidth + 1),
        severity: 'error',
        message: next[2],
      });
      i += 1;
      continue;
    }

    const m = positionOf(line);
    if (m) {
      const hasColumn = m.length === 6;
      entries.push({
        file: m[1],
        line: parseInt(m[2], 10),
        column: hasColumn ? parseInt(m[3], 10) : 1,
        severity: hasColumn ? m[4] : m[3],
        message: hasColumn ? m[5] : m[4],
      });
      // Swallow the echoed source line and its caret, however many lines cc1
      // chose to spend on them, but never run past another diagnostic.
      let j = i + 1;
      while (j < lines.length && !positionOf(lines[j])) {
        const consumed = lines[j];
        j += 1;
        if (CARET.test(consumed)) break;
      }
      i = j - 1;
      continue;
    }
    notices.push(line.trim());
  }
  return { entries, notices };
}

function severityOf(word) {
  if (word === 'warning') return vscode.DiagnosticSeverity.Warning;
  if (word === 'note') return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Error;
}

// cc1 gives a point; a squiggle under a single character is hard to see and
// harder to click. Widen it to the token that starts there when the file can
// be read, and leave it at one character when it cannot.
async function rangeFor(uri, lineNumber, column) {
  const line = Math.max(0, lineNumber - 1);
  const col = Math.max(0, column - 1);
  const fallback = new vscode.Range(line, col, line, col + 1);
  let doc;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (e) {
    return fallback;
  }
  if (line >= doc.lineCount) return fallback;
  const text = doc.lineAt(line).text;
  if (col >= text.length) {
    return new vscode.Range(line, Math.max(0, text.length - 1), line, text.length);
  }
  const word = doc.getWordRangeAtPosition(new vscode.Position(line, col));
  if (word) return word;
  return fallback;
}

// Group by file first, because a DiagnosticCollection is set per URI and
// setting the same URI twice replaces rather than adds.
async function toDiagnostics(entries, cwd) {
  const byFile = new Map();
  for (const e of entries) {
    const resolved = path.isAbsolute(e.file) ? e.file : path.resolve(cwd, e.file);
    const uri = vscode.Uri.file(resolved);
    const range = await rangeFor(uri, e.line, e.column);
    const d = new vscode.Diagnostic(range, e.message, severityOf(e.severity));
    d.source = 'cc1';
    const key = uri.toString();
    if (!byFile.has(key)) byFile.set(key, { uri, list: [] });
    byFile.get(key).list.push(d);
  }
  return Array.from(byFile.values());
}

module.exports = { parse, toDiagnostics, rangeFor, severityOf };
