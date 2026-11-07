from setuptools import setup

setup(
    name="evaluator-agentx-bridge",
    version="1.0.0",
    packages=["evaluator_agentx"],
    package_data={"evaluator_agentx": ["plugins.yaml"]},
    entry_points={"aiperf.plugins": ["evaluator_agentx=evaluator_agentx:plugins.yaml"]},
)
