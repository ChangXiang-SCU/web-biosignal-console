/* =============================================================================
   思知瑞 GSR 皮肤电模块 → Polar 采集台（串口 GSR 通道）
   -----------------------------------------------------------------------------
   接线（模块背面丝印）：
     GND -> GND      5V -> 5V(或3V3)      OUT -> A0
   适用：Arduino UNO/Nano(CH340)、STM32、Pico、ESP32 —— 只需改 GSR_PIN / ADC 位数
   输出：每行 "millis,adc"，115200 波特，10 Hz
        adc 带 3 位小数（见下），采集台按这个格式解析；只发一个整数也能认。

   为什么是 10 Hz 而不是更快：
     每个输出点在 100 ms 窗口内连续过采样再平均。100 ms 正好是 50 Hz 的 5 个
     周期、60 Hz 的 6 个周期，所以国内国外都能把工频串扰整周期抵消掉。
     皮肤电本身 <1 Hz，10 Hz 远远够用，给 SCR 峰检测也留足了余量。

   为什么输出带小数（2026-09-06 改）：
     UNO 的 ADC 是 10 位，一个台阶换算到电导约 0.05 µS。这个数字尴尬在它正好
     等于有效 SCR 的惯例阈值（0.01–0.05 µS），会把小幅度的 SCR 直接量化掉，
     也让 SCR 幅度的估计带上约 ±18% 的量化误差。
     但本来就在 100 ms 窗口里过采样了几百次，只要信号上有 ±1 LSB 以上的噪声
     做抖动（实测有 ±2 LSB），平均值的有效分辨率就远高于一个台阶：过采样 N 次
     理论上多拿 log4(N) 位，N≈900 时约 4.9 位。
     所以别取整，直接输出浮点平均值，等效分辨率从 0.05 µS 提到约 0.01 µS。
     这是标准的 oversampling + dithering，多出来的位来自真实的多次独立采样，
     前提就是那点噪声，不是插值造假。
   ============================================================================= */

const int  GSR_PIN  = A0;
const long BAUD     = 115200;
const int  RATE_HZ  = 10;              // 输出速率；窗口 = 1000/RATE_HZ ms
const unsigned long WINDOW_MS = 1000UL / RATE_HZ;

unsigned long nextTick = 0;

void setup() {
  Serial.begin(BAUD);
  // ESP32 / Pico / STM32 若用 12bit，解开下一行，并在网页里把 ADC 满量程选 4095
  // analogReadResolution(12);
  analogRead(GSR_PIN);                 // 丢掉上电后第一次转换
  nextTick = millis() + WINDOW_MS;
}

void loop() {
  // 在整个窗口内连续采样求平均：整周期积分 = 工频串扰自然抵消
  unsigned long sum = 0;
  unsigned long n   = 0;
  while ((long)(millis() - nextTick) < 0) {
    sum += analogRead(GSR_PIN);
    n++;
  }
  unsigned long now = millis();
  nextTick += WINDOW_MS;
  if ((long)(now - nextTick) > 0) nextTick = now + WINDOW_MS;   // 丢帧后重新对齐

  if (n == 0) return;
  float adc = (float)sum / (float)n;      // ← 不取整：保住过采样换来的分辨率

  Serial.print(now);
  Serial.print(',');
  Serial.println(adc, 3);                 // 3 位小数 = 0.001 LSB，远低于噪声底
}

/* -----------------------------------------------------------------------------
   网页侧换算（不用改这里，写出来只是让你知道 CSV 里的列怎么来的）：
     R_human(Ω) = ((1024 + 2*adc10) * 10000) / (512 - adc10)      ← Grove GSR 官方式
     G(µS)      = 1e6 / R_human
   adc10 是折算到 10bit 的读数；12bit/16bit 的板子由网页按你选的满量程自动折算。
   adc >= 511 视为无效（分母趋零），CSV 里该行留空。

   自检：模块没接 A0 时，读数会在 0 和一两百之间逐样本乱跳（悬空引脚吃工频）。
        接好模块、手指夹上指套后，读数应该是一个稳定的值，随情绪缓慢漂移。
        如果串口输出没有小数点，说明烧的还是旧版固件。
   ----------------------------------------------------------------------------- */
