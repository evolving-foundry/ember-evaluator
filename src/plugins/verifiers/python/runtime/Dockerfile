FROM python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG EVALUATOR_GITHUB_MIRROR=https://github.com/
RUN apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o APT::Update::Error-Mode=any update && \
    apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --retries 3 --timeout 60 --index-url "$PIP_INDEX_URL" uv==0.10.2
COPY build-runtime.py /bridge/build-runtime.py
RUN python /bridge/build-runtime.py
COPY worker.py /bridge/worker.py
COPY workbuddy.py /bridge/workbuddy.py
ENTRYPOINT ["/runtime/.venv/bin/python", "-I", "/bridge/worker.py"]
