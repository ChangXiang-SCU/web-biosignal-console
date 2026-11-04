import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './helpers/load-core.mjs';
import { ecgPacket, h10AccPacket, deltaPacket, expandDeltas } from './helpers/pmd-encode.mjs';

const C = loadCore();

test('signExtend：-2^(bits-1) 是负数（旧实现用 > 判断，这个值会被当成正数）', () => {
  assert.equal(C.signExtend(0b10, 2), -2);
  assert.equal(C.signExtend(0b01, 2), 1);
  assert.equal(C.signExtend(0x80, 8), -128);
  assert.equal(C.signExtend(0x7f, 8), 127);
  assert.equal(C.signExtend(0x800000, 24), -8388608);
  assert.equal(C.signExtend(0, 0), 0);
});

test('readIntLE：小端有符号', () => {
  const u8 = Uint8Array.from([0xff, 0xff, 0xff, 0x00, 0x80, 0x34, 0x12, 0x00]);
  assert.equal(C.readIntLE(u8, 0, 3), -1);
  assert.equal(C.readIntLE(u8, 3, 2), -32768);
  assert.equal(C.readIntLE(u8, 5, 3), 0x1234);
});

test('PMD 头：类型、2000 纪元纳秒时间戳、帧类型', () => {
  const pk = ecgPacket(599_616_000_123.456, [0]);
  const h = C.parsePmdHeader(pk);
  assert.equal(h.type, 0);
  assert.equal(h.frameType, 0);
  assert.equal(h.compressed, false);
  assert.ok(Math.abs(h.devMs - 599_616_000_123.456) < 1e-3);
  assert.throws(() => C.parsePmdHeader(new Uint8Array(5)));
});

test('ECG：3 字节 µV，超出 16 bit 的值也对（旧实现只读低 2 字节）', () => {
  const uV = [0, 1, -1, 1234, -1234, 32767, -32768, 40000, -40000, 8388607, -8388608];
  const p = C.parsePmdPacket(ecgPacket(1000, uV));
  assert.equal(p.name, 'ECG');
  assert.equal(p.truncated, false);
  assert.deepEqual(p.channels, [uV]);
});

test('H10 ACC：帧 1，每轴 2 字节，三轴交错', () => {
  const xyz = [[1, -2, 1000], [-32768, 32767, 0], [12, 34, -56]];
  const p = C.parsePmdPacket(h10AccPacket(5000, xyz));
  assert.equal(p.name, 'ACC');
  assert.equal(p.compressed, false);
  assert.deepEqual(p.channels, [[1, -32768, 12], [-2, 32767, 34], [1000, 0, -56]]);
});

test('增量帧：偶数位宽、多块、每块位宽不同', () => {
  const ref = [1000, -2000, 3000];
  const blocks = [
    { bits: 6,  deltas: [[1, -1, 0], [31, -32, 5], [-7, 7, 2]] },
    { bits: 10, deltas: [[511, -512, 100], [-300, 200, -1]] },
  ];
  const p = C.parsePmdPacket(deltaPacket(2, 1, 0x80, ref, 2, blocks));
  assert.equal(p.compressed, true);
  assert.equal(p.truncated, false);
  assert.deepEqual(p.channels, expandDeltas(ref, blocks));
});

test('增量帧：奇数位宽（旧的 2 bit 切块实现解不对）', () => {
  for (const bits of [1, 3, 5, 7, 9, 11, 13, 17, 19]) {
    const lim = 2 ** (bits - 1);
    const deltas = [];
    for (let s = 0; s < 9; s++) deltas.push([(-lim + s) , (lim - 1 - s) , (s % 2 ? -lim : lim - 1)].map(v => Math.max(-lim, Math.min(lim - 1, v))));
    const ref = [5, -5, 0];
    const blocks = [{ bits, deltas }];
    const p = C.parsePmdPacket(deltaPacket(2, 1, 0x80, ref, 2, blocks));
    assert.deepEqual(p.channels, expandDeltas(ref, blocks), `bits=${bits}`);
  }
});

test('增量帧：块尾补齐位不会多解出假样本（旧实现按字节数切块）', () => {
  // 2 bit × 3 通道 × 3 样本 = 18 bit → 3 字节，末尾 6 个补齐位
  const ref = [0, 0, 0];
  const blocks = [{ bits: 2, deltas: [[1, -2, 0], [-1, 1, -2], [0, 0, 1]] }];
  const p = C.parsePmdPacket(deltaPacket(2, 1, 0x80, ref, 2, blocks));
  assert.equal(p.channels[0].length, 4);
  assert.deepEqual(p.channels, expandDeltas(ref, blocks));
});

test('Verity Sense PPG：4 通道、3 字节参考样本（22 bit）', () => {
  const ref = [2_000_000, -2_000_000, 123_456, -1];
  const blocks = [{ bits: 21, deltas: [[-1_048_576, 1_048_575, 7, -7], [100, -100, 0, 1]] }];
  const p = C.parsePmdPacket(deltaPacket(1, 1, 0x80, ref, 3, blocks));
  assert.equal(p.name, 'PPG');
  assert.deepEqual(p.channels, expandDeltas(ref, blocks));
});

test('截断包：解出完整的部分并标 truncated，不抛错', () => {
  const ref = [1, 2, 3];
  const blocks = [{ bits: 8, deltas: [[1, 1, 1], [2, 2, 2]] }, { bits: 8, deltas: [[3, 3, 3]] }];
  const full = deltaPacket(2, 1, 0x80, ref, 2, blocks);
  const p = C.parsePmdPacket(full.slice(0, full.length - 1));
  assert.equal(p.truncated, true);
  assert.deepEqual(p.channels, expandDeltas(ref, [blocks[0]]));
  const ecg = ecgPacket(1, [5, 6]);
  const q = C.parsePmdPacket(ecg.slice(0, ecg.length - 1));
  assert.equal(q.truncated, true);
  assert.deepEqual(q.channels, [[5]]);
});

test('未知类型 / 帧类型：supported=false，不抛错', () => {
  const p = C.parsePmdPacket(Uint8Array.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]));
  assert.equal(p.supported, false);
  assert.deepEqual(p.channels, []);
});
