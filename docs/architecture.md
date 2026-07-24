# Architecture and boundaries

Status: Evolving
Scope: `@carbonenginejs/format-webgpu`
Audience: Shader-tool authors, engine integrators, and maintainers
Summary: Defines the package's compiler, container, dependency, and engine boundaries.

## Purpose

`format-webgpu` is the transformation and package layer between compiled
Carbon-style effects and WebGPU engine realization. It converts supported
shader programs into portable WGSL descriptors without creating live GPU
objects.

## Dependency direction

```text
@carbonenginejs/format-hlsl
          |
          +---- effect selection and binding metadata
          |
          v
@carbonenginejs/format-webgpu <---- @carbonenginejs/format-dxbc
          |                              decoded DXBC
          |
          +---- CEWGPU bytes, analysis, WGSL, canonical layouts
          |
          v
@carbonenginejs/engine-webgpu
```

Node build tools may call the public byte-oriented API, but the format package
does not import the toolchain. Dependency direction remains tools to formats,
then package data to the engine.

## Owned responsibilities

- Reading, inspecting, and building the CEWGPU v1 chunk container.
- Resolving one compiled-effect permutation and complete pass.
- Normalizing effect, stage, binding, and decoded DXBC analysis.
- Building validated shader intermediate representation and structured control
  flow.
- Lowering the supported vertex and fragment profiles to WGSL.
- Allocating a pass-global binding plan with explicit stage scope.
- Assembling emitted shaders and layouts into a portable WGSL set.
- Rejecting unsupported or ambiguous semantics with explicit diagnostics.

## Ownership elsewhere

- `format-hlsl` owns compiled-effect parsing, permutation resolution, and
  binding-manifest interpretation.
- `format-dxbc` owns DXBC container and instruction decoding.
- `engine-webgpu` owns `GPUDevice`, shader-module compilation, bind groups,
  pipelines, resource realization, device loss, and draw execution.
- Node tooling owns indexed input acquisition, filesystem adapters, caching,
  build reports, and optional native comparison.
- Runtime packages own scene objects, resource lifecycles, and authored effect
  references.

## Browser and Node boundary

The public class accepts `ArrayBuffer`, typed-array, and compatible byte views.
Its source does not read files, inspect processes, or invoke native programs.
This allows applications to fetch or select bytes and build CEWGPU data in a
browser.

The repository's command-line scripts are development adapters over the same
public operations. They are not a second compiler contract.

## Shader target

The current translation target is DX11 SM5.0 vertex and fragment bytecode.
DX12 SM5.1 input is useful for differential analysis where supported, but
DX12-only bindless resource ranges are not part of the current translation
target.

Compute, geometry, hull, and domain stages are not emitted by the current WGSL
compiler. The exact supported and adapted boundaries are listed in
[WGSL compatibility](reference/wgsl-compatibility.md).

## Related documentation

- [Package documentation](README.md)
- [CEWGPU package format](formats/cewgpu.md)
- [Public API reference](reference/api.md)
