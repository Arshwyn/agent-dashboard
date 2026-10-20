#!/usr/bin/env bash
# Emit a `pipeline` event to agent-dashboard. Fail-open: always exits 0.
#
# Usage:
#   emit-pipeline-event.sh --run-id RUN [--kind KIND] [--step STEP] [--substep NAME] --state STATE [--attempt N]
#       [--target TEXT]
#       [--failed-gate GATE] [--repo R] [--branch B] [--pr-url URL] [--commit-sha SHA]
#       [--deploy-result success|failure_rolled_back|failure_rollback_failed]
#       [--summary TEXT] [--agent NAME] [--session-id ID]
#
#   KIND : feature (default) | question | server_task | single_role
#          Non-feature kinds render as one generic activity row (start, state, end), not the
#          stepper: send --state active at the start and passed|failed at the end, each with
#          --summary (max 400 chars) and --target (repo or host). --step is optional for them,
#          except single_role, where it names the role (spec code test security styling
#          code-review cleanup).
#   STEP : spec code verify review user-approval merge deploy cleanup
#          (legacy gate names test security styling code-review are still accepted; the
#          dashboard shows them as substeps of verify / review and
#          never creates a card for them)
#   SUBSTEP: test styling (under --step verify) | security code-review (under --step review).
#          Dropped by this script (not sent) for any other name or any other --step.
#   STATE: pending active passed failed   (non-feature kinds: active passed failed)
#
# Config (env or ~/.config/agent-dashboard/hook.env):
#   AGENT_DASHBOARD_URL, AGENT_DASHBOARD_INGEST_TOKEN
set +e

ENV_FILE="${AGENT_DASHBOARD_ENV_FILE:-$HOME/.config/agent-dashboard/hook.env}"
if [ -r "$ENV_FILE" ]; then
  while IFS='=' read -r k v; do
    case "$k" in
      AGENT_DASHBOARD_URL | AGENT_DASHBOARD_INGEST_TOKEN)
        v="${v%\"}"; v="${v#\"}"
        [ -z "${!k}" ] && export "$k=$v"
        ;;
    esac
  done < <(grep -E '^(AGENT_DASHBOARD_URL|AGENT_DASHBOARD_INGEST_TOKEN)=' "$ENV_FILE")
fi
[ -z "$AGENT_DASHBOARD_URL" ] || [ -z "$AGENT_DASHBOARD_INGEST_TOKEN" ] && exit 0

run_id=""; kind=""; target=""; step=""; state=""; attempt=""; failed_gate=""; substep=""; repo=""; branch=""
pr_url=""; commit_sha=""; deploy_result=""; summary=""; agent="orchestrator"; session_id="orchestrator"
while [ $# -gt 0 ]; do
  case "$1" in
    --run-id) run_id="$2"; shift 2 ;;
    --kind) kind="$2"; shift 2 ;;
    --target) target="$2"; shift 2 ;;
    --step) step="$2"; shift 2 ;;
    --substep) substep="$2"; shift 2 ;;
    --state) state="$2"; shift 2 ;;
    --attempt) attempt="$2"; shift 2 ;;
    --failed-gate) failed_gate="$2"; shift 2 ;;
    --repo) repo="$2"; shift 2 ;;
    --branch) branch="$2"; shift 2 ;;
    --pr-url) pr_url="$2"; shift 2 ;;
    --commit-sha) commit_sha="$2"; shift 2 ;;
    --deploy-result) deploy_result="$2"; shift 2 ;;
    --summary) summary="$2"; shift 2 ;;
    --agent) agent="$2"; shift 2 ;;
    --session-id) session_id="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# JSON-escape a string: backslash, quote, control chars.
esc() {
  printf '%s' "$1" | head -c 400 | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/ /g' | tr '\n\r' '  ' | tr -d '\000-\010\013\014\016-\037'
}
field() { [ -n "$2" ] && printf ',"%s":"%s"' "$1" "$(esc "$2")"; }

meta="\"run_id\":\"$(esc "$run_id")\",\"state\":\"$(esc "$state")\""
[ -n "$step" ] && meta="$meta,\"step\":\"$(esc "$step")\""
case "$step:$substep" in
  verify:test | verify:styling | review:security | review:code-review) meta="$meta,\"substep\":\"$substep\"" ;;
esac
[ -n "$attempt" ] && [ "$attempt" -eq "$attempt" ] 2>/dev/null && meta="$meta,\"attempt\":$attempt"
for kv in "kind:$kind" "target:$target" "failed_gate:$failed_gate" "repo:$repo" "branch:$branch" "pr_url:$pr_url" "commit_sha:$commit_sha" "deploy_result:$deploy_result"; do
  k="${kv%%:*}"; v="${kv#*:}"
  [ -n "$v" ] && meta="$meta,\"$k\":\"$(esc "$v")\""
done

body="{\"ts\":$(date +%s)000,\"agent\":\"$(esc "$agent")\",\"session_id\":\"$(esc "$session_id")\",\"type\":\"pipeline\""
body="$body$(field summary "$summary")$(field repo "$repo")$(field branch "$branch"),\"meta\":{$meta}}"

# Token is passed via a process-substitution header file so it never appears in argv.
curl -sS --max-time 2 --connect-timeout 1 -o /dev/null \
  -X POST "${AGENT_DASHBOARD_URL%/}/event" \
  -H 'Content-Type: application/json' \
  -H @<(printf 'Authorization: Bearer %s\n' "$AGENT_DASHBOARD_INGEST_TOKEN") \
  --data-binary "$body" >/dev/null 2>&1
exit 0
