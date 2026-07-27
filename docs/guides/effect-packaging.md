# Build a CEWGPU package from compiled effect bytes

Status: Evolving
Scope: `@carbonenginejs/format-webgpu`
Audience: Shader-tool authors and engine integrators
Summary: Shows how to select one complete compiled-effect pass and package its supported stages as CEWGPU data.

## Purpose

Use `buildEffect` when an application or build tool already has compiled
effect bytes and needs one structurally valid CEWGPU package for a selected
effect body. The operation performs effect analysis, exact selection,
DXBC-to-IR lowering, pass-global binding allocation, WGSL emission, package
assembly, and structural qualification.

## Prerequisites

- Caller-supplied compiled `.sm_*` effect bytes.
- An exact technique, pass index, and complete stage list when deterministic
  selection matters.
- Permutation assertions for every axis whose value must not depend on effect
  defaults.

## Build one pass

```js
import { CjsFormatWebgpu } from "@carbonenginejs/format-webgpu";

const result = CjsFormatWebgpu.buildEffect(effectBytes, {
    source: "res:/graphics/effect.dx11/example.sm_hi",
    mode: "selected",
    permutation: [
        { name: "QUALITY", value: "HIGH" }
    ],
    selection: {
        techniqueName: "Main",
        passIndex: 0,
        stageNames: [ "vertex", "pixel" ]
    }
});

const packageBytes = result.bytes;
const emittedShaders = result.wgsl;
```

The `source` value is diagnostic provenance only. The method does not open
that path. Callers may separately provide `sourceIdentity` with a canonical
`logicalPath` plus optional `game`, `client`, `build`, `md5`, and `sha256`
fields. Its logical path need not equal the diagnostic label. `BuildEffect`
always computes the lower-case SHA-256 digest over the exact input byte view;
when a caller supplies `sha256`, the build fails if it does not match.

Selected-effect packages use INFO schema version 2 while the binary CEWGPU
container remains version 1. INFO v2 identifies the `webgpu` target, the
producing `@carbonenginejs/format-webgpu` package version, and the
`dxbc-js-wgsl` translator version. The reader continues to accept legacy
selected-effect INFO v1 packages.

## Result

The returned record contains:

| Field | Purpose |
| --- | --- |
| `bytes` | Encoded CEWGPU package bytes. |
| `info` | Translator and package information. |
| `metadata` | Selection and caller provenance. |
| `analysis` | Compact selected-body diagnostic binding/stage data; not lossless effect reflection. |
| `wgsl` | Portable shader set and pass layouts. |
| `inspection` | Summary produced by reading the built package. |
| `qualification` | Structural conversion outcome. |

`mode: "selected"` is the default and currently the only supported body mode.
The package retains normalized analysis for that resolved body while emitting
WGSL for the selected complete passes. It does not retain lossless source
reflection or other permutation bodies, so it is not sufficient by itself to
hydrate a complete `Tr2EffectRes`. `mode: "all"` fails explicitly until the
`@carbonenginejs/format-hlsl` reader exposes portable complete reflection and
all-body enumeration.

Raw stage bytecode, decoded DXBC instruction trees, and compiler IR are
transient build inputs and are not embedded in `ANLS`. Use `AnalyzeEffect`
when return-only DXBC/IR diagnostics are required.

The qualification record distinguishes structural package validity from
broader completeness. `packageValid` means only that the selected CEWGPU
container passed required-chunk, schema, cross-document, key, layout, and
selection reconciliation. `sourceComplete` would require
every axis, permutation mapping, unique body, and full portable reflection.
`backendComplete` would additionally require every required translated
program, layout, and transform. `runtimeComplete` would require
complete-resource hydration and selection. None of these fields is
prepared-pipeline or rendered evidence. The same four booleans are retained
under `INFO.completeness` in the package.

When exact semantic metadata and shader use prove an allowed physical resource
coalescing, the returned WGSL document is a `CJS_WGSL_SET` version 3 record.
Its `resourceTransforms` recipes are required runtime work, not optional
diagnostics: the consumer must build the described resource and bind it through
the matching transformed layout entry. See the package-format contract before
passing version 3 output to an engine. Packages without transforms remain WGSL
set version 2.

## Binding scope

A D3D resource tuple is stage-local unless the caller has authoritative
metadata proving that the vertex and fragment declarations name one compatible
resource. Build one binding plan from the complete stage set; do not build
independent stage plans and combine them afterward.

When compatible sharing is proven, pass the base binding identity through
`sharedIdentities`:

```js
const plan = CjsFormatWebgpu.buildWgslBindingPlan(
    [ vertexIr, fragmentIr ],
    { sharedIdentities: [ "uniform-buffer:0:0" ] }
);
```

Unshared identities receive distinct `@vertex` or `@fragment` scopes and
numeric binding slots.

## Errors

Conversion fails explicitly when:

- a permutation assertion is unknown or unresolved;
- the technique, pass, or requested stage does not exist;
- the requested stage list is incomplete or duplicated;
- the selected shader uses unsupported semantics;
- resource declarations cannot form one unambiguous pass layout; or
- emitted package records fail structural validation.

An unsupported requested shader aborts selected-pass packaging; no partially
translated pass is emitted. This fail-closed behavior does not imply
whole-effect completeness.

## Related documentation

- [Public API reference](../reference/api.md)
- [CEWGPU package format](../formats/cewgpu.md)
- [WGSL compatibility](../reference/wgsl-compatibility.md)
