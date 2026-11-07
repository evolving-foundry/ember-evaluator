"""Read-only NPU sampling owned by a CLI connection, using Python stdlib only."""
import argparse
import hmac
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import socketserver
import sys
import threading
import uuid

from local_telemetry import LocalTelemetry

LIMIT = 65536


def read_message(stream):
    line = stream.readline(LIMIT + 1)
    if not line:
        return None
    if len(line) > LIMIT or not line.endswith(b"\n"):
        raise ValueError("Invalid sampling protocol message")
    value = json.loads(line)
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError("Invalid sampling protocol version")
    return value


def send(stream, kind, **values):
    stream.write((json.dumps({"schemaVersion": 1, "type": kind, **values}) + "\n").encode())
    stream.flush()


def devices_from(request):
    devices = request.get("devices")
    if not isinstance(devices, list) or not devices or len(devices) > 256:
        raise ValueError("Expected explicit NPU devices")
    seen = set()
    for device in devices:
        if not isinstance(device, dict) or set(device) - {"deviceId", "chipId"}:
            raise ValueError("Invalid NPU target fields")
        if "deviceId" not in device or any(type(v) is not int or v < 0 or v > 2**53 - 1 for v in device.values()):
            raise ValueError("Invalid NPU target number")
        if device["deviceId"] in seen:
            raise ValueError("Duplicate NPU device")
        seen.add(device["deviceId"])
    return devices


def sample_connection(request, reader, writer, artifacts):
    if request.get("op") != "sample":
        raise ValueError("Unknown sampling operation")
    devices = devices_from(request)
    with LocalTelemetry({"ascend": {"mode": "local", "devices": devices}}, artifacts) as telemetry:
        send(writer, "ready", targets=telemetry.evidence())
        message = read_message(reader)
        if message is not None and message.get("op") != "finish":
            raise ValueError("Unknown sampling session operation")
        targets = telemetry.evidence()
    if message is not None:
        send(writer, "finished", targets=targets)


class SamplingServer(socketserver.ThreadingTCPServer):
    daemon_threads = False
    allow_reuse_address = False

    def __init__(self, token, artifacts):
        self.token, self.artifacts = token, artifacts
        self.active = set()
        self.active_lock = threading.Lock()
        super().__init__(("127.0.0.1", 0), SamplingHandler)

    def close_connections(self):
        with self.active_lock:
            connections = list(self.active)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


class SamplingHandler(socketserver.StreamRequestHandler):
    def handle(self):
        with self.server.active_lock:
            self.server.active.add(self.connection)
        try:
            self.connection.settimeout(10)
            request = read_message(self.rfile)
            if request is None or not isinstance(request.get("token"), str) or not hmac.compare_digest(request["token"], self.server.token):
                send(self.wfile, "error", message="Sampling authentication failed")
                return
            self.connection.settimeout(None)
            if request.get("op") == "ping":
                send(self.wfile, "pong")
                return
            sample_connection(request, self.rfile, self.wfile, self.server.artifacts / uuid.uuid4().hex)
        except (OSError, ValueError, KeyboardInterrupt) as error:
            try:
                send(self.wfile, "error", message=str(error))
            except OSError:
                pass
        finally:
            with self.server.active_lock:
                self.server.active.discard(self.connection)


def serve(ready_file):
    token = secrets.token_hex(32)
    with SamplingServer(token, ready_file.parent / "sessions") as server:
        ready = {"schemaVersion": 1, "address": "127.0.0.1:%d" % server.server_address[1], "token": token}
        if ready_file.exists():
            raise ValueError("Sampling readiness file already exists")
        temporary = ready_file.with_suffix(".tmp")
        with temporary.open("x", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            stream.write(json.dumps(ready) + "\n")
        temporary.replace(ready_file)

        def stop(_signal, _frame):
            server.close_connections()
            threading.Thread(target=server.shutdown, daemon=True).start()

        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, stop)
        try:
            server.serve_forever(poll_interval=0.1)
        finally:
            server.close_connections()
            ready_file.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serve", type=Path)
    parser.add_argument("--artifacts", type=Path)
    args = parser.parse_args()
    if args.serve:
        serve(args.serve)
        return
    if args.artifacts is None:
        parser.error("stdio sampling requires --artifacts")
    request = read_message(sys.stdin.buffer)
    if request is None:
        raise ValueError("Missing sampling request")
    sample_connection(request, sys.stdin.buffer, sys.stdout.buffer, args.artifacts)


if __name__ == "__main__":
    main()
