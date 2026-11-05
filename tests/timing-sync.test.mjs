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

test('包内时间戳：设备时间倒退或重复 → 整包丢弃，next 保持上一包，下一包照常接上', () => {
  const a = C.packetSampleTimes(1000, undefined, 10, 5);
  for (const end of [900, 1000]) {
    const b = C.packetSampleTimes(end, a.next, 10, 5);
    assert.equal(b.backwards, true);
    assert.equal(b.drop, true);
    assert.deepEqual(b.times, []);
    assert.deepEqual(b.next, a.next, 'last accepted endpoint is kept');
  }
  const c = C.packetSampleTimes(1050, a.next, 10, 5);
  assert.equal(c.drop, false);
  assert.ok(c.times[0] > a.times.at(-1), 'monotonic across the dropped packet');
});

test('包内时间戳：往前走但太短 → irregular，本包压紧排不重叠，不记住这个间隔', () => {
  const a = C.packetSampleTimes(1000, undefined, 10, 5);
  const m = C.packetSampleTimes(1049, a.next, 10, 5);               // 4.9 ms/样本，采信
  const c = C.packetSampleTimes(1049 + 10, m.next, 10, 5);          // 1 ms/样本：时间往前，但不到一半
  assert.equal(c.irregular, true);
  assert.equal(c.backwards, false);
  assert.equal(c.drop, false);
  assert.equal(c.times.at(-1), 1059);
  assert.ok(c.times[0] > m.times.at(-1), 'no overlap with the previous packet');
  for (let i = 1; i < 10; i++) close(c.times[i] - c.times[i - 1], 1, 1e-3);
  close(c.next.step, 4.9, 1e-9, 'keeps last accepted step');
  assert.equal(c.gapMs, 0);
});

/* ---------- 设备时钟跳变 ---------- */
// 一台设备两路数据（ECG 每 562 ms 一包、ACC 每 178 ms 一包），到达延迟 20–60 ms
function feed(guard, events){
  return events.map(([stream, raw, arr]) => ({ stream, raw, arr, ...guard.map(stream, raw, arr) }));
}
function twoStreams(T0, wall0, seconds, clock){
  const ev = [];
  for (let t = 0; t < seconds * 1000; t += 1) {
    if (t % 562 === 0) ev.push([0, clock(t), wall0 + t + 20 + (t % 40)]);
    if (t % 178 === 0) ev.push([2, clock(t), wall0 + t + 25 + (t % 35)]);
  }
  return ev.sort((a, b) => a[2] - b[2]);
}

test('设备时钟：正常录制和掉线重连（设备钟照走）都不触发跳变', () => {
  const T0 = Date.UTC(2019, 5, 1) - C.EPOCH_2000_TO_1970, wall0 = 1.79e12;
  const ev = twoStreams(T0, wall0, 120, t => T0 + t * (1 + 1e-4))
    .filter(e => !(e[2] > wall0 + 40e3 && e[2] < wall0 + 95e3));   // 中间 55 s 掉线
  const out = feed(new C.DeviceClockGuard(), ev);
  assert.ok(out.every(o => o.event === null && o.devMs === o.raw));
});

test('设备时钟：重启后 RTC 回到出厂时刻 → 一次 jump，之后两路都接回主机时间轴、单调', () => {
  const T0 = Date.UTC(2019, 5, 1) - C.EPOCH_2000_TO_1970, RESET = Date.UTC(2019, 0, 1) - C.EPOCH_2000_TO_1970, wall0 = 1.79e12;
  const ev = twoStreams(T0, wall0, 120, t => (t < 60e3 ? T0 + t : RESET + (t - 60e3)))
    .filter(e => !(e[2] > wall0 + 55e3 && e[2] < wall0 + 70e3));   // 重启造成的掉线
  const out = feed(new C.DeviceClockGuard(), ev);
  const jumps = out.filter(o => o.event === 'jump');
  assert.equal(jumps.length, 1, JSON.stringify(jumps));
  assert.ok(jumps[0].jumpMs < -1e10, 'backwards by months: ' + jumps[0].jumpMs);
  for (const s of [0, 2]) {
    const o = out.filter(x => x.stream === s);
    for (let i = 1; i < o.length; i++) assert.ok(o[i].devMs > o[i - 1].devMs, `stream ${s} monotonic at ${i}`);
  }
  // 接上后设备时间 + 首包偏移 ≈ 到达时刻（误差就是传输延迟的差）
  const base = out[0].arr - out[0].raw;
  for (const o of out) assert.ok(Math.abs(o.arr - o.devMs - base) < 100, `aligned: ${o.arr - o.devMs - base}`);
});

test('设备时钟：被对表往前跳 7 年 → jump，数据不会挪到几年以后', () => {
  const T0 = Date.UTC(2019, 5, 1) - C.EPOCH_2000_TO_1970, wall0 = 1.79e12;
  const SET = wall0 - C.EPOCH_2000_TO_1970;
  const out = feed(new C.DeviceClockGuard(), twoStreams(T0, wall0, 60, t => (t < 30e3 ? T0 + t : SET + t)));
  assert.equal(out.filter(o => o.event).length, 1);
  const base = out[0].arr - out[0].raw;
  for (const o of out) assert.ok(Math.abs(o.arr - o.devMs - base) < 100);
});

test('设备时钟：主机卡顿 60 s 后积压的包一起到，只是迟到，不触发跳变', () => {
  const T0 = 6e11, wall0 = 1.79e12;
  const ev = twoStreams(T0, wall0, 120, t => T0 + t).map(e => {
    const t = e[1] - T0;
    return (t >= 40e3 && t < 100e3) ? [e[0], e[1], wall0 + 100e3 + 30 + (t - 40e3) / 1000] : e;
  }).sort((a, b) => a[2] - b[2]);
  const out = feed(new C.DeviceClockGuard(), ev);
  assert.ok(out.every(o => o.event === null && o.devMs === o.raw));
});

test('设备时钟：跳变时另一路还在路上的旧包用旧平移量；小幅倒退不算跳变（交给 packetSampleTimes 丢包）', () => {
  const g = new C.DeviceClockGuard();
  const wall = 1.79e12, T = 6e11;
  g.map(0, T, wall); g.map(2, T + 5, wall + 5);
  g.map(0, T + 1000, wall + 1000); g.map(2, T + 1005, wall + 1005);
  const j = g.map(0, T - 5e6, wall + 2000);                          // ECG 先看到重启后的钟
  assert.equal(j.event, 'jump');
  const old = g.map(2, T + 1180, wall + 2010);                        // ACC 重启前发出的最后一包
  assert.equal(old.event, null);
  assert.equal(old.devMs, T + 1180);
  const neu = g.map(2, T - 5e6 + 30, wall + 2040);
  assert.equal(neu.event, null);
  close(neu.devMs, T + 2030, 1e-6);
  const small = g.map(0, T - 5e6 - 2000, wall + 2600);                // 倒退 2 s：不是跳变
  assert.equal(small.event, null);
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
