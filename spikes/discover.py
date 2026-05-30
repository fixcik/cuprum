#!/usr/bin/env python3
"""Phase 0 spike: SDCP discovery for Elegoo Saturn 4 Ultra.

Broadcasts "M99999" on UDP:3000 and collects JSON responses from any
SDCP-compatible printer on the LAN. Saves raw responses to discovery_response.json.

Usage:
    python3 discover.py [--timeout SECONDS] [--broadcast ADDR]
"""

import argparse
import json
import socket
import sys
import time
from pathlib import Path

DISCOVERY_MSG = b"M99999"
SDCP_PORT = 3000


def broadcast_addrs(explicit=None):
    addrs = []
    if explicit:
        addrs.append(explicit)
    # Global broadcast
    addrs.append("255.255.255.255")
    # Subnet-directed broadcast derived from local IP (best-effort /24)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        parts = local_ip.split(".")
        subnet_bc = ".".join(parts[:3] + ["255"])
        if subnet_bc not in addrs:
            addrs.append(subnet_bc)
        print(f"[i] local IP detected: {local_ip}")
    except OSError as e:
        print(f"[!] could not detect local IP: {e}")
    return addrs


def discover(timeout, explicit_bc):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.bind(("", 0))
    src_port = sock.getsockname()[1]
    print(f"[i] listening on UDP source port {src_port}")

    for addr in broadcast_addrs(explicit_bc):
        try:
            sock.sendto(DISCOVERY_MSG, (addr, SDCP_PORT))
            print(f"[>] sent {DISCOVERY_MSG!r} -> {addr}:{SDCP_PORT}")
        except OSError as e:
            print(f"[!] send to {addr} failed: {e}")

    print(f"[i] waiting up to {timeout}s for responses... (Ctrl-C to stop)\n")
    sock.settimeout(0.5)
    responses = []
    seen = set()
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            data, src = sock.recvfrom(65535)
        except socket.timeout:
            continue
        if src in seen:
            continue
        seen.add(src)
        raw = data.decode("utf-8", errors="replace")
        print(f"[<] response from {src[0]}:{src[1]} ({len(data)} bytes)")
        try:
            parsed = json.loads(raw)
            print(json.dumps(parsed, indent=2, ensure_ascii=False))
            responses.append({"from": f"{src[0]}:{src[1]}", "json": parsed})
        except json.JSONDecodeError:
            print(f"[!] not valid JSON, raw:\n{raw}")
            responses.append({"from": f"{src[0]}:{src[1]}", "raw": raw})
        print()
    sock.close()
    return responses


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=float, default=6.0)
    ap.add_argument("--broadcast", default=None,
                    help="explicit broadcast/target address to also try")
    args = ap.parse_args()

    responses = discover(args.timeout, args.broadcast)
    if not responses:
        print("[x] no printers responded.")
        print("    - confirm the printer is powered on and on the same WiFi/LAN")
        print("    - macOS may prompt to allow incoming UDP for python3 (allow it)")
        print("    - try: python3 discover.py --broadcast <printer_subnet>.255")
        sys.exit(1)

    out = Path(__file__).with_name("discovery_response.json")
    out.write_text(json.dumps(responses, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[ok] {len(responses)} printer(s) found. Saved -> {out}")


if __name__ == "__main__":
    main()
