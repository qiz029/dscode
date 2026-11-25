# The Linux end-to-end harness. `npm run test:e2e` builds and runs this image, and
# the scheduled workflow runs the same thing. It exists for two reasons the macOS
# gate cannot cover: a nested Seatbelt profile is refused inside a dscode session,
# so `verify:hub` (install the bundle, boot the installed profile, fail an upgrade,
# roll back) can never run there, and nothing verified the harness on Linux at all.
# The Docker Official Images mirror avoids Docker Hub's anonymous pull quota on
# shared CI runners while retaining the same Node/Debian image. Node 24 matches the
# macOS checks and the private runtime the self-contained packages ship. CI can
# select the official Docker Hub image when this mirror is rate-limited.
ARG DSCODE_E2E_BASE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm-slim
FROM ${DSCODE_E2E_BASE_IMAGE}

# git: verify:hub initialises a repository and the worktree probe creates its own.
# curl: install.sh needs it on the piped path, and its unit tests run it for real.
# python3: the Unicode shell regression drives a real PTY with the standard library.
# bubblewrap: the Linux backend the harness confines commands with.
# ca-certificates: npm, the loopback Hub fixture's upstream proxy, and the registry.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git bubblewrap python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /dscode

# The dependency graph first, so editing the source does not reinstall it. Scripts stay
# off: `npm run setup` is the one step that patches the runtime, and it runs per check.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .

# English output keeps the probe assertions stable, and CI keeps npm non-interactive.
ENV DSCODE_LANGUAGE=en \
    CI=1

CMD ["node", "scripts/e2e.mjs", "--inside"]
