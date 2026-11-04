import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './helpers/load-core.mjs';

const C = loadCore();
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

/* ---------- 合成天琴座帧：EdaBuffer protobuf → COBS ---------- */
function varint(n, out){ while (n > 127){ out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } out.push(n); }
function f32(v){ const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return [...b]; }
function edaBuffer(imp, sec, us){
  const out = [];
  for (const z of imp){
    const inner = [0x0d, ...f32(z.re), 0x15, ...f32(z.im)];
    out.push(0x0a); varint(inner.length, out); out.push(...inner);
  }
  const ts = []; ts.push(0x08); varint(sec, ts); ts.push(0x10); varint(us, ts);
  out.push(0x12); varint(ts.length, out); out.push(...ts);
  return Uint8Array.from(out);
}

test('COBS：含 0x00、长度跨 254 字节边界的往返', () => {
  for (const len of [0, 1, 5, 253, 254, 255, 600]){
    const buf = Uint8Array.from({ length: len }, (_, i) => (i * 37) % 7 === 0 ? 0 : (i * 13) & 0xff || 1);
    const enc = C.cobsEncode(buf);
    assert.equal(enc[enc.length - 1], 0);
    assert.ok(!enc.slice(0, -1).includes(0), 'no zero inside frame');
    assert.deepEqual([...C.cobsDecode(enc.slice(0, -1))], [...buf], `len=${len}`);
  }
});

test('天琴座帧：16 频点复阻抗 + 时间戳，204 字节，COBS 后解析一致', () => {
  const imp = Array.from({ length: 16 }, (_, i) => ({ re: 30000 - i * 900, im: -(2000 + i * 150) }));
  const pb = edaBuffer(imp, 1788000000, 125000);
  assert.equal(pb.length, 204);
  const frame = C.cobsEncode(pb);
  const msg = C.pbParseEdaBuffer(C.cobsDecode(frame.slice(0, -1)));
  assert.equal(msg.imp.length, 16);
  msg.imp.forEach((z, i) => { close(z.re, imp[i].re, 1e-2); close(z.im, imp[i].im, 1e-2); });
  assert.equal(msg.t_s, 1788000000);
  assert.equal(msg.t_us, 125000);
});

test('protobuf：0 值字段被省略时按 0 处理；截断帧抛错（调用方会丢弃）', () => {
  const pb = Uint8Array.from([0x0a, 0x00, 0x12, 0x02, 0x08, 0x05]);
  const m = C.pbParseEdaBuffer(pb);
  assert.deepEqual(m.imp, [{ re: 0, im: 0 }]);
  assert.equal(m.t_s, 5);
  assert.throws(() => C.pbParseEdaBuffer(Uint8Array.from([0x0a, 0x10, 0x0d])));
});

test('对表帧：Timestamp 编码再 COBS，帧首不是 0x00', () => {
  const enc = C.cobsEncode(C.pbEncodeTimestamp(1788000000, 250000));
  assert.notEqual(enc[0], 0);
  const back = C.cobsDecode(enc.slice(0, -1));
  assert.deepEqual([...back], [...C.pbEncodeTimestamp(1788000000, 250000)]);
});

test('Nyquist 圆拟合：理想圆弧精确复现，散点 cfit 变大', () => {
  const cx = 20000, cy = 3000, r = 12000;
  const arc = Array.from({ length: 16 }, (_, i) => { const a = Math.PI * (1.1 + 0.8 * i / 15); return { re: cx + r * Math.cos(a), im: cy + r * Math.sin(a) }; });
  const f = C.fitCircle(arc);
  close(f.cx, cx, 1e-6); close(f.cy, cy, 1e-6); close(f.r, r, 1e-6);
  assert.ok(f.cfit < 1e-9);
  const noisy = arc.map((p, i) => ({ re: p.re + (i % 2 ? 3000 : -3000), im: p.im + (i % 3 ? 2000 : -2500) }));
  assert.ok(C.fitCircle(noisy).cfit > 0.1);
  assert.equal(C.fitCircle(arc.slice(0, 2)), null);
});

test('EdaProc：2 点平均消掉逐样本两相交替；阶跃后出 SCR 峰', () => {
  const p = new C.EdaProc();
  let last;
  for (let i = 0; i < 80; i++){
    const G = 10 + (i % 2 ? 0.5 : -0.5);               // 逐样本 ±0.5 µS 交替
    last = p.update(i / 8, [{ re: 1e6 / G, im: 0 }]);
  }
  close(last.G, 10, 0.02, 'de-interleaved');
  close(last.Graw, 10.5, 0.01);
  let peaks = 0;
  for (let i = 80; i < 160; i++){
    const G = i < 100 ? 10 : 11;                         // 阶跃 +1 µS
    if (p.update(i / 8, [{ re: 1e6 / G, im: 0 }]).peak) peaks++;
  }
  assert.ok(peaks >= 1);
});

