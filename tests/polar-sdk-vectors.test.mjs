// 用 Polar 官方 SDK（polarofficial/polar-ble-sdk）单元测试里的 PMD 数据包校验 BSCore 的解包和时间戳。
// 官方 SDK 的许可证不允许把它的内容无声明地并入本仓库，所以这里不拷贝任何字节，
// 而是在运行时从本地 SDK 克隆里的 Kotlin 测试文件抽出 byteArrayOf(...)。没有克隆就跳过。
//
//   git clone --depth 1 --filter=blob:none --sparse https://github.com/polarofficial/polar-ble-sdk.git
//   cd polar-ble-sdk && git sparse-checkout set --no-cone '/sources/Android/android-communications/**/pmd/**'
//   POLAR_SDK_DIR=/path/to/polar-ble-sdk node --test
//
// 下面断言里的数字取自官方测试的断言和注释（协议事实），出处写在每个用例名里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadCore } from './helpers/load-core.mjs';

const C = loadCore();
const SDK = process.env.POLAR_SDK_DIR;
const T = SDK && path.join(SDK, 'sources/Android/android-communications/library/src/test/java/com/polar/androidcommunications/api/ble/model/gatt/client/pmd');
const skip = !SDK ? 'POLAR_SDK_DIR not set' : (!existsSync(T) ? 'Polar SDK tests not found under POLAR_SDK_DIR' : false);

// 取 Kotlin 测试文件里某个 `fun \`name\`()` 函数体中 `val <name> = byteArrayOf(...)` 的字节
function sdkBytes(file, fn, name){
  const src = readFileSync(path.join(T, file), 'utf8');
  const start = src.indexOf('fun `' + fn + '`');
  assert.ok(start >= 0, `test ${fn} not found in ${file}`);
  const next = src.indexOf('fun `', start + 5);
  const body = src.slice(start, next < 0 ? undefined : next);
  const m = body.match(new RegExp('val ' + name + '\\s*=\\s*byteArrayOf\\('));
  assert.ok(m, `${name} not found in ${fn}`);
  // 按括号配对找到 byteArrayOf( … ) 的结尾（元素里的 toByte() 自带括号）
  let i = m.index + m[0].length, depth = 1;
  for (; i < body.length && depth > 0; i++) { if (body[i] === '(') depth++; else if (body[i] === ')') depth--; }
  const inner = body.slice(m.index + m[0].length, i - 1);
  return [...inner.matchAll(/0x([0-9A-Fa-f]{1,2})\.toByte\(\)/g)].map(x => parseInt(x[1], 16));
}
const packet = (file, fn, header, content) => Uint8Array.from([...sdkBytes(file, fn, header), ...sdkBytes(file, fn, content)]);
const NS = 1e6;   // BSCore 的设备时间单位是 ms，官方用 ns

