import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseDocument, subComponentPrefixLength } from '../parser';

/** Build a well-formed CMTrace record. */
function record(message: string, type: number | string = 1): string {
    return `<![LOG[${message}]LOG]!><time="10:00:00.000" date="1-2-2026" ` +
        `component="Comp" context="" type="${type}" thread="7" file="main.cpp:1">`;
}

test('parses every metadata field of a well-formed record', () => {
    const entries = parseDocument(record('hello', 3));
    assert.equal(entries.length, 1);

    const entry = entries[0];
    assert.ok(entry);
    assert.equal(entry.message, 'hello');
    assert.equal(entry.time, '10:00:00.000');
    assert.equal(entry.date, '1-2-2026');
    assert.equal(entry.component, 'Comp');
    assert.equal(entry.thread, '7');
    assert.equal(entry.file, 'main.cpp:1');
    assert.equal(entry.type, 3);
    assert.equal(entry.malformed, false);
});

test('offset and length bound each record exactly', () => {
    // Decorations are derived from these two numbers, so if the slice they
    // describe is not exactly the record, the wrong lines get highlighted.
    const text = `noise\n${record('one', 2)}\nnoise\n${record('two', 3)}\n`;
    const entries = parseDocument(text);
    assert.equal(entries.length, 2);

    for (const entry of entries) {
        const slice = text.slice(entry.offset, entry.offset + entry.length);
        assert.ok(slice.startsWith('<![LOG['), `slice began with: ${slice.slice(0, 20)}`);
        assert.ok(slice.endsWith('>'), `slice ended with: ${slice.slice(-20)}`);
        assert.ok(slice.includes(entry.message));
    }
});

test('preserves a multi-line message and spans every line it covers', () => {
    // PowerShell error records in IME logs routinely span lines; the decoration
    // has to cover all of them, not just the first.
    const message = 'Exception calling X\r\n  at line 1\r\n  at line 2';
    const text = record(message, 3);
    const entries = parseDocument(text);

    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.ok(entry);
    assert.equal(entry.message, message);

    const slice = text.slice(entry.offset, entry.offset + entry.length);
    assert.equal(slice.split('\n').length, 3, 'decorated span should cover 3 lines');
});

test('regression: a truncated record is not merged with the one after it', () => {
    // Log rotation leaves half-written records behind. Previously the lazy
    // message body paired record one's opening marker with record two's
    // metadata, producing a single entry that carried record TWO's type and a
    // range covering both.
    const text =
        '<![LOG[entry ONE is lost]LOG]!><time="10:00:00.000" date="1-2-2026" compon\r\n' +
        record('entry TWO', 3);

    const entries = parseDocument(text);
    assert.equal(entries.length, 2, 'both records should be accounted for');

    const [first, second] = entries;
    assert.ok(first && second);

    // The truncated record is surfaced, but flagged rather than mistyped.
    assert.equal(first.message, 'entry ONE is lost');
    assert.equal(first.malformed, true);
    assert.equal(first.type, undefined);

    // The intact record keeps its own type and its own range.
    assert.equal(second.message, 'entry TWO');
    assert.equal(second.malformed, false);
    assert.equal(second.type, 3);
    assert.ok(!second.message.includes('entry ONE'));
    assert.ok(second.offset >= first.offset + first.length);
});

test('regression: attributes are matched by name, not by position', () => {
    // The old pattern hardcoded time -> date -> component -> type -> thread.
    // Any producer emitting another order had its records silently dropped,
    // which for an error record means the user concludes there are no errors.
    const text = '<![LOG[ordered differently]LOG]!>' +
        '<date="1-2-2026" type="3" thread="7" time="10:00:00.000" component="Comp" context="">';

    const entries = parseDocument(text);
    assert.equal(entries.length, 1, 'reordered attributes must still parse');

    const entry = entries[0];
    assert.ok(entry);
    assert.equal(entry.type, 3);
    assert.equal(entry.date, '1-2-2026');
    assert.equal(entry.time, '10:00:00.000');
    assert.equal(entry.malformed, false);
});

