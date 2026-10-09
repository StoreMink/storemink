# Theme imagery

Each bundled theme keeps its photography under `/themes/<id>/`; provenance and
the source prompts are in `docs/theme-assets.md`.

The `exemplar-*` entries are symbolic links to the bundled set each exemplar
theme (`lib/themes/exemplars/`) borrows. The package contract holds a theme's
assets to its own `/themes/<id>/` folder, so the exemplar's paths are its own
while the bytes stay the bundled theme's; nothing here is a second copy.
