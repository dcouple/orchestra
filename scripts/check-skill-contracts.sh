#!/usr/bin/env bash
# Validate orchestra's skills-first contract, discovery layout, and safe sync.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOWS=(
  create-epic
  create-plan
  discussion
  "do"
  excalidraw-pr-diagrams
  investigate
  postmortem
  postmortem-loop
  prepare-pull-request
  sentry-loop
)
ROLES=(
  backend-verifier
  code-researcher
  code-reviewer
  frontend-verifier
  implementer
  investigator
  plan-reviewer
  socrates
  web-researcher
)
REMOVED_ROLE_SKILLS=(
  backend-verifier
  code-researcher
  code-reviewer
  implementer
  investigator
  plan-reviewer
)
LEGACY_CODEX_SKILLS=("${REMOVED_ROLE_SKILLS[@]}" investigate)

fail() {
  echo "skill-contract check failed: $*" >&2
  exit 1
}

require_file() {
  [[ -f "$1" ]] || fail "missing file: ${1#"$ROOT/"}"
}

check_static_contracts() {
  local workflow adapter count role
  for workflow in "${WORKFLOWS[@]}"; do
    require_file "$ROOT/references/workflows/$workflow.md"
    for adapter in \
      "$ROOT/claude/skills/$workflow/SKILL.md" \
      "$ROOT/codex/skills/$workflow/SKILL.md"; do
      require_file "$adapter"
      count="$(
        grep -Foc ".references/workflows/$workflow.md" "$adapter" || true
      )"
      [[ "$count" == 1 ]] \
        || fail "${adapter#"$ROOT/"} must point exactly once to .references/workflows/$workflow.md"
    done
  done

  for adapter in "do" prepare-pull-request; do
    local high_impact="$ROOT/codex/skills/$adapter/SKILL.md"
    grep -Eq \
      '^description: .*inventory visibility alone is not authorization\.$' \
      "$high_impact" \
      || fail "$adapter metadata must make inventory visibility non-authorizing"
    local high_impact_body
    high_impact_body="$(
      awk '
        /^---$/ { delimiters++; next }
        delimiters >= 2 { print }
      ' "$high_impact"
    )"
    grep -Fq 'Inventory visibility is not authorization.' \
      <<<"$high_impact_body" \
      || fail "$adapter body must guard inventory visibility from authorization"
    grep -Fq 'current user' <<<"$high_impact_body" \
      || fail "$adapter body must require direct current-user authorization"
    if [[ -e "$ROOT/codex/skills/$adapter/agents/openai.yaml" ]] \
      && grep -Fq 'allow_implicit_invocation: false' \
        "$ROOT/codex/skills/$adapter/agents/openai.yaml"; then
      fail "$adapter must remain visible in the model skill inventory"
    fi
  done

  for role in "${ROLES[@]}"; do
    require_file "$ROOT/codex/agents/$role.toml"
    require_file "$ROOT/references/agents/$role/instructions.md"
  done

  local dispatcher="$ROOT/claude/skills/codex/SKILL.md"
  require_file "$dispatcher"
  if grep -Fq '.claude/agents/' "$dispatcher"; then
    fail "Claude Codex dispatcher must use shared role contracts directly"
  fi
  local dispatch_format
  while IFS='|' read -r role dispatch_format; do
    grep -Fq ".references/agents/$role/instructions.md" "$dispatcher" \
      || fail "Claude Codex dispatcher is missing the $role instruction mapping"
    grep -Fq "$dispatch_format" "$dispatcher" \
      || fail "Claude Codex dispatcher is missing the $role format mapping"
    require_file "$ROOT/${dispatch_format#.}"
  done <<'EOF'
