/*******************************************************************************
    Copyright (C) 2026 Duck Duck Go, Inc.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.
*/

/**
 * Removes the artificial playback delay YouTube applies once its ads are blocked.
 *
 * YouTube streams media over SABR, whose responses are UMP-framed: a sequence of
 * parts, each prefixed by a varint type and a varint size. Alongside the media
 * parts the server sends a NEXT_REQUEST_POLICY part (type 35) whose field 4,
 * `backoffTimeMs`, tells the player how long to wait before requesting the next
 * chunk. In a control-only response — one delivered ahead of any media — a
 * multi-second backoff makes the player sit idle, which the viewer sees as
 * buffering. Zeroing that field lets the player request the next chunk
 * immediately.
 *
 * Only field 4 of part type 35 is touched. Other parts carry field-4 varints
 * that are not backoffs (readahead limits, timescales) and rewriting those would
 * corrupt playback, so parts are matched on type before any field is inspected.
 *
 * The rewrite is length-preserving: the replacement is a non-canonical varint
 * encoding of zero occupying the same number of bytes as the original value
 * (`0x80 0x80 0x00` for a three-byte value), so the enclosing UMP part size and
 * the response's Content-Length stay valid. Media parts are never buffered —
 * they are forwarded through the TransformStream as their bytes arrive.
 */
