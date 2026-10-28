#!/bin/bash
# bench_params.sh — Build env_flags array for a benchmark script
# from proj.json benchmark_params overrides.
#
# Usage (after sourcing):
#   build_bench_params <bench_abs_path> <proj_json_path>
#
# Outputs (caller-visible array):
#   env_flags  — "--script-env KEY=VAL" flag pairs for rlog.sh
#
# The array is reset on each call.

build_bench_params() {
    local bench="$1"
    local proj_json="$2"

    local bench_rel
    bench_rel="benchmarks/$(basename "$(dirname "$bench")")/$(basename "$bench")"

    env_flags=()

    # Read all key/value pairs from benchmark_params[bench_rel] in proj.json
    while IFS=$'\t' read -r key val; do
        [[ -z "$key" ]] && continue
        env_flags+=(--script-env "${key}=${val}")
    done < <(jq -r --arg rel "$bench_rel" \
        '.benchmark_params[$rel] // {} | to_entries[] | [.key, .value] | @tsv' \
        "$proj_json" 2>/dev/null)
}
