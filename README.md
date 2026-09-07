# Web Biosignal Console

A **single HTML file** that records ECG, skin conductance (EDA/GSR) and accelerometry
simultaneously in the browser, aligns every stream to one clock, and writes CSV to disk.
No install, no drivers, no Python runtime. Open it in Chrome and go.

单文件网页多模态生理信号同步采集台。心电 + 皮肤电 + 加速度，共用一根时间轴，直接落盘 CSV。
不需要安装任何软件、驱动或 Python 环境。

---

## Supported devices

| Channel | Device | Transport | Measured rate |
|---|---|---|---|
| ECG | Polar H10 chest strap | Web Bluetooth (Polar PMD) | 129.4–129.9 Hz |
| ACC | Polar H10 / Verity Sense | Web Bluetooth (Polar PMD) | ~202.6 Hz / 416 Hz |
| PPG | Polar Verity Sense | Web Bluetooth (Polar PMD) | 176 Hz |
| EDA | Lyra / **Nervous EDA** (16-frequency impedance spectroscopy) | Web Bluetooth (Nordic UART) | 8.001 Hz |
| GSR | Arduino + analog GSR module | Web Serial (CH340) | 10.00 Hz |

Every rate above was **measured on real hardware**, not copied from a datasheet.

Multiple devices of the same type can be connected at once — each gets its own card and its own
labelled column block in the CSV.

---

## Why it exists

Off-the-shelf tools record one sensor each and leave you to align the clocks afterwards. That
turns out to be the hard part: in our setup the Polar H10's internal RTC had never been set and
reported **2019**, while the EDA sensor reported correct POSIX time — a 7.7-year gap between two
devices recording the same person at the same moment.

This console solves that by anchoring every device to the host clock at its first packet and
writing a `unix_host_ms` column that is directly comparable across devices. Per-packet arrival
times, clock skew and link dropouts are all logged into the CSV header so the alignment can be
audited or refined offline.

---

## Quick start

1. Open `polarconsole_eda.html` in **Chrome or Edge** (Safari and Firefox lack Web Bluetooth / Web Serial)
2. Pick an output folder under **Output** — without one, data lives only in memory
3. Connect the sensors you want, tick the streams, hit **Start recording**
4. Add event markers from the panel on the right; they land in the CSV on the same time axis

Full walkthrough: [`docs/usage-guide.md`](docs/usage-guide.md)（使用说明）

### Arduino GSR

```
GND → GND      5V → 5V      OUT → A0
```

Flash [`firmware/GSR_serial/GSR_serial.ino`](firmware/GSR_serial/GSR_serial.ino), board = Arduino Uno.
Output is `millis,adc` at 115200 baud, 10 Hz.

The sketch integrates over a **100 ms window** — exactly 5 mains cycles at 50 Hz and 6 at 60 Hz — so
line-frequency pickup cancels in either region. It then reports the **floating-point** average rather
than rounding: with ~900 oversamples and ≥1 LSB of dither, effective resolution goes from
1 LSB (≈0.05 µS) to ≈0.06 LSB (≈0.003 µS). That matters because 0.05 µS is the conventional
minimum amplitude for a valid SCR, so the raw 10-bit step was quantising away the smallest
real responses.

---

## Output

CSV per stream group, written incrementally every 60 s (`Polar_auto_*`) plus one merged file on
stop (`Polar_full_*`). Each file carries three header sections before the data table:

- **MARKERS** — event marks on the shared time axis
- **LINK EVENTS** — Bluetooth disconnects and reconnects, so data gaps are traceable
- **SYNC** — per-device clock offset, skew, transport latency and jitter

