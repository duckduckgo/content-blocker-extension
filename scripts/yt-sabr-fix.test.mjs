import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '../src/content-scripts/yt-sabr-fix.js');
const source = readFileSync(scriptPath, 'utf8');

const sabrUrl = 'https://rr3---sn-abc.googlevideo.com/videoplayback?sabr=1&rn=7';
const MAX_INSPECTED_PART_SIZE = 4096;

// ---- UMP / protobuf encoders (inverse of the decoders under test) ----------

/**
 * @param {number} value
 * @returns {number[]}
 */
function umpVarint(value) {
    if (value < 1 << 7) {
        return [value];
    }
    if (value < 1 << 14) {
        return [0x80 | (value & 0x3f), (value >> 6) & 0xff];
    }
    if (value < 1 << 21) {
        return [0xc0 | (value & 0x1f), (value >> 5) & 0xff, (value >> 13) & 0xff];
    }
    if (value < 1 << 28) {
        return [0xe0 | (value & 0x0f), (value >> 4) & 0xff, (value >> 12) & 0xff, (value >> 20) & 0xff];
    }
    return [0xf0, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

/**
 * @param {number} value
 * @returns {number[]}
 */
function protoVarint(value) {
    const bytes = [];
    let remaining = value;
    do {
        const byte = remaining & 0x7f;
        remaining >>>= 7;
        bytes.push(remaining > 0 ? byte | 0x80 : byte);
    } while (remaining > 0);
    return bytes;
}

/**
 * @param {number} field
 * @param {number} value
 * @returns {number[]}
 */
function protoVarintField(field, value) {
    return [...protoVarint(field * 8), ...protoVarint(value)];
}

/**
 * @param {number} type
 * @param {number[]} payload
 * @returns {number[]}
 */
function umpPart(type, payload) {
    return [...umpVarint(type), ...umpVarint(payload.length), ...payload];
}

/**
 * @param {number} length
 * @param {number} seed
 * @returns {number[]}
 */
function mediaPayload(length, seed) {
    return Array.from({ length }, (unused, i) => (i * 31 + seed) & 0xff);
}

/**
 * A NEXT_REQUEST_POLICY part: a leading field the mutator must skip over, the
 * backoff itself, then a trailing field that must survive the rewrite.
 * @param {number} backoffMs
 * @returns {number[]}
 */
function nextRequestPolicy(backoffMs) {
    return umpPart(35, [...protoVarintField(1, 12345), ...protoVarintField(4, backoffMs), ...protoVarintField(5, 999)]);
}

// ---- harness ---------------------------------------------------------------

/**
 * Evaluate the shipped content script against a stub `window`, then drive it
 * with a response body delivered in the given chunks.
 * @returns {{ fetch: Function, setUpstream: (fn: Function) => void, listeners: Record<string, Function[]> }}
 */
function loadContentScript() {
    /** @type {Record<string, Function[]>} */
    const listeners = {};
    let upstream = () => {
        throw new Error('no upstream configured');
    };
    const window = {
        fetch: (...args) => upstream(...args),
        addEventListener(type, listener) {
            (listeners[type] ??= []).push(listener);
        },
    };

    const context = vm.createContext({ window, TransformStream, Response, ReadableStream, Uint8Array, Math });
    vm.runInContext(source, context, { filename: scriptPath });

    return { window, listeners, setUpstream: (fn) => (upstream = fn) };
}

/**
 * @param {Uint8Array[]} chunks
 * @returns {Response}
 */
function responseOf(chunks) {
    const body = new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }
            controller.close();
        },
    });
    return new Response(body, { status: 200, statusText: 'OK' });
}

/**
 * @param {Uint8Array} bytes
 * @param {number} size
 * @returns {Uint8Array[]}
 */
function split(bytes, size) {
    const chunks = [];
    for (let i = 0; i < bytes.length; i += size) {
        chunks.push(bytes.subarray(i, i + size));
    }
    return chunks;
}

/**
 * @param {number[]} stream UMP bytes to feed through the mutator
 * @param {number} chunkSize
 * @returns {Promise<Uint8Array>} the bytes the player would receive
 */
async function pipe(stream, chunkSize) {
    const input = new Uint8Array(stream);
    const harness = loadContentScript();
    harness.setUpstream(() => Promise.resolve(responseOf(split(input, chunkSize))));
    const response = await harness.window.fetch(sabrUrl);
    return new Uint8Array(await response.arrayBuffer());
}

// ---- tests -----------------------------------------------------------------

test('a stream with no NEXT_REQUEST_POLICY part is passed through byte for byte', async () => {
    // Sizes chosen to exercise the one-, two- and three-byte UMP varint forms.
    const stream = [
        ...umpPart(20, mediaPayload(40, 1)),
        ...umpPart(21, mediaPayload(9000, 2)),
        ...umpPart(42, mediaPayload(300, 3)),
        ...umpPart(47, protoVarintField(4, 2500)),
        ...umpPart(22, []),
        ...umpPart(21, mediaPayload(64, 4)),
    ];
    const input = new Uint8Array(stream);

    // Every split matters: a header, a size varint or a payload can straddle any boundary.
    for (const chunkSize of [1, 2, 3, 7, 64, 1000, input.length, input.length * 2]) {
        const output = await pipe(stream, chunkSize);
        assert.deepEqual(output, input, `output differed for chunk size ${chunkSize}`);
    }
});

