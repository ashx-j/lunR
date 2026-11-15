#!/usr/bin/env bash
set -euo pipefail

# Keep every test process away from the caller's saved profiles and credentials.
test_profile=$(mktemp -d "${TMPDIR:-/tmp}/lunr-tests.XXXXXXXX")
cleanup() {
    rm -rf -- "$test_profile"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$test_profile"/{home,agent,tmp,config,cache,data,appdata,localappdata}

test_env=(
    "HOME=$test_profile/home"
    "USERPROFILE=$test_profile/home"
    "PI_CODING_AGENT_DIR=$test_profile/agent"
    "TMPDIR=$test_profile/tmp"
    "TMP=$test_profile/tmp"
    "TEMP=$test_profile/tmp"
    "XDG_CONFIG_HOME=$test_profile/config"
    "XDG_CACHE_HOME=$test_profile/cache"
    "XDG_DATA_HOME=$test_profile/data"
    "APPDATA=$test_profile/appdata"
    "LOCALAPPDATA=$test_profile/localappdata"
    "PI_NO_LOCAL_LLM=1"
    "npm_config_update_notifier=false"
)
# Only OS/tool lookup and test presentation settings may cross this boundary.
for name in PATH SystemRoot SYSTEMROOT WINDIR COMSPEC PATHEXT TERM LANG LC_ALL LC_CTYPE TZ CI GITHUB_ACTIONS NO_COLOR FORCE_COLOR; do
    if [[ ${!name+x} ]]; then
        test_env+=("$name=${!name}")
    fi
done

echo "Running tests with a disposable profile and no inherited credentials..."
env -i "${test_env[@]}" npm test "$@"
