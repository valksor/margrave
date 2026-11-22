# syntax=docker/dockerfile:1
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS runtime-base

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates git libatomic1 openssh-client \
    && rm -rf /var/lib/apt/lists/*

FROM runtime-base AS source-collection
RUN sed 's/^Types: deb$/Types: deb-src/' /etc/apt/sources.list.d/debian.sources > /etc/apt/sources.list.d/debian-src.sources \
    && apt-get update \
    && mkdir /debian-sources \
    && dpkg-query -W -f='${db:Status-Status}\t${source:Package}\t${source:Version}\n' > /tmp/package-inventory \
    && awk -F '\t' '$1 == "installed" { if (NF != 3 || $2 !~ /^[a-z0-9][a-z0-9+.-]*$/ || $3 !~ /^[^[:space:]]+$/) exit 1; print $2 "=" $3 }' /tmp/package-inventory > /tmp/source-inventory \
    && sort -u /tmp/source-inventory > /debian-sources/manifest.txt \
    && test -s /debian-sources/manifest.txt \
    && chown _apt /debian-sources \
    && cd /debian-sources \
    && set -- \
    && while IFS= read -r source; do set -- "$@" "$source"; done < manifest.txt \
    && apt-get source --only-source --download-only "$@"

FROM scratch AS debian-sources
COPY --from=source-collection /debian-sources /debian-sources

FROM runtime-base AS runtime
ARG TARGETARCH
ADD --chown=0:0 margrave-${TARGETARCH}.tar.gz /opt/
RUN useradd --create-home --uid 1000 margrave \
    && mkdir /home/margrave/.margrave \
    && chown margrave:margrave /home/margrave/.margrave
ENV HOME=/home/margrave
WORKDIR /home/margrave
USER margrave
RUN /opt/margrave/bin/margrave version \
    && /opt/margrave/vendor/ripwire/ripwire --version \
    && test -f /usr/share/doc/git/copyright \
    && test -f /usr/share/common-licenses/GPL-2 \
    && test -f /usr/share/common-licenses/GPL-3
ENTRYPOINT ["/opt/margrave/bin/margrave"]
CMD ["--help"]