Three time columns: `unix_host_ms` (**use this** for cross-device analysis), `unix_dev_ms`
(the device's own clock, not comparable across devices), `DevTime_us`.

### Analysis

```python
import pandas as pd, neurokit2 as nk
df = pd.read_csv("..._GSR.csv", skiprows=4)
signals, info = nk.eda_process(df["GSR_uS"].dropna().values, sampling_rate=10)
```

10 Hz is ample for EDA — SCR rise time is 1–3 s and the signal sits below 1 Hz; the widely
published Empatica E4 records EDA at 4 Hz.

What each channel yields, what every metric means, and a suggested analysis pipeline:
[`docs/analysis-guide.md`](docs/analysis-guide.md)（三个通道能做什么分析）

---

## The EDA sensor

The BLE EDA device sold as "天琴座 Lyra" self-identifies over GATT as
**`INL - INSA Lyon` / `Nervous EDA Sensors`** — it is a rebrand of the open-hardware
[sensors-inl/Nervous-EDA](https://github.com/sensors-inl/Nervous-EDA) project (MIT, ANR-22-CE31-0023-03).

**Cite the original design, not the retail name:**

> B. Massot, E. Desmazure, A. Montalibet, E. McAdams, C. Gehin,
> "A Portable Device Performing Continuous Impedance Spectroscopy for Skin Conductivity,"
> *IEEE Sensors Journal*, 2024. [doi:10.1109/JSEN.2024.3485187](https://doi.org/10.1109/JSEN.2024.3485187)

### Protocol

No encryption. It speaks **Nordic UART Service**, which is why it appears in the OS Bluetooth
panel but cannot be paired usefully there — Windows has no driver for a vendor-defined transport.

```
BLE service   6E400001-B5A3-F393-E0A9-E50E24DCCA9E   (NUS)
  6E400003-…  notify   device → host
  6E400002-…  write    host → device
framing       COBS, 0x00 delimiter
payload       Protocol Buffers
              EdaBuffer { repeated Impedance data = 1; Timestamp timestamp = 2; }
              Impedance { float real = 1; float imag = 2; }
              Timestamp { uint64 time = 1; uint32 us = 2; }
frame size    204 bytes → 16 complex impedances + timestamp
frequencies   12 28 32 36 44 68 84 108 136 196 256 324 400 484 576 724  Hz
```

Full reverse-engineering notes, measured latencies and the frame parser:
[`docs/technical-reference.md`](docs/technical-reference.md)（多模态生理采集系统 技术说明）

### Contact-quality metric

The console computes `EDA_Cfit` — the RMS residual of the 16 impedance points against a
least-squares fitted Nyquist circle, normalised by its radius. Good electrode contact puts the
16 points on a clean arc (Cole model), giving Cfit well below 0.10; poor contact scatters them.
This is not in the vendor software and turned out to be the most useful single diagnostic
available.

### Status on our unit

On **our** device (firmware 1.0.0) the EDA channel did not pass physiological validation: during a
mental-arithmetic stressor it showed no response (r = −0.19 against simultaneously recorded heart
rate) while the Arduino GSR channel on the other hand did (r = +0.674), and its 16-point impedance
spectrum did not decrease monotonically with frequency as a parallel-RC skin model requires.
Swapping hands changed nothing.

This is **n = 1** and says nothing about the model in general. Firmware v1.1.0 upstream notes a
32.768 kHz clock and an added phase-correction factor, which we have not tested. Anyone using this
channel should validate it against a known stimulus before trusting it. The integration itself is
complete and frame parsing is error-free.

---

## Repository layout

```
polarconsole_eda.html              the console (open this)
firmware/GSR_serial/GSR_serial.ino Arduino sketch
docs/usage-guide.md                user guide (使用说明)
docs/technical-reference.md        protocol, measured specs, CSV dictionary, methods templates (技术说明)
docs/analysis-guide.md             what each channel measures and what you can compute from it (分析指南)
```

## License

MIT. The Nervous EDA protocol implementation is an independent reimplementation informed by the
upstream MIT-licensed project; Polar PMD handling derives from the author's earlier
`WebPolarReader` work.
