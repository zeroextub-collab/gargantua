#!/usr/bin/env bash
# GARGANTUA P0 — environment + input facts, regenerated from scratch.
# Usage (Git Bash, from anywhere):  bash tools/p0/env_report.sh
# Writes docs/evidence/p0/*. Read-only with respect to the system: no installs,
# no driver calls beyond nvidia-smi queries; Chrome runs headless on a throwaway
# profile under work/ that is deleted afterwards.
set -u
cd "$(dirname "$0")/../.."
OUT=docs/evidence/p0
mkdir -p "$OUT" work/p0
CLIPS=(refs/reel.mp4 input/Video_Project_8.mp4 input/walk_portrait_4k.mp4)

# ---------- inputs ----------
{
  echo "# P0 input facts — generated $(date -Iseconds)"
  for f in "${CLIPS[@]}"; do
    echo
    echo "## $f  ($(stat -c %s "$f") bytes)"
    ffprobe -v error -select_streams v:0 \
      -show_entries stream=codec_name,profile,pix_fmt,width,height,sample_aspect_ratio,r_frame_rate,avg_frame_rate,nb_frames,duration,color_space,color_transfer,color_primaries,color_range,bits_per_raw_sample:stream_side_data=rotation \
      -of default=nw=1 "$f"
    echo "audio_streams=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$f" | wc -l | tr -d ' ')"
    ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of default=nw=1 "$f"
    # decoded-frame timestamp intervals: equal min/max => constant frame rate
    ffprobe -v error -select_streams v:0 -show_entries frame=best_effort_timestamp_time -of csv=p=0 "$f" | tr -d ',' |
      awk 'NR>1{d=$1-p; if(NR==2||d<mn)mn=d; if(d>mx)mx=d; s+=d; n++}{p=$1}
           END{printf "frame_interval_s min=%.5f max=%.5f mean=%.5f last_ts=%.4f\n", mn, mx, s/n, p}'
    echo "decode_error_lines=$(ffmpeg -v error -i "$f" -map 0:v:0 -f null - 2>&1 | wc -l | tr -d ' ')"
    if [ "$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$f" | wc -l)" -gt 0 ]; then
      ffmpeg -hide_banner -i "$f" -map 0:a:0 -af volumedetect -f null - 2>&1 | grep -oE '(mean|max)_volume: [-0-9.]+ dB' | tr '\n' ' '
      echo
    fi
  done
  echo
  echo "## reference stills"
  for p in refs/*.png; do echo "$p $(ffprobe -v error -show_entries stream=width,height,pix_fmt -of csv=p=0 "$p")"; done
} > "$OUT/inputs.txt"

for f in "${CLIPS[@]}"; do
  ffprobe -v error -show_format -show_streams -of json "$f" > "$OUT/$(basename "$f" .mp4).ffprobe.json"
done

# ---------- volume tier arithmetic (RGBA8 = 4 bytes/voxel, decimal MB) ----------
{
  echo "# volume tiers, RGBA8"
  for t in "960 540 422" "360 640 279" "540 960 279" "720 1280 279"; do
    set -- $t
    awk -v w="$1" -v h="$2" -v d="$3" 'BEGIN{b=w*h*d*4; printf "%dx%dx%d  %d bytes  %.1f MB  %.1f MiB\n", w, h, d, b, b/1e6, b/1048576}'
  done
} > "$OUT/volume_tiers.txt"

# ---------- toolchain ----------
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
{
  echo "# toolchain — generated $(date -Iseconds)"
  echo "node $(node --version)"
  echo "npm $(npm --version)"
  echo "python(PATH) $(python --version 2>&1) at $(python -c 'import sys;print(sys.executable)')"
  echo "py-launcher $(py -0p 2>&1 | tr -s ' ' | tr '\n' ';')"
  echo "uv $(uv --version)"
  echo "git $(git --version)"
  ffmpeg -hide_banner -version | head -1
  echo "ffmpeg_path $(command -v ffmpeg)"
  echo "chrome $(powershell -NoProfile -Command "(Get-Item '${CHROME//\/c\//C:\\}').VersionInfo.ProductVersion" | tr -d '\r')"
  echo "os $(powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).Caption + ' build ' + (Get-CimInstance Win32_OperatingSystem).BuildNumber" | tr -d '\r')"
  echo "cpu $(powershell -NoProfile -Command "(Get-CimInstance Win32_Processor | Select-Object -First 1).Name" | tr -d '\r')"
  echo "ram_gb $(powershell -NoProfile -Command "[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1)" | tr -d '\r')"
} > "$OUT/versions.txt"

# ---------- GPU + disk ----------
{
  echo "# GPU (nvidia-smi query only) — generated $(date -Iseconds)"
  nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,memory.free,compute_cap --format=csv
  echo
  echo "# all display adapters"
  powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | ForEach-Object { \$_.Name + ' | driver ' + \$_.DriverVersion }" | tr -d '\r'
  echo
  echo "# disk"
  df -h /c /d
} > "$OUT/gpu_disk.txt"

# ---------- WebGL2 in installed Chrome (headless, throwaway profile) ----------
# The profile path must be absolute: a relative --user-data-dir makes Chrome exit 21 with no output.
PROF="$PWD/work/p0/chrome-probe-profile"
URL="file:///$(cygpath -m "$PWD/tools/p0/webgl_probe.html")"
"$CHROME" --headless=new --user-data-dir="$(cygpath -w "$PROF")" --no-first-run --no-default-browser-check \
  --disable-extensions --virtual-time-budget=20000 --dump-dom "$URL" 2>/dev/null |
  grep -oE 'PROBE_RESULT \{.*\}' | sed 's/^PROBE_RESULT //' > "$OUT/webgl_probe.json"
rm -rf "$PROF"

echo "wrote:"; ls -l "$OUT"
# An empty file is a failed instrument, not a result.
fail=0
for f in inputs.txt versions.txt gpu_disk.txt volume_tiers.txt webgl_probe.json; do
  [ -s "$OUT/$f" ] || { echo "P0 PROBE FAILED: $OUT/$f is empty"; fail=1; }
done
grep -q 'nan\|0\.0 MB' "$OUT/volume_tiers.txt" && { echo "P0 PROBE FAILED: tier arithmetic"; fail=1; }
exit $fail