test('Polar SDK 官方向量', { skip }, async (t) => {
  await t.test('EcgDataTest「process raw ecg data type 0」：3 字节 µV，时间戳归最后一个样本', () => {
    const pk = C.parsePmdPacket(packet('model/EcgDataTest.kt', 'process raw ecg data type 0', 'ecgDataFrameHeader', 'ecgDataFrameContent'));
    assert.deepEqual(pk.channels, [[-32766, 32770]]);
    assert.equal(pk.devMs, 2000000000 / NS);
    const r = C.packetSampleTimes(pk.devMs, { end: 100 / NS, step: null }, 2, 1000 / 130);
    assert.equal(r.times.at(-1), pk.devMs);
  });

  await t.test('EcgDataTest 帧类型 1 / 2（新设备格式，H10 用帧 0）：标为不支持，不乱解', () => {
    for (const fn of ['process raw ecg data type 1', 'process raw ecg data type 2']) {
      const pk = C.parsePmdPacket(packet('model/EcgDataTest.kt', fn, 'ecgDataFrameHeader', 'ecgDataFrameContent'));
      assert.equal(pk.supported, false, fn);
    }
  });

  await t.test('AccDataTest「process acc raw data frame type 1」：H10 未压缩 16 bit 三轴', () => {
    const content = sdkBytes('model/AccDataTest.kt', 'process acc raw data frame type 1', 'accDataFrameContent');
    const pk = C.parsePmdPacket(packet('model/AccDataTest.kt', 'process acc raw data frame type 1', 'accDataFrameHeader', 'accDataFrameContent'));
    assert.equal(pk.channels[0].length, content.length / 6);
    assert.deepEqual(pk.channels.map(c => c.slice(0, 2)), [[-9, -8], [-1, -2], [999, 997]]);
    // 逐样本对照独立实现（Int16 小端）
    const dv = new DataView(Uint8Array.from(content).buffer);
    for (let s = 0; s < content.length / 6; s++)
      for (let c = 0; c < 3; c++) assert.equal(pk.channels[c][s], dv.getInt16(s * 6 + c * 2, true));
  });

  await t.test('AccDataTest「process acc compressed data type 0」：Verity Sense 压缩帧，10 bit 增量 56 个', () => {
    const fn = 'process acc compressed data type 0';
    const pk = C.parsePmdPacket(packet('model/AccDataTest.kt', fn, 'accDataFrameHeader', 'accDataFrameContent'));
    assert.equal(pk.compressed, true);
    assert.equal(pk.truncated, false);
    assert.equal(pk.channels[0].length, 57);
    assert.deepEqual(pk.channels.map(c => c[0]), [1905, 27376, -29282]);
    assert.deepEqual(pk.channels.map(c => c[1]), [1905 + 190, 27376 - 105, -29282 - 85]);
    // 官方测试用 factor 2.44e-4（±8 g）换成 mG，写法是 (factor * sample * 1000f).toInt()。
    // 换算后每个样本都在量程内，说明 56 个增量全部解对，没有累加跑飞
    const factor = 2.44e-4;
    const mg = C.applyPmdFactor(pk, factor);
    const expect = v => Math.trunc(Math.fround(Math.fround(Math.fround(factor) * v) * 1000));
    assert.deepEqual(mg.map(c => c.slice(0, 2)), [[expect(1905), expect(1905 + 190)], [expect(27376), expect(27376 - 105)], [expect(-29282), expect(-29282 - 85)]]);
    for (const ch of mg) for (const v of ch) assert.ok(Math.abs(v) <= 8000, `out of range ${v}`);
  });

  await t.test('AccDataTest「process acc compressed data type 1」：帧 0x81，6 bit 负增量', () => {
    const fn = 'process acc compressed data type 1';
    const pk = C.parsePmdPacket(packet('model/AccDataTest.kt', fn, 'accDataFrameHeader', 'accDataFrameContent'));
    assert.deepEqual(pk.channels, [[-15, -20], [20, 17], [1008, 1008]]);
  });

  await t.test('PpgDataTest「test raw PPG frame type 0」：4 通道 × 3 字节', () => {
    const pk = C.parsePmdPacket(packet('model/PpgDataTest.kt', 'test raw PPG frame type 0', 'ppgDataFrameHeader', 'ppgDataFrameContent'));
    assert.deepEqual(pk.channels, [[197121, -1], [394500, -1052913], [8388607, -8388608], [0, -1052913]]);
  });

  await t.test('PpgDataTest「test compressed PPG frame type 0」：Verity Sense 压缩 PPG，41 个 10 bit 增量', () => {
    const pk = C.parsePmdPacket(packet('model/PpgDataTest.kt', 'test compressed PPG frame type 0', 'ppgDataFrameHeader', 'ppgDataFrameContent'));
    assert.equal(pk.truncated, false);
    assert.equal(pk.channels[0].length, 42);
    assert.deepEqual(pk.channels.map(c => c[0]), [11564, 30658, -11565, -30659]);
    assert.deepEqual(pk.channels.map(c => c[1]), [11564 + 178, 30658 - 68, -11565 - 178, -30659 + 68]);
  });

  await t.test('PmdTimeStampUtilsTest：首包按采样率倒推、后续包按相邻时间戳均分，最后一个样本 = 包时间戳', () => {
    const ms = ns => ns / NS;
    // 「samples time stamps based on frequency」
    let r = C.packetSampleTimes(ms(10000000000), undefined, 10, 1000);
    assert.deepEqual(r.times, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(s => s * 1000));
    // 「samples time based on frequency only one sample」
    assert.deepEqual(C.packetSampleTimes(ms(1000000000), undefined, 1, 1000).times, [1000]);
    // 「samples time stamps based on previous time stamp test 1」
    r = C.packetSampleTimes(ms(11000000000), { end: ms(1000000000), step: 1000 }, 10, 1000);
    assert.deepEqual(r.times, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(s => s * 1000));
    // 「samples time stamps based on previous time stamp test 2」：本工具时间戳精度 1 µs
    r = C.packetSampleTimes(ms(2000000000), { end: ms(100), step: 1000 }, 3, 1000);
    [666666733, 1333333367, 2000000000].forEach((ns, i) => assert.ok(Math.abs(r.times[i] - ms(ns)) <= 0.0005, `${r.times[i]} vs ${ms(ns)}`));
    // 「samples time stamps based on previous time stamp only one sample」
    assert.deepEqual(C.packetSampleTimes(ms(2000000000), { end: ms(1000000000), step: 1000 }, 1, 1000).times, [2000]);
  });
});