test('regression: a multi-digit type is preserved rather than dropping the record', () => {
    // The old pattern matched a single digit, so type="10" failed to match at
    // all and the record vanished entirely.
    const entries = parseDocument(record('two digits', 10));
    assert.equal(entries.length, 1);

    const entry = entries[0];
    assert.ok(entry);
    assert.equal(entry.type, 10);
    assert.equal(entry.malformed, false);
});

test('an unknown type is reported verbatim, not coerced to Info', () => {
    const entry = parseDocument(record('verbose', 4))[0];
    assert.ok(entry);
    assert.equal(entry.type, 4);
});

test('a message containing a literal terminator is not cut short', () => {
    const entry = parseDocument(record('echoing: inner]LOG]!> done', 3))[0];
    assert.ok(entry);
    assert.equal(entry.message, 'echoing: inner]LOG]!> done');
    assert.equal(entry.type, 3);
});

test('is idempotent across repeated calls', () => {
    // The previous implementation held a module-level /g regex. matchAll
    // happens to clone it, but a refactor to exec() in a loop would
    // reintroduce the classic every-other-call bug and nothing else would
    // catch it.
    const text = `${record('a', 1)}\n${record('b', 2)}`;
    assert.deepEqual(parseDocument(text), parseDocument(text));
    assert.equal(parseDocument(text).length, 2);
});

test('parses CRLF and LF files identically apart from offsets', () => {
    const records = [record('a', 1), record('b', 3)];
    const crlf = parseDocument(records.join('\r\n'));
    const lf = parseDocument(records.join('\n'));

    assert.deepEqual(crlf.map(e => e.message), lf.map(e => e.message));
    assert.deepEqual(crlf.map(e => e.type), lf.map(e => e.type));
    // Offsets must differ, since CRLF adds a byte before the second record.
    assert.equal(crlf[1]!.offset, lf[1]!.offset + 1);
});

test('handles an empty message body', () => {
    const entry = parseDocument(record('', 2))[0];
    assert.ok(entry);
    assert.equal(entry.message, '');
    assert.equal(entry.type, 2);
    assert.equal(entry.malformed, false);
});

test('returns nothing for text with no records', () => {
    assert.deepEqual(parseDocument(''), []);
    assert.deepEqual(parseDocument('just a plain log line\nand another'), []);
});

test('rejects a metadata block with no type attribute', () => {
    const entries = parseDocument('<![LOG[no type here]LOG]!><time="10:00:00.000" date="1-2-2026">');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.malformed, true);
});

test('ignores an unterminated trailing record', () => {
    const text = `${record('good', 1)}\n<![LOG[never closed`;
    const entries = parseDocument(text);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.message, 'good');
});

test('measures a leading sub-component tag chain', () => {
    assert.equal(subComponentPrefixLength('[Win32App] Starting'), '[Win32App]'.length);
    assert.equal(
        subComponentPrefixLength('[Win32App][WinGetApp][AppPackageManager] Done'),
        '[Win32App][WinGetApp][AppPackageManager]'.length
    );
    // Intune sometimes separates tags with a space.
    assert.equal(
        subComponentPrefixLength('[Win32AppPlugin] [AgentExecutorController`1] Run'),
        '[Win32AppPlugin] [AgentExecutorController`1]'.length
    );
});

test('ignores brackets that are not a leading tag', () => {
    assert.equal(subComponentPrefixLength('Starting [Win32App]'), 0);
    assert.equal(subComponentPrefixLength(' [Win32App] leading space'), 0);
    assert.equal(subComponentPrefixLength('[] empty'), 0);
    assert.equal(subComponentPrefixLength('[unterminated\r\n] tag'), 0);
    assert.equal(subComponentPrefixLength(''), 0);
});
