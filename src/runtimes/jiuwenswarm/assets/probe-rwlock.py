"""Check the pinned SDK's file tool lock lifecycle before model execution."""
import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory

from openjiuwen.core.sys_operation.local._async_read_write_lock import HybridAsyncReadWriteLock


async def probe():
    with TemporaryDirectory(prefix="evaluator-rwlock-") as root:
        lock = HybridAsyncReadWriteLock(Path(root) / "probe.db")
        async with lock.write(3):
            pass
        async with lock.read(3):
            pass
        await lock.close()


asyncio.run(asyncio.wait_for(probe(), timeout=10))
print("jiuwenswarm-rwlock-ok")
