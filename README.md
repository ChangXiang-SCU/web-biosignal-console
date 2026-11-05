# Web Biosignal Console

A **single HTML file** that records ECG, accelerometry, PPG and skin conductance (EDA/GSR)
simultaneously in the browser, aligns every stream to one host clock, and writes CSV to disk.
No install, no drivers, no Python runtime. Double-click it in Chrome or Edge and go.

单文件网页多模态生理信号同步采集台。心电 + 皮肤电 + 加速度，共用一根时间轴，直接落盘 CSV。
不需要安装任何软件、驱动或 Python 环境，用 Chrome / Edge 双击打开即可。

---

## Supported devices

| Device | Streams (CSV group) | Transport | Nominal rate | Measured on our units | Unit in CSV |
|---|---|---|---|---|---|
| Polar H10 chest strap | ECG (`_ECG`) | Web Bluetooth, Polar PMD | 130 Hz | 129.4–129.9 Hz | µV |
| Polar H10 chest strap | ACC (`_ACC`) | Web Bluetooth, Polar PMD | 200 Hz, ±4 g, 16 bit | ~202.6 Hz | mG |
| Polar Verity Sense | PPG (`_PPG`) | Web Bluetooth, Polar PMD | 176 Hz | not re-measured | raw counts |
| Polar Verity Sense | ACC (`_ACC`) | Web Bluetooth, Polar PMD | 416 Hz | not re-measured | mG (device FACTOR applied) |
| Lyra / **Nervous EDA** (16-frequency impedance spectroscopy) | EDA (`_EDA`), spectrum (`_EDAZ`) | Web Bluetooth, Nordic UART | 8 Hz | 8.001 Hz | µS / Ω |
| Arduino Uno/Nano + analog GSR module | GSR (`_GSR`) | Web Serial (CH340) | 10 Hz | 10.00 Hz | ADC counts / µS (uncalibrated) |

Measured rates come from real hardware; nominal ones are what the console requests.
Other Polar models (OH1, H9, …) are rejected with a message rather than half-connected.

Multiple devices of the same type can be connected at once: each gets its own card and its own
labelled column block in the CSV.

## Browser support

| Browser | Bluetooth sensors | Serial GSR | Write to a folder | Notes |
|---|---|---|---|---|
| Chrome / Edge, Windows 10+ and macOS | yes | yes | yes | the target platform |
| Chrome / Edge, Linux | usually | yes | yes | Web Bluetooth may need `chrome://flags/#enable-experimental-web-platform-features` |
| Chrome, Android | untested | untested | no (falls back to downloads) | |
| Firefox, Safari, any browser on iOS | no | no | no | the page says so in a banner and on every connect button |

The page checks for Web Bluetooth, Web Serial and the File System Access API at load time and
shows a banner listing what is missing. It also reports when the browser sees no usable Bluetooth
adapter. Opening the file directly (`file://`) works; Chrome treats it as a secure context.

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

1. Open `polarconsole_eda.html` in Chrome or Edge (double-click is fine, no server needed).
2. Under **Output**, click **Choose output folder**. Without one, data stays in memory and is only
   written as browser downloads when you stop.
3. Connect sensors: **Connect a sensor** for Polar (pick it in Chrome's Bluetooth chooser; click
   again for each extra device), **Lyra EDA** for the impedance sensor, **serial GSR** for the
   Arduino (pick its COM port). Each device gets a card.
4. Tick the streams you want on each card. ACC is the heaviest BLE stream; switch it off if you
   do not need it.
5. Click **Start recording**. Keep the tab in the foreground: background tabs are throttled,
   which can drop BLE links and delay autosave.
6. Type a label under **Event markers**, click **Add** to make a button, and click that button
   when the event happens. Markers go into every CSV on the same time axis.
7. Click **Stop recording**. The console writes the last incremental chunk and one merged FULL
   file per stream group.

If a Bluetooth device drops out mid-recording the card shows "reconnecting", the console retries
up to 20 times with back-off (about 1.5 minutes in total), restarts the streams that were
running and keeps writing into the same buffer. The gap and the reconnect are logged in the CSV.

Full walkthrough in Chinese: [`docs/usage-guide.md`](docs/usage-guide.md)（使用说明）

### Arduino GSR wiring

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

## Output files

