/* 注入到页面里的假设备（Playwright addInitScript 用）。
   window.__fake.polar：假 Polar H10，走真实的 PMD 控制/数据特征流程，按真实 ODR 发 ECG / ACC 包，
                         设备时钟停在 2019 年（和实测 H10 一样），可以模拟掉线、首次重连失败、重启后 RTC 归零。
   window.__fake.sense：假 Verity Sense，发压缩帧：ACC 9 bit（奇数位宽）增量、启动应答带 FACTOR，
                         PPG 11 bit 增量。把 window.__fake.next 设成 'sense'，下一次「连接传感器」选到它。
   window.__fake.port： 假 Arduino GSR 串口，10 Hz 输出 "millis,adc"。
   只在测试里用，页面本身不加载这个文件。 */
(function(){
  const PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
  const PMD_CONTROL = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
  const PMD_DATA    = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';
  const EPOCH = 946684800000;

  function header(type, devMs, frameType){
    const h = new Uint8Array(10); h[0] = type;
    let ns = BigInt(Math.round(devMs * 1e6));
    for(let i = 0; i < 8; i++){ h[1 + i] = Number(ns & 0xffn); ns >>= 8n; }
    h[9] = frameType; return h;
  }
  function intLE(out, v, n){ let u = v < 0 ? v + 2 ** (8 * n) : v; for(let i = 0; i < n; i++){ out.push(u % 256); u = Math.floor(u / 256); } }

  // 采样值是样本序号的确定函数，测试端可以按同一公式核对
  const ecgValue = k => (k % 50 === 0 ? 40000 : Math.round(1500 * Math.sin(2 * Math.PI * k / 130)));
  const accValue = k => [k % 1000 - 500, -(k % 700), 1000];

  const H10_STREAMS = {
    0: { n: 73, step: 1000 / 129.9, build(devEnd, k0){ const b = []; for(let i = 0; i < 73; i++) intLE(b, ecgValue(k0 + i), 3); return [header(0, devEnd, 0), b]; } },
    2: { n: 36, step: 177.65 / 36,  build(devEnd, k0){ const b = []; for(let i = 0; i < 36; i++) for(const v of accValue(k0 + i)) intLE(b, v, 2); return [header(2, devEnd, 1), b]; } },
  };

  // 增量压缩帧：参考样本 + 一块 bits 位宽、LSB-first 交错打包的增量
  function deltaBody(samples, refBytes, bits){
    const b = [];
    for(const v of samples[0]) intLE(b, v, refBytes);
    const deltas = [];
    for(let s = 1; s < samples.length; s++) samples[s].forEach((v, c) => deltas.push(v - samples[s - 1][c]));
    b.push(bits, samples.length - 1);
    const packed = new Uint8Array(Math.ceil(deltas.length * bits / 8));
    let bp = 0;
    for(const d of deltas){
      if(d < -(2 ** (bits - 1)) || d >= 2 ** (bits - 1)) throw new Error('delta does not fit ' + d);
      const u = d < 0 ? d + 2 ** bits : d;
      for(let k = 0; k < bits; k++, bp++) if(Math.floor(u / 2 ** k) % 2) packed[bp >> 3] |= 1 << (bp & 7);
    }
    return b.concat(Array.from(packed));
  }
  // Verity Sense 的原始计数（±8 g 时约 4096 计数 = 1 g）；相邻样本差落在 9 bit / 11 bit 范围内
  const senseAccRaw = k => [Math.round(2000 * Math.sin(k / 10)), Math.round(-1500 * Math.cos(k / 7)), 4096 + (k % 50) - 25];
  const sensePpgRaw = k => [100000 + Math.round(500 * Math.sin(k / 5)), 90000 + Math.round(400 * Math.cos(k / 6)), 80000 + (k % 40), 1000 + (k % 7)];
  const SENSE_ACC_FACTOR = Math.fround(2.44e-4);
  const SENSE_STREAMS = {
    2: { n: 36, step: 1000 / 416, build(devEnd, k0){ const smp = []; for(let i = 0; i < 36; i++) smp.push(senseAccRaw(k0 + i)); return [header(2, devEnd, 0x80), deltaBody(smp, 2, 9)]; } },
    1: { n: 25, step: 1000 / 176, build(devEnd, k0){ const smp = []; for(let i = 0; i < 25; i++) smp.push(sensePpgRaw(k0 + i)); return [header(1, devEnd, 0x80), deltaBody(smp, 3, 11)]; } },
  };
  const f32le = v => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return Array.from(b); };
  const SENSE_PARAMS = { 2: [0x05, 0x01, ...f32le(SENSE_ACC_FACTOR)], 1: [0x05, 0x01, ...f32le(1.0)] };

  class FakePolar extends EventTarget {
    constructor(name, streams, params){
      super();
      this.name = name;
      this.streams = streams;
      this.params = params || {};
      this.dev0 = Date.UTC(2019, 5, 1) - EPOCH;   // RTC 没对过表（实测 H10 停在 2019 年）
      this.wall0 = Date.now();
      this.failUntil = 0;
      this.log = [];
      this.running = {};                          // type -> {timer, lastEnd, k}
      const self = this;
      this.gatt = {
        connected: false,
        async connect(){
          if(Date.now() < self.failUntil){ self.log.push('connect-fail'); throw new Error('fake connect failure'); }
          self.gatt.connected = true; self.log.push('connect');
          return self._server();
        },
        disconnect(){ self._drop(false); }
      };
    }
    devNow(){ return this.dev0 + (Date.now() - this.wall0); }
    _server(){
      const self = this;
      const svc = { device: self };
      const mkChar = () => { const c = new EventTarget(); c.service = svc; c.value = null;
        c.startNotifications = async () => c; c.stopNotifications = async () => c; return c; };
      const ctrl = mkChar(), data = mkChar();
      this.ctrl = ctrl; this.data = data;
      const myConn = (self.connId = (self.connId || 0) + 1);   // 每次 connect 一个编号，断开后旧连接上的写会失败
      ctrl.writeValue = async (u8) => {
        if(!self.gatt.connected) throw new Error('GATT disconnected');
        u8 = new Uint8Array(u8.buffer ? u8.buffer.slice(u8.byteOffset || 0) : u8);
        self.log.push('write ' + Array.from(u8).join(' ') + ' @conn' + myConn);
        // 测试钩子：onWrite 在写入时触发（用来在恢复数据流的过程中掉线或点停止），writeDelay 模拟写入耗时
        if(self.onWrite) self.onWrite(u8, myConn);
        if(self.writeDelay) await new Promise(r => setTimeout(r, self.writeDelay));
        if(!self.gatt.connected || self.connId !== myConn) throw new Error('GATT disconnected during write');
        const op = u8[0], type = u8[1];
        if(op === 2) self._start(type); else if(op === 3) self._stop(type);
        const extra = op === 2 ? (self.params[type] || []) : [];
        setTimeout(() => { ctrl.value = new DataView(Uint8Array.from([0xF0, op, type, 0x00, 0x00, ...extra]).buffer); ctrl.dispatchEvent(new Event('characteristicvaluechanged')); }, 5);
      };
      ctrl.writeValueWithoutResponse = ctrl.writeValue;
      svc.getCharacteristic = async (uuid) => { if(uuid === PMD_CONTROL) return ctrl; if(uuid === PMD_DATA) return data; throw new Error('no char ' + uuid); };
      return { device: self, getPrimaryService: async (uuid) => { if(uuid !== PMD_SERVICE) throw new Error('no service ' + uuid); return svc; } };
    }
    _start(type){
      const S = this.streams[type]; if(!S) return;
      const r = this.running[type] || (this.running[type] = { lastEnd: null, k: 0, sent: 0 });
      if(r.timer) return;
      // 断开期间设备时钟照走，这段时间的样本就丢了（真机就是这样）
      r.lastEnd = Math.max(r.lastEnd ?? -Infinity, this.devNow() - S.n * S.step);
      r.timer = setInterval(() => {
        if(!this.gatt.connected) return;
        const end = r.lastEnd + S.n * S.step;
        const [h, b] = S.build(end, r.k);
        const pk = new Uint8Array(h.length + b.length); pk.set(h, 0); pk.set(Uint8Array.from(b), h.length);
        r.packets = r.packets || []; r.packets.push({ end, k0: r.k, n: S.n });
        r.lastEnd = end; r.k += S.n; r.sent++;
        this.data.value = new DataView(pk.buffer);
        this.data.dispatchEvent(new Event('characteristicvaluechanged'));
      }, S.n * S.step);
    }
    _stop(type){ const r = this.running[type]; if(r && r.timer){ clearInterval(r.timer); r.timer = null; } }
    _drop(fire){
      for(const t in this.running) this._stop(t);
      const was = this.gatt.connected; this.gatt.connected = false;
      if(fire && was) this.dispatchEvent(new Event('gattserverdisconnected'));
    }
    // 测试用：掉线，failMs 毫秒内的重连都失败
    simulateDrop(failMs){ this.failUntil = Date.now() + (failMs || 0); this.log.push('drop'); this._drop(true); }
    // 测试用：设备重启。掉线，RTC 回到出厂时刻（2019-01-01），重启后从头计时
    simulateReboot(failMs){
      this.simulateDrop(failMs);
      this.dev0 = Date.UTC(2019, 0, 1) - EPOCH; this.wall0 = Date.now();
      for(const t in this.running) this.running[t].lastEnd = null;
      this.log.push('reboot');
    }
  }

  /* ---------- 假串口 GSR ---------- */
  class FakePort {
    constructor(){ this.millis0 = 12345; this.wall0 = null; this.readable = null; this.lines = 0; }
    getInfo(){ return { usbVendorId: 0x1a86, usbProductId: 0x7523 }; }
    async open(){
      this.wall0 = Date.now();
      const enc = new TextEncoder(); const self = this; let timer;
      this.readable = new ReadableStream({
        start(ctrl){
          timer = setInterval(() => {
            const k = self.lines++;
            const ms = self.millis0 + k * 100;
            const adc = (200 + 30 * Math.sin(k / 20)).toFixed(3);
            // 故意把一行拆成两次到达，测试按行拼接
            const line = ms + ',' + adc + '\r\n';
            ctrl.enqueue(enc.encode(line.slice(0, 4)));
            ctrl.enqueue(enc.encode(line.slice(4)));
          }, 100);
        },
        cancel(){ clearInterval(timer); }
      });
    }
    async close(){}
  }

  const polar = new FakePolar('Polar H10 TEST0001', H10_STREAMS);
  const sense = new FakePolar('Polar Sense TEST0002', SENSE_STREAMS, SENSE_PARAMS);
  const port = new FakePort();
  window.__fake = { polar, sense, port, EPOCH, ecgValue, accValue, senseAccRaw, sensePpgRaw, SENSE_ACC_FACTOR, next: 'h10' };
  const bt = { requestDevice: async () => (window.__fake.next === 'sense' ? sense : polar), getAvailability: async () => true };
  Object.defineProperty(Navigator.prototype, 'bluetooth', { configurable: true, get: () => bt });
  const serial = { requestPort: async () => port };
  Object.defineProperty(Navigator.prototype, 'serial', { configurable: true, get: () => serial });
})();
