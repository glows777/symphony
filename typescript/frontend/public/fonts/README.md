# Frontend Fonts

This directory vendors the fixed typography assets used by the Symphony frontend.

- `SourceHanSerifSC-VF.ttf.woff2`: Source Han Serif SC variable font, version 2.003R, from Adobe's Source Han Serif release branch.
- `CascadiaMono.woff2`: Cascadia Mono variable WOFF2, version 2407.24, from the Microsoft Cascadia Code release archive.

Both font families are distributed under the SIL Open Font License, Version 1.1. See `SourceHanSerif-LICENSE.txt` and `CascadiaMono-LICENSE.txt`.

The Source Han Serif face is scoped to CJK Unicode ranges in the stylesheet so
ASCII-only pages do not download the 21 MB CJK resource. The stylesheet also
uses each file's short SHA-256 digest in its URL query, which keeps the
one-year static cache safe when a font asset is replaced.
