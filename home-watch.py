#!/usr/bin/env python3
"""Make the Home button open the launcher instead of LG's home.

webOS does not let an app replace Home, or even see which app is in front, so this runs on
another always-on device on the same network (a Mac, a Raspberry Pi, a phone in Termux). It
watches the foreground app over the TV's remote-control service and, the moment LG's home
appears, launches the launcher on top. LG's home shows for about half a second.

Press Home twice within ESCAPE_SECONDS to stay on LG's home (for its menus).

The remote's Home Dashboard button is turned into an input switch the same way: each press goes
to the next HDMI input (1 -> 2 -> 3 -> 4 -> 1), or to HDMI 1 when no HDMI input is in front.
Press it twice within ESCAPE_SECONDS to open the Home Dashboard as usual.

    python3 home-watch.py 192.168.1.50

Needs: pip install websockets. Pair once first (sync-apps.py does it).
"""
import asyncio
import json
import os
import sys
import time

import lgtv

LAUNCHER = "com.gathin.tvhome"
LG_HOME = "com.webos.app.home"
DASHBOARD = "com.webos.app.homeconnect"
HDMI_INPUTS = ["com.webos.app.hdmi1", "com.webos.app.hdmi2", "com.webos.app.hdmi3", "com.webos.app.hdmi4"]
ESCAPE_SECONDS = 3.0


def log(*args):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *args, flush=True)


async def watch(host):
    ws = await lgtv.session(host, ping_interval=10, ping_timeout=10)
    log("connected to", host)
    last_redirect = 0.0
    last_switch = 0.0
    previous = None
    try:
        await ws.send(json.dumps({"type": "subscribe", "id": "fg",
                                  "uri": "ssap://com.webos.applicationManager/getForegroundAppInfo",
                                  "payload": {}}))
        async for raw in ws:
            msg = json.loads(raw)
            if msg.get("id") != "fg":
                continue
            app = msg.get("payload", {}).get("appId")
            before, previous = previous, app
            if app == DASHBOARD:
                now = time.monotonic()
                if now - last_switch < ESCAPE_SECONDS:
                    log("Dashboard pressed twice: staying on Home Dashboard")
                    last_switch = 0.0
                    continue
                last_switch = now
                if before in HDMI_INPUTS:
                    target = HDMI_INPUTS[(HDMI_INPUTS.index(before) + 1) % len(HDMI_INPUTS)]
                else:
                    target = HDMI_INPUTS[0]
                await ws.send(json.dumps({"type": "request", "id": "launch", "uri": "ssap://system.launcher/launch",
                                          "payload": {"id": target}}))
                log("Home Dashboard ->", target)
                continue
            if app != LG_HOME:
                continue
            now = time.monotonic()
            if now - last_redirect < ESCAPE_SECONDS:
                log("Home pressed twice: staying on LG home")
                last_redirect = 0.0
                continue
            last_redirect = now
            await ws.send(json.dumps({"type": "request", "id": "launch", "uri": "ssap://system.launcher/launch",
                                      "payload": {"id": LAUNCHER}}))
            log("LG home -> launcher")
    finally:
        await ws.close()


async def main(host):
    delay = 5
    while True:
        try:
            await watch(host)
            delay = 5
        except (OSError, asyncio.TimeoutError, lgtv.websockets.WebSocketException) as e:
            # TV off, in standby or off the network: keep trying, but back off.
            log("not connected:", type(e).__name__, e)
            delay = min(delay * 2, 20)
        await asyncio.sleep(delay)


if __name__ == "__main__":
    host = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TV_HOST")
    if not host:
        sys.exit("usage: home-watch.py <TV IP>")
    try:
        asyncio.run(main(host))
    except KeyboardInterrupt:
        pass
