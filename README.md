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
   A tag pad can also hold a frequency, which it tunes instead if the radio
   has no channel with that tag. **Done** when finished.
6. **Scan lists** shows the favorites lists on the radio with an on/off switch
   each; tap a list for its systems, and a system for its departments. These
   are the radio's quick keys, so only the ones assigned in Sentinel appear.
   **✎** names one (the radio can't send names over Bluetooth; list and system
   names are also picked up from its screen), and **+ pad** puts a switch for
   it on the current bank. A switch pad (**A scan switch** in Edit) takes a
   quick key such as `2` (list 2), `1.5` (system 5 in list 1) or `1.2.3`
   (department 3 of system 2 in list 1), glows while it's on, and flips it
   when pressed. Tick **Scan only this list** on a list's switch (e.g. `2`)
   and the pad turns that list on, every other list off, and starts the
   radio scanning, all in one press.
7. **Export** saves your pads to `scanpad.json`; **Import** loads them on
   another device. **Defaults** offers the built-in pad sets (below); picking
   one replaces all four banks.
8. Swipe left or right across the pads to change banks.

## Pad sets

**Defaults** lists the sets in [`pads/index.json`](pads/index.json); a first
visit loads **Nationwide basics**.

| Set | What's in it |
| --- | --- |
| Nationwide basics | NOAA weather WX1–WX7, aviation emergency and air-to-air, marine, CB, FRS/GMRS/MURS, ham calling frequencies, APRS, the ISS, national interop calling channels |
| New York City, Washington DC, Chicago, Detroit, Miami, Atlanta, Austin, Denver, Los Angeles, San Francisco | Bank A the main airport (tower, ground, clearance, ATIS, approach, departure), B the other airports, C police, fire and EMS channels that are in the clear, D weather, state police, interop, marine and rail |
| New York: N2MAV's radio | The author's own: NYPD and NY State Police, JFK, LaGuardia |
| NY area airports: N2MAV's radio | Newark, Teterboro, Stewart, Westchester, Republic, MacArthur, Gabreski |

The city sets tune by frequency, so they work on any SDS150. They only hold
conventional channels: most big-city police and fire dispatch is on trunked
digital systems, often encrypted, and a frequency pad can't follow a trunked
talkgroup (each city file's `notes` says what was left out and why, and its
`sources` where the frequencies came from). Frequencies change; corrections
are welcome.

The two N2MAV sets jump by number tag to channels in the author's favorites
lists (Police NY is list 1, Aviation NYC is list 2), with the frequency as a
fallback. On your radio a tag pad tunes its frequency instead, unless you give
your channels the same tags in Sentinel (or edit the tags in the file; an AI
can do the renumbering for you). Trunked talkgroups have no frequency to fall
back on.

## Make your own pads

Build pads in the app with **Edit**, then **Export** to keep them. Or write a
`scanpad.json` by hand (or ask an AI to) and **Import** it. Feel free to fork
the project and ship your own defaults. The format is four banks of 16 pads
each (`null` is an empty pad):

```json
{
  "bank": "A",
  "banks": {
    "A": [
      { "name": "NOAA WX1", "mhz": "162.5500", "mode": "NFM", "color": "#5ad16b" },
      { "kind": "tag", "name": "LGA Tower", "tag": "2.1.201", "mhz": "118.7000", "mode": "AM", "color": "#ff5a36" },
      { "kind": "qk", "name": "Aviation only", "qk": "2", "only": true, "color": "#5ad16b" },
      null
    ],
    "B": [], "C": [], "D": []
  }
}
```

- `mhz`: frequency in MHz. Required unless the pad has a tag.
- `kind: "tag"` with `tag`: jump to the channel with this Sentinel number tag
  (favorites list . system . channel).
- `mode`: shown on the pad only; the radio picks the modulation itself.
- `kind: "qk"` with `qk`: a scan switch for that quick key (`"2"`, `"1.5"`,
  `"1.2.3"`). Add `"only": true` on a list's switch to make it a scan-only
  pad.
- `color`: any CSS color.

The file can also carry `"names"`, keyed the same way (`{"1": "Police NY",
"1.5": "Metro-25"}`), to label the Scan lists panel.

To add a set to **Defaults**, put its file in `pads/` and list it in
`pads/index.json` with an `id` (the file name without `.json`), a `name` and
an `about` line.

The SDS150 drops a Bluetooth link by itself now and then. ScanPad reconnects
on its own, retrying for about three minutes, and shows "Link dropped,
reconnecting…" while it does.

On a keyboard the grid is `1 2 3 4 / Q W E R / A S D F / Z X C V`, and the
arrow keys switch banks. Space resumes scanning.

## Files

- `index.html` — the pad
- `sds150.js` — SDS150 Bluetooth link: framing, replies, tune command
- `probe.html` — a test bench for trying raw commands on the radio
- `pads/` — the pad sets, listed in `pads/index.json`

## How it talks to the radio

The SDS150 exposes one custom BLE service (`3a5b9d10-f2ec-4f5c-bb2e-2f1a8d98a0a6`)
with one characteristic (`ab8c17d4-c1c5-4c91-8c56-7d01954c471e`) used for both
commands and replies. Commands are Uniden's usual ASCII remote commands, each
wrapped in a small binary "PT" frame; see the header of `sds150.js`.
Tune-and-hold is `QSH,<frequency in 100 Hz steps, 8 digits>`, e.g.
`QSH,04708625` for 470.8625 MHz. A tag pad sends `JNT,<list>,<system>,<channel>`
(the radio answers `JNT,OK`, or `JNT,NG` if nothing has that tag), and
`JPM,SCN_MODE,0` resumes scanning. Scan switches use the quick-key commands
`FQK` (lists), `SQK,<list>` (systems) and `DQK,<list>,<system>`
(departments): each answers one line of 100 slots (0 = not assigned, 1 = off,
2 = on), and setting one sends all 100 back. The radio stops answering for a
few seconds after a switch.

Over Bluetooth the SDS150 delivers only the **last line** of a multi-line reply,
so commands that answer with lists (`GLT`, `GSI`) don't work; that's why
favorites channels are reached by number tag rather than browsed.

## Run locally

```bash
python -m http.server 8150
```

Then open http://localhost:8150/ in Chrome.
