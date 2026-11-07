"""Build the pinned upstream runtime through configured transports, preserving its lock."""
from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import time
import tomllib
from pathlib import Path
from urllib.parse import urlsplit

WORKBUDDY_REPOSITORY = "https://github.com/Tencent/workbuddy-bench.git"
WORKBUDDY_COMMIT = "625b2233093ae4f23e76be28c1f341d41cc70373"


def run_bounded(args: list[str], *, timeout: float, check: bool = True, **options) -> subprocess.CompletedProcess:
    process = subprocess.Popen(args, start_new_session=os.name == "posix", **options)
    try:
        code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass
        process.wait()
        raise
    if check and code:
        raise subprocess.CalledProcessError(code, args)
    return subprocess.CompletedProcess(args, code)


def fetch_checkout(repository: str, commit: str, target: Path, *, run=run_bounded, sleep=time.sleep) -> None:
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Upstream Git revision must be an immutable commit")
    if not repository.startswith("https://github.com/"):
        raise ValueError("Unexpected upstream repository")
    mirror = os.environ.get("EVALUATOR_GITHUB_MIRROR", "https://github.com/").rstrip("/") + "/"
    parsed = urlsplit(mirror)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("GitHub mirror must be a credential-free HTTP(S) URL prefix")
    url = mirror + repository.removeprefix("https://github.com/")
    run(["git", "init", str(target)], check=True, timeout=30)
    run(["git", "-C", str(target), "remote", "add", "origin", url], check=True, timeout=30)
    for attempt in range(3):
        try:
            run(["git", "-C", str(target), "-c", "http.lowSpeedLimit=1024", "-c", "http.lowSpeedTime=30",
                 "fetch", "--depth=1", "origin", commit], check=True, timeout=120,
                env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
            break
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            if attempt == 2:
                raise
            sleep(2 ** (attempt + 1))
    run(["git", "-C", str(target), "checkout", "--detach", commit], check=True, timeout=30)


def locked_harbor(lock: dict) -> tuple[str, str]:
    package = next(package for package in lock["package"] if package["name"] == "harbor")
    source = urlsplit(package["source"]["git"])
    if source.scheme != "https" or source.netloc != "github.com" or source.path != "/harbor-framework/harbor.git":
        raise ValueError("Unexpected locked Harbor repository")
    if not re.fullmatch(r"[a-f0-9]{40}", source.fragment):
        raise ValueError("Harbor lock must contain an immutable Git commit")
    return "https://github.com" + source.path, source.fragment


def main() -> None:
    runtime = Path("/runtime")
    fetch_checkout(WORKBUDDY_REPOSITORY, WORKBUDDY_COMMIT, runtime)
    original_lock = (runtime / "uv.lock").read_bytes()
    harbor_repository, harbor_commit = locked_harbor(tomllib.loads(original_lock.decode()))
    harbor = Path("/harbor")
    fetch_checkout(harbor_repository, harbor_commit, harbor)
    install_dependencies(runtime, harbor)


def install_dependencies(runtime: Path, harbor: Path, *, run=run_bounded) -> None:
    original_lock = (runtime / "uv.lock").read_bytes()
    # Export only registry packages. Their versions and hashes come from the
    # upstream lock; uv pip resolves download locations against the selected
    # mirror instead of following uv.lock's files.pythonhosted.org URLs.
    requirements = "/tmp/verifier-requirements.txt"
    run(["uv", "export", "--frozen", "--offline", "--no-dev", "--no-emit-project",
                    "--no-emit-package", "harbor", "--format", "requirements-txt", "--output-file", requirements],
                   cwd=runtime, check=True, timeout=60)
    python = str(runtime / ".venv/bin/python")
    run(["uv", "venv", "--no-python-downloads", "--python", sys.executable, str(runtime / ".venv")],
                   check=True, timeout=60)
    index = os.environ["PIP_INDEX_URL"]
    environment = {**os.environ, "UV_HTTP_TIMEOUT": "60", "UV_HTTP_RETRIES": "3", "UV_PYTHON_DOWNLOADS": "never"}
    run(["uv", "pip", "install", "--python", python, "--no-config", "--no-deps", "--require-hashes",
                    "--default-index", index, "--requirements", requirements], check=True, env=environment, timeout=900)
    run(["uv", "pip", "install", "--python", python, "--no-config", "--no-deps", "--default-index", index,
                    str(harbor), str(runtime)], check=True, env=environment, timeout=300)
    if (runtime / "uv.lock").read_bytes() != original_lock:
        raise RuntimeError("Verifier build changed the upstream dependency lock")


if __name__ == "__main__":
    main()
