import importlib.util
import sys
import threading
from urllib.request import urlopen

spec = importlib.util.spec_from_file_location("distribution_metrics", sys.argv[1])
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)
sampler = metrics.DeviceSampler(0, 0, reader=lambda *_: {entry[0]: 1.0 for entry in metrics.FIELDS.values()})
sampler.sample()
server = metrics.create_server(sampler, "127.0.0.1", 0)
worker = threading.Thread(target=server.serve_forever)
worker.start()
try:
    with urlopen("http://127.0.0.1:%s/metrics" % server.server_port, timeout=5) as response:
        assert response.status == 200
        print(response.read().decode())
finally:
    server.shutdown()
    server.server_close()
    worker.join(timeout=5)
    assert not worker.is_alive()