backend-verifier|.references/agents/frontend-verifier/verification-result.md
code-researcher|.references/agents/code-researcher/codebase-findings.md
code-reviewer|.references/agents/code-reviewer/review-report.md
implementer|.references/agents/implementer/implementation-result.md
investigator|.references/agents/investigator/root-cause-finding.md
plan-reviewer|.references/agents/plan-reviewer/review-report.md
EOF

  local toml expected pointer format_found
  for role in "${ROLES[@]}"; do
    toml="$ROOT/codex/agents/$role.toml"
    grep -Eq "^name = [\"']${role}[\"']$" "$toml" \
      || fail "${toml#"$ROOT/"} has the wrong name"
    grep -Eq '^description = ".+"$' "$toml" \
      || fail "${toml#"$ROOT/"} is missing a description"
    grep -Fq 'developer_instructions = """' "$toml" \
      || fail "${toml#"$ROOT/"} is missing developer instructions"
    expected=".references/agents/$role/instructions.md"
    grep -Fq "$expected" "$toml" \
      || fail "${toml#"$ROOT/"} is missing $expected"
    grep -Eq 'Do not (modify files, )?spawn|Do not spawn' "$toml" \
      || fail "${toml#"$ROOT/"} is missing its leaf-only spawn prohibition"
    if ! grep -Fq 'codex exec' "$toml" || ! grep -Fq 'claude' "$toml"; then
      fail "${toml#"$ROOT/"} is missing its agent-CLI prohibition"
    fi
    format_found=0
    while IFS= read -r pointer; do
      [[ "$pointer" == "$expected" ]] && continue
      if [[ -f "$ROOT/${pointer#.}" ]]; then
        format_found=1
      fi
    done < <(grep -Eo '\.references/agents/[a-z-]+/[a-z-]+\.md' "$toml" | sort -u)
    [[ "$format_found" == 1 ]] \
      || fail "${toml#"$ROOT/"} is missing an existing output-format pointer"
    if command -v yq >/dev/null 2>&1; then
      yq -p toml -o json "$toml" >/dev/null \
        || fail "${toml#"$ROOT/"} is not valid TOML"
    fi
  done

  for role in "${REMOVED_ROLE_SKILLS[@]}"; do
    [[ ! -e "$ROOT/codex/skills/$role" ]] \
      || fail "obsolete Codex role skill remains: codex/skills/$role"
  done

  [[ -L "$ROOT/.agents/skills" ]] \
    && [[ "$(readlink "$ROOT/.agents/skills")" == ../codex/skills ]] \
    || fail ".agents/skills must point to ../codex/skills"
  [[ -L "$ROOT/.codex/agents" ]] \
    && [[ "$(readlink "$ROOT/.codex/agents")" == ../codex/agents ]] \
    || fail ".codex/agents must point to ../codex/agents"
  [[ ! -e "$ROOT/.codex/skills" && ! -L "$ROOT/.codex/skills" ]] \
    || fail ".codex/skills must be removed"

  if rg -n \
    '(/Users/tbrownio|/opt/linear-agent-daemon|bloomapi/bloom-mono|veil-hurricane|ORCH-[0-9]+)' \
    "$ROOT/claude" "$ROOT/codex" "$ROOT/references"; then
    fail "synced content contains a consumer-specific name, path, or ID"
  fi
  if rg -n \
    '(Fable|Claudex|Claude Code|codex exec|spawn_agent|collaboration tool|Task tool|claude_subagents)' \
    "$ROOT/references/workflows"; then
    fail "shared workflow contract contains harness-specific dispatch language"
  fi
  if rg -n -F '$ARGUMENTS' "$ROOT/references/workflows"; then
    fail "shared workflow contract contains adapter invocation syntax"
  fi

  local do_contract="$ROOT/references/workflows/do.md"
  local semantic
  for semantic in \
    'When no work-item input is supplied' \
    'never overlap phases' \
    'durable resume|resumability' \
    'Reviewer prompts are neutral' \
    'Stop every service' \
    'publish (one|the final) pull request' \
    'wrap-up' \
    'Never expand scope'; do
    grep -Eiq "$semantic" "$do_contract" \
      || fail "shared /do contract is missing semantic marker: $semantic"
  done
}

tree_digest() {
  local root="$1"
  (
    cd "$root"
    find . -type f -print0 \
      | LC_ALL=C sort -z \
      | xargs -0 shasum -a 256
  )
}

seed_legacy_skills() {
  local root="$1" name
  for name in "${LEGACY_CODEX_SKILLS[@]}"; do
    mkdir -p "$root/.codex/skills/$name"
    printf 'stale orchestra copy\n' > "$root/.codex/skills/$name/SKILL.md"
  done
}

check_installed_home() {
  local home="$1" name
  [[ -d "$home" ]] || fail "installed home does not exist: $home"
  for name in "${LEGACY_CODEX_SKILLS[@]}"; do
    [[ ! -e "$home/.codex/skills/$name" ]] \
      || fail "legacy user skill survived: .codex/skills/$name"
  done
  for name in "${WORKFLOWS[@]}"; do
    require_file "$home/.agents/skills/$name/SKILL.md"
  done
  for name in "${ROLES[@]}"; do
    require_file "$home/.codex/agents/$name.toml"
  done
  if [[ -f "$home/.agents/skills/personal/SKILL.md" ]]; then
    grep -Fq '.references/personal.md' \
      "$home/.agents/skills/personal/SKILL.md" \
      || fail "personal user skill was rewritten"
  fi
  if [[ -f "$home/.codex/agents/personal.toml" ]]; then
    grep -Fq '.references/personal-agent.md' \
      "$home/.codex/agents/personal.toml" \
      || fail "personal user agent was rewritten"
  fi
  if [[ -f "$home/.codex/skills/personal/SKILL.md" ]]; then
    grep -Fqx 'personal legacy namespace entry' \
      "$home/.codex/skills/personal/SKILL.md" \
      || fail "personal legacy-namespace skill was changed"
  fi
}