| File | Written | Content |
|---|---|---|
| `Polar_auto_<time>_<GROUP>.csv` | every 60 s while recording, to the chosen folder | only the rows that arrived since the previous chunk; chunks do not overlap |
| `Polar_full_<start>__to__<end>_<GROUP>.csv` | once, on stop | every row of the session; **use this for analysis** |
| `Polar data <time>_AUTO_…` / `_FULL_…` | same, when no folder was chosen | browser downloads instead of folder writes |
| `Polar data <time>_RAW_<GROUP>.csv` | when you click **Export buffer** | everything in memory, with the full per-packet SYNC log |

`<GROUP>` is one of `ECG`, `ACC`, `PPG`, `EDA`, `EDAZ`, `GSR`. A file is only written for groups
that have data.

### Layout of one file

Each file is a stack of sections separated by blank lines. The number of lines before the data
table varies (it depends on how many markers, link events and packets there were), so **do not
use a fixed `skiprows`**; find the line that starts with `DevTime_us`.

1. **`MARKERS`** `unix_host_ms,iso_utc,name`
2. **`LINK EVENTS`** `unix_host_ms,iso_utc,device,event,detail`
3. **`SYNC summary`** one line per device and stream (all files)
4. **`SYNC per-packet`** one line per BLE packet / serial line (AUTO and RAW files, only for the
   group's own stream; concatenate all AUTO files for the whole session)
5. one info line per device (`COLUMN BLOCK n: <device>,…,host_offset_ms=…` in FULL files)
6. the **data table**: header line starting with `DevTime_us`, then rows until the next blank line

In the data table every device has its own block of columns, side by side. In FULL files every
column name carries an `@<device name>` suffix, so two H10s can be told apart. **Rows of
different devices on the same line are not simultaneous**: each block has its own time columns,
and blocks of different lengths are padded with empty cells. Align devices on `unix_host_ms`.

### Reading it in Python

```python
import io, pandas as pd

def read_console_csv(path):
    """Data table of a console CSV (AUTO, FULL or RAW)."""
    lines = open(path, encoding="utf-8-sig").read().splitlines()
    a = next(i for i, l in enumerate(lines) if l.startswith("DevTime_us"))
    b = next((i for i in range(a + 1, len(lines)) if not lines[i]), len(lines))
    return pd.read_csv(io.StringIO("\n".join(lines[a:b])))

df = read_console_csv("Polar_full_..._GSR.csv")
dev = next(c for c in df.columns if c.startswith("GSR_uS@")).split("@", 1)[1]
t_ms, g_uS = df[f"unix_host_ms@{dev}"], df[f"GSR_uS@{dev}"]
```

```python
import neurokit2 as nk
signals, info = nk.eda_process(g_uS.dropna().values, sampling_rate=10)
```

10 Hz is ample for EDA: SCR rise time is 1–3 s and the signal sits below 1 Hz; the widely
published Empatica E4 records EDA at 4 Hz. What each channel yields and a suggested pipeline:
[`docs/analysis-guide.md`](docs/analysis-guide.md)（三个通道能做什么分析）

## CSV field reference

### Time columns (every block)

| Column | Unit | Meaning |
|---|---|---|
| `DevTime_us` | µs | device clock, microseconds since 2000-01-01 |
| `unix_dev_ms` | ms | device clock as UNIX time. Not comparable across devices (our H10 reported 2019) |
| `unix_host_ms` | ms | **shared host time axis**: `unix_dev_ms + host_offset_ms`. Use this across devices |

For Polar streams, the device timestamp of each BLE packet belongs to its **last** sample; the
earlier samples are spaced by the measured interval (packet-to-packet device time ÷ samples),
which tracks the real output rate instead of the nominal one. `host_offset_ms` is fixed at the
first sample of each device: host arrival time minus device time, so it includes one transport
latency. If a Polar clock jumps mid-session (`clock-jump`), `DevTime_us` and `unix_dev_ms` after
that point are the re-joined values, not the raw sensor clock.

For GSR, `unix_host_ms = millis + θ`, where θ follows the smallest `arrival − millis` seen in the
last 30 s, changing by at most 1 % of elapsed time: host stalls do not move it, Arduino clock
drift is tracked smoothly, and the time axis never steps backwards.

### Signal columns

| Group | Column | Unit | Meaning |
|---|---|---|---|
| `_ECG` | `ECG` | µV | single-lead ECG, unfiltered (Polar PMD spec: frame type 0, 3 bytes per sample) |
| `_ACC` | `acc_x`, `acc_y`, `acc_z` | mG | accelerometer axes. H10 sends mG directly; Verity Sense sends compressed counts that are multiplied by the FACTOR from its start response |
| `_ACC` | `acc_v` | same as axes | magnitude √(x²+y²+z²); ≈1000 at rest on an H10 |
| `_PPG` | `PPG0`, `PPG1`, `PPG2`, `ambient` | raw counts | Verity Sense optical channels |
| `_PPG` | `PPGsum` | raw counts | PPG0+PPG1+PPG2 after a 0.2 s high-pass filter (display signal, not raw) |
| `_EDA` | `EDA_G` | µS | 12 Hz conductance, 2-point de-interleaved. Main EDA column |
| `_EDA` | `EDA_G_raw` | µS | 12 Hz conductance before de-interleaving |
| `_EDA` | `EDA_SCL`, `EDA_SCR` | µS | tonic (exponential smoothing, α = 0.04, τ ≈ 3.1 s) and phasic = G − SCL |
| `_EDA` | `EDA_SCRpeak` | 0/1 | sample is an SCR peak (≥ 0.02 µS, ≥ 2 s apart) |
| `_EDA` | `EDA_SCRmin` | count | SCR peaks in the last 60 s |
| `_EDA` | `EDA_Cx`, `EDA_Cy`, `EDA_Cr` | Ω | centre and radius of the circle fitted to the 16-point Nyquist plot |
| `_EDA` | `EDA_Cfit` | — | RMS residual to that circle ÷ radius; contact quality, good below 0.10 |
| `_EDA` | `EDA_SQI` | 0–100 | vendor-style signal quality index |
| `_EDA` | `EDA_Arousal_vendor` | 0–100 | vendor heuristic, no literature basis; do not publish |
| `_EDA` | `EDA_bat` | % | battery |
| `_EDAZ` | `Z12_re`, `Z12_im` … `Z724_re`, `Z724_im` | Ω | raw complex impedance at the 16 frequencies (32 columns) |
| `_GSR` | `GSR_raw` | ADC counts | Arduino reading (float: 100 ms oversampled mean). Most trustworthy GSR column |
| `_GSR` | `GSR_uS`, `GSR_ohm` | µS, Ω | Grove formula with the selected polarity; uncalibrated, relative use only |

### `LINK EVENTS` event types

| `event` | Meaning |
|---|---|
| `disconnect` | the BLE link dropped |
| `reconnect` | reconnected and the streams restarted (in device order, skipping any the user stopped meanwhile); `detail` gives the attempt number and the gap length. A drop during the restart is logged as a second `disconnect` and handled by the same retry loop |
| `give-up` | 20 reconnect attempts failed; the device card is removed, data recorded so far is kept |
| `gap` | a Polar stream skipped samples (`detail`: stream and missing milliseconds, from the device clock) |
| `clock-backwards` | a Polar packet's device time went back a little or repeated; that packet is dropped so the time axis stays monotonic |
| `clock-irregular` | a Polar packet's device time advanced by less than half the expected span; its samples are squeezed into that span so they do not overlap the previous packet |
| `clock-jump` | a Polar device clock jumped by more than 30 s against host arrival time (sensor rebooted and its clock reset, or another app set it); the device time is re-joined to the host axis from that packet on |
| `truncated` | a malformed Polar packet was dropped (its samples cannot be placed in time); the next packet shows the gap |
| `reanchor` | the serial GSR time axis was re-anchored because the Arduino rebooted (`millis()` went backwards) |
| `pmd-start`, `pmd-stop` | Polar's answer to a start/stop command: status, the FACTOR if the sensor sent one, and the raw response bytes (a failed start shows up here) |

### `SYNC summary` columns

`Device, Stream, offset_ms, skew, offset_at_mean_ms, p05_latency_ms, median_latency_ms,
jitter_median_ms, jitter_p95_ms`: a least-squares fit `host_arrival ≈ offset + skew × unix_dev_ms`
over the **last 300 packets**, plus the distribution of `host_arrival − unix_dev_ms`. The two
latency columns are only real latencies when the device clock was set (Lyra, GSR); the jitter
columns are relative to the smallest difference in the window and compare directly across
devices. For a whole-session skew fit, use the `SYNC per-packet` lines of the AUTO files.

## Known limitations

- **Clock alignment is first-sample anchored.** `unix_host_ms` carries one transport latency
  (Lyra measured 221 ms median) and does not correct device clock
  drift online. At 50 ppm that is 180 ms per hour. Correct linearly with the SYNC fit if you
  need sub-second cross-device timing.
- **Verity Sense scaling depends on the FACTOR in the start response.** Compressed ACC and PPG
  frames are scaled the way the official Polar SDK does it (ACC: counts × FACTOR × 1000 = mG).
  If a firmware sends no FACTOR, the values stay raw counts; `pmd-start` in `LINK EVENTS` shows
  whether one was received.
- **Polar reconnect was verified with a simulated device only** (see `tests/`). It follows the
  existing Lyra reconnect logic, but a real H10 dropout still needs checking.
- **All data lives in memory** until written. Hours-long recordings at full rate use hundreds of
  MB. Closing the tab mid-recording may lose the last minute: stop recording first.
- **Without an output folder** the stop flush downloads both an AUTO chunk and a FULL file per
  group; the FULL file is the one to keep.
- **GSR µS values are uncalibrated**, and the Grove formula's polarity was inverted on our module
  (decided from data, see `docs/technical-reference.md`). Report `GSR_raw` or state the formula.
- **Arduino clocks drift.** Boards with a ceramic resonator can be off by up to about 0.5 %. The
  GSR axis tracks it smoothly (sample spacing stretched or compressed by at most 1 %); a slow
  board clock leaves the axis up to about 0.15 s behind (drift × 30 s window).
- **The Lyra EDA channel did not pass physiological validation on our unit** (details below).
- Supported Polar models are H10 and Verity Sense only.

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

## Development and tests

The parsing and timing logic lives in one block of pure functions at the top of the HTML file,
`<script id="bsc-core">` (`BSCore`): PMD packet decoding, per-packet timestamp reconstruction,
host-clock anchoring, the sync fit, CSV block assembly, COBS, the protobuf reader, the Nyquist
circle fit, EDA processing, GSR conversion and the serial clock. The page calls it; the tests
extract that same block from the HTML and run it in Node, so the file stays a single
double-clickable page with no build step.

```bash
node --test
```

Requires Node 20 or newer (tested on 22), nothing to install. `tests/*.test.mjs` feed synthetic packets built
by `tests/helpers/pmd-encode.mjs` (ECG, H10 ACC, delta-compressed frames with odd and even bit
widths, truncated packets, Lyra frames, serial lines with drift, stalls and board resets).
`tests/page.e2e.test.mjs` opens the real page in Chromium through Playwright when it is
available (it is skipped otherwise): it checks that the page loads without errors offline, that
browsers without Web Bluetooth / Web Serial get a clear message, and drives a simulated H10 and
Arduino (`tests/helpers/fake-devices.js`) through connect, record, dropout, reconnect and stop,
then checks the resulting CSV files: headers, timestamps, sample values, link events and SYNC
sections. A simulated Verity Sense sends compressed ACC (odd 9-bit deltas, FACTOR in the start
response) and compressed PPG. Further cases cover reconnect races (the link dropping again
while the streams are being restarted, the user pressing Stop during the restart) and an H10
that reboots mid-recording with its clock reset to the factory date.

`tests/polar-sdk-vectors.test.mjs` additionally checks the decoder against the PMD packets in the
official [Polar BLE SDK](https://github.com/polarofficial/polar-ble-sdk) unit tests (ECG, H10 ACC,
compressed ACC and PPG, timestamp rules). The SDK's licence does not allow copying its files
here, so the test reads them from a local clone and is skipped without one:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/polarofficial/polar-ble-sdk.git
git -C polar-ble-sdk sparse-checkout set --no-cone '/sources/Android/android-communications/**/pmd/**'
POLAR_SDK_DIR=$PWD/polar-ble-sdk node --test
```

## Repository layout

```
polarconsole_eda.html              the console (open this)
firmware/GSR_serial/GSR_serial.ino Arduino sketch
docs/usage-guide.md                user guide (使用说明)
docs/technical-reference.md        protocol, measured specs, CSV dictionary, methods templates (技术说明)
docs/analysis-guide.md             what each channel measures and what you can compute from it (分析指南)
tests/                             Node tests and Playwright end-to-end test
```

## License

MIT. The Nervous EDA protocol implementation is an independent reimplementation informed by the
upstream MIT-licensed project; Polar PMD handling derives from the author's earlier
`WebPolarReader` work.
