# Video fixtures

Tiny clips (2 s, 320x240, 10 fps, no audio, < 50 KB each) used by the upload and
worker tests. Generated with FFmpeg 7 (`jrottenberg/ffmpeg:7-alpine`) from the
`testsrc` pattern. Run from `nestjs-project/`:

```bash
F='-f lavfi -i testsrc=duration=2:size=320x240:rate=10 -an'

docker run --rm -v "$PWD/test/fixtures:/out" jrottenberg/ffmpeg:7-alpine -y $F \
  -c:v libx264 -pix_fmt yuv420p -crf 35 -movflags +faststart /out/sample.mp4

docker run --rm -v "$PWD/test/fixtures:/out" jrottenberg/ffmpeg:7-alpine -y $F \
  -c:v libvpx-vp9 -b:v 80k -pix_fmt yuv420p /out/sample.webm

docker run --rm -v "$PWD/test/fixtures:/out" jrottenberg/ffmpeg:7-alpine -y $F \
  -c:v libx264 -pix_fmt yuv420p -crf 35 -f mov /out/sample.mov
```

On Windows Git Bash, prefix with `MSYS_NO_PATHCONV=1` and use `$(pwd -W)` instead of `$PWD`.
