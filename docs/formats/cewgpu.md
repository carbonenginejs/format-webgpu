# CEWGPU package format

Status: Evolving
Scope: `@carbonenginejs/format-webgpu` CEWGPU version 1
Audience: Shader-tool authors and engine integrators
Summary: Defines the flat CEWGPU v1 container, common chunks, and structured WGSL package records.

## Purpose

CEWGPU is a CarbonEngineJS-defined container for WebGPU shader analysis,
emitted WGSL, and pass layout metadata. It is designed for deterministic
offline construction and simple browser-side reading.

## Binary layout

All integers are unsigned 32-bit little-endian values.

| Field | Size | Meaning |
| --- | ---: | --- |
| Magic | 4 bytes | ASCII `CWGP`. |
| Version | 4 bytes | Container version; the current reader accepts `1`. |
| Chunk count | 4 bytes | Number of following chunks. |
| Chunk tag | 4 bytes | ASCII four-character code. |
| Chunk size | 4 bytes | Payload byte length. |
| Chunk payload | Variable | Raw bytes, UTF-8 text, or UTF-8 JSON by chunk contract. |

The tag, size, and payload fields repeat in declaration order. A reader rejects
an unsupported version, truncated chunk, invalid magic, or trailing bytes.

## Common chunks

| Tag | Payload | Purpose |
| --- | --- | --- |
| `INFO` | JSON | Format and translator information. |
| `META` | JSON | Caller provenance and effect-selection metadata. |
| `ANLS` | JSON or text | Selected-body diagnostic stage/binding data and optional DXBC/IR analysis; not lossless effect reflection. |
| `WGSL` | WGSL text or JSON | One raw module or a structured shader set with layouts. |

Unknown four-character chunks remain readable as raw bytes. The package
builder preserves the caller's chunk order.

## Analysis document

The current analysis document records normalized data for one selected effect
body:

- selected permutation and effect body;
- techniques, passes, and stage topology;
- Carbon binding-manifest data;
- per-stage DXBC metadata and decoded instructions when bytes are available and
  decoding is requested; and
- validated shader IR for successfully decoded stages.

Analysis is retained as provenance even when `BuildEffect` emits WGSL for only
some complete selected passes. `ANLS` is not lossless source reflection. It
omits the ordered axes/options and total permutation-index-to-body mapping,
unselected bodies, exact constant-default bytes, complete nested
reflection/libraries, and some typed annotations needed to hydrate a complete
source effect resource.

`BuildEffect` records `bodyMode: "selected"` in `INFO` and `META`. Its returned
qualification record uses `validator: "cewgpu-structural"` and reports
`packageValid: true`, while `sourceComplete`, `backendComplete`, and
`runtimeComplete` are false. These flags prevent container validity from being
mistaken for complete source reflection, all-body translation, or runtime
validation. The same booleans are embedded under `INFO.completeness`.
All-body packaging is not yet supported.

## Structured WGSL set

`CJS_WGSL_SET` version 2 records contain emitted shader descriptors and
optional pass-level `layouts`. A layout records the exact numeric bind group
and binding slots already present in the WGSL source. A set remains version 2
when its source resources map one-to-one to physical WebGPU bindings.

Each binding keeps:

- a D3D-derived base `identity`;
- a resource-resolution `scopeIdentity`;
- stage visibility;
- the buffer, texture, or sampler layout; and
- its numeric group and binding.

Version 2 treats resource tuples as stage-scoped unless the caller explicitly
confirms one compatible shared identity. The builder rejects duplicate scopes,
duplicate numeric slots, mixed shared and stage-scoped forms, incomplete
visibility, and stage/layout conflicts. It never renumbers slots during WGSL
set assembly.

Version 1 binding plans remain accepted as legacy input. Ordinary new plans
and WGSL sets use version 2.

### Version 3 resource transforms

A set becomes version 3 when the compiler proves that several logical source
resources can be represented by one physical WebGPU resource. The top-level
`resourceTransforms` array records the realization recipe; the matching
physical layout binding carries its `transformId` and `arrayLayerCount`.

The currently defined version-1 recipe has this shape:

```json
{
  "id": "Main.pass0:detail-map-array:sampled-resource:0:16",
  "version": 1,
  "kind": "texture-2d-array",
  "layoutKey": "Main.pass0",
  "stage": "fragment",
  "inputs": [
    {
      "parameter": "Detail1Map",
      "layer": 0,
      "identity": "sampled-resource:0:16",
      "scopeIdentity": "sampled-resource:0:16@fragment"
    },
    {
      "parameter": "Detail2Map",
      "layer": 1,
      "identity": "sampled-resource:0:17",
      "scopeIdentity": "sampled-resource:0:17@fragment"
    }
  ],
  "output": {
    "name": "DetailMapArray",
    "identity": "sampled-resource:0:16",
    "scopeIdentity": "sampled-resource:0:16@fragment",
    "viewDimension": "2d-array",
    "layerCount": 2
  },
  "representation": "native-or-rgba8",
  "missingLayer": "reject"
}
```

Inputs are ordered by their exact fixed array layer. The output reuses layer
zero's D3D identity; later logical inputs do not remain as physical bindings.
The compiler emits every affected sample with that fixed integer layer.

`native-or-rgba8` requires the consumer to realize one compatible
`texture_2d_array` from the named source textures, either in a shared native
representation or after decoding every layer to RGBA8. Dimensions, mip
coverage, sample type, and texture format must be compatible with one WebGPU
array view. `missingLayer: "reject"` forbids substituting a fallback layer.

The set builder fails closed unless every recipe:

- targets an emitted fragment stage in its own pass;
- links exactly one `texture_2d_array<f32>` physical binding;
- numbers distinct inputs contiguously from layer zero;
- matches the binding's identity, view dimension, and layer count; and
- removes only the later input scopes from that recipe's owning pass.

WGSL-set version 3 is currently a compiler/module contract. The committed
`engine-webgpu` package reader accepts versions 1 and 2 and rejects version 3,
so a runtime must add explicit recipe realization before it can consume these
packages. Raw emitted modules may still be validated independently.

## Encoding values

`Build` accepts chunk payloads as strings, plain objects, typed bytes,
`ArrayBuffer`, or other array-buffer views. Plain objects are serialized as
UTF-8 JSON. Byte values are preserved without interpretation.

## Related documentation

- [Effect packaging guide](../guides/effect-packaging.md)
- [Public API reference](../reference/api.md)
- [WGSL compatibility](../reference/wgsl-compatibility.md)