test('GSR 行解析：millis,adc / 空格 / 只有 adc / 垃圾行', () => {
  assert.deepEqual(C.parseGsrLine('12500,28.417'), { millis: 12500, adc: 28.417 });
  assert.deepEqual(C.parseGsrLine('  12600 28.392 '), { millis: 12600, adc: 28.392 });
  assert.deepEqual(C.parseGsrLine('512'), { millis: null, adc: 512 });
  assert.equal(C.parseGsrLine('hello'), null);
  assert.equal(C.parseGsrLine(''), null);
});

test('GSR 换算：Grove 原式与极性镜像', () => {
  close(C.gsrToOhm(0, false), 10240000 / 512, 1e-9);
  assert.equal(C.gsrToOhm(511, false), null);
  // 镜像后 ADC 越大电阻越小（电导越大）
  assert.ok(C.gsrToOhm(300, true) < C.gsrToOhm(200, true));
  assert.ok(C.gsrToOhm(300, false) > C.gsrToOhm(200, false));
  assert.equal(C.gsrToOhm(0, true), null);
});

/* ---------- 串口时钟 ---------- */
function runClock(lines, opt){
  const clk = new C.SerialClock(opt);
  return lines.map(([dev, arr]) => ({ dev, arr, ...clk.map(dev, arr) }));
}

test('串口时钟：正常 10 Hz，间隔完全来自 millis', () => {
  const lines = Array.from({ length: 100 }, (_, i) => [5000 + i * 100, 1e12 + i * 100 + 3 + (i % 3)]);
  const out = runClock(lines);
  for (let i = 1; i < out.length; i++) close(out[i].hostMs - out[i - 1].hostMs, 100, 1e-9);
  assert.ok(out.every(o => o.event === null));
});

test('串口时钟：主机卡顿 3 s 后一阵积压，时间轴不留永久偏移（旧实现在这个场景下永久偏 900 ms）', () => {
  const lines = [];
  for (let i = 0; i < 300; i++){
    const dev = i * 100;
    let arr = 1e12 + dev + 5;
    if (i >= 100 && i < 130) arr = 1e12 + 130 * 100 + 5;  // 卡顿：这 30 行一起在 13.0 s 到
    lines.push([dev, arr]);
  }
  const out = runClock(lines);
  assert.ok(out.every(o => o.event === null), 'no re-anchor');
  close(out[299].hostMs, 1e12 + 29900 + 5, 1e-6);   // 首行锚点含 5 ms 传输延迟
});

test('串口时钟：板子复位（millis 倒退）立即重锚', () => {
  const lines = [[10_000, 1e12], [10_100, 1e12 + 100], [50, 1e12 + 200], [150, 1e12 + 300]];
  const out = runClock(lines);
  assert.equal(out[2].event, 'reset');
  close(out[2].hostMs, 1e12 + 200, 1e-9);
  close(out[3].hostMs, 1e12 + 300, 1e-9);
});

test('串口时钟：板子钟偏慢 0.3%，持续迟到超阈值才平移，且只平移最小迟到量', () => {
  const lines = [];
  for (let i = 0; i < 12000; i++) lines.push([i * 100 * (1 - 0.003), 1e12 + i * 100 + 5]);   // 20 分钟
  const out = runClock(lines);
  const ev = out.filter(o => o.event);
  assert.ok(ev.length >= 1 && ev.every(o => o.event.startsWith('slow')));
  // 任何时刻映射误差都不超过阈值 + 窗口内漂移
  for (const o of out) assert.ok(o.arr - o.hostMs > -100 && o.arr - o.hostMs < 2000 + 50 * 0.3 + 10);
});

test('串口时钟：板子钟偏快，数据「早到」超阈值时重锚', () => {
  const lines = [];
  for (let i = 0; i < 9000; i++) lines.push([i * 100 * 1.003, 1e12 + i * 100 + 5]);
  const out = runClock(lines);
  assert.ok(out.some(o => o.event && o.event.startsWith('early')));
  for (const o of out) assert.ok(o.hostMs - o.arr <= 2000 + 1);
});
