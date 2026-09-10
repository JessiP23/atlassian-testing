# panda-agent runtime — one image, every pin explicit. Built from a git tag by .github/workflows/build-image.yml
# and run by pioneer-ticket-to-pr.yml as `container:`. Nothing here is installed at job time.
#
#   Node 20.14.0          pioneer's .nvmrc
#   Playwright 1.63.0-α   the exact version @playwright/mcp 0.0.80 depends on — its Chromium is the one baked in
#   @playwright/mcp       0.0.80  (screenshot/video paths changed between releases; `@latest` is how a run drifts)
#   Claude Code           2.1.267 (stream-json format is parsed by the agent)
#   Xvfb                  headed Chromium — qa's WAF Bot Control rejects HeadlessChrome
#   ffmpeg                webm → gif for the PR
#
# Rebuild on purpose (monthly bump PR, gated by the agent's self-tests and retrieval eval), never by accident.
FROM node:20.14.0-bookworm

ARG PLAYWRIGHT_VERSION=1.63.0-alpha-2026-08-31
ARG PLAYWRIGHT_MCP_VERSION=0.0.80
ARG CLAUDE_CODE_VERSION=2.1.267
ARG AGENT_REF=dev

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DISPLAY=:99 \
    CLAUDE_CODE_USE_BEDROCK=1 \
    PAG_ENV_PRECEDENCE=env \
    PAG_QUIET_ENV=1 \
    PAG_IMAGE_REF=${AGENT_REF}

# OS: virtual display, video encode, fonts, git, jq, AWS CLI, GitHub CLI. All from the pinned base's Debian.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      xvfb ffmpeg fonts-liberation fonts-noto-color-emoji git jq curl ca-certificates unzip lsof procps \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update -qq && apt-get install -y -qq --no-install-recommends gh \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip \
    && rm -rf /var/lib/apt/lists/*

# Toolchain: Playwright (matching the MCP's own dependency), its Chromium + system deps, the MCP, Claude Code.
RUN npm install -g --no-audit --no-fund \
      playwright@${PLAYWRIGHT_VERSION} \
      @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= npx playwright install --with-deps chromium \
    && npm cache clean --force

# The agent itself, from this checkout (the build workflow checks out the tag).
WORKDIR /opt/panda-agent
COPY agent/ ./agent/
RUN cd agent/graph && npm ci --no-audit --no-fund && npm test

# Xvfb is started by the entrypoint so every process in the job — the MCP's Chromium included — has a screen.
COPY agent/docker/entrypoint.sh /usr/local/bin/panda-entrypoint
RUN chmod +x /usr/local/bin/panda-entrypoint

LABEL org.opencontainers.image.title="panda-agent" \
      org.opencontainers.image.revision="${AGENT_REF}" \
      org.opencontainers.image.description="Jira ticket → draft PR with evidence. Pinned runtime: Node 20.14, Playwright ${PLAYWRIGHT_VERSION}, MCP ${PLAYWRIGHT_MCP_VERSION}, Claude Code ${CLAUDE_CODE_VERSION}."

ENTRYPOINT ["/usr/local/bin/panda-entrypoint"]
CMD ["bash"]
