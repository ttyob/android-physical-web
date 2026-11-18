"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AnnexBParser, H264AccessUnits } = require("../ui/ios-h264");

const sps = [0x67, 0x42, 0xe0, 0x1f], pps = [0x68, 0xce, 0x06];
const key = [0x65, 0x80, 0x21], continuation = [0x65, 0x40, 0x22], delta = [0x41, 0x80, 0x23];
const sei = [0x06, 0x05, 0x80];

function wire(nals) { return Uint8Array.from(nals.flatMap((nal, index) => [...(index % 2 ? [0, 0, 1] : [0, 0, 0, 1]), ...nal])); }

test("Annex B parsing survives start codes split at every possible byte and preserves the final NAL", () => {
    const nals = [sps, pps, sei, key, continuation, sei, delta];
    const bytes = wire(nals);
    for (let split = 0; split <= bytes.length; split++) {
        const received = [], parser = new AnnexBParser(nal => received.push(Array.from(nal)));
        parser.push(bytes.subarray(0, split)); parser.push(bytes.subarray(split)); parser.finish();
        assert.deepEqual(received, nals, `split ${split}`);
    }
    const received = [], parser = new AnnexBParser(nal => received.push(Array.from(nal)));
    for (const byte of bytes) { parser.push(Uint8Array.of(byte)); }
    parser.finish(); assert.deepEqual(received, nals);
});

test("H.264 access units keep multiple slices together and prepend parameter sets for keyframes", () => {
    const received = [], units = new H264AccessUnits(unit => received.push(unit));
    for (const nal of [sps, pps, sei, key, continuation, sei, delta, delta]) { units.push(Uint8Array.from(nal)); }
    units.finish();
    assert.deepEqual(received.map(unit => unit.key), [true, false, false]);
    const first = [];
    const parser = new AnnexBParser(nal => first.push(Array.from(nal)));
    parser.push(received[0].data); parser.finish();
    assert.deepEqual(first, [sps, pps, sei, key, continuation]);
    assert.deepEqual(Array.from(received[0].sps), sps);
});

test("invalid or unbounded H.264 data fails without buffering indefinitely", () => {
    const parser = new AnnexBParser(() => {});
    assert.throws(() => parser.push(new Uint8Array(4 * 1024 * 1024 + 1)), /数据无效/);
    const units = new H264AccessUnits(() => assert.fail("invalid stream must not decode"));
    assert.throws(() => units.push(Uint8Array.from([0x65, 0])), /不完整/);
});
