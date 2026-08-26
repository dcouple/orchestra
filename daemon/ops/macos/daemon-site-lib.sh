#!/bin/bash
# Shared by the macOS ops scripts: loads the site config (site.env) that
# carries this deployment's identity, and renders the @PLACEHOLDER@ templates
# next to it. Sourced, never executed.

DAEMON_SITE_ENV=${DAEMON_SITE_ENV:-/usr/local/etc/linear-agent-daemon/site.env}

site_die() { echo "$*" >&2; return 1; }

load_site_env() {
  [[ -r $DAEMON_SITE_ENV ]] || site_die "site config missing or unreadable: $DAEMON_SITE_ENV (copy daemon/ops/macos/site.env.example, fill it in, and pass it to provision.sh --site)" || return
  local line key value
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    [[ $line == *=* ]] || site_die "site config: malformed line: $line" || return
    key=${line%%=*}; value=${line#*=}
    case $key in
      DAEMON_PUBLIC_HOSTNAME|DAEMON_TUNNEL_NAME|DAEMON_SERVICE_USER|DAEMON_SERVICE_HOME|DAEMON_LAUNCHD_PREFIX|DAEMON_SOURCE_REPO_URL) ;;
      *) site_die "site config: unknown key: $key" || return ;;
    esac
    printf -v "$key" '%s' "$value"
  done < "$DAEMON_SITE_ENV"
  : "${DAEMON_SERVICE_USER:?site config: DAEMON_SERVICE_USER is required}"
  DAEMON_SERVICE_HOME=${DAEMON_SERVICE_HOME:-/Users/$DAEMON_SERVICE_USER}
  : "${DAEMON_PUBLIC_HOSTNAME:?site config: DAEMON_PUBLIC_HOSTNAME is required}"
  : "${DAEMON_LAUNCHD_PREFIX:?site config: DAEMON_LAUNCHD_PREFIX is required}"
  DAEMON_TUNNEL_NAME=${DAEMON_TUNNEL_NAME:-linear-agent}
  DAEMON_SOURCE_REPO_URL=${DAEMON_SOURCE_REPO_URL:-https://github.com/dcouple/orchestra.git}
  # Values are substituted with sed using | as the delimiter and land in
  # plists, sudoers, and YAML — keep them to the characters those accept.
  [[ $DAEMON_SERVICE_USER =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || site_die "site config: invalid DAEMON_SERVICE_USER: $DAEMON_SERVICE_USER" || return
  [[ $DAEMON_SERVICE_HOME =~ ^/[A-Za-z0-9._/-]+$ ]] || site_die "site config: invalid DAEMON_SERVICE_HOME: $DAEMON_SERVICE_HOME" || return
  [[ $DAEMON_PUBLIC_HOSTNAME =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || site_die "site config: invalid DAEMON_PUBLIC_HOSTNAME: $DAEMON_PUBLIC_HOSTNAME" || return
  [[ $DAEMON_LAUNCHD_PREFIX =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$ ]] || site_die "site config: invalid DAEMON_LAUNCHD_PREFIX: $DAEMON_LAUNCHD_PREFIX" || return
  [[ $DAEMON_TUNNEL_NAME =~ ^[A-Za-z0-9._-]+$ ]] || site_die "site config: invalid DAEMON_TUNNEL_NAME: $DAEMON_TUNNEL_NAME" || return
  [[ $DAEMON_SOURCE_REPO_URL == https://* && $DAEMON_SOURCE_REPO_URL != *'|'* ]] || site_die "site config: DAEMON_SOURCE_REPO_URL must be an https:// URL" || return
  DAEMON_LABEL=$DAEMON_LAUNCHD_PREFIX.linear-agent-daemon
  PROXY_LABEL=$DAEMON_LAUNCHD_PREFIX.cliproxyapi
  TUNNEL_LABEL=$DAEMON_LAUNCHD_PREFIX.cloudflared
  export DAEMON_PUBLIC_HOSTNAME DAEMON_TUNNEL_NAME DAEMON_SERVICE_USER DAEMON_SERVICE_HOME \
    DAEMON_LAUNCHD_PREFIX DAEMON_SOURCE_REPO_URL DAEMON_LABEL PROXY_LABEL TUNNEL_LABEL
}

# render_site_template TEMPLATE > OUTPUT — substitutes the site placeholders.
# @TUNNEL_ID@ is deliberately left alone; the provisioner fills it from the
# tunnel credentials on the host.
render_site_template() {
  sed -e "s|@SERVICE_USER@|$DAEMON_SERVICE_USER|g" \
      -e "s|@SERVICE_HOME@|$DAEMON_SERVICE_HOME|g" \
      -e "s|@LAUNCHD_PREFIX@|$DAEMON_LAUNCHD_PREFIX|g" \
      -e "s|@PUBLIC_HOSTNAME@|$DAEMON_PUBLIC_HOSTNAME|g" \
      "$1"
}

# render_site_templates DIR — renders every template the provisioner installs
# into DIR: <label>.plist for the three services, sudoers, and the cloudflared
# config (still carrying @TUNNEL_ID@).
render_site_templates() {
  local src=${SITE_TEMPLATE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)} out=$1 rendered
  render_site_template "$src/linear-agent-daemon.plist.template" > "$out/$DAEMON_LABEL.plist"
  render_site_template "$src/cliproxyapi.plist.template" > "$out/$PROXY_LABEL.plist"
  render_site_template "$src/cloudflared.plist.template" > "$out/$TUNNEL_LABEL.plist"
  render_site_template "$src/sudoers-services.template" > "$out/sudoers"
  render_site_template "$src/cloudflared-config.yml.template" > "$out/cloudflared-config.yml"
  for rendered in "$out/$DAEMON_LABEL.plist" "$out/$PROXY_LABEL.plist" "$out/$TUNNEL_LABEL.plist" "$out/sudoers" "$out/cloudflared-config.yml"; do
    ! grep -qE '@(SERVICE_USER|SERVICE_HOME|LAUNCHD_PREFIX|PUBLIC_HOSTNAME)@' "$rendered" || site_die "unrendered placeholder in $rendered" || return
  done
}
