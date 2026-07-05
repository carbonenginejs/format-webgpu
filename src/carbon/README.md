# src/carbon

This folder is a temporary home for CarbonEngine/library-shaped classes that
are needed by this format or tooling package before their proper standalone
library exists.

When classes here mirror, reference, or are derived from CarbonEngine or Fenris
Creations (CCP Games) behavior, formats, source structure, tools, assets, or
shader conventions, record that provenance in the package README/NOTICE before
shipping the change. Do not imply affiliation with or endorsement by CCP Games.

Classes here are transient:

- They are not the format boundary API.
- Keep the public format class in `src/CjsFormat*.js`.
- Keep parser, codec, conversion, and validation helpers in `src/core`.
- Move these classes into the correct standalone library package when that
  package exists.
- Preserve provenance, legal notices, schema mappings, and migration notes when
  moving them.

Do not treat imports from this folder as stable public API unless the package
README explicitly says otherwise.
