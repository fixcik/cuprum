#!/usr/bin/env python3
"""Phase 0 spike: SDCP WebSocket dump (read-only).

Connects to ws://<MainboardIP>:3030/websocket, listens for auto-pushed messages,
then requests Attributes (Cmd 1) and Status (Cmd 0). Collects everything and saves
to ws_dump.json. Does NOT start any print — purely observational.

Reads printer Id / MainboardID / IP from discovery_response.json (override with flags).

Usage:
    python3 ws_dump.py [--ip IP] [--seconds N]
"""

import argparse
import asyncio
import json
import time
import uuid
from pathlib import Path

import aiohttp


def load_discovery():
    f = Path(__file__).with_name("discovery_response.json")
    if not f.exists():
        return None
    data = json.loads(f.read_text(encoding="utf-8"))
    for entry in data:
        d = entry.get("json", {}).get("Data", {})
        if d.get("MainboardIP"):
            return {
                "Id": entry["json"].get("Id", ""),
                "MainboardID": d.get("MainboardID", ""),
                "MainboardIP": d.get("MainboardIP", ""),
            }
    return None


def build_request(dev_id, mainboard_id, cmd):
    return {
        "Id": dev_id,
        "Data": {
            "Cmd": cmd,
            "Data": {},
            "RequestID": uuid.uuid4().hex,
            "MainboardID": mainboard_id,
            "TimeStamp": int(time.time()),
            "From": 0,
        },
        "Topic": f"sdcp/request/{mainboard_id}",
    }


async def run(ip, dev_id, mainboard_id, seconds):
    url = f"ws://{ip}:3030/websocket"
    print(f"[i] connecting {url}")
    collected = []

    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(url, heartbeat=None) as ws:
            print("[ok] connected")

            async def reader():
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        try:
                            parsed = json.loads(msg.data)
                            topic = parsed.get("Topic", "?")
                            print(f"[<] {topic}")
                            print(json.dumps(parsed, indent=2, ensure_ascii=False))
                            print()
                            collected.append(parsed)
                        except json.JSONDecodeError:
                            print(f"[<] non-JSON text: {msg.data!r}")
                            collected.append({"_raw": msg.data})
                    elif msg.type in (aiohttp.WSMsgType.CLOSED,
                                      aiohttp.WSMsgType.ERROR):
                        print(f"[!] ws closed/error: {msg.type}")
                        break

            reader_task = asyncio.create_task(reader())

            # give the printer a moment to auto-push anything on connect
            await asyncio.sleep(1.5)

            for cmd, label in ((1, "Attributes"), (0, "Status")):
                req = build_request(dev_id, mainboard_id, cmd)
                print(f"[>] Cmd {cmd} ({label})")
                await ws.send_str(json.dumps(req))
                await asyncio.sleep(0.4)

            await asyncio.sleep(seconds)
            reader_task.cancel()
            try:
                await reader_task
            except asyncio.CancelledError:
                pass

    return collected


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ip", default=None)
    ap.add_argument("--id", default=None)
    ap.add_argument("--mainboard", default=None)
    ap.add_argument("--seconds", type=float, default=5.0)
    args = ap.parse_args()

    disc = load_discovery() or {}
    ip = args.ip or disc.get("MainboardIP")
    dev_id = args.id or disc.get("Id", "")
    mainboard_id = args.mainboard or disc.get("MainboardID", "")

    if not ip or not mainboard_id:
        raise SystemExit("[x] need IP + MainboardID. Run discover.py first or pass --ip/--mainboard.")

    print(f"[i] ip={ip} mainboard={mainboard_id} id={dev_id or '(empty)'}")
    collected = asyncio.run(run(ip, dev_id, mainboard_id, args.seconds))

    out = Path(__file__).with_name("ws_dump.json")
    out.write_text(json.dumps(collected, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[ok] {len(collected)} message(s) collected. Saved -> {out}")
    if not collected:
        print("[!] nothing received — printer may push only on change; try --seconds 10")


if __name__ == "__main__":
    main()
