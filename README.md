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
4. **Edit** to set a pad's name, frequency and color. **Done** when finished.
5. **Export** saves your pads to `scanpad.json`; **Import** loads them on
   another device.

On a keyboard the grid is `1 2 3 4 / Q W E R / A S D F / Z X C V`, and the
arrow keys switch banks.

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
`QSH,04708625` for 470.8625 MHz.

## Run locally

```bash
python -m http.server 8150
```

Then open http://localhost:8150/ in Chrome.