test('backoffTimeMs is zeroed without changing the byte length of the stream', async () => {
    const stream = [...umpPart(20, mediaPayload(16, 1)), ...nextRequestPolicy(4000), ...umpPart(21, mediaPayload(128, 2))];
    const expected = new Uint8Array([...umpPart(20, mediaPayload(16, 1)), ...nextRequestPolicy(0), ...umpPart(21, mediaPayload(128, 2))]);

    const output = await pipe(stream, 4096);

    assert.equal(output.length, stream.length, 'the rewrite must preserve the stream length');
    // 4000 encodes as two protobuf bytes and 0 as one, so the zeroed field is a
    // non-canonical encoding rather than the shortest one.
    assert.notDeepEqual(output, expected);
    assert.deepEqual(
        [...output.subarray(output.length - 128 - 2)],
        [...expected.subarray(expected.length - 128 - 2)],
        'media must be intact',
    );
});

test('the zeroed backoff decodes to 0 and neighbouring fields are untouched', async () => {
    const policy = nextRequestPolicy(4000);
    const output = await pipe([...umpPart(20, mediaPayload(8, 1)), ...policy], 4096);
    const payload = output.subarray(output.length - (policy.length - 2));

    assert.deepEqual([...payload], [...protoVarintField(1, 12345), 0x20, 0x80, 0x00, ...protoVarintField(5, 999)]);
});

test('a NEXT_REQUEST_POLICY part split across chunks is still zeroed', async () => {
    const stream = [...umpPart(21, mediaPayload(50, 1)), ...nextRequestPolicy(9000), ...umpPart(21, mediaPayload(50, 2))];

    for (const chunkSize of [1, 2, 5]) {
        const output = await pipe(stream, chunkSize);
        assert.equal(output.length, stream.length);
        assert.notDeepEqual(output, new Uint8Array(stream), `backoff was not rewritten at chunk size ${chunkSize}`);
        assert.deepEqual(output.subarray(0, 52), new Uint8Array(stream.slice(0, 52)), 'preceding media must be intact');
    }
});

test('a NEXT_REQUEST_POLICY part larger than the inspection limit is passed through', async () => {
    const oversized = [...protoVarintField(4, 4000), ...mediaPayload(MAX_INSPECTED_PART_SIZE, 5)];
    const stream = umpPart(35, oversized);

    const output = await pipe(stream, 4096);

    assert.deepEqual(output, new Uint8Array(stream));
});

test('a field 4 varint outside NEXT_REQUEST_POLICY is left alone', async () => {
    // Readahead limits and timescales are also field 4; rewriting them corrupts playback.
    const stream = [
        ...umpPart(47, protoVarintField(4, 3000)),
        ...umpPart(43, protoVarintField(4, 1500)),
        ...umpPart(20, protoVarintField(4, 600)),
    ];

    const output = await pipe(stream, 4096);

    assert.deepEqual(output, new Uint8Array(stream));
});

test('an already-zero backoff is left as it is', async () => {
    const stream = nextRequestPolicy(0);

    const output = await pipe(stream, 4096);

    assert.deepEqual(output, new Uint8Array(stream));
});

test('a truncated response still delivers the bytes the mutator was holding', async () => {
    const policy = nextRequestPolicy(4000);
    // Cut the policy part short so it never completes and stays in the collect buffer.
    const stream = [...umpPart(21, mediaPayload(32, 1)), ...policy.slice(0, policy.length - 4)];

    const output = await pipe(stream, 8);

    assert.deepEqual(output, new Uint8Array(stream), 'no bytes may be dropped when the stream ends mid-part');
});

test('a response that ends mid-header still delivers the trailing bytes', async () => {
    // 0xc0 opens a three-byte UMP varint, so this header can never complete and
    // the byte sits in the carry buffer until flush.
    const stream = [...umpPart(21, mediaPayload(32, 1)), 0xc0];

    const output = await pipe(stream, 8);

    assert.deepEqual(output, new Uint8Array(stream), 'no bytes may be dropped when the stream ends mid-header');
});

test('requests that are not SABR media are not intercepted', async () => {
    const harness = loadContentScript();
    const original = new Response('ok');
    harness.setUpstream(() => Promise.resolve(original));

    const passthrough = await harness.window.fetch('https://www.youtube.com/watch?v=abc');
    const noSabrFlag = await harness.window.fetch('https://rr3---sn-abc.googlevideo.com/videoplayback?rn=7');

    assert.equal(passthrough, original, 'a non-googlevideo request must reach the caller untouched');
    assert.equal(noSabrFlag, original, 'a googlevideo request without sabr=1 must reach the caller untouched');
});

test('the fetch hook is reinstalled after a YouTube SPA navigation', async () => {
    const harness = loadContentScript();
    const hook = harness.window.fetch;

    harness.window.fetch = () => Promise.resolve(new Response('replaced'));
    for (const listener of harness.listeners['yt-navigate-finish']) {
        listener();
    }

    assert.equal(harness.window.fetch, hook);
});
