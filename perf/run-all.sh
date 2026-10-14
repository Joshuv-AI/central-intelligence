#!/bin/bash
# Lane I consolidated rehearsal runner — sequential (the CDP driver owns a
# fixed debug port, so only one Chromium at a time). Each step is timeout-
# boxed; a hung step is killed and the runner proceeds (IRON RULE).
cd ~/workspace/central-intelligence-v2
LOG=perf/results/runner.log
echo "=== runner start $(date -Is) ===" >> $LOG
step() { echo "--- STEP $1 start $(date -Is)" >> $LOG; timeout "${2:-1500}" bash -c "$1" >> $LOG 2>&1; echo "--- STEP done rc=$? $(date -Is)" >> $LOG; }
step "node perf/measure-boot.mjs" 1500
step "node perf/measure-heap-layers.mjs" 2400
step "node perf/measure-stress.mjs" 1800
step "node ~/workspace/gev-rebuild/ux/scripts/rehearsal-newcomer.mjs desktop" 1800
step "node ~/workspace/gev-rebuild/ux/scripts/rehearsal-console-sweep.mjs desktop" 2400
step "node ~/workspace/gev-rebuild/ux/scripts/rehearsal-honesty.mjs" 1500
step "node ~/workspace/gev-rebuild/ux/scripts/rehearsal-newcomer.mjs mobile" 1800
step "node ~/workspace/gev-rebuild/ux/scripts/rehearsal-console-sweep.mjs mobile" 2400
step "CI_PERF_MOBILE=1 node perf/measure-stress.mjs" 1800
echo "=== runner launching soak $(date -Is) ===" >> $LOG
setsid nohup node perf/soak.mjs >> perf/results/soak.out 2>&1 &
echo "=== runner end $(date -Is) ===" >> $LOG
