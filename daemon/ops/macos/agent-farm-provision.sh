#!/bin/bash
# shellcheck disable=SC2015
# Sourced by provision.sh. Uses its agent(), record(), and fail() helpers.
# Agent Farm distributes a source checkout, not a published npm package.
AGENT_FARM_VERSION=0.1.1
AGENT_FARM_COMMIT=f36bdef2987aee9b01c7caebe38c6745420e134b
AGENT_FARM_REPO=https://github.com/dcouple/agent-farm.git
AGENT_FARM_CHECKOUT=$AGENT_HOME/.local/share/agent-farm/$AGENT_FARM_COMMIT
AGENT_FARM_BIN=$AGENT_HOME/.local/bin/agent-farm
AGENT_FARM_CONFIG_ROOT=$AGENT_HOME/.config/agent-farm
AGENT_FARM_PLUGIN_SOURCE=$AGENT_FARM_CHECKOUT/plugins/dcouple

agent_farm_source_correct() {
  local status
  [[ $(agent git -C "$AGENT_FARM_CHECKOUT" rev-parse HEAD 2>/dev/null) == "$AGENT_FARM_COMMIT" ]] \
    && [[ $(agent git -C "$AGENT_FARM_CHECKOUT" remote get-url origin 2>/dev/null) == "$AGENT_FARM_REPO" ]] || return 1
  status=$(agent git -C "$AGENT_FARM_CHECKOUT" status --porcelain --untracked-files=no 2>/dev/null) || return 1
  [[ -z $status ]]
}
agent_farm_cli_correct() {
  agent_farm_source_correct \
    && agent test -x "$AGENT_FARM_CHECKOUT/dist/cli.js" \
    && [[ $(agent readlink "$AGENT_FARM_BIN" 2>/dev/null) == "$AGENT_FARM_CHECKOUT/dist/cli.js" ]] \
    && [[ $(agent node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$AGENT_FARM_CHECKOUT/package.json" 2>/dev/null) == "$AGENT_FARM_VERSION" ]] \
    && agent "$AGENT_FARM_BIN" --help </dev/null >/dev/null 2>&1
}
agent_farm_plugin_correct() {
  agent node "$SCRIPT_DIR/agent-farm-state.mjs" "$AGENT_FARM_CHECKOUT" "$AGENT_FARM_CONFIG_ROOT" </dev/null >/dev/null 2>&1
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
  if (( cli_correct )); then
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
    agent install -d -m 0750 "$AGENT_HOME/.local/share" "$AGENT_HOME/.local/share/agent-farm"
    if ! agent test -e "$AGENT_FARM_CHECKOUT"; then
      agent env GIT_TERMINAL_PROMPT=0 git clone --no-checkout "$AGENT_FARM_REPO" "$AGENT_FARM_CHECKOUT" </dev/null
      agent env GIT_TERMINAL_PROMPT=0 git -C "$AGENT_FARM_CHECKOUT" checkout --detach "$AGENT_FARM_COMMIT" </dev/null
    fi
    agent_farm_source_correct || fail "Agent Farm checkout differs from the pin; preserve and reconcile: $AGENT_FARM_CHECKOUT"
    # The service-user shell expands positional parameters.
    # shellcheck disable=SC2016
    agent /bin/bash -c 'cd "$1" && CI=1 "$2" install --frozen-lockfile && CI=1 "$2" build' _ "$AGENT_FARM_CHECKOUT" /usr/local/bin/pnpm </dev/null
    if agent test -e "$AGENT_FARM_BIN" && ! agent test -L "$AGENT_FARM_BIN"; then
      fail "Agent Farm executable is not a symlink; preserve and reconcile: $AGENT_FARM_BIN"
    fi
    agent ln -sfn "$AGENT_FARM_CHECKOUT/dist/cli.js" "$AGENT_FARM_BIN"
    agent_farm_cli_correct || fail "Agent Farm CLI did not verify"
    record agent-farm-cli applied
  fi

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