check_disposable_syncs() {
  local scratch temp_root consumer home first second name root_link
  scratch="$(mktemp -d)"
  scratch="$(cd "$scratch" && pwd -P)"
  temp_root="${TMPDIR:-/tmp}"
  mkdir -p "$temp_root"
  temp_root="$(cd "$temp_root" && pwd -P)"
  case "$scratch" in
    "$temp_root"/*|/tmp/*|/private/tmp/*) ;;
    *) fail "mktemp returned an unexpected path: $scratch" ;;
  esac
  trap 'rm -rf "$scratch"' EXIT

  if ORCHESTRA_SYNC_HOME=/tmp/.. "$ROOT/scripts/sync-user.sh" >/dev/null 2>&1; then
    fail "sync-user accepted a path that canonicalizes to /"
  fi
  root_link="$scratch/root-link"
  ln -s / "$root_link"
  if ORCHESTRA_SYNC_HOME="$root_link" "$ROOT/scripts/sync-user.sh" >/dev/null 2>&1; then
    fail "sync-user accepted a symlink that canonicalizes to /"
  fi

  consumer="$scratch/consumer"
  mkdir -p "$consumer"
  git -C "$consumer" init -q
  mkdir -p "$consumer/.agents/skills/personal" \
    "$consumer/.codex/skills/personal"
  printf 'consumer-local\n' > "$consumer/.agents/skills/personal/SKILL.md"
  printf 'consumer legacy namespace entry\n' \
    > "$consumer/.codex/skills/personal/SKILL.md"
  seed_legacy_skills "$consumer"
  "$ROOT/scripts/sync.sh" "$consumer" >/dev/null
  first="$(tree_digest "$consumer")"
  "$ROOT/scripts/sync.sh" "$consumer" >/dev/null
  second="$(tree_digest "$consumer")"
  [[ "$first" == "$second" ]] || fail "consumer sync is not idempotent"
  grep -Fqx 'consumer-local' "$consumer/.agents/skills/personal/SKILL.md" \
    || fail "consumer-local skill was changed"
  grep -Fqx 'consumer legacy namespace entry' \
    "$consumer/.codex/skills/personal/SKILL.md" \
    || fail "unrelated consumer .codex/skills entry was changed"
  for name in "${LEGACY_CODEX_SKILLS[@]}"; do
    [[ ! -e "$consumer/.codex/skills/$name" ]] \
      || fail "legacy consumer skill survived: .codex/skills/$name"
  done

  home="$scratch/home"
  mkdir -p "$home/.agents/skills/personal" \
    "$home/.codex/agents" \
    "$home/.codex/skills/personal"
  # shellcheck disable=SC2016 # literal installed fixture; backticks must survive
  printf 'Read `.references/personal.md`.\n' \
    > "$home/.agents/skills/personal/SKILL.md"
  # shellcheck disable=SC2016 # literal installed fixture; backticks must survive
  printf 'developer_instructions = "Read `.references/personal-agent.md`."\n' \
    > "$home/.codex/agents/personal.toml"
  printf 'personal legacy namespace entry\n' \
    > "$home/.codex/skills/personal/SKILL.md"
  seed_legacy_skills "$home"
  ORCHESTRA_SYNC_HOME="$home" "$ROOT/scripts/sync-user.sh" >/dev/null
  first="$(tree_digest "$home")"
  ORCHESTRA_SYNC_HOME="$home" "$ROOT/scripts/sync-user.sh" >/dev/null
  second="$(tree_digest "$home")"
  [[ "$first" == "$second" ]] || fail "user sync is not idempotent"
  check_installed_home "$home"

  if command -v codex >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    local prompt_json prompt_text
    prompt_json="$(
      cd "$consumer" \
        && codex debug prompt-input 'List the available workflow skills.'
    )"
    prompt_text="$(
      jq -r '
        .[]
        | select(.role == "developer")
        | .content[]?
        | select(.type == "input_text")
        | .text
      ' <<<"$prompt_json"
    )"
    for name in "${WORKFLOWS[@]}"; do
      grep -Fq "$consumer/.agents/skills/$name/SKILL.md" <<<"$prompt_text" \
        || fail "workflow is missing from the Codex skill inventory: $name"
    done
  else
    fail "codex and jq are required to verify native skill discovery"
  fi

  rm -rf "$scratch"
  trap - EXIT
}

case "${1:-}" in
  "")
    check_static_contracts
    check_disposable_syncs
    ;;
  --installed-home)
    [[ $# == 2 ]] || fail "usage: check-skill-contracts.sh --installed-home PATH"
    check_installed_home "$2"
    ;;
  *)
    fail "usage: check-skill-contracts.sh [--installed-home PATH]"
    ;;
esac

echo "skill-contract check: PASS"
