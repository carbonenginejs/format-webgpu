# Build a CEWGPU package from compiled effect bytes

Status: Evolving
Scope: `@carbonenginejs/format-webgpu`
Audience: Shader-tool authors and engine integrators
Summary: Shows how to select one complete compiled-effect pass and package its supported stages as CEWGPU data.

## Purpose

Use `buildEffect` when an application or build tool already has compiled
effect bytes and needs one self-contained CEWGPU package. The operation
performs effect analysis, exact selection, DXBC-to-IR lowering, pass-global
binding allocation, WGSL emission, package assembly, and structural
qualification.

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
that path.

## Result

The returned record contains:

| Field | Purpose |
| --- | --- |
| `bytes` | Encoded CEWGPU package bytes. |
| `info` | Translator and package information. |
| `metadata` | Selection and caller provenance. |
| `analysis` | Normalized effect, binding, stage, and DXBC analysis. |
| `wgsl` | Portable shader set and pass layouts. |
| `inspection` | Summary produced by reading the built package. |
| `qualification` | Structural conversion outcome. |

The CEWGPU package retains full effect analysis while emitting WGSL only for
the selected complete pass.

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

An unsupported shader is not packaged as a partially successful result.

## Related documentation

- [Public API reference](../reference/api.md)
- [CEWGPU package format](../formats/cewgpu.md)
- [WGSL compatibility](../reference/wgsl-compatibility.md)
