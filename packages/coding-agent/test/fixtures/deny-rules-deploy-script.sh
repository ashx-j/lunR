#!/usr/bin/env bash
set -euo pipefail
export NODE_ENV=production
trap 'echo "cleanup: rm -rf /tmp/x skipped"' EXIT

# Step 0: build and check package 0. Never rm -rf the cache or git push from here.
build_pkg_0() {
  local dir="packages/pkg-0"
  if [ ! -d "$dir" ]; then
    echo "skip: $dir missing (would sudo install it otherwise)" >&2
    return 0
  fi
  case "${MODE:-ci}" in
    ci) npm --prefix "$dir" run build -- --silent ;;
    local|dev) (cd "$dir" && npm run build) ;;
    *) echo "unknown mode: ${MODE}"; return 1 ;;
  esac
  count=$(find "$dir/dist" -name '*.js' | wc -l)
  printf 'built %s files for %s\n' "$count" "$dir"
  grep -rn "npm publish" "$dir/README.md" || true
  for f in "$dir"/src/*.ts; do
    [ -f "$f" ] && wc -l "$f" | awk '{ s += $1 } END { print "lines:", s }'
  done
  cat > "$dir/BUILD_INFO" <<EOF
built-by: ${USER}
note: run git push --force only from the release job
commit: $(git rev-parse --short HEAD)
EOF
  while read -r line; do
    echo "  > $line"
  done < "$dir/BUILD_INFO"
}
build_pkg_0 || { echo "pkg 0 failed: see 'rm -rf build' note"; exit 1; }

# Step 1: build and check package 1. Never rm -rf the cache or git push from here.
build_pkg_1() {
  local dir="packages/pkg-1"
  if [ ! -d "$dir" ]; then
    echo "skip: $dir missing (would sudo install it otherwise)" >&2
    return 0
  fi
  case "${MODE:-ci}" in
    ci) npm --prefix "$dir" run build -- --silent ;;
    local|dev) (cd "$dir" && npm run build) ;;
    *) echo "unknown mode: ${MODE}"; return 1 ;;
  esac
  count=$(find "$dir/dist" -name '*.js' | wc -l)
  printf 'built %s files for %s\n' "$count" "$dir"
  grep -rn "npm publish" "$dir/README.md" || true
  for f in "$dir"/src/*.ts; do
    [ -f "$f" ] && wc -l "$f" | awk '{ s += $1 } END { print "lines:", s }'
  done
  cat > "$dir/BUILD_INFO" <<EOF
built-by: ${USER}
note: run git push --force only from the release job
commit: $(git rev-parse --short HEAD)
EOF
  while read -r line; do
    echo "  > $line"
  done < "$dir/BUILD_INFO"
}
build_pkg_1 || { echo "pkg 1 failed: see 'rm -rf build' note"; exit 1; }

# Step 2: build and check package 2. Never rm -rf the cache or git push from here.
build_pkg_2() {
  local dir="packages/pkg-2"
  if [ ! -d "$dir" ]; then
    echo "skip: $dir missing (would sudo install it otherwise)" >&2
    return 0
  fi
  case "${MODE:-ci}" in
    ci) npm --prefix "$dir" run build -- --silent ;;
    local|dev) (cd "$dir" && npm run build) ;;
    *) echo "unknown mode: ${MODE}"; return 1 ;;
  esac
  count=$(find "$dir/dist" -name '*.js' | wc -l)
  printf 'built %s files for %s\n' "$count" "$dir"
  grep -rn "npm publish" "$dir/README.md" || true
  for f in "$dir"/src/*.ts; do
    [ -f "$f" ] && wc -l "$f" | awk '{ s += $1 } END { print "lines:", s }'
  done
  cat > "$dir/BUILD_INFO" <<EOF
built-by: ${USER}
note: run git push --force only from the release job
commit: $(git rev-parse --short HEAD)
EOF
  while read -r line; do
    echo "  > $line"
  done < "$dir/BUILD_INFO"
}
build_pkg_2 || { echo "pkg 2 failed: see 'rm -rf build' note"; exit 1; }

# Step 3: build and check package 3. Never rm -rf the cache or git push from here.
build_pkg_3() {
  local dir="packages/pkg-3"
  if [ ! -d "$dir" ]; then
    echo "skip: $dir missing (would sudo install it otherwise)" >&2
    return 0
  fi
  case "${MODE:-ci}" in
    ci) npm --prefix "$dir" run build -- --silent ;;
    local|dev) (cd "$dir" && npm run build) ;;
    *) echo "unknown mode: ${MODE}"; return 1 ;;
  esac
  count=$(find "$dir/dist" -name '*.js' | wc -l)
  printf 'built %s files for %s\n' "$count" "$dir"
  grep -rn "npm publish" "$dir/README.md" || true
  for f in "$dir"/src/*.ts; do
    [ -f "$f" ] && wc -l "$f" | awk '{ s += $1 } END { print "lines:", s }'
  done
  cat > "$dir/BUILD_INFO" <<EOF
built-by: ${USER}
note: run git push --force only from the release job
commit: $(git rev-parse --short HEAD)
EOF
  while read -r line; do
    echo "  > $line"
  done < "$dir/BUILD_INFO"
}
build_pkg_3 || { echo "pkg 3 failed: see 'rm -rf build' note"; exit 1; }

# Step 4: build and check package 4. Never rm -rf the cache or git push from here.
build_pkg_4() {
  local dir="packages/pkg-4"
  if [ ! -d "$dir" ]; then
    echo "skip: $dir missing (would sudo install it otherwise)" >&2
    return 0
  fi
  case "${MODE:-ci}" in
    ci) npm --prefix "$dir" run build -- --silent ;;
    local|dev) (cd "$dir" && npm run build) ;;
    *) echo "unknown mode: ${MODE}"; return 1 ;;
  esac
  count=$(find "$dir/dist" -name '*.js' | wc -l)
  printf 'built %s files for %s\n' "$count" "$dir"
  grep -rn "npm publish" "$dir/README.md" || true
  for f in "$dir"/src/*.ts; do
    [ -f "$f" ] && wc -l "$f" | awk '{ s += $1 } END { print "lines:", s }'
  done
  cat > "$dir/BUILD_INFO" <<EOF
built-by: ${USER}
note: run git push --force only from the release job
commit: $(git rev-parse --short HEAD)
EOF
  while read -r line; do
    echo "  > $line"
  done < "$dir/BUILD_INFO"
}
build_pkg_4 || { echo "pkg 4 failed: see 'rm -rf build' note"; exit 1; }

# Step 5: build and check package 5. Never rm -rf the cache or git push from here.
build_pkg_5() {
  local dir="packages/pkg-5"
  if [ ! -d "$dir" ]; then
    echo "skip: $dir missing (would sudo install it otherwise)" >&2
    return 0
  fi
  case "${MODE:-ci}" in
    ci) npm --prefix "$dir" run build -- --silent ;;
    local|dev) (cd "$dir" && npm run build) ;;
    *) echo "unknown mode: ${MODE}"; return 1 ;;
  esac
  count=$(find "$dir/dist" -name '*.js' | wc -l)
  printf 'built %s files for %s\n' "$count" "$dir"
  grep -rn "npm publish" "$dir/README.md" || true
  for f in "$dir"/src/*.ts; do
    [ -f "$f" ] && wc -l "$f" | awk '{ s += $1 } END { print "lines:", s }'
  done
  cat > "$dir/BUILD_INFO" <<EOF
built-by: ${USER}
note: run git push --force only from the release job
commit: $(git rev-parse --short HEAD)
EOF
  while read -r line; do
    echo "  > $line"
  done < "$dir/BUILD_INFO"
}
build_pkg_5 || { echo "pkg 5 failed: see 'rm -rf build' note"; exit 1; }

# Step 6: build and check package 6. Never rm -rf the cache or git push from here.
build_pkg_6() {
  local dir="packages/pkg-6"
  if [ ! -d "$dir" ]; then
    echo "skip: $dir missing (would sudo install it otherwise)" >&2
    return 0
  fi
  case "${MODE:-ci}" in
    ci) npm --prefix "$dir" run build -- --silent ;;
    local|dev) (cd "$dir" && npm run build) ;;
    *) echo "unknown mode: ${MODE}"; return 1 ;;
  esac
  count=$(find "$dir/dist" -name '*.js' | wc -l)
  printf 'built %s files for %s\n' "$count" "$dir"
  grep -rn "npm publish" "$dir/README.md" || true
  for f in "$dir"/src/*.ts; do
    [ -f "$f" ] && wc -l "$f" | awk '{ s += $1 } END { print "lines:", s }'
  done
  cat > "$dir/BUILD_INFO" <<EOF
built-by: ${USER}
note: run git push --force only from the release job
commit: $(git rev-parse --short HEAD)
EOF
  while read -r line; do
    echo "  > $line"
  done < "$dir/BUILD_INFO"
}
build_pkg_6 || { echo "pkg 6 failed: see 'rm -rf build' note"; exit 1; }

# Step 7: build and check package 7. Never rm -rf the cache or git push from here.
build_pkg_7() {
  local dir="packages/pkg-7"
  if [ ! -d "$dir" ]; then
    echo "skip: $dir missing (would sudo install it otherwise)" >&2
    return 0
  fi
  case "${MODE:-ci}" in
    ci) npm --prefix "$dir" run build -- --silent ;;
    local|dev) (cd "$dir" && npm run build) ;;
    *) echo "unknown mode: ${MODE}"; return 1 ;;
  esac
  count=$(find "$dir/dist" -name '*.js' | wc -l)
  printf 'built %s files for %s\n' "$count" "$dir"
  grep -rn "npm publish" "$dir/README.md" || true
  for f in "$dir"/src/*.ts; do
    [ -f "$f" ] && wc -l "$f" | awk '{ s += $1 } END { print "lines:", s }'
  done
  cat > "$dir/BUILD_INFO" <<EOF
built-by: ${USER}
note: run git push --force only from the release job
commit: $(git rev-parse --short HEAD)
EOF
  while read -r line; do
    echo "  > $line"
  done < "$dir/BUILD_INFO"
}
build_pkg_7 || { echo "pkg 7 failed: see 'rm -rf build' note"; exit 1; }

# Step 8: build and check package 8. Never rm -rf the cache or git push from here.
build_pkg_8() {
  local dir="packages/pkg-8"
  if [ ! -d "$dir" ]; then
    echo "skip: $dir missing (would sudo install it otherwise)" >&2
    return 0
  fi
  case "${MODE:-ci}" in
    ci) npm --prefix "$dir" run build -- --silent ;;
    local|dev) (cd "$dir" && npm run build) ;;
    *) echo "unknown mode: ${MODE}"; return 1 ;;
  esac
  count=$(find "$dir/dist" -name '*.js' | wc -l)
  printf 'built %s files for %s\n' "$count" "$dir"
  grep -rn "npm publish" "$dir/README.md" || true
  for f in "$dir"/src/*.ts; do
    [ -f "$f" ] && wc -l "$f" | awk '{ s += $1 } END { print "lines:", s }'
  done
  cat > "$dir/BUILD_INFO" <<EOF
built-by: ${USER}
note: run git push --force only from the release job
commit: $(git rev-parse --short HEAD)
EOF
  while read -r line; do
    echo "  > $line"
  done < "$dir/BUILD_INFO"
}
build_pkg_8 || { echo "pkg 8 failed: see 'rm -rf build' note"; exit 1; }

# Step 9: build and check package 9. Never rm -rf the cache or git push from here.
build_pkg_9() {
  local dir="packages/pkg-9"
  if [ ! -d "$dir" ]; then
    echo "skip: $dir missing (would sudo install it otherwise)" >&2
    return 0
  fi
  case "${MODE:-ci}" in
    ci) npm --prefix "$dir" run build -- --silent ;;
    local|dev) (cd "$dir" && npm run build) ;;
    *) echo "unknown mode: ${MODE}"; return 1 ;;
  esac
  count=$(find "$dir/dist" -name '*.js' | wc -l)
  printf 'built %s files for %s\n' "$count" "$dir"
  grep -rn "npm publish" "$dir/README.md" || true
  for f in "$dir"/src/*.ts; do
    [ -f "$f" ] && wc -l "$f" | awk '{ s += $1 } END { print "lines:", s }'
  done
  cat > "$dir/BUILD_INFO" <<EOF
built-by: ${USER}
note: run git push --force only from the release job
commit: $(git rev-parse --short HEAD)
EOF
  while read -r line; do
    echo "  > $line"
  done < "$dir/BUILD_INFO"
}
build_pkg_9 || { echo "pkg 9 failed: see 'rm -rf build' note"; exit 1; }

# Step 10: build and check package 10. Never rm -rf the cache or git push from here.
build_pkg_10() {
  local dir="packages/pkg-10"
  if [ ! -d "$dir" ]; then
    echo "skip: $dir missing (would sudo install it otherwise)" >&2
    return 0
  fi
  case "${MODE:-ci}" in
    ci) npm --prefix "$dir" run build -- --silent ;;
    local|dev) (cd "$dir" && npm run build) ;;
    *) echo "unknown mode: ${MODE}"; return 1 ;;
  esac
  count=$(find "$dir/dist" -name '*.js' | wc -l)
  printf 'built %s files for %s\n' "$count" "$dir"
  grep -rn "npm publish" "$dir/README.md" || true
  for f in "$dir"/src/*.ts; do
    [ -f "$f" ] && wc -l "$f" | awk '{ s += $1 } END { print "lines:", s }'
  done
  cat > "$dir/BUILD_INFO" <<EOF
built-by: ${USER}
note: run git push --force only from the release job
commit: $(git rev-parse --short HEAD)
EOF
  while read -r line; do
    echo "  > $line"
  done < "$dir/BUILD_INFO"
}
build_pkg_10 || { echo "pkg 10 failed: see 'rm -rf build' note"; exit 1; }
echo "done. next: git push origin main (by hand)"
