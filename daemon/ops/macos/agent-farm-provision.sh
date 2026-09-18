#!/bin/bash
# shellcheck disable=SC2015
# Sourced by provision.sh. Uses its agent(), record(), and fail() helpers.
AGENT_FARM_VERSION=0.1.1
AGENT_FARM_BIN=$AGENT_HOME/.pnpm/bin/agent-farm
AGENT_FARM_VERSION_FILE=$AGENT_HOME/.pnpm/agent-farm-version
AGENT_FARM_CONFIG_ROOT=$AGENT_HOME/.config/agent-farm
AGENT_FARM_PACKAGE_ROOT=
AGENT_FARM_PLUGIN_SOURCE=

agent_farm_cli_correct() {
  agent test -x "$AGENT_FARM_BIN" && agent test -f "$AGENT_FARM_VERSION_FILE" \
    && [[ $(agent cat "$AGENT_FARM_VERSION_FILE" 2>/dev/null) == "$AGENT_FARM_VERSION" ]]
}
agent_farm_resolve_plugin_source() {
  local package_root
  # pnpm 11 isolates each global package; ask pnpm for its installed path.
  package_root=$(agent /usr/local/bin/pnpm list --global --depth 0 --json </dev/null \
    | agent node -e '
      const fs = require("node:fs");
      const entries = JSON.parse(fs.readFileSync(0, "utf8"));
      const item = entries.map(entry => entry.dependencies?.["@dcouple/agent-farm"]).find(Boolean);
      if (!item || typeof item.path !== "string" || !item.path) process.exit(1);
      process.stdout.write(item.path);
    ') || return 1
  AGENT_FARM_PACKAGE_ROOT=$package_root
  AGENT_FARM_PLUGIN_SOURCE=$AGENT_FARM_PACKAGE_ROOT/plugins/dcouple
}
agent_farm_plugin_correct() {
  agent node "$SCRIPT_DIR/agent-farm-state.mjs" "$AGENT_FARM_PACKAGE_ROOT" "$AGENT_FARM_CONFIG_ROOT" </dev/null >/dev/null 2>&1
}
agent_farm_profiles_correct() {
  local profile
  for profile in planner implementer; do
    agent cmp -s "$AGENT_FARM_PLUGIN_SOURCE/profiles/$profile.yaml" "$AGENT_FARM_CONFIG_ROOT/profiles/$profile.yaml" \
      && agent "$AGENT_FARM_BIN" inspect "$profile" --config-root "$AGENT_FARM_CONFIG_ROOT" </dev/null >/dev/null 2>&1 || return 1
  done
}

# ITEM 5 WORKSPACE PLACEMENT HOOK: add its managed workspace installation and
# readback here, using DRY_RUN to inspect only and preserving unrelated files.
# Until item 5 supplies that file, this hook records the dependency and writes
# nothing. It runs in both inventory and apply paths.
provision_agent_farm_workspace() {
  record agent-farm-workspace "pending-item-5: workspace placement"
}

provision_agent_farm() {
  local cli_correct=0 plugin_correct=0 profiles_correct=0
  agent_farm_cli_correct && cli_correct=1
  if (( cli_correct )) && agent_farm_resolve_plugin_source 2>/dev/null; then
    agent_farm_plugin_correct && plugin_correct=1
    agent_farm_profiles_correct && profiles_correct=1
  fi
  if (( DRY_RUN )); then
    (( cli_correct )) && record agent-farm-cli already-correct || record agent-farm-cli would-apply
    (( plugin_correct )) && record agent-farm-plugin already-correct || record agent-farm-plugin would-apply
    (( profiles_correct )) && record agent-farm-profiles already-correct || record agent-farm-profiles would-apply
    provision_agent_farm_workspace
    return 0
  fi

  if (( cli_correct )); then record agent-farm-cli already-correct; else
    agent /usr/local/bin/pnpm add --global "@dcouple/agent-farm@$AGENT_FARM_VERSION" </dev/null
    printf '%s\n' "$AGENT_FARM_VERSION" | agent tee "$AGENT_FARM_VERSION_FILE" >/dev/null
    agent_farm_cli_correct || fail "Agent Farm CLI did not verify"
    record agent-farm-cli applied
  fi
  agent_farm_resolve_plugin_source || fail "Agent Farm installed package path did not resolve"

  if (( plugin_correct )); then record agent-farm-plugin already-correct; else
    agent install -d -m 0750 "$AGENT_FARM_CONFIG_ROOT"
    agent "$AGENT_FARM_BIN" plugin install "$AGENT_FARM_PLUGIN_SOURCE" --config-root "$AGENT_FARM_CONFIG_ROOT" </dev/null
    agent_farm_plugin_correct || fail "Agent Farm plugin receipt and installed contents did not verify"
    record agent-farm-plugin applied
  fi
  # Plugin install places the shipped profiles along with their agents/skills.
  # Do not mount them globally or replace their identities with daemon copies.
  agent_farm_profiles_correct || fail "Agent Farm planner and implementer profiles did not verify"
  (( profiles_correct )) && record agent-farm-profiles already-correct || record agent-farm-profiles applied
  provision_agent_farm_workspace
}
