#!/usr/bin/env bash
# Classify-and-recover wrapper for the emulator E2E driver.
#
# The CI fleet kills qemu at RANDOM: runs 38040231871…38054146643 lost 10 of
# 19 emulators — heartbeat shows qemu going <defunct> and vanishing with
# 10–14GB RAM free, no OOM, no app FATAL, on BOTH ubuntu-24.04.5 and
# ubuntu-22.04. A dead fleet is not a test result: retrying the journey once
# on a fresh emulator separates environment from code.
#
# Rules:
#   - Only DEVICE-DEATH signatures are recovered (CDP connect fail, device
#     not found/offline, socket closed). Journey bugs exit immediately with
#     the driver's RC — a bug must never burn the retry.
#     bounded: exactly ONE recovery cycle; second failure exits as-is.
#   - The relaunch mirrors the action's own flags (heartbeat cmdline):
#     -avd test -port 5554 keeps adb serial emulator-5554 and the action's
#     post-step `emu kill` working.
set -u

APK=android/app/build/outputs/apk/debug/app-debug.apk
SERIAL=emulator-5554
OUT="${E2E_OUT:-emulator-artifacts}"

: > e2e-stdout.log

run_driver() {
  timeout 480 env E2E_OUT="$OUT" node tools/emulator-e2e.mjs >> e2e-stdout.log 2>&1
}

fatal_of() { # report's fatal field ('' when the report is missing/invalid)
  python3 -c "import json,sys; print(json.load(open('$OUT/emulator-report.json')).get('fatal') or '')" 2>/dev/null || true
}

is_death() { # every signature the fleet produced: runs 13,15,16,17,18,19
  case "$1" in
    *"not found"*|*"device offline"*|*"socket closed"*|*"CDP connect failed"*) return 0 ;;
    *) return 1 ;;
  esac
}

run_driver; rc=$?
[ "$rc" -eq 0 ] && exit 0
fatal="$(fatal_of)"
if ! is_death "$fatal"; then
  echo "[recover] journey failure, not a fleet death: $fatal" >&2
  exit "$rc"
fi
echo "[recover] fleet death detected: $fatal" >&2

# --- restore the device exactly as the action started it --------------------
if adb devices 2>/dev/null | grep -q "^$SERIAL[[:space:]]*offline"; then
  adb emu kill >/dev/null 2>&1 || true
fi
# a zombie qemu would hold port 5554 and refuse the relaunch — clear it
pkill -f "qemu-system-x86_64-headless -port 5554" >/dev/null 2>&1 || true
sleep 3

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
nohup "$SDK/emulator/emulator" -avd test -port 5554 -no-window -no-snapshot -noaudio \
  -no-boot-anim -gpu swiftshader_indirect -camera-back none -camera-front none \
  > emulator-relaunch.log 2>&1 &
timeout 240 adb wait-for-device || { echo "[recover] device never returned" >&2; exit "$rc"; }
booted=0
for _ in $(seq 1 90); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && { booted=1; break; }
  sleep 2
done
[ "$booted" = 1 ] || { echo "[recover] boot never completed" >&2; exit "$rc"; }

adb install -r "$APK" >> e2e-stdout.log 2>&1 || echo "[recover] INSTALL_RC=$?" >&2
# the original logcat capture died with the device — follow the new one
adb logcat -v time >> logcat-stream.txt 2>&1 &
adb shell am start -n com.nemoobc.beartool/.MainActivity >> e2e-stdout.log 2>&1 || true
sleep 8

echo "[recover] emulator relaunched — rerunning the journey" >&2
run_driver; rc2=$?
exit "$rc2"
