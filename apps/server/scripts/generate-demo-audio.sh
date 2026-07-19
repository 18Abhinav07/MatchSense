#!/bin/sh
set -eu

output_dir="${1:-/out}"
mkdir -p "$output_dir"

common_flags="-hide_banner -loglevel error -codec:a libmp3lame -b:a 48k -ar 24000 -ac 1 -reservoir 0 -write_xing 0 -id3v2_version 0 -write_id3v1 0"

# Original Spike 0 one-second silence bed keeps mobile media sessions alive
# without creating large write bursts.
ffmpeg -y -f lavfi -i "anullsrc=r=24000:cl=mono:d=1" $common_flags "$output_dir/silence.mp3"

# Original two-tone goal cue (E5 -> A5), synthesized from lavfi only. No
# broadcast, player, federation, or third-party media is used.
ffmpeg -y \
  -f lavfi -i "sine=frequency=659.25:sample_rate=24000:duration=0.44" \
  -f lavfi -i "sine=frequency=880:sample_rate=24000:duration=0.44" \
  -filter_complex "[0:a]afade=t=in:st=0:d=0.025,afade=t=out:st=0.39:d=0.05[a0];[1:a]afade=t=in:st=0:d=0.025,afade=t=out:st=0.39:d=0.05[a1];[a0][a1]concat=n=2:v=0:a=1,apad=pad_dur=0.06[a]" \
  -map "[a]" -t 0.94 $common_flags "$output_dir/goal-cue.mp3"
