# WebGPU format documentation

Status: Evolving
Scope: `@carbonenginejs/format-webgpu`
Audience: Shader-tool authors, engine integrators, and maintainers
Summary: Explains the CEWGPU package format, compiled-effect conversion API, and bounded DXBC-to-WGSL compiler.

## Purpose

`@carbonenginejs/format-webgpu` reads and builds CEWGPU shader packages and
converts supported compiled effect stages into portable WGSL package data. It
owns effect analysis, DXBC-to-intermediate-representation lowering, WGSL
emission, pass-global binding planning, and CEWGPU assembly.

Unsupported shader semantics fail explicitly instead of producing a partial
package that appears usable.

## Use this package when

Use `format-webgpu` when you need to:

- inspect or build a `.cewgpu` package;
- analyze caller-supplied compiled effect bytes;
- lower supported DXBC vertex and fragment programs to WGSL;
- build one collision-free WebGPU binding layout across a complete pass; or
- convert one selected compiled-effect pass into a CEWGPU package.

Use `@carbonenginejs/format-hlsl` directly for effect metadata without WGSL
conversion, and `@carbonenginejs/format-dxbc` directly for standalone DXBC
inspection. GPU device, shader-module, bind-group, and pipeline realization
belong in `@carbonenginejs/engine-webgpu`.

## Where it fits

```text
compiled effect bytes
        |
        +---- format-hlsl ---- effect and binding metadata
        |
        +---- format-dxbc ---- decoded shader programs
        |                              |
        +------------------------------+
                       |
                       v
                format-webgpu
          analysis + WGSL + CEWGPU
                       |
                       v
                 engine-webgpu
```

The package is browser-safe at its public source boundary. Repository-only
commands may adapt filesystem input for development, but the core conversion
path accepts bytes and does not depend on Node filesystem APIs or native
executables.

## Start here

```js
import { CjsFormatWebgpu } from "@carbonenginejs/format-webgpu";

const summary = CjsFormatWebgpu.inspect(packageBytes);
const packageData = CjsFormatWebgpu.read(packageBytes);
```

For compiled-effect conversion, continue with the
[effect packaging guide](guides/effect-packaging.md).

## Documentation map

- [Architecture and boundaries](architecture.md)
- [Effect packaging guide](guides/effect-packaging.md)
- [Public API reference](reference/api.md)
- [CEWGPU package format](formats/cewgpu.md)
- [WGSL compatibility](reference/wgsl-compatibility.md)
- [Class-purpose catalog](reference/classes/README.md)
