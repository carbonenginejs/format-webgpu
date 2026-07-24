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
| `ANLS` | JSON or text | Normalized effect, stage, binding, DXBC, and shader-IR analysis. |
| `WGSL` | WGSL text or JSON | One raw module or a structured shader set with layouts. |

Unknown four-character chunks remain readable as raw bytes. The package
builder preserves the caller's chunk order.

## Analysis document

The current analysis document records:

- selected permutation and effect body;
- techniques, passes, and stage topology;
- Carbon binding-manifest data;
- per-stage DXBC metadata and decoded instructions when requested; and
- validated shader IR for decoded stages.

Analysis is retained as provenance even when `BuildEffect` emits WGSL for only
one selected pass.

## Structured WGSL set

`CJS_WGSL_SET` version 2 records contain emitted shader descriptors and
optional pass-level `layouts`. A layout records the exact numeric bind group
and binding slots already present in the WGSL source.

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

Version 1 binding plans remain accepted as legacy input. New plans and WGSL
sets use version 2.

## Encoding values

`Build` accepts chunk payloads as strings, plain objects, typed bytes,
`ArrayBuffer`, or other array-buffer views. Plain objects are serialized as
UTF-8 JSON. Byte values are preserved without interpretation.

## Related documentation

- [Effect packaging guide](../guides/effect-packaging.md)
- [Public API reference](../reference/api.md)
- [WGSL compatibility](../reference/wgsl-compatibility.md)
