// CMTrace log parsing.
//
// This module deliberately imports nothing from `vscode` so it can be unit
// tested in plain Node (see src/test/parser.test.ts). Everything that needs the
// editor API lives in extension.ts.

export const LOG_TYPE_INFO = 1;
export const LOG_TYPE_WARNING = 2;
export const LOG_TYPE_ERROR = 3;

export interface LogEntry {
    message: string;
    time: string;
    date: string;
    component: string;
    context: string;
    thread: string;
    file: string;
    /**
     * Raw CMTrace `type`: 1 = Info, 2 = Warning, 3 = Error. Values outside that
     * range (4 = Verbose, for instance) are preserved verbatim instead of being
     * coerced to Info, so callers decide how to treat them. `undefined` means
     * the attribute was absent or non-numeric.
     */
    type: number | undefined;
    /** Character offset of `<![LOG[` within the source text. */
    offset: number;
    /** Length from `offset` through the closing `>` of the metadata block. */
    length: number;
    /**
     * True when a `<![LOG[...]LOG]!>` body was found but no usable metadata
     * block followed it — typically a record truncated by log rotation. The
     * message is still reported so that nothing disappears silently, but no
     * metadata field on this entry is trustworthy.
     */
    malformed: boolean;
}

/**
 * Intune prefixes many messages with one or more bracketed sub-component tags,
 * e.g. `[Win32App][WinGetApp][AppPackageManager] ...` or
 * `[Win32AppPlugin][AgentExecutorController`1] ...`. Tags never span a line.
 * Keep in sync with the `subcomponent` rule in syntaxes/cmtrace.tmLanguage.json.
 */
const SUBCOMPONENT_PREFIX_RE = /^\[[^\]\r\n]+\](?:[ \t]*\[[^\]\r\n]+\])*/;

/** Length of the leading sub-component tag chain in `message`, or 0 if none. */
export function subComponentPrefixLength(message: string): number {
    return SUBCOMPONENT_PREFIX_RE.exec(message)?.[0].length ?? 0;
}

const START = '<![LOG[';

/** Length of the `<![LOG[` marker that precedes every message body. */
export const MESSAGE_START_LENGTH = START.length;
const END = ']LOG]!>';

const ATTR_RE = /([A-Za-z_][\w.-]*)="([^"]*)"/g;

interface MetadataBlock {
    attrs: Map<string, string>;
    /** Offset just past the closing `>`. */
    end: number;
}

function readAttributes(block: string): Map<string, string> {
    const attrs = new Map<string, string>();
    for (const match of block.matchAll(ATTR_RE)) {
        const name = match[1];
        const value = match[2];
        if (name === undefined || value === undefined) { continue; }
        const key = name.toLowerCase();
        // First occurrence wins, so a duplicated attribute cannot be used to
        // override the one we already trusted.
        if (!attrs.has(key)) { attrs.set(key, value); }
    }
    return attrs;
}

/**
 * Parse the `<time="..." date="..." ...>` block that must begin exactly at
 * `at`. Returns undefined unless a complete single-line block carrying a `type`
 * attribute closes before `limit`.
 *
 * Refusing to cross a newline is what prevents a half-written metadata block
 * from consuming the records that follow it.
 */
function parseMetadata(text: string, at: number, limit: number): MetadataBlock | undefined {
    if (text[at] !== '<') { return undefined; }

    let i = at + 1;
    while (i < limit) {
        const ch = text[i];
        if (ch === '\n' || ch === '\r') { return undefined; }
        if (ch === '>') {
            const attrs = readAttributes(text.slice(at + 1, i));
            // `type` is the attribute the extension actually acts on; a block
            // without it is not a record we can classify.
            return attrs.has('type') ? { attrs, end: i + 1 } : undefined;
        }
        if (ch === '"') {
            // Skip the quoted value wholesale so that a `>` inside it does not
            // terminate the block early.
            const close = text.indexOf('"', i + 1);
            if (close === -1 || close >= limit) { return undefined; }
            if (/[\r\n]/.test(text.slice(i + 1, close))) { return undefined; }
            i = close + 1;
            continue;
        }
        i++;
    }
    return undefined;
}

/**
 * Parse every CMTrace record in `text`, in document order.
 *
 * Scanning is explicit rather than one large regex because two rules need to
 * hold simultaneously, and a single pattern cannot express both:
 *
 *  1. A message body must never extend past the next `<![LOG[` marker, so a
 *     truncated record cannot be merged with its successor.
 *  2. Within that region the nearest `]LOG]!>` that is actually followed by
 *     valid metadata wins, so a message containing a literal `]LOG]!>` is not
 *     cut short.
 */
export function parseDocument(text: string): LogEntry[] {
    const entries: LogEntry[] = [];
    let cursor = 0;

    while (cursor < text.length) {
        const start = text.indexOf(START, cursor);
        if (start === -1) { break; }

        const bodyStart = start + START.length;

        // Rule 1: the next opening marker is a hard boundary for this record.
        const nextStart = text.indexOf(START, bodyStart);
        const limit = nextStart === -1 ? text.length : nextStart;

        // Rule 2: try each terminator in the region, nearest first.
        let firstEnd = -1;
        let matchedEnd = -1;
        let metadata: MetadataBlock | undefined;
        let searchFrom = bodyStart;

        for (;;) {
            const end = text.indexOf(END, searchFrom);
            if (end === -1 || end + END.length > limit) { break; }
            if (firstEnd === -1) { firstEnd = end; }
            const candidate = parseMetadata(text, end + END.length, limit);
            if (candidate) {
                matchedEnd = end;
                metadata = candidate;
                break;
            }
            searchFrom = end + END.length;
        }

        if (metadata !== undefined && matchedEnd !== -1) {
            const attrs = metadata.attrs;
            const rawType = attrs.get('type');
            entries.push({
                message:   text.slice(bodyStart, matchedEnd),
                time:      attrs.get('time') ?? '',
                date:      attrs.get('date') ?? '',
                component: attrs.get('component') ?? '',
                context:   attrs.get('context') ?? '',
                thread:    attrs.get('thread') ?? '',
                file:      attrs.get('file') ?? '',
                type:      rawType !== undefined && /^\d+$/.test(rawType) ? parseInt(rawType, 10) : undefined,
                offset:    start,
                length:    metadata.end - start,
                malformed: false,
            });
            cursor = metadata.end;
            continue;
        }

        if (firstEnd !== -1) {
            // Body closed, metadata unusable. Report the message rather than
            // dropping it, but mark every metadata field as untrustworthy.
            entries.push({
                message:   text.slice(bodyStart, firstEnd),
                time:      '',
                date:      '',
                component: '',
                context:   '',
                thread:    '',
                file:      '',
                type:      undefined,
                offset:    start,
                length:    firstEnd + END.length - start,
                malformed: true,
            });
            cursor = firstEnd + END.length;
            continue;
        }

        // No terminator at all before the next record: skip this marker.
        cursor = limit;
    }

    return entries;
}
