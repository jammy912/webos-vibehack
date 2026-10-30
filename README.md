# webos-vibehack

An Apple TV-style home screen for LG TVs. It's a webOS port of the launcher from
[tv-vibehack](https://github.com/Gathin23/tv-vibehack), which does the same for Android TVs.

![The launcher running on an LG OLED C6](docs/screenshot.jpg)

Tested on an LG OLED C6 (OLED55C6XLA, webOS 26, firmware 43.21.79).

## What's different from Android

webOS is more locked down than Android TV, so three things work differently:

| | Android TV | LG webOS |
|---|---|---|
| Install | ADB, no account | LG's **Developer Mode** app (free LG developer account) |
| App list | read on the TV | read from your computer by `sync-apps.py` and bundled in; webOS won't let an app list installed apps |
| Home button | the launcher *is* Home | webOS always opens LG's home; `home-watch.py`, running on another device, switches straight back (about 0.1 s) |

There's no debloat step: webOS has no ADB-style package disabling. Turn off LG's ads in the TV's
own settings instead (see [Cleaning up LG's home](#cleaning-up-lgs-home)).

Nothing is rooted. Developer Mode is LG's official way to install your own apps, firmware updates
keep working, and deleting the Developer Mode app removes everything.

## Setup

You need a Mac or Windows PC on the same Wi-Fi as the TV, with Node.js (for LG's `ares` CLI, fetched with `npx`)
and Python 3. `install.sh` is macOS only (it makes the app icon with `sips`); on Windows use
`install-windows.ps1` (see the end of step 3).

**1. Developer Mode on the TV**

1. Create a free account at [webostv.developer.lge.com](https://webostv.developer.lge.com).
2. On the TV, install **Developer Mode** from the LG Content Store and sign in.
3. Turn on **Dev Mode Status** (the TV restarts), open the app again and turn on **Key Server**.
   Note the **IP address** and **Passphrase** it shows.

**2. Connect your computer** (once)

```bash
export TV_HOST=192.168.1.50                       # the IP from the Developer Mode app
npx -y -p @webos-tools/cli ares-setup-device -a lgtv -i "{'host':'$TV_HOST','port':'9922','username':'prisoner'}"
npx -y -p @webos-tools/cli ares-novacom --device lgtv --getkey        # type the passphrase
npx -y -p @webos-tools/cli ares-setup-device -m lgtv -i "{'privatekey':'lgtv_webos','passphrase':'ABC123'}"
```

**3. Install**

```bash
git clone https://github.com/jammy912/webos-vibehack.git
cd webos-vibehack
python3 -m venv venv && venv/bin/pip install websockets
TV_HOST=192.168.1.50 ./install.sh
```

The first run shows an "allow this device?" prompt on the TV: accept it. That pairing lets
`sync-apps.py` read your apps and icons. `install.sh` then packages the app, installs it and opens
it. Run it again whenever you install or remove apps on the TV.

**On Windows**, [`install-windows.ps1`](install-windows.ps1) does steps 2 and 3 in one go: it
installs the `ares` CLI, downloads the project to `%USERPROFILE%\webos-vibehack`, binds the TV
(asks for the passphrase twice), syncs apps, makes the icons with Pillow instead of `sips`, then
packages, installs and opens the launcher. Install Node.js and Python first
(`winget install OpenJS.NodeJS.LTS`, `winget install Python.Python.3.12`), then:

```powershell
powershell -ExecutionPolicy Bypass -File install-windows.ps1 -TvHost 192.168.1.50
```

**4. A one-press shortcut**

With the launcher open, hold a number key on the remote (say **1**) and assign it. From then on,
holding 1 opens the launcher from anywhere.

## The Home button

webOS hard-wires Home to LG's home, and blocks Developer Mode apps from seeing which app is in front,
so the TV can't redirect it on its own. [`home-watch.py`](home-watch.py) does it from another
always-on device on the same network: it watches the TV's foreground app and, the moment LG's home
appears, opens the launcher on top.

- **Press Home twice** within three seconds to stay on LG's home, for its menus.
- When the TV powers on to LG's home, it goes to the launcher too.
- When the watcher isn't running, Home simply opens LG's home as usual.
- **The Home Dashboard button switches inputs**: each press goes to the next HDMI input
  (1 → 2 → 3 → 4 → 1, inputs without a signal included), or to HDMI 1 from anything else. Press it
  twice within three seconds to open the Home Dashboard as usual. The Guide and Alexa buttons can't
  be used for this: they open an overlay, not an app, so the watcher never sees them.
- **The LG Channels button opens the [router dashboard](#router-dashboard)**. Press it twice within
  three seconds to stay on LG Channels.

On a Mac, install it as a background service that starts at login:

```bash
TV_HOST=192.168.1.50 ./home-watch-mac.sh       # install or update
./home-watch-mac.sh uninstall                  # remove
```

macOS will ask for Local Network access for Python: allow it (System Settings → Privacy & Security →
Local Network), or the watcher logs "No route to host". The log is at
`~/Library/Logs/tv-vibehack-home-watch.log`. A Mac only redirects Home while it's awake and at
home; for every time, run `python3 home-watch.py 192.168.1.50` on something that's always on, such
as a Raspberry Pi.

On an OpenWrt router (needs room for Python 3, e.g. 128 MB+ flash or extroot),
[`setup-home-watch.sh`](setup-home-watch.sh) installs Python and `websockets`, downloads the
watcher, pairs with the TV and runs it as a procd service that starts at boot:

```sh
sh setup-home-watch.sh 192.168.1.50
logread -f | grep -i home
```

Give the TV a static DHCP lease: the watcher and its pairing key are tied to the IP.

## Using it

Same as the [Android launcher](https://github.com/Gathin23/tv-vibehack#the-launcher): a dock of four apps with the focused app's name above it and a glow
in its colour, the rest of your apps in a grid below, and Inputs (HDMI ports and Live TV), Wi-Fi
and Settings at the top. The header slides away when the grid scrolls into it.

**Rearrange tiles on the TV**: hold **OK** on a tile until it wiggles, move it with the arrows
(into the top row puts it in the dock), then **OK** to place it or **Back** to cancel. The order is
saved on the TV.

**Configure** in [`app/config.js`](app/config.js): the starting dock, apps to hide, the Live TV
app and the number of columns. App ids come from `venv/bin/python sync-apps.py $TV_HOST --list`.
Changing `dockApps` resets an order arranged on the TV.

**Photo or video background**: put a 1920x1080 JPEG at `app/background.jpg`, or an H.264 MP4 at
`app/background.mp4` (looped, muted, paused while another app is open), and reinstall. The video
wins if both are there. It's shown darkened behind everything; without either file the background
stays black. Both files are gitignored, and they're packaged into the app, so keep the video small.

## Router dashboard

[`routerdash/`](routerdash/) is a second, separate app: a full-screen status board for an OpenWrt
router. Every 5 seconds it fetches a read-only JSON endpoint on the router (`tv-status`, a CGI that
must send `Access-Control-Allow-Origin: *`) and shows:

- WAN and WAN6 (uptime, ping), CPU usage with the 1, 5 and 15 minute load averages, memory,
  connections and DHCP clients;
- WAN throughput, each physical port (link speed and live rates) and each active Wi-Fi network
  (band, channel, clients);
- every WireGuard tunnel, laid out to compare traffic: live rates, a bar against the busiest tunnel,
  a graph on one shared scale, and handshake age and ping in small print. Tiles shrink to fit past
  ten tunnels.

A bar on the left of each card rises and turns from green to red with load or poor health: CPU
usage, memory, connections, ping, and traffic against the bandwidth qosify is actually shaping to,
read live, so changing qosify needs no change here. Back returns to the launcher. Set the URL and
thresholds in [`routerdash/config.js`](routerdash/config.js), then:

```bash
npx -y -p @webos-tools/cli ares-package routerdash -o build
npx -y -p @webos-tools/cli ares-install -d lgtv build/com.jammy.routerdash_1.0.0_all.ipk
```

Run `sync-apps.py` again afterwards so the launcher gets a tile for it.

**Route editor**: press OK (or click Top 10) to list the devices in the routing Sheet with the
tunnel each one uses; pick one and choose another tunnel from the menu. Changes go through a Google
Apps Script web app that edits the Sheet, and the router applies them on its next sync, about a
minute later. It needs `routerdash/token.js` (gitignored, never commit it) containing
`window.TV_TOKEN = '<token>';`: the router hands out the Apps Script URL only for that token.
Without the file the editor stays locked and the rest of the dashboard works as before.

## Cleaning up LG's home

For when you do land on it. Names vary a little by webOS version:

- **Settings → General → System → Additional Settings → Home Settings**: turn off **Home
  Promotion** and **Content Recommendation**.
- **Settings → Support → Privacy & Terms → User Agreements**: untick **Viewing Information** and
  **Interest-Based Recommendations**.

## Troubleshooting

- **Pairing fails with "403 Pairing rejected: blacklisted certificate detected".** Newer firmware
  rejects the signed manifest that open-source LG clients share. `lgtv.py` pairs with an unsigned
  one, which still works.
- **No pairing prompt on the TV.** Turn on the TV's option for connecting from mobile apps (on the
  C6: Settings → General → Devices → External Devices; named "LG Connect Apps" or similar).
- **`ares` says "All configured authentication methods failed".** The device profile is missing
  its key: run the third command in step 2 again.
- **Apps stop opening after a while.** Developer Mode sessions expire (LG shows the time left in
  the Developer Mode app; it was 999 hours on our C6). Press **Extend Session Time** there.
  To renew it automatically from an OpenWrt router, copy the `ares` private key over
  (`scp -O $HOME\.ssh\lgtv_webos root@192.168.1.1:/root/webos-vibehack/` on Windows) and run
  `sh setup-devmode-renew.sh <TV IP> <passphrase>`: an hourly cron job reads the session token over
  SSH and calls LG's renewal URL, at most once a day. This is a community-documented method, not an
  official LG API; check with `logread | grep devmode-renew`.

## Files

| File | What it does |
|---|---|
| [`app/`](app/) | The launcher: `index.html`, `style.css`, `app.js`, `config.js`, `appinfo.json` |
| [`install.sh`](install.sh) | Syncs your apps, packages and installs the launcher, and opens it |
| [`install-windows.ps1`](install-windows.ps1) | The same on Windows, plus the `ares` CLI install and TV binding |
| [`setup-home-watch.sh`](setup-home-watch.sh) | Runs the watcher as a procd service on an OpenWrt router |
| [`setup-devmode-renew.sh`](setup-devmode-renew.sh) | Renews the Developer Mode session from an OpenWrt router via cron |
| [`sync-apps.py`](sync-apps.py) | Reads apps, icons and HDMI inputs from the TV into `app/apps.js` and `app/icons/` |
| [`home-watch.py`](home-watch.py) | Sends the Home button to the launcher |
| [`home-watch-mac.sh`](home-watch-mac.sh) | Runs the watcher as a macOS background service |
| [`lgtv.py`](lgtv.py) | Pairs with and talks to the TV's remote-control service |
| [`assets/icon.jpg`](assets/icon.jpg) | The app icon, resized to PNG by `install.sh` |
| [`docs/webos-appletv-style-notes.zh-TW.docx`](docs/webos-appletv-style-notes.zh-TW.docx) | Notes (Traditional Chinese): how the webOS port works, OpenWrt as the watcher |

## Credits

The design, layout and app icon come from [tv-vibehack](https://github.com/Gathin23/tv-vibehack)
by [Gathin](https://github.com/Gathin23). The Outfit font is under the SIL Open Font License
([`app/fonts/OFL.txt`](app/fonts/OFL.txt)). MIT licensed, see [`LICENSE`](LICENSE).
