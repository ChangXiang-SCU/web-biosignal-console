import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './helpers/load-core.mjs';

const C = loadCore();
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);

test('包内时间戳：最后一个样本就是包时间戳（PMD 规定），首包用标称间隔', () => {
  const r = C.packetSampleTimes(10_000, undefined, 73, 1000 / 130);
  assert.equal(r.times.length, 73);
  assert.equal(r.times[72], 10_000);
  close(r.times[0], 10_000 - 72 * 1000 / 130, 1e-3);
  assert.equal(r.gapMs, 0);
});

test('包内时间戳：连续包用实测间隔，跨包接缝无重叠无缺口（H10 ACC 实测 202.6 Hz）', () => {
  const realStep = 177.65 / 36;              // 实测每包 36 样本前进 177.65 ms
  let prev, all = [];
  for (let k = 0; k < 20; k++) {
    const r = C.packetSampleTimes(1_000 + k * 177.65, prev, 36, 5);
    prev = r.next; all.push(...r.times);
  }
  // 第 2 包起采用实测间隔
  for (let i = 37; i < all.length; i++) close(all[i] - all[i - 1], realStep, 2e-3, `i=${i}`);
  close(prev.step, realStep, 1e-9);
});

test('包内时间戳：丢一包 → 用上次实测间隔排样本，并报告缺口', () => {
  const step = 7.7;
  const a = C.packetSampleTimes(1000, undefined, 73, 1000 / 130);
  const b = C.packetSampleTimes(1000 + 73 * step, a.next, 73, 1000 / 130);   // 测到 7.7 ms
  const c = C.packetSampleTimes(1000 + 3 * 73 * step, b.next, 73, 1000 / 130); // 中间丢了一包
  close(c.step, step, 1e-9, 'step after gap');
  close(c.gapMs, 73 * step, 1e-6, 'gap');
  assert.equal(c.times[72], 1000 + 3 * 73 * step);
});

test('包内时间戳：设备时间倒退 → backwards，不采信', () => {
  const a = C.packetSampleTimes(1000, undefined, 10, 5);
  const b = C.packetSampleTimes(900, a.next, 10, 5);
  assert.equal(b.backwards, true);
  assert.equal(b.step, 5);
});

test('主机时间轴：H10 钟停在 2019 年、EDA 钟正确，unix_host_ms 仍然对齐', () => {
  const wall = Date.UTC(2026, 8, 4, 3, 5, 35);
  const latency = 40;
  const h10Dev = Date.UTC(2019, 0, 1) - C.EPOCH_2000_TO_1970;   // ms since 2000
  const edaDev = wall - C.EPOCH_2000_TO_1970;
  const offH10 = C.hostOffset(h10Dev, wall + latency);
  const offEda = C.hostOffset(edaDev, wall + latency);
  // 1 s 后两台设备同时采到的样本
  close(C.hostMs(h10Dev + 1000, offH10), C.hostMs(edaDev + 1000, offEda), 1e-6);
  close(C.hostMs(edaDev + 1000, offEda), wall + 1000 + latency, 1e-6);
  assert.equal(C.hostOffset(undefined, 5), 0);
});

test('时钟拟合：恢复 skew / 偏移，jitter 与设备钟绝对值无关', () => {
  const skew = 1 + 80e-6, x0 = 1.56e12, pairs = [];
  let seed = 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 300; i++) {
    const x = x0 + i * 562;                               // 每包 562 ms
    const jitter = 15 + 30 * rnd();                       // 15..45 ms 传输延迟
    pairs.push([x, 2.4e11 + skew * x + jitter]);          // 设备钟差 7.7 年
  }
  const f = C.fitClockPairs(pairs);
  close(f.est.skew, skew, 2e-6, 'skew');
  close(f.stats.median - f.stats.min, 15, 10, 'jitter median');
  assert.ok(f.stats.p95 >= f.stats.median && f.stats.median >= f.stats.min);
  assert.equal(C.fitClockPairs([[1, 2]]), null);
});
