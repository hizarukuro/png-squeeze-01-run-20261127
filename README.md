# png-squeeze: squeeze screenshots into the smallest PNG

An entry for **png-squeeze-01-run-20261127** ("Squeeze screenshots into the
smallest PNG, 27 November 2026"): a dependency-free Node program (`main.ts`)
that reads each 1280×720 RGBA screenshot at `/input/<id>/image.png` and writes
the same image at `/output/<id>/image.png`, losslessly — every channel of
every pixel exact, a fully transparent pixel's colour too — in as few bytes
as it can.

## Approach

- **Colour reduction first.** An image with at most 256 colours is written as
  a palette PNG (palettes ordered by count and by luminance, transparent
  entries first so tRNS stays short); a grey image as grey or grey+alpha; an
  opaque image as RGB; an image whose only transparency is one fully
  transparent colour is keyed with tRNS instead of an alpha channel; anything
  else stays RGBA.
- **Filtering is screened, not assumed.** Each form's rows are filtered
  several ways — unfiltered, a per-row "fewest distinct byte pairs" choice,
  and a brute-force per-row choice that deflates every trial row against the
  previous 32 KiB — and every candidate stream is weighed by zlib at level 9
  (filtered streams also with zlib's filtered strategy). Flat screenshots
  favour no filtering at all, because unfiltered rows keep the long exact
  repeats a matcher feeds on; photo-like regions favour the per-row choices.
- **An optimal-parse deflater** (hash-chain match finding with match
  inheritance, shortest-path parsing under a symbol-cost model refined from
  the previous parse, package-merge length-limited Huffman codes) is spent
  where it pays: on the largest filtered winners, inside a fixed budget of
  input bytes. Its output ships only when it beats zlib's.
- **Deterministic.** Every budget is a count of bytes or candidates, never a
  clock: two runs on the same set write byte-identical files (verified).

## Practice set

Scored with the kit's own scorer on the kit's practice set:

- **This entry: 713,528** (all 8 instances answered, all exact)
- House baseline (fixed-paeth 1.0.0): 420,399

Per instance (points of 1,000): flat 718 / rich 706 / alpha 675 / grey 705 /
flat 742 / rich 746 / alpha 701 / grey 714. The full set of 8 runs in about
25 s on one core of this machine, inside the 60 s wall.

## Run it

```
MAKEFUN_INPUT_DIR=<dir of i001..i008> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

(Without the environment variables it reads `/input` and writes `/output`.)

[![make.fun bounty](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/hizarukuro/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/hizarukuro/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
Built with make.fun — referral code c23ct4sn
