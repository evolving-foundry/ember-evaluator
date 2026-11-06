"""Create a private runtime; do not install packages into the user's interpreter."""
import os
from pathlib import Path
import subprocess
import sys
import venv

if not (3, 11) <= sys.version_info[:2] < (3, 14):
    raise RuntimeError("AgentX requires Python 3.11–3.13")
root = Path(sys.argv[1]).resolve()
assets = Path(__file__).resolve().parent
venv.EnvBuilder(with_pip=True).create(root)
python = root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
pip_install = [str(python), "-m", "pip", "install", "--disable-pip-version-check"]
subprocess.run([*pip_install, "-r", str(assets / "requirements.txt")], check=True)
subprocess.run([*pip_install, "--no-deps", "--no-build-isolation", str(assets)], check=True)
