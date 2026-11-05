# ScanPad

A drum-machine style pad for the Uniden SDS150. Each pad holds a name and a
frequency; press it and the scanner tunes there and holds. 4 banks of 16 pads.

Runs in the browser over Bluetooth (Web Bluetooth). No install, no server code.

## Where it runs

| Device | Browser |
| --- | --- |
| Windows / Mac / Android | Chrome or Edge |
| iPad / iPhone | [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) (Safari has no Web Bluetooth) |

The page must be opened over `https://` (or `localhost`). The SDS150 takes only
one Bluetooth connection at a time, so close U/AWARE or any other scanner app
first.

## Use

1. Turn on the SDS150's Bluetooth.
2. Open ScanPad and tap **Connect**, then pick **SDS150**.
3. Tap a pad. The radio tunes to it and holds; the pad it is on glows.
4. **▶ Scan** releases the hold and sends the radio back to scanning.
5. **Edit** to set a pad's name, color, and what it tunes to: either a
   frequency you type, or **a tagged channel** from your favorites, by its
   Sentinel number tag (list.system.channel, e.g. `1.1.3`). **Use what's on
   now** fills in the tag of the channel the radio is on. Tag pads show a ★.
   **Done** when finished.
6. **Export** saves your pads to `scanpad.json`; **Import** loads them on
   another device.

On a keyboard the grid is `1 2 3 4 / Q W E R / A S D F / Z X C V`, and the
arrow keys switch banks. Space resumes scanning.

## Files

- `index.html` — the pad
- `sds150.js` — SDS150 Bluetooth link: framing, replies, tune command
- `probe.html` — a test bench for trying raw commands on the radio

## How it talks to the radio

The SDS150 exposes one custom BLE service (`3a5b9d10-f2ec-4f5c-bb2e-2f1a8d98a0a6`)
with one characteristic (`ab8c17d4-c1c5-4c91-8c56-7d01954c471e`) used for both
commands and replies. Commands are Uniden's usual ASCII remote commands, each
wrapped in a small binary "PT" frame; see the header of `sds150.js`.
Tune-and-hold is `QSH,<frequency in 100 Hz steps, 8 digits>`, e.g.
`QSH,04708625` for 470.8625 MHz. A tag pad sends `JNT,<list>,<system>,<channel>`
(the radio answers `JNT,OK`, or `JNT,NG` if nothing has that tag), and
`JPM,SCN_MODE,0` resumes scanning.

Over Bluetooth the SDS150 delivers only the **last line** of a multi-line reply,
so commands that answer with lists (`GLT`, `GSI`) don't work; that's why
favorites channels are reached by number tag rather than browsed.

## Run locally

```bash
python -m http.server 8150
```

Then open http://localhost:8150/ in Chrome.
