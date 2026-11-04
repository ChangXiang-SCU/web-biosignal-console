import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './helpers/load-core.mjs';

const C = loadCore();
const E = C.EPOCH_2000_TO_1970;

test('CSV 列块：表头与数据一一对应，每块自带三个时间列', () => {
  const blocks = [
    { dev: 'Polar H10 A', x: [0, 7.692, 15.385], cols: { ECG: [10, -20, 30] }, offset: 100 },
    { dev: 'Polar H10 B', x: [5, 12.692],        cols: { ECG: [1, 2] },        offset: -50 },
  ];
  const { header, rows } = C.csvDeviceBlocks(blocks, ['ECG']);
  assert.equal(header, 'DevTime_us,unix_dev_ms,unix_host_ms,ECG,DevTime_us,unix_dev_ms,unix_host_ms,ECG');
  assert.equal(rows.length, 3);
  const r0 = rows[0].split(',');
  assert.equal(r0.length, 8);
  assert.deepEqual(r0.slice(0, 4), ['0', E.toFixed(3), (E + 100).toFixed(3), '10']);
  assert.deepEqual(r0.slice(4), ['5000', (E + 5).toFixed(3), (E + 5 - 50).toFixed(3), '1']);
  // 短的设备块补空，列数不变
  const r2 = rows[2].split(',');
  assert.equal(r2.length, 8);
  assert.deepEqual(r2.slice(4), ['', '', '', '']);
  assert.equal(r2[3], '30');
});

test('CSV 列块：@设备名后缀；增量游标 start/end', () => {
  const b = { dev: 'GSR 1a86:7523', x: [0, 100, 200, 300], cols: { GSR_raw: [1, 2, 3, 4], GSR_uS: [0.1, 0.2, '', 0.4] }, start: 2, end: 4 };
  const { header, rows } = C.csvDeviceBlocks([b], ['GSR_raw', 'GSR_uS'], { suffixDevice: true });
  assert.equal(header.split(',')[0], 'DevTime_us@GSR 1a86:7523');
  assert.equal(header.split(',').length, 5);
  assert.deepEqual(rows.map(r => r.split(',').slice(3)), [['3', ''], ['4', '0.4']]);
});

test('CSV 列块：空 blocks → 空表；字段清洗去掉逗号换行', () => {
  assert.deepEqual(C.csvDeviceBlocks([], ['ECG']), { header: '', rows: [] });
  assert.equal(C.csvField('a,b\r\nc'), 'a b c');
  assert.equal(C.csvField(null), '');
});
