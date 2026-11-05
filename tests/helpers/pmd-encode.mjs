// 合成 Polar PMD 数据包（编码方向），只给测试用。格式与 BSCore.parsePmdPacket 的注释一致。
export const EPOCH_2000_TO_1970 = 946684800000;

function header(type, devMs, frameType){
  const h = new Uint8Array(10);
  h[0] = type;
  let ns = BigInt(Math.round(devMs * 1e6));
  for(let i = 0; i < 8; i++){ h[1 + i] = Number(ns & 0xffn); ns >>= 8n; }
  h[9] = frameType;
  return h;
}
function intLE(v, n){
  const out = [];
  let u = v < 0 ? v + 2 ** (8 * n) : v;
  for(let i = 0; i < n; i++){ out.push(u % 256); u = Math.floor(u / 256); }
  return out;
}
function concat(...parts){
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len); let o = 0;
  for(const p of parts){ out.set(p, o); o += p.length; }
  return out;
}
// 未压缩帧：samples[s][c]
export function rawPacket(type, devMs, frameType, samples, bytes){
  const body = [];
  for(const s of samples) for(const v of s) body.push(...intLE(v, bytes));
  return concat(header(type, devMs, frameType), Uint8Array.from(body));
}
export const ecgPacket = (devMs, uV) => rawPacket(0, devMs, 0x00, uV.map(v => [v]), 3);
export const h10AccPacket = (devMs, xyz) => rawPacket(2, devMs, 0x01, xyz, 2);

// LSB-first 位打包
function packBits(values, bits){
  const nBytes = Math.ceil(values.length * bits / 8);
  const out = new Uint8Array(nBytes);
  let bp = 0;
  for(const v of values){
    const u = v < 0 ? v + 2 ** bits : v;
    for(let k = 0; k < bits; k++, bp++) if(Math.floor(u / 2 ** k) % 2) out[bp >> 3] |= 1 << (bp & 7);
  }
  return out;
}
// 增量帧：ref[c] 参考样本；blocks = [{bits, deltas:[[d_c0, d_c1, ...], ...]}]
export function deltaPacket(type, devMs, frameType, ref, refBytes, blocks){
  const parts = [header(type, devMs, frameType), Uint8Array.from(ref.flatMap(v => intLE(v, refBytes)))];
  for(const b of blocks){
    for(const d of b.deltas) for(const v of d){
      const lim = 2 ** (b.bits - 1);
      if(v < -lim || v >= lim) throw new Error(`delta ${v} does not fit in ${b.bits} bits`);
    }
    parts.push(Uint8Array.from([b.bits, b.deltas.length]));
    parts.push(packBits(b.deltas.flat(), b.bits));
  }
  return concat(...parts);
}
// 期望值：参考样本 + 逐个累加
export function expandDeltas(ref, blocks){
  const ch = ref.map(v => [v]);
  for(const b of blocks) for(const d of b.deltas) d.forEach((v, c) => ch[c].push(ch[c][ch[c].length - 1] + v));
  return ch;
}
