# Throwaway deploy target for scripts/verify-deploy.sh: an SSH server with the
# Docker CLI and the Compose plugin, standing in for the customer's server.
# It drives the host's Docker daemon through a mounted socket. CI only.
FROM docker:28-cli AS docker-cli

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install --yes --no-install-recommends bash ca-certificates openssh-server \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh && mkdir -p /run/sshd
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
