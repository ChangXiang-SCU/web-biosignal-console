// 端到端：用 Playwright 打开 polarconsole_eda.html（file://，和双击打开一样）。
// 没装 playwright 或者起不来浏览器时自动跳过，不影响 `node --test` 跑其余单元测试。
//   1. 页面加载无 JS 错误；外网（字体、Plotly CDN）不通时也不报错
//   2. 不支持 Web Bluetooth / Web Serial 的浏览器：横幅说明 + 点按钮有提示，按钮不卡死
//   3. 假 Polar H10 + 假串口 GSR 走完整流程：连接 → 录制 → H10 掉线、首次重连失败 → 自动重连
//      → 停止落盘；核对 FULL / AUTO CSV 的表头、时间戳、数值、LINK EVENTS、SYNC
//   4. 假 Verity Sense 的压缩帧和 FACTOR；重连竞态两种；H10 重启后 RTC 归零
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { HTML_PATH } from './helpers/load-core.mjs';

const require = createRequire(import.meta.url);
let chromium = null, skipReason = false;
try { ({ chromium } = require('playwright')); } catch { skipReason = 'playwright not installed'; }

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = readFileSync(path.join(here, 'helpers', 'fake-devices.js'), 'utf8');
const URL_ = pathToFileURL(HTML_PATH).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openPage(browser, { locale = 'en-US', init = null, offline = true } = {}) {
  const ctx = await browser.newContext({ locale, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [], downloads = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource|ERR_(FAILED|INTERNET|NAME|TUNNEL|CONNECTION)/.test(m.text())) errors.push('console: ' + m.text());
  });
  page.on('download', d => downloads.push(d));
  if (offline) await page.route(/^https?:/, r => r.abort());
  if (init) await page.addInitScript(init);
  await page.goto(URL_);
  return { ctx, page, errors, downloads };
}

function section(csv, startsWith) {
  const lines = (csv.charCodeAt(0) === 0xFEFF ? csv.slice(1) : csv).split(/\r?\n/);
  const i = lines.findIndex(l => l.startsWith(startsWith));
  return i < 0 ? null : lines.slice(i);
}
function table(csv) {
  const lines = section(csv, 'DevTime_us');
  assert.ok(lines, 'data header not found');
  const header = lines[0].split(',');
  const rows = [];
  for (const l of lines.slice(1)) { if (!l) break; rows.push(l.split(',')); }
  return { header, rows };
}

