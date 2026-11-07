FROM node:24.22.1-bookworm-slim AS node
FROM docker:28.5.1-cli AS docker
FROM python:3.12.14-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    apt-get update && apt-get install -y --no-install-recommends bash openssl ca-certificates libstdc++6 && \
    rm -rf /var/lib/apt/lists/*
ARG NPM_CONFIG_REGISTRY="https://registry.npmjs.org"
ENV NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY}
ARG PIP_INDEX_URL="https://pypi.org/simple"
ENV PIP_INDEX_URL=${PIP_INDEX_URL}
WORKDIR /opt/evaluator
# Build the local dist and install dependencies before composing this smoke image.
COPY dist/adapters/harness/pi/runtime-package.json ./package.json
COPY dist/adapters/harness/pi/runtime-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --registry="${NPM_CONFIG_REGISTRY}"
COPY node_modules/agent-bundle-core/package.json ./node_modules/agent-bundle-core/package.json
COPY node_modules/agent-bundle-core/dist ./node_modules/agent-bundle-core/dist
COPY dist/infrastructure/ray/python/requirements.txt ./ray-requirements.txt
RUN pip install --no-cache-dir -r ray-requirements.txt "ray[default]==2.58.0"
COPY dist ./dist
COPY scripts ./scripts
COPY tests/fixtures/ray/plugin.mjs ./scripts/ray-smoke/controlled.mjs
ARG EVALUATOR_SOURCE_FINGERPRINT="manual"
LABEL org.ember.evaluator.source-fingerprint="${EVALUATOR_SOURCE_FINGERPRINT}"
ENTRYPOINT ["node", "scripts/ray-smoke/start.mjs"]