(function () {
    'use strict';

    // NEXT_REQUEST_POLICY parts are tens of bytes. Refusing to buffer anything
    // larger bounds our memory use and keeps a mislabelled part from being held.
    const MAX_INSPECTED_PART_SIZE = 4096;
    const TARGET_TYPE = 35; // NEXT_REQUEST_POLICY
    const TARGET_FIELD = 4; // backoffTimeMs

    const realFetch = window.fetch;
    if (typeof realFetch !== 'function') {
        return;
    }

    const wrapped = function (resource, init) {
        let url = '';
        try {
            url = typeof resource === 'string' ? resource : (resource && resource.url) || '';
        } catch (e) {}
        if (!url.includes('googlevideo.com') || !url.includes('sabr=1')) {
            return realFetch.apply(this, arguments);
        }

        return realFetch.apply(this, arguments).then(function (response) {
            if (!response.body) {
                return response;
            }
            try {
                const mutator = makeMutator();
                const tap = new TransformStream({
                    transform(chunk, controller) {
                        mutator.push(chunk, controller);
                    },
                    flush(controller) {
                        mutator.flush(controller);
                    },
                });
                return new Response(response.body.pipeThrough(tap), {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                });
            } catch (e) {
                return response; // never break playback on our account
            }
        });
    };

    try {
        window.fetch = wrapped;
    } catch (e) {}

    // YouTube is a single-page app; a navigation can leave a different `fetch` in
    // place, so re-install ours after one.
    window.addEventListener(
        'yt-navigate-finish',
        function () {
            if (window.fetch !== wrapped) {
                try {
                    window.fetch = wrapped;
                } catch (e) {}
            }
        },
        true,
    );

    /**
     * A single-consumer UMP part reader that forwards its input downstream.
     *
     * Every part except a small type-35 one is emitted as it arrives: the header
     * goes out as soon as it is parsed, then the payload is passed through in
     * whatever chunks the network delivers. A small type-35 part is held until
     * complete so field 4 can be rewritten in place, then emitted.
     * @returns {{ push: (chunk: Uint8Array, controller: TransformStreamDefaultController) => void,
     *             flush: (controller: TransformStreamDefaultController) => void }}
     */
    function makeMutator() {
        let carry = new Uint8Array(0);
        let mode = 'header'; // header | stream | collect
        let need = 0;
        let curType = -1;
        let curSize = 0;
        let collectHeader = null;
        let collectBuf = null;
        let collectPos = 0;
        let ended = false;

        function flushCollect(controller) {
            if (curType === TARGET_TYPE) {
                const backoff = decodeProto(collectBuf).find((field) => field.f === TARGET_FIELD && field.wire === 'varint');
                if (backoff && backoff.v > 0) {
                    zeroVarintAt(collectBuf, backoff.valStart, backoff.valEnd);
                }
            }
            controller.enqueue(collectHeader);
            controller.enqueue(collectBuf);
            collectHeader = null;
            collectBuf = null;
            collectPos = 0;
            mode = 'header';
        }

        function process(controller) {
            let progressed = true;
            while (progressed) {
                progressed = false;
                if (mode === 'header') {
                    const header = tryReadHeader(carry);
                    if (header) {
                        collectHeader = carry.slice(0, header.headerLen); // copy; the rest of carry stays a view
                        carry = carry.subarray(header.headerLen);
                        curType = header.type;
                        curSize = header.size;
                        if (curType === TARGET_TYPE && curSize <= MAX_INSPECTED_PART_SIZE) {
                            mode = 'collect';
                            collectBuf = new Uint8Array(curSize);
                            collectPos = 0;
                            if (curSize === 0) {
                                flushCollect(controller);
                            }
                        } else {
                            controller.enqueue(collectHeader);
                            collectHeader = null;
                            need = curSize;
                            mode = need === 0 ? 'header' : 'stream';
                        }
                        progressed = true;
                    }
                } else if (mode === 'stream') {
                    if (carry.length > 0 && need > 0) {
                        const take = Math.min(need, carry.length);
                        controller.enqueue(carry.subarray(0, take)); // a view; we never mutate carry
                        carry = carry.subarray(take);
                        need -= take;
                        progressed = true;
                    }
                    if (need === 0) {
                        mode = 'header';
                    }
                } else if (mode === 'collect') {
                    if (carry.length > 0 && collectPos < collectBuf.length) {
                        const take = Math.min(collectBuf.length - collectPos, carry.length);
                        collectBuf.set(carry.subarray(0, take), collectPos);
                        collectPos += take;
                        carry = carry.subarray(take);
                        progressed = true;
                    }
                    if (collectPos === collectBuf.length) {
                        flushCollect(controller);
                    }
                }
            }
        }

        return {
            push(chunk, controller) {
                if (ended || !chunk || chunk.length === 0) {
                    return;
                }
                carry = concat(carry, chunk);
                process(controller);
            },
            flush(controller) {
                if (ended) {
                    return;
                }
                ended = true;
                // A truncated response must still reach the player intact, so emit
                // whatever we are holding rather than dropping it.
                try {
                    if (mode === 'collect' && collectBuf) {
                        if (collectHeader) {
                            controller.enqueue(collectHeader);
                        }
                        controller.enqueue(collectPos < collectBuf.length ? collectBuf.subarray(0, collectPos) : collectBuf);
                    } else if (carry.length > 0) {
                        controller.enqueue(carry);
                    }
                } catch (e) {}
            },
        };
    }

    // ---- UMP varints ------------------------------------------------------
    // Length is encoded in the leading bits of the first byte; the remaining
    // payload bits of that byte hold the value's most significant bits, except
    // in the five-byte form where they are unused.

    /**
     * @param {number} b0 first byte of the varint
     * @returns {number} total length of the varint in bytes
     */
    function umpVarintLen(b0) {
        return (b0 & 0x80) === 0 ? 1 : (b0 & 0x40) === 0 ? 2 : (b0 & 0x20) === 0 ? 3 : (b0 & 0x10) === 0 ? 4 : 5;
    }

    /**
     * @param {Uint8Array} buf
     * @param {number} off
     * @returns {{ value: number, len: number }}
     */
    function readUmpVarint(buf, off) {
        const b0 = buf[off];
        const len = umpVarintLen(b0);
        let value;
        switch (len) {
            case 1:
                value = b0;
                break;
            case 2:
                value = (b0 & 0x3f) | (buf[off + 1] << 6);
                break;
            case 3:
                value = (b0 & 0x1f) | (buf[off + 1] << 5) | (buf[off + 2] << 13);
                break;
            case 4:
                value = (b0 & 0x0f) | (buf[off + 1] << 4) | (buf[off + 2] << 12) | (buf[off + 3] << 20);
                break;
            default:
                value = buf[off + 1] | (buf[off + 2] << 8) | (buf[off + 3] << 16) | (buf[off + 4] << 24);
                break;
        }
        return { value: value >>> 0, len };
    }

    /**
     * @param {Uint8Array} buf
     * @param {number} off
     * @returns {{ value: number, len: number } | null} null if the varint is not fully buffered
     */
    function readUmpVarintSafe(buf, off) {
        if (off >= buf.length) {
            return null;
        }
        if (off + umpVarintLen(buf[off]) > buf.length) {
            return null;
        }
        return readUmpVarint(buf, off);
    }

    /**
     * @param {Uint8Array} buf
     * @returns {{ type: number, size: number, headerLen: number } | null} null if the header is not fully buffered
     */
    function tryReadHeader(buf) {
        const type = readUmpVarintSafe(buf, 0);
        if (!type) {
            return null;
        }
        const size = readUmpVarintSafe(buf, type.len);
        if (!size) {
            return null;
        }
        return { type: type.value, size: size.value, headerLen: type.len + size.len };
    }

    // ---- protobuf ---------------------------------------------------------

    /**
     * Standard protobuf varint: seven bits per byte, least significant first.
     * @param {Uint8Array} buf
     * @param {number} off
     * @returns {{ value: number, len: number } | null} null if the varint is truncated
     */
    function readProtoVarint(buf, off) {
        let value = 0;
        let shift = 0;
        let i = off;
        while (i < buf.length && shift < 64) {
            const byte = buf[i];
            i++;
            value += (byte & 0x7f) * Math.pow(2, shift);
            if ((byte & 0x80) === 0) {
                return { value, len: i - off };
            }
            shift += 7;
        }
        return null;
    }

    /**
     * Shallow field scan. Varint fields record the byte range of their value so
     * it can be rewritten in place; other wire types are only skipped over.
     * @param {Uint8Array} buf
     * @returns {{ f: number, wire: string, v?: number, len?: number, valStart?: number, valEnd?: number }[]}
     */
    function decodeProto(buf) {
        const fields = [];
        let i = 0;
        while (i < buf.length) {
            const tag = readProtoVarint(buf, i);
            if (!tag) {
                break;
            }
            const f = Math.floor(tag.value / 8);
            const wire = tag.value % 8;
            const valStart = i + tag.len;
            if (wire === 0) {
                const value = readProtoVarint(buf, valStart);
                if (!value) {
                    break;
                }
                fields.push({ f, wire: 'varint', v: value.value, valStart, valEnd: valStart + value.len });
                i = valStart + value.len;
            } else if (wire === 2) {
                const len = readProtoVarint(buf, valStart);
                if (!len) {
                    break;
                }
                fields.push({ f, wire: 'len', len: len.value });
                i = valStart + len.len + len.value;
            } else if (wire === 5) {
                fields.push({ f, wire: 'i32' });
                i = valStart + 4;
            } else if (wire === 1) {
                fields.push({ f, wire: 'i64' });
                i = valStart + 8;
            } else {
                break;
            }
        }
        return fields;
    }

    /**
     * Overwrite a varint value in place with a same-length encoding of zero.
     * Continuation bytes carry no value bits, so padding with 0x80 keeps the
     * byte count — and therefore the part size — unchanged.
     * @param {Uint8Array} buf
     * @param {number} start inclusive
     * @param {number} end exclusive
     */
    function zeroVarintAt(buf, start, end) {
        for (let i = start; i < end; i++) {
            buf[i] = i < end - 1 ? 0x80 : 0x00;
        }
    }

    /**
     * @param {Uint8Array} a
     * @param {Uint8Array} b
     * @returns {Uint8Array}
     */
    function concat(a, b) {
        if (a.length === 0) {
            return b;
        }
        if (b.length === 0) {
            return a;
        }
        const out = new Uint8Array(a.length + b.length);
        out.set(a, 0);
        out.set(b, a.length);
        return out;
    }
})();