test('page e2e', { skip: skipReason, timeout: 180_000 }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); }
  catch (e) { t.skip('chromium failed to launch: ' + e.message); return; }

  try {
    await t.test('加载无 JS 错误；离线时 Plotly 缺失有横幅', async () => {
      const { ctx, page, errors } = await openPage(browser);
      await sleep(800);
      assert.equal(await page.isVisible('#plotlyBanner'), true);
      assert.equal(await page.evaluate(() => typeof BSCore.parsePmdPacket), 'function');
      assert.deepEqual(errors, []);
      await ctx.close();
    });

    await t.test('不支持 Web Bluetooth / Web Serial 的浏览器：横幅 + 点击提示，按钮不卡死', async () => {
      const strip = () => {
        delete Navigator.prototype.bluetooth; delete Navigator.prototype.serial;
        delete window.showDirectoryPicker;
      };
      for (const locale of ['zh-CN', 'en-US']) {
        const { ctx, page, errors } = await openPage(browser, { locale, init: strip });
        assert.equal(await page.isVisible('#compatBanner'), true, 'banner visible');
        const keys = await page.$$eval('#compatBanner div', ds => ds.map(d => d.dataset.key));
        assert.deepEqual(keys, ['compat.nobt', 'compat.noserial', 'compat.nofs']);
        const bannerText = await page.textContent('#compatBanner');
        assert.match(bannerText, /Web Bluetooth/);
        assert.match(bannerText, locale === 'zh-CN' ? /Chrome 或 Edge/ : /Chrome or Edge/);

        const dialogs = [];
        page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
        await page.click('#Sense');
        await page.click('#btnEDA');
        await page.click('#btnGSR');
        await sleep(200);
        assert.equal(dialogs.length, 3, JSON.stringify(dialogs));
        assert.match(dialogs[0], /Web Bluetooth/);
        assert.match(dialogs[1], /Web Bluetooth/);
        assert.match(dialogs[2], /Web Serial/);
        for (const id of ['#Sense', '#btnEDA', '#btnGSR']) assert.equal(await page.isDisabled(id), false, id + ' stuck disabled');
        assert.deepEqual(errors, []);
        await ctx.close();
      }
    });

    await t.test('支持的浏览器：不出兼容横幅', async () => {
      const { ctx, page, errors } = await openPage(browser, { init: FAKE });
      await sleep(300);
      assert.equal(await page.isVisible('#compatBanner'), false);
      assert.deepEqual(errors, []);
      await ctx.close();
    });

    await t.test('假 H10 + 假 GSR：录制、掉线重连、落盘 CSV', async () => {
      const { ctx, page, errors, downloads } = await openPage(browser, { locale: 'zh-CN', init: FAKE });
      page.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });

      // 故意先连 GSR 再连 H10：旧版 FULL_ECG 的第一组表头会是 @GSR，数据却是 H10 的
      await page.click('#btnGSR');
      await page.waitForSelector('[id="card_GSR_1a86_7523"]');
      await page.click('#btnAddDev');                      // 空状态里的「连接传感器」此时已隐藏
      await page.waitForSelector('[id="card_Polar_H10_TEST0001"]');
      await page.click('#btnRec');
      await page.waitForFunction(() => recordingActive === true);

      await sleep(3500);
      await page.evaluate(() => window.__fake.polar.simulateDrop(600));   // 第 1 次重连（0.4 s）失败，第 2 次（1.2 s）成功
      await page.waitForFunction(() => window.dropLog.some(e => e.ev === 'reconnect'), null, { timeout: 15_000 });
      assert.equal(await page.isVisible('[id="card_Polar_H10_TEST0001"]'), true, 'card kept during reconnect');
      await sleep(3000);
      const nowAtStop = await page.evaluate(() => Date.now());
      await page.click('#btnRec');
      await page.waitForFunction(() => recordingActive === false);
      await sleep(1500);

      const st = await page.evaluate(() => ({
        log: window.dropLog.map(e => ({ dev: e.dev, ev: e.ev, detail: e.detail })),
        fakeLog: window.__fake.polar.log,
        packets: window.__fake.polar.running[0].packets,
        accPackets: window.__fake.polar.running[2].packets,
        fullECG: buildDataMatrixOnlyCsv(['ECG'], 'ECG'),
        fullACC: buildDataMatrixOnlyCsv(['acc_x', 'acc_y', 'acc_z', 'acc_v'], 'ACC'),
        fullGSR: buildDataMatrixOnlyCsv(['GSR_raw', 'GSR_uS', 'GSR_ohm'], 'GSR'),
        rawECG: DataObjectToCSV(['ECG'], 'ECG'),
        ecgValues: Array.from({ length: 2000 }, (_, k) => window.__fake.ecgValue(k)),
      }));

      // ---- LINK EVENTS ----
      const evs = st.log.filter(e => e.dev === 'Polar H10 TEST0001').map(e => e.ev);
      for (const ev of ['pmd-start', 'disconnect', 'reconnect', 'gap']) assert.ok(evs.includes(ev), `missing ${ev}: ${evs}`);
      assert.ok(st.fakeLog.includes('connect-fail'), 'first reconnect attempt should have failed');
      const reconnect = st.log.find(e => e.ev === 'reconnect');
      assert.match(reconnect.detail, /第 2 次成功/);
      assert.match(reconnect.detail, /ECG/);
      assert.match(reconnect.detail, /ACC_H10/);

      // ---- FULL ECG ----
      assert.ok(section(st.fullECG, 'SYNC summary'), 'FULL file carries SYNC summary');
      assert.ok(section(st.fullECG, 'LINK EVENTS (unix_host_ms'), 'FULL file carries LINK EVENTS');
      const ecg = table(st.fullECG);
      assert.deepEqual(ecg.header, ['DevTime_us', 'unix_dev_ms', 'unix_host_ms', 'ECG'].map(c => c + '@Polar H10 TEST0001'),
        'only the H10 block, even though GSR was connected first');
      const nPk = st.packets.length;
      assert.equal(ecg.rows.length, nPk * 73);
      ecg.rows.forEach((r, k) => assert.equal(Number(r[3]), st.ecgValues[k] + 0, `ECG value row ${k}`));   // +0：-0 归一
      // 每包最后一个样本 = 包时间戳
      for (const p of st.packets) assert.ok(Math.abs(Number(ecg.rows[p.k0 + p.n - 1][0]) - p.end * 1000) <= 1, 'last sample = packet ts');
      // 设备钟 2019 年；主机时间轴在今天
      assert.equal(new Date(Number(ecg.rows[0][1])).getUTCFullYear(), 2019);
      const lastHost = Number(ecg.rows.at(-1)[2]);
      assert.ok(nowAtStop - lastHost > -100 && nowAtStop - lastHost < 2000, `host axis near wall clock: ${nowAtStop - lastHost}`);
      // 时间单调；连续段里间隔 = 实测 ODR；掉线处只有一个大缺口
      const dt = ecg.rows.slice(1).map((r, i) => Number(r[1]) - Number(ecg.rows[i][1]));
      assert.ok(dt.every(d => d > 0), 'monotonic');
      const big = dt.filter(d => d > 50);
      assert.equal(big.length, 1, 'exactly one gap: ' + big);
      assert.ok(big[0] > 600, 'gap reflects the disconnect');
      const steady = dt.slice(146).filter(d => d < 50);
      for (const d of steady) assert.ok(Math.abs(d - 1000 / 129.9) < 0.01, `ECG step ${d}`);

      // ---- FULL ACC ----
      const acc = table(st.fullACC);
      assert.equal(acc.header.length, 7);
      assert.equal(acc.rows.length, st.accPackets.length * 36);
      for (const r of acc.rows.slice(0, 50)) {
        const [x, y, z, v] = r.slice(3).map(Number);
        assert.equal(v, Math.round(Math.hypot(x, y, z)), 'acc_v = |a|');
      }

      // ---- FULL GSR ----
      const gsr = table(st.fullGSR);
      assert.equal(gsr.header[0], 'DevTime_us@GSR 1a86:7523');
      assert.ok(gsr.rows.length > 60, 'GSR rows ' + gsr.rows.length);
      const gdt = gsr.rows.slice(1).map((r, i) => Number(r[1]) - Number(gsr.rows[i][1]));
      // 间隔来自板子 millis（100 ms），串口时钟追踪漂移时最多拉伸或压缩 1%；时间轴必须单调
      for (const d of gdt) assert.ok(d >= 99 - 1e-3 && d <= 101 + 1e-3, `GSR step ${d}`);
      assert.ok(gsr.rows.every(r => r[3] !== '' && r[4] !== ''), 'GSR raw / uS present');

      // ---- RAW 手动导出：逐包 SYNC 只带 ECG 这一路 ----
      const sync = section(st.rawECG, 'SYNC per-packet');
      assert.ok(sync);
      const rest = sync.slice(2);
      const syncData = rest.slice(0, rest.indexOf(''));
      assert.ok(syncData.length >= nPk - 1);
      assert.ok(syncData.every(l => l.startsWith('Polar H10 TEST0001,ECG,')), 'per-packet sync filtered to ECG');

      // ---- 停止时自动落盘（没选文件夹 → 浏览器下载）：AUTO + FULL ----
      const names = downloads.map(d => d.suggestedFilename());
      for (const g of ['ECG', 'ACC', 'GSR']) {
        assert.ok(names.some(n => n.includes('FULL_') && n.endsWith(`_${g}.csv`)), `FULL ${g} downloaded: ${names}`);
        assert.ok(names.some(n => n.includes('AUTO_') && n.endsWith(`_${g}.csv`)), `AUTO ${g} downloaded: ${names}`);
      }
      const autoECG = downloads.find(d => d.suggestedFilename().includes('AUTO_') && d.suggestedFilename().endsWith('_ECG.csv'));
      const autoText = readFileSync(await autoECG.path(), 'utf8');
      const autoSync = section(autoText, 'SYNC per-packet').slice(2);
      const autoSyncRows = autoSync.slice(0, autoSync.indexOf(''));
      assert.ok(autoSyncRows.length >= nPk - 1, 'AUTO ECG has its own per-packet SYNC rows');
      assert.ok(autoSyncRows.every(l => l.startsWith('Polar H10 TEST0001,ECG,')), 'AUTO ECG per-packet SYNC = ECG only');
      const autoTbl = table(autoText);
      assert.equal(autoTbl.header.length, 4, 'AUTO ECG: only the H10 block');

      assert.deepEqual(errors, []);
      await ctx.close();
    });

    await t.test('假 Verity Sense：压缩 ACC（9 bit 奇数位宽 + FACTOR）和压缩 PPG（11 bit）', async () => {
      const { ctx, page, errors } = await openPage(browser, { locale: 'zh-CN', init: FAKE });
      page.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
      await page.evaluate(() => { window.__fake.next = 'sense'; });
      await page.click('#Sense');
      await page.waitForSelector('[id="card_Polar_Sense_TEST0002"]');
      await page.click('#btnRec');
      await page.waitForFunction(() => recordingActive === true);
      await sleep(2500);
      await page.click('#btnRec');
      await page.waitForFunction(() => recordingActive === false);
      await sleep(500);

      const st = await page.evaluate(() => {
        const F = window.__fake, dev = 'Polar Sense TEST0002';
        const accPk = F.sense.running[2].packets, ppgPk = F.sense.running[1].packets;
        const k = Math.fround(F.SENSE_ACC_FACTOR * 1000);
        const nAcc = accPk.length * 36, nPpg = ppgPk.length * 25;
        return {
          accPk, ppgPk,
          accExpect: Array.from({ length: nAcc }, (_, i) => F.senseAccRaw(i).map(v => Math.trunc(Math.fround(v * k)) + 0)),   // +0：-0 归一
          ppgExpect: Array.from({ length: nPpg }, (_, i) => F.sensePpgRaw(i)),
          fullACC: buildDataMatrixOnlyCsv(['acc_x', 'acc_y', 'acc_z', 'acc_v'], 'ACC'),
          fullPPG: buildDataMatrixOnlyCsv(streamsPresent(PPG_EXPORT_COLUMNS), 'PPG'),
          log: window.dropLog.filter(e => e.dev === dev).map(e => e.ev + ' ' + e.detail),
        };
      });

      // 启动应答里的 FACTOR 进了 LINK EVENTS
      assert.ok(st.log.some(l => l.startsWith('pmd-start ACC Success factor 0.0002')), st.log.join(' | '));

      const acc = table(st.fullACC);
      assert.equal(acc.header[0], 'DevTime_us@Polar Sense TEST0002');
      assert.equal(acc.rows.length, st.accPk.length * 36);
      acc.rows.forEach((r, i) => {
        const [x, y, z, v] = r.slice(3).map(Number);
        assert.deepEqual([x, y, z], st.accExpect[i], `ACC row ${i}`);
        assert.equal(v, Math.round(Math.hypot(x, y, z)));
      });
      // 静止那一轴（z ≈ 4096 计数）换算后约 1 g = 1000 mG
      assert.ok(Math.abs(Number(acc.rows[0][5]) - 1000) < 20, 'z ≈ 1 g in mG: ' + acc.rows[0][5]);
      for (const p of st.accPk) assert.ok(Math.abs(Number(acc.rows[p.k0 + p.n - 1][0]) - p.end * 1000) <= 1, 'ACC last sample = packet ts');

      const ppg = table(st.fullPPG);
      assert.deepEqual(ppg.header.slice(3, 7), ['PPG0', 'PPG1', 'PPG2', 'ambient'].map(c => c + '@Polar Sense TEST0002'));
      assert.equal(ppg.rows.length, st.ppgPk.length * 25);
      ppg.rows.forEach((r, i) => assert.deepEqual(r.slice(3, 7).map(Number), st.ppgExpect[i], `PPG row ${i}`));
      for (const p of st.ppgPk) assert.ok(Math.abs(Number(ppg.rows[p.k0 + p.n - 1][0]) - p.end * 1000) <= 1, 'PPG last sample = packet ts');

      assert.deepEqual(errors, []);
      await ctx.close();
    });

    async function startH10(locale = 'zh-CN'){
      const o = await openPage(browser, { locale, init: FAKE });
      o.page.on('dialog', d => { o.errors.push('dialog: ' + d.message()); d.dismiss(); });
      await o.page.click('#Sense');
      await o.page.waitForSelector('[id="card_Polar_H10_TEST0001"]');
      await o.page.click('#btnRec');
      await o.page.waitForFunction(() => recordingActive === true);
      await sleep(1500);
      return o;
    }

    await t.test('重连恢复数据流时又断开：只有一个重连循环，最后两路都在录', async () => {
      const { ctx, page, errors } = await startH10();
      await page.evaluate(() => {
        const P = window.__fake.polar;
        P.writeDelay = 60;
        let armed = false;
        P.simulateDrop(0);
        // 第一次重连成功、正在发第一条开始命令时再断一次，之后 3 s 内连不上
        P.onWrite = (u8, conn) => { if (!armed && u8[0] === 2 && conn >= 2) { armed = true; setTimeout(() => P.simulateDrop(3000), 10); } };
      });
      await page.waitForFunction(() => {
        const P = window.__fake.polar;
        return window.dropLog.some(e => e.ev === 'reconnect') && P.gatt.connected && P.running[0]?.timer && P.running[2]?.timer;
      }, null, { timeout: 30_000 });
      await sleep(2000);   // 如果还有第二个循环在跑，这段时间里会再连一次、再记一条 reconnect
      const st = await page.evaluate(() => {
        const P = window.__fake.polar;
        const writes = P.log.filter(l => l.startsWith('write '));
        const lastConn = Math.max(...writes.map(l => Number(l.split('@conn')[1])));
        return {
          reconnects: window.dropLog.filter(e => e.ev === 'reconnect').map(e => e.detail),
          flags: streamFlags['Polar H10 TEST0001'], rec: recordingActive,
          startsOnLast: writes.filter(l => l.endsWith('@conn' + lastConn) && l.startsWith('write 2 ')).map(l => l.split(' ')[2]),
          connectedAt: P.connId, lastConn, connected: P.gatt.connected,
        };
      });
      assert.equal(st.reconnects.length, 1, JSON.stringify(st.reconnects));
      assert.match(st.reconnects[0], /恢复 ECG\+ACC_H10/);
      assert.deepEqual(st.flags, { ECG: true, ACC_H10: true });
      assert.equal(st.rec, true);
      assert.equal(st.connected, true);
      assert.equal(st.lastConn, st.connectedAt, 'no newer connection opened by a second loop');
      assert.deepEqual(st.startsOnLast.sort(), ['0', '2'], 'each stream started exactly once on the live link');
      assert.deepEqual(errors, []);
      await ctx.close();
    });

    await t.test('重连恢复数据流时点停止：停掉的流不会被重新打开', async () => {
      const { ctx, page, errors } = await startH10();
      await page.evaluate(() => {
        const P = window.__fake.polar;
        let armed = false;
        P.simulateDrop(0);
        // 重连成功后刚发出 ECG 的开始命令，用户就点了停止
        P.onWrite = (u8, conn) => { if (!armed && u8[0] === 2 && u8[1] === 0 && conn >= 2) { armed = true; setTimeout(() => UI.toggleRecord(), 30); } };
      });
      await page.waitForFunction(() => window.dropLog.some(e => e.ev === 'reconnect'), null, { timeout: 15_000 });
      await sleep(1000);
      const st = await page.evaluate(() => ({
        rec: recordingActive, flags: streamFlags['Polar H10 TEST0001'],
        running: Object.fromEntries(Object.entries(window.__fake.polar.running).map(([k, v]) => [k, !!v.timer])),
        btn: document.getElementById('btnRec').textContent,
      }));
      assert.equal(st.rec, false);
      assert.deepEqual(st.flags, { ECG: false, ACC_H10: false });
      assert.deepEqual(st.running, { 0: false, 2: false }, 'device is not streaming any more');
      assert.equal(st.btn, '开始录制');
      assert.deepEqual(errors, []);
      await ctx.close();
    });

    await t.test('H10 重启、RTC 回到出厂时刻：重连后时间轴接上、不倒退、不丢包', async () => {
      const { ctx, page, errors } = await startH10();
      const tDrop = await page.evaluate(() => { window.__fake.polar.simulateReboot(0); return Date.now(); });
      await page.waitForFunction(() => window.dropLog.some(e => e.ev === 'reconnect'), null, { timeout: 15_000 });
      const tBack = await page.evaluate(() => Date.now());
      await sleep(2500);
      await page.click('#btnRec');
      await page.waitForFunction(() => recordingActive === false);
      await sleep(300);
      const st = await page.evaluate(() => ({
        evs: window.dropLog.map(e => e.ev + ' ' + e.detail),
        packets: window.__fake.polar.running[0].packets,
        fullECG: buildDataMatrixOnlyCsv(['ECG'], 'ECG'),
        fullACC: buildDataMatrixOnlyCsv(['acc_x', 'acc_y', 'acc_z', 'acc_v'], 'ACC'),
        ecgValues: Array.from({ length: 2000 }, (_, k) => window.__fake.ecgValue(k)),
      }));
      const jumps = st.evs.filter(e => e.startsWith('clock-jump'));
      assert.equal(jumps.length, 1, st.evs.join(' | '));
      assert.ok(!st.evs.some(e => e.startsWith('clock-backwards')), 'no packet dropped as backwards');
      for (const [csv, label] of [[st.fullECG, 'ECG'], [st.fullACC, 'ACC']]) {
        const tb = table(csv);
        const host = tb.rows.map(r => Number(r[2]));
        for (let i = 1; i < host.length; i++) assert.ok(host[i] > host[i - 1], `${label} unix_host_ms monotonic at ${i}`);
        const big = host.slice(1).map((h, i) => h - host[i]).filter(d => d > 50);
        assert.equal(big.length, 1, `${label}: one gap ${big}`);
        assert.ok(big[0] > 200 && big[0] < tBack - tDrop + 1500, `${label} gap ${big[0]} vs outage ${tBack - tDrop}`);
      }
      const ecg = table(st.fullECG);
      assert.equal(ecg.rows.length, st.packets.length * 73, 'every packet kept');
      ecg.rows.forEach((r, k) => assert.equal(Number(r[3]), st.ecgValues[k] + 0, `ECG value row ${k}`));
      assert.deepEqual(errors, []);
      await ctx.close();
    });
  } finally {
    await browser.close();
  }
});
