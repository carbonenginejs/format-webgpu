# WGSL compatibility

Status: Evolving
Scope: `@carbonenginejs/format-webgpu` DXBC-to-WGSL lowering
Audience: Shader-tool authors, engine integrators, and maintainers
Summary: Records deliberate semantic adaptations, unsupported inputs, and bounded compiler behavior.

## Purpose

This page records every deliberate divergence between the DXBC contract and
emitted WGSL, every fail-closed boundary, and every bounded support decision.
Consult and update it whenever compiler behavior changes;
each entry says why it exists and what revisiting it would take. Categories:

- **Adapted** — accepted input whose WGSL semantics deliberately differ from
  the exact D3D contract. These are the entries to re-read first when hunting
  a rendering difference against the native client.
- **Not supported (fail closed)** — inputs the compiler rejects with an
  explicit diagnostic rather than guessing.
- **Bounded / temporary** — supported within stated limits; the limits are the
  first thing to widen when a shader trips them.

## Adapted

### `precise` floating-point operations → ordinary math + `@invariant` position

Current package policy adapts DXBC `precise`, which forbids
reassociation/fusion so multi-pass position math is bit-identical.
WGSL has no general no-contraction control, so instead of rejecting these
operations (a previous compiler boundary for higher-quality shader profiles):

- `precise`-marked operations lower as ordinary IEEE float math;
- every vertex `SV_Position` output is emitted `@invariant @builtin(position)`
  (unconditionally, all vertex shaders), which guarantees identical position
  results across pipelines built from the same emitted WGSL — the multi-pass
  crack/z-fight artifact `precise` protects against;
- precise-mask metadata is still validated structurally (well-formed mask,
  lanes covered by a destination write) in
  `src/core/wgsl/precisionControls.js`.

NOT promised: bit-exact arithmetic parity with native D3D11; differential
tests against native output may differ in final ulps. Globally-non-refactorable
shaders (missing `REFACTORING_ALLOWED`) remain rejected — that contract is
stronger and genuinely unrepresentable. Revisit: if WGSL ever gains a
no-contraction control, restore exact lowering and drop this entry.

### DXBC comparison masks → `select` masks

DXBC comparisons produce 0xFFFFFFFF/0 integer masks; WGSL comparisons produce
`bool`. All comparison opcodes (`lt/ge/eq/ne`, `ilt/ige/ieq/ine`, `ult/uge`)
lower as `select(0u, 0xffffffffu, a OP b)` so downstream mask arithmetic
(`and`/`movc` chains) stays bit-faithful.

### Typeless registers → per-lane storage types with explicit bitcasts

DXBC registers are typeless 32-bit lanes. The type-inference union assigns one
storage type per SSA lane (conflicts become `bitpattern32` = `u32`) and every
crossing emits an explicit `bitcast`. Mixed-component writes (one instruction
writing lanes of different resolved types) split into per-component `let`s
(`valueN_x`, …) for immediate movs, structured loads, packed intrinsic
projections, and per-lane `movc` selects — in BOTH stages.

### SSA-legal cross-scope reads → hoisted function-top `var`s

SSA may resolve a post-join read to one arm's definition (the other path
diverges via return/discard); structured WGSL scoping cannot express that
directly. `src/core/wgsl/hoistEscapingValues.js` hoists escaping declarations
to uninitialized function-top `var`s (WGSL zero-initializes) plus in-place
assignments. The zero is unobservable — SSA proves the value is only read on
assigning paths.

### Switch clauses without a `default` → empty WGSL `default`

WGSL requires a `default` clause; DXBC switches without one fall through to
`endswitch`. The emitter appends an empty `default: {}`. Switches carrying
live merges DO require a real DXBC default (fail closed otherwise).

### `SV_IsFrontFace` → `front_facing` mask projection

DXBC reads the front-face flag as a 0xFFFFFFFF/0 mask; WGSL's builtin is
`bool`. Consumers receive `select(0u, 0xffffffffu, front_facing)` (or the
signed variant).

### Selection arms may write outputs alongside a live merge

A vertex `if`/`else` whose arms write shader outputs (typically `SV_Position`
in a Picking/stretch pass — one arm computes the real transform, the other
writes a constant/off-screen position) AND also carry a scalar phi merge
(e.g. a `TEXCOORD` lane read after the join) used to be rejected outright.
Output writes inside a branch compose correctly with the merge machinery: the
merge `var` is pre-declared before the `if` and assigned at each arm's end,
while output completeness is enforced by the post-branch component
intersection and the reachable-`ret` coverage check. The guard is therefore
removed for selections; the genuine "terminates before merge assignments"
(return inside an arm ahead of the appended merge write) guard stays.
This shape is covered by browser validation across vertex selections and live
merges.

The fragment stage kept this guard longer than the vertex stage even though its
surrounding machinery (per-arm written-component cloning, post-branch
intersection, merge-var appends) is identical; the fragment guard is now
removed too, browser-validated across fragment selections with live merges.

### Scalar merge inputs inherited through an arm tail

A two-armed selection merge's inputs are matched to arms by
`incoming.blockId === trueBlockId/falseBlockId`; canonical IR records the CFG
predecessor there even when its value ref resolves to an upstream definition.
For accepted prebuilt IR where exactly one edge identity is unavailable, the
remaining input is assigned to the remaining arm by elimination — a two-armed
join has exactly two edges and the phi exactly two inputs. The referenced input
may still be inherited through an arm tail, which requires the scope handling
described below.

The inherited input frequently does not lexically dominate its arm-tail merge
assignment. That is safe for the two arms whose assignment is emitted *inside* a
branch body (the true arm, and the else arm of an if/else): a selection region
is acyclic, so on the path reaching the arm tail the value was already assigned
before the merge write, and `hoistEscapingValues` lifts its declaration to a
function-top `var` (the zero initializer is unobservable on paths that skip it).
The **no-else false input is excluded** from this relaxation — it pre-initializes
the merge `var` *before* the `if`, so it must genuinely dominate the header;
hoisting cannot rescue a value that may be unassigned on a path reaching the
pre-init. Inputs that neither dominate nor are hoistable (and undefined-register
inputs on the true edge) still fail closed. Browser-validated on avatar tattoo
picking selections whose merges inherit a true-arm value through an inner join.

### Source modifiers (`neg`/`abs`/`absneg`) → per-consumer-type lowering

DXBC source-modifier semantics depend on the consuming instruction's type, and
the supported cases lower according to that consumer:

- float consumers: IEEE negate/abs (`-(x)`, `abs(x)`, `-(abs(x))`);
- signed-integer consumers: `neg` is two's-complement negation (`-(x)` on
  `i32`);
- unsigned-integer consumers: `neg` is two's-complement negation, emitted as
  the wrapping `(0u - x)` (WGSL has no unary minus on `u32`);
- integer consumers: `abs`/`absneg` fail closed because the absolute modifier
  is defined only for floating-point instructions;
- bit-preserving movers (`mov`/`movc` with unknown or conflicting lane types):
  the modifier applies FLOAT semantics to the raw lane bits, and IEEE
  negate/abs/absneg are pure sign-bit operations, so they lower to
  `^ 0x80000000u` / `& 0x7fffffffu` / `| 0x80000000u` on the `u32` storage
  (with `bitcast` in/out for `i32`-stored lanes).

The ordinary WGSL float operators match finite non-zero inputs; signed-zero
and non-finite behavior inherits WGSL's floating-point latitude. The
bit-preserving mover path uses explicit sign-bit arithmetic.

Previously the modifier was applied as a type-blind `-(x)`/`abs(x)`, which was
invalid WGSL on `u32` lanes (caught by the browser gate) and a silent
miscompile on integer-stored mover lanes (two's-complement where the contract
is a sign-bit flip). The corpus-wide rebuild confirmed every previously
qualified package is byte-identical under the typed lowering: no already
qualified shader used the changed paths. Both stages; per-lane (mixed-type
`movc`) reads share the same storage-typed rules.

*Confirmed against vkd3d-shader:* `vsir_program_lower_modifiers` (ir.c) lowers
`NEG` as `data_type_is_integer(src) ? INEG : NEG` — integer vs float negate
dispatched on the operand's data type, the same per-consumer typing — with
`ABS` as float abs and `ABSNEG` as abs-then-neg. (vkd3d resolves the type before
lowering, so it has no separate bit-mover case; our sign-bit-on-raw-bits path is
the WGSL-specific equivalent for lanes whose type is still `bitpattern32`.)

When a `movc` writes lanes whose inferred storage types differ, both stages
emit one scalar `select` per lane instead of an unrepresentable mixed-type WGSL
vector. Each condition and value source is selected with that destination
lane's original swizzle, modifier, and storage reinterpretation. This path is
bounded to unsaturated temporary results and register, immediate, or constant-
buffer lane sources; other mixed mover shapes remain fail-closed. Condition
modifiers follow the `u32` consumer rules (two's-complement `neg`, with
`abs`/`absneg` rejected), while the two value operands retain the raw float-
data mover rules above.

### `continue`/`continuec` in loops → WGSL `continuing {}` latch

Loop phi-latch updates are emitted in a WGSL `continuing {}` block (which runs
on both fall-through and `continue` paths) instead of being appended to the loop
body. `continue` lowers to `continue;` and `continuec` to `if (cond) { continue;
}`. Behavior is unchanged for loops without `continue` (the continuing block
still runs the latch each iteration); it simply makes body `continue` correct
rather than skipping the latch. Both stages.

### Declared-but-unwritten location outputs → zero-filled (vertex only)

A **vertex** output signature may declare a `location` varying (COLOR/TEXCOORD)
that a given permutation never writes. D3D leaves such
lanes undefined; WGSL zero-initializes `var output`, so the unwritten lanes read
as 0 — a safe, valid choice. Completeness is still enforced for **builtin**
outputs (`SV_Position` must be fully written; zero is not a meaningful position).

The **fragment** stage does NOT relax this: an unwritten `SV_Target` lane still
fails closed (an undefined render-target lane is not a safe zero — it feeds
blending). Only the vertex `ret` completeness check was relaxed.

### Dead untyped temp writes → skipped

Compiler-emitted dead stores whose values nothing reads (and whose types are
therefore unresolvable) are dropped instead of failing the module.

### Terminal control flow → dead tail dropped

An `if`/`else` whose both arms return, or a `switch` with a default whose every
clause returns, terminates all paths; instructions after it (a trailing
unreachable `ret`, common after fully-branched Picking/depth outputs) are dead
and not lowered. Output-completeness is validated only on reachable `ret`s.

### `immediate_constant_buffer` (DXBC icb) → module `const` array

DXBC's inline constant table (`customdata`, dataClass 3) is emitted as a
module-scope `const icb = array<vec4<f32>, N>(vec4<f32>(...), ...)`. Finite
non-zero lanes use a shortest f32 decimal and non-finite lanes fall back to
`bitcast<f32>(0x..u)`; negative zero currently serializes as positive zero.
WGSL does not fix the rounding direction for an inexact decimal-to-f32
conversion, so readable decimal emission is not a normative raw-bit guarantee;
guaranteed preservation would require raw-bit literals for every lane. The same
literal emitter is used for immutable indexable-temp tables.
`immediate_constant_buffer` operands lower as
`icb[<index>].<comp>` reusing the dynamic constant-buffer index machinery
(pure-relative and base+relative indices both supported), with int/uint
consumers bitcast exactly like uniform cbuffers. Out-of-bounds dynamic indices
are an adaptation: D3D constant/ICB reads return zero, while the emitted
unchecked WGSL array access has implementation-chosen out-of-bounds behavior;
qualified corpus shaders stay in range.

### Relative indexable temps → module `const` tables (immutable shape only)

An indexable temp (`x#`) accessed with relative addressing is recognized when
it is an immutable constant table: every write is a straight-line
pre-control-flow `mov x#[slot].mask, l(...)` immediate with one shared write
mask, every declared slot is fully written, and reads select only written
lanes. Such registers lower exactly like the icb — a module-scope
`const xt# = array<vec4<f32>, N>(...)` with reads through the shared dynamic
index machinery (`xt#[base + i32(index)].comp`) — so the dynamic read needs no
mutable-register SSA and inherits index-driven uniformity. This is the
compiler-generated shape for small lookup tables (e.g. the six quad-corner
UVs in `particles/gpu/quads`). Any other relative indexable-temp use —
mutable writes, non-immediate initializers, initializers under control flow,
partial slots — fails closed with a per-reason diagnostic. Out-of-bounds
dynamic indices retain WGSL's implementation-chosen array-access behavior
rather than D3D's out-of-bounds register semantics; no qualified corpus shader
indexes out of bounds.

### Component-packed varyings → one merged interface field per register

DXBC signature tables can emit several rows for a single interpolant register
when distinct semantics occupy different lanes (e.g. three `TEXCOORD`s packed
into `x`/`y`/`z` of output register 2, as in `starsprites`). Each row carries a
non-prefix mask (`y`-only, `z`-only) that would individually be rejected as a
gap in the WGSL location layout. Both stages now group signature rows by
`registerIndex`, union their masks, and emit ONE interface field per register
(validated prefix, single component type across the group). This is a
faithfulness fix, not a divergence — the merged field reproduces the register's
true lane occupancy.

### `linear_noperspective` varyings → `@interpolate(linear)` on both stages

DXBC `linear` interpolation is perspective-correct — the WGSL default — and
needs no attribute. DXBC `linear_noperspective` maps exactly to WGSL
`@interpolate(linear)` (center sampling on both sides). Because WebGPU
requires the vertex output and fragment input attributes at one location to
MATCH at pipeline creation, and DXBC declares interpolation only on the
fragment side (`dcl_input_ps`), the pass-global binding plan records the
non-default modes (`varyingInterpolation`) and the vertex module mirrors them
onto its paired outputs. Mixed modes on one packed register, centroid and
sample variants, and `constant` fail closed.

### Non-float `saturate` on movers → float clamp on the raw bits

D3D `saturate` assumes float data (like source modifiers). When a
bit-preserving `mov`/`movc` result's lanes resolve to integer storage, the
saturate lowers as `bitcast<T>(clamp(bitcast<f32-vec>(bits), 0.0, 1.0))` —
the direct WGSL float clamp on the raw lanes, keeping the storage type. Finite
values match the D3D clamp; non-finite inputs do not have portable
D3D-equivalent results in WGSL. Saturate on
genuinely integer arithmetic results still fails closed.

*Confirmed against vkd3d-shader:* `spirv_compiler_emit_sat` (spirv.c) is
`nclamp(x, 0.0, 1.0)` with float constants for floating-point data and a
`FIXME("Unhandled data type")` for non-float — saturate is a float clamp and
integer saturate is unhandled, matching "assumes float". Our bitcast-clamp on
`bitpattern32` mover lanes is the WGSL-specific handling for the float-data-in-
integer-storage case vkd3d left as a FIXME.

### `rcp` (both stages) → ordinary f32 division

DXBC `rcp` is a reduced-precision component-wise reciprocal; its maximum
relative error is 2^-21. It lowers to `1.0 / x`. For a finite, normal,
non-zero f32 with `abs(x)` in `[2^-126, 2^126]`, WGSL gives f32 division a
maximum error of 2.5 ULP, which satisfies that DXBC accuracy allowance.

The special-value contract is adapted. D3D specifies signed infinities for
signed-zero and subnormal inputs, signed zero for infinities, and NaN for NaN.
WGSL permits zero signs to be ignored and makes a runtime result that is
infinite or NaN indeterminate under its finite-math assumption. Exact behavior
for those inputs is therefore not portable. Finite normal denominators outside
the stated magnitude range can produce a subnormal reciprocal that D3D flushes
to signed zero but WGSL may preserve, so only the stated range has the claimed
accuracy match. Immediate operands are a fail-closed portability boundary:
each consumed lane whose raw f32 exponent is zero (signed zero or subnormal) or
255 (infinity or NaN) is rejected before modifiers and result saturation.
Unused immediate lanes are ignored, one-word immediates replicate normally,
and finite normal lanes remain accepted. Dynamic operands remain supported
with the signed-zero, subnormal, and non-finite caveats above. The same
signed-zero and non-finite caveats apply to the supported `div` opcode in both
stages.

*Confirmed against vkd3d-shader:* `spirv_compiler_emit_rcp` (spirv.c) emits
`SpvOpFDiv` with a `1.0` numerator, the same ordinary floating division used
here. Its `tests/hlsl/rcp.shader_test` also records the D3D results for positive
and negative zero and infinity; those expectations identify the non-finite
WGSL limitation above rather than requiring a different finite-input lowering.

### Vertex-stage texture sampling → explicit LOD/gradient only

The vertex binding restriction now admits texture and sampler bindings, and the
vertex stage lowers `sample_l` (`textureSampleLevel`) and `sample_d`
(`textureSampleGrad`). Implicit-LOD `sample`/`sample_b` stay fragment-only —
WGSL forbids implicit derivatives in a vertex entry point.

### Typed uint buffer UAVs + `atomic_iadd` → guarded storage atomics

A `dcl_unordered_access_view_typed` buffer with a uniform uint return type
lowers to `var<storage, read_write> uN: array<atomic<u32>>` (fragment stage
only under the current compiler/engine portability contract; vertex writable
storage is not admitted), and `atomic_iadd`
becomes a bounds-guarded statement:
`if (i < arrayLength(&uN)) { atomicAdd(&uN[i], v); }`. The guard reproduces
D3D's defined behavior — out-of-bounds typed-UAV atomics are dropped — where
an unguarded WGSL access could target a live element or otherwise raise a
dynamic error. The result-returning form (`imm_atomic_iadd`), other atomic
opcodes, and non-uint or non-buffer UAV shapes fail closed. The engine must
bind it as storage containing raw 4-byte u32 words (`minBindingSize: 4`);
unlike typed SRV buffers, this is one scalar word per element. No DXGI
view-format conversion is reproduced.
*Checked against vkd3d-shader:* `spirv_compiler_emit_atomic_instruction`
(spirv.c) emits the corresponding SPIR-V atomic through a directly computed
buffer/image pointer with no explicit bounds branch. Any out-of-bounds behavior
is therefore delegated to the Vulkan robustness features available at runtime;
that path does not itself confirm D3D's exact drop result. This compiler
implements the D3D result independently with an explicit statement-level
guard.

### `float_16` minimum precision → full-precision f32

D3D minimum precision is a floor, not a format: an implementation that computes
`min16float` operands at full 32-bit precision is conforming, and the registers
are 32-bit regardless of the hint. Numeric/value operands tagged `float_16`
therefore lower as ordinary f32 lanes — the hint is dropped, which changes
nothing observable versus a conforming D3D driver running at full precision.
Resource, sampler, and UAV handles are not value lanes and require default
precision. The other operand minimum-precision kinds (`float_2_8`, `sint_16`,
`uint_16`) stay fail-closed until a shader needs them.

*Confirmed against vkd3d-shader:* its SPIR-V backend (`spirv.c`) never reads the
decoded `min_precision` field — arithmetic lowers at full 32-bit width, the same
promotion. I/O-signature precision is a separate field. This compiler ignores
it and emits the signature's base 32-bit component type, so valid 10/16-bit
float or integer minima are conformingly widened; reserved or unknown
signature-precision values are not yet rejected.

### Resource handles → fixed, unmodified identities

Every supported resource, sampler, or UAV role requires the declared handle
type, default minimum precision, no source modifier, and a fixed descriptor
identity within the admitted singleton binding range. Relative identities fail
closed before binding lookup; a present fixed absolute identity is checked
against the resolved singleton binding. Legal resource-result swizzles remain
supported. *Confirmed against vkd3d-shader:* its register and descriptor
validation likewise restricts modifier types and verifies descriptor indices
against their declared ranges. This compiler is stricter about relative member
indices because its binding layout deliberately supports singleton ranges only.

### Typed `Buffer` SRVs → read-only storage buffers

WGSL has no texel-buffer type, so a `dcl_resource` with dimension `buffer`
lowers to `var<storage, read> tN: array<vec4<f32>>` (float4 elements) or
`array<vec4<u32>>` (uint4 elements), and `ld` on it becomes a guarded element
fetch:
`select(vec4<T>(), tN[min(i, arrayLength(&tN) - 1u)], i < arrayLength(&tN))`.
The in-range clamp makes the eagerly evaluated load valid before zero is
selected, reproducing D3D's defined out-of-bounds result without triggering
WGSL's invalid-memory-reference behavior. The layout advertises
`minBindingSize: 16`, so every valid binding has at least one element and
`arrayLength(&tN) - 1u` cannot underflow. Both stages support the load (this
is also the first vertex-stage `ld`; texture `ld` remains fragment-only).

The deliberate divergence is the engine contract: D3D typed buffers convert
through the *bound view's* DXGI format in hardware (an `R8G8B8A8_UNORM` view
would yield normalized floats). That conversion is not reproduced — the engine
must bind the underlying buffer as storage containing 16-byte elements already
matching the declared component type. The element type is recorded in the
binding's WGSL `type` (a typed buffer is distinguishable from a structured one
by `structureStride: null`). Element types other than uniform float4/uint4
fail closed.

## Not supported (fail closed)

- **Globally non-refactorable shaders** (`dcl_global_flags` without
  `REFACTORING_ALLOWED`) — every operation would be precise; see the Adapted
  entry for why per-op precise is representable but this is not.
- **DX12 bindless sampled-resource ranges** (`space1` arrays/unbounded
  ranges) — comparison-only limitation under the current DX11 translation target
  (DX11 is the target; DX12 exists to confirm equal results). Needs its own
  audited design if it ever becomes target work.
- **`imul`/`umul` high-half results** — WGSL has no 32×32→64 multiply
  builtin; only the low-half destination is supported.
- **Dynamic constant-buffer register selection** (`cbX[dynamic][…]` selecting
  the *buffer*) — only the vector index may be dynamic.
- **Non-immediate mip levels in `resinfo`**; texture `ld` accepts a dynamic
  address/mip but remains bounded to the resource shapes listed below.
- **Unknown texture dimensions** (`texturecubearray`, MSAA kinds, …) in
  sampled layouts.
- **Immediate texture offsets** (`sample_controls` / `_aoffimmi`) outside the
  bounded 2D sample family below. In particular, offset texture `ld` and
  non-2D sampling fail closed.
- **Mutable relative `indexable_temp` registers** (any shape outside the
  constant-table form above), and subroutine control flow
  (`call`/`callc`/`label`/`interface_call`) — front-end rejections.
- **Compute, geometry, hull, and domain stage kinds** — structurally valid
  stages the packager cannot lower: WGSL has no geometry/hull/domain stage,
  and compute lowering plus its compute-pipeline browser gate are not built.
  These fail closed per stage kind instead of being misreported as malformed
  records.
- **Sampler modes other than `default`**, fragment input interpolation modes
  other than `linear` and `linear_noperspective`, minimum-precision operand
  kinds other than `float_16` (which promotes; see Adapted), and vertex system semantics
  outside `SV_Position`/`SV_VertexID`/`SV_InstanceID` (fragment:
  `SV_Position`/`SV_IsFrontFace`, output `SV_Target`).

## Supported mappings

### `sample_d` gradient sampling and integer/rounding opcodes

`sample_d` lowers to `textureSampleGrad(t, s, coord, ddx, ddy)` (2/3-component
spatial gradients by dimension). A 2D-array address consumes three source
lanes (xy coordinate plus array layer) but its gradients consume only xy;
3D/cube addresses and gradients consume xyz. Added `imax/imin/umax/umin` (WGSL overloaded
`max`/`min`), `ishl`/`ishr` (`<< u32(...)` / `>> u32(...)` — DXBC shift counts
cast to the WGSL-required u32), `ineg` (signed negation), `round_ne`
(`round`, ties to even), `round_pi` (`ceil`), and the previously handler-only
`ult`/`uge` to the applicable stage support sets.

### 2D-array sample layers → round-to-nearest-even

DXBC sampling rounds a floating Texture2DArray layer coordinate to the nearest
integer with ties to even, then clamps it to the available layer range. The
layer argument therefore lowers as `i32(round(layer))`; WGSL `round` has the
same tie rule and WGSL sampling clamps the resulting array index. The spatial
xy coordinate stays separate from that layer argument in every supported
sample form and in both stages.

## Bounded / temporary

- **Immediate 2D sample offsets** — `sample`, `sample_b`, `sample_d`, and
  `sample_l` lower their signed `_aoffimmi(u,v,w)` record to WGSL's final
  constant `vec2<i32>(u, v)` sampling argument. Both APIs apply that
  texel-space offset before sampler address modes, and both require components
  in `[-8, 7]`. D3D ignores `w` for a Texture2D, so only `u` and `v` are
  emitted. Fragment supports all four opcodes; vertex supports the
  explicit-gradient/LOD pair already legal there. Duplicate or malformed
  records, offsets on other opcodes, and non-2D resource shapes fail closed.
  *Confirmed against vkd3d-shader:* its IR preserves the signed immediate
  offset on sample instructions, and its SPIR-V, GLSL, and MSL backends pass
  those constants through as the target sampling operation's constant offset.
- **`resinfo` (fragment stage)** — 2D and 3D textures, scalar immediate mip, components x/y
  (dimensions), z (depth, 3D only), and w (`textureNumLevels`); z rejected
  for 2D. A non-zero mip is queried through an in-range clamped level and its
  dimensions are selected to zero when the requested level is out of range,
  reproducing D3D instead of exposing WGSL's indeterminate out-of-range
  `textureDimensions` result. `_rcpFloat` reciprocates only dimensions, never
  the mip count; its specified infinity for zero dimensions shares the
  non-finite WGSL limitation documented for `rcp` above. Unknown return-type
  encodings and the invalid saturate modifier fail closed. D3D's zero result
  for an unbound resource is outside
  this shader mapping: WebGPU requires every declared binding, and the engine
  rejects a missing caller resource. A fallback texture cannot reproduce the
  exact result because WebGPU textures cannot have zero dimensions (and
  `_rcpFloat` requires infinity for applicable zero dimensions); exact
  emulation would need explicit bound-state metadata and a selected result.
  Widen per dimension when a shader needs it.
  *Confirmed against vkd3d-shader:* `spirv_compiler_emit_resinfo` (spirv.c)
  emits image-size and mip-level-count queries, pads missing dimension
  components with zero, and converts the uint vector to float for the ordinary
  float form. It explicitly rejects `VKD3DSI_RESINFO_RCP_FLOAT`; that form here
  follows the D3D contract independently. vkd3d also issues the size query
  directly, so our explicit clamped-query/zero-select is the WGSL-specific
  guard needed to preserve D3D's defined out-of-range result.
- **`ld`** — 2D textures (fragment only; original address lanes xy=texel and
  w=mip, packed into a three-lane u32 WGSL address) and typed buffers (both
  stages; scalar u32 element index).
  Texture coordinates and mip are clamped to a valid texel for the eagerly
  evaluated `textureLoad`, then the result is selected to zero unless the
  original address was fully in range. This excludes WGSL's otherwise
  permitted live in-bounds texel result for an invalid logical texel address.
  The zero vector is exact under the current engine contract that these
  bindings use four-component views (`rgba8unorm` or `rgba8unorm-srgb` today).
  A future one- or two-component view would require view-channel metadata so
  the explicit out-of-bounds replacement can reproduce D3D's missing-component
  defaults (normally alpha one).
- **`ld_structured`** — fixed immediate DWORD byte offsets, one scalar
  address, fixed (non-relative) resource operands. Every word fetch is clamped
  to valid storage-buffer memory and selected to zero when the structure index
  is outside `arrayLength / stride`. Offset-plus-swizzle accesses beyond the
  declared stride fail closed, so D3D's undefined byte-offset-overrun case is
  never emitted.
  *Checked against vkd3d-shader:* `spirv_compiler_emit_ld` loads texture
  coordinates from the resource-dimensional coordinate mask, takes LOD
  separately from source lane w, and emits `OpImageFetch` directly, while
  raw/structured buffer loads use direct image reads or storage-buffer access
  chains. There is no compiler-inserted bounds guard; any out-of-bounds
  behavior is delegated to the Vulkan robustness features available at
  runtime, which does not itself confirm D3D's exact zero result. The explicit
  WGSL clamps and selects above implement that D3D result independently,
  without relying on an implementation-chosen invalid-access outcome.
- **`f16tof32`/`f32tof16`** — per-lane `unpack2x16float`/`pack2x16float`.
  `f16tof32` is exact for finite normal inputs, but WGSL may flush binary16
  subnormals and ignore zero sign. `f32tof16` keeps only the low 16 result bits
  and is exact for finite non-zero inputs representable as normal binary16.
  Subnormal and zero-sign behavior shares the preceding caveat. For other
  finite normal-range values D3D requires round-toward-zero while WGSL does not
  fix a rounding direction; on finite overflow D3D yields signed max-f16 while
  WGSL permits an indeterminate result. Those inputs are an adapted boundary.
- **`udiv` (both stages)** — quotient and remainder lower to WGSL `u32`
  division and remainder. Immediate divisors whose lanes are all non-zero keep
  the direct byte-stable `/` or `%` form. Dynamic or possibly-zero divisors use
  `select(0xffffffffu, a / max(b, 1u), b != 0u)` (and the corresponding `%`
  form); clamping the eagerly evaluated operation is necessary because WGSL
  evaluates both `select` alternatives. Both destinations may be written by
  one instruction when their masks match; mismatched live masks fail closed.
  A `null` destination does not contribute active source lanes. That shared
  multi-destination rule also corrects partial-mask `sincos` source lanes:
  the full-corpus rebuild intentionally changes only the affected WGSL lines
  in `beaconfx`, `raymarcher`, and `scannerbackground`; the other 494
  previously qualified packages remain byte-identical.
  *Confirmed against vkd3d-shader:* its
  `vsir_program_lower_udiv` comments that "division by zero is well-defined for
  … UDIV, and returns UINT_MAX", and it emits a `MOVC` selecting `0xffffffff`
  for both quotient and remainder when the divisor is zero — the same semantic
  reproduced by the eager-safe WGSL guard.
- **Loop merges** — scalar header phis with exactly one entry and one
  backedge incoming. The entry and backedge use their actual reaching
  references, including an inherited preheader value. Multi-exit loops resolve
  and validate one assignment for every live scalar exit phi at every reachable
  `break` edge.
- **Loop-exit (break-join) and header-backedge merges — cross-plan reaching
  values.** A loop exited only through `break` edges yields phis at the after-
  `endloop` join; a header phi likewise takes a value back along the latch edge.
  In both cases the per-edge value is resolved by `reachingRef` — a walk up the
  dominator chain from the edge's predecessor to the nearest block whose
  `outputValues` actually define the register. This is necessary because a break
  predecessor (or latch block) commonly only *inherits* the register: it has no
  matching entry in its own `outputValues`, while the canonical phi incoming
  retains the predecessor `blockId` but may reference an upstream definition.
  The resolved value is accepted when it is (a) an instruction result / program
  input that dominates the edge; (b) this loop's own header phi (a `var` before
  the loop / a no-op
  self-latch); or (c) any other **live** merge phi — an enclosing selection/
  switch/loop plan declares it as a `var` and `hoistEscapingValues` lifts that
  declaration to function scope, so the cross-plan read resolves. A non-live phi
  is never declared and fails closed.
- **Switch merges** — break-terminated clauses; at most ONE pass-through
  incoming (a clause that keeps the prior value); a shared-join planner exists
  for `if { switch } endif` joins.
- **Selection merges** — scalar phis; two-armed regions identify arm tails by
  edge kind; guaranteed-output tracking intersects arms.
- **Observable undefined merge paths** — validation follows the exact
  references emitted by ordinary selections, switch clauses, shared
  `if { switch }` joins, loop header entry/backedge assignments, and loop-exit
  break assignments. Correlation keys include both SSA value identity and
  component, so two lanes written by one vector comparison are not conflated.
  Conditions are preserved through acyclic selection paths but cleared across
  loop backedges/exits, where they may change between iterations. Switch
  selector correlations are not modeled. Direct instruction uses fail closed
  except for one lane-exact rule: an undefined carrier consumed by raw bitwise
  `and` is safe when the sibling lane is the exact SSA condition proven zero on
  that path (`0 & unknown` is deterministically zero). The proof is repeated
  independently for every use and lane, requires the canonical unmodified
  default-precision `and` shape, and is cleared across loop boundaries; other
  operations, sibling identities, components, modifiers, index reads, and
  additional uses remain unsupported.
- **`gather4`** — front-end lanes reserved, WGSL emission not yet built.

Unless a mapping states otherwise, ordinary WGSL floating-point operations
inherit WGSL's permitted rounding, denormal, and zero-sign behavior plus its
finite-math assumption. D3D's prescribed NaN/infinity tables are therefore not
portable on those edge inputs.

## Adapted — numeric conversion edges

`ftoi`/`ftou` lower to WGSL `i32(x)`/`u32(x)`. Finite inputs within the target
integer range match D3D's truncation toward zero. NaN and positive overflow do
not: D3D specifies zero for NaN and the full integer maximum for overflow,
whereas WGSL makes the NaN conversion indeterminate and clamps positive
overflow to the largest target integer exactly representable by f32
(`2147483520` for i32 and `4294967040` for u32). These inputs are an adapted
boundary.

## Adapted — uniformity

### Derivatives / implicit-LOD samples in non-uniform control flow → `diagnostic(off, derivative_uniformity)`

WGSL forbids screen-space derivatives — the `dpdx*`/`dpdy*` family and the
implicit-LOD samples that derive internally (`textureSample` /
`textureSampleBias`) — inside **non-uniform** control flow (a branch whose
condition can differ between the pixels of a 2x2 quad), because the derivative
compares neighbor pixels that may not all be present. `src/core/wgsl/
uniformity.js` tags each SSA value uniform or varying; when the fragment lowerer
finds one of these operations under a varying-conditioned branch it records
`requiresDerivativeUniformityOptOut` on the program, and `emitWgsl` prepends the
module-level filter `diagnostic(off, derivative_uniformity);` (a standard WGSL
opt-out that Dawn/Tint and Naga both honor — browser-gate confirmed) rather than
rejecting the shader.

Why the directive and not gradient hoisting: the DXBC came from HLSL that relied
on **D3D11's permissive divergent-derivative behavior** (non-participating quad
lanes yield undefined derivatives). The directive keeps the operation at its
original source-level control-flow point; both APIs leave the divergent result
nonportable or undefined, and WGSL does not guarantee a particular hardware
evaluation strategy. Converting to `textureSampleGrad` with a gradient computed in
uniform control flow (hoisting) would substitute a *different* gradient than the
one D3D11 used, i.e. be less faithful. The directive is emitted only when the
analysis actually detects a non-uniform derivative/sample, and it is visible in
the WGSL (with an explanatory comment) plus flagged on the typed program, so the
reliance on the opt-out is never silent.

Soundness of the trigger: constant-buffer and immediate operands are not SSA
values. Varying seeds are interpolated fragment inputs (`input[N]`, including
`SV_Position`) and, conservatively, all texture sampling/loading and derivative
results. This avoids known false negatives but may add the opt-out for a branch
whose producer happens to be dynamically uniform; that only broadens where the
diagnostic is disabled.

Loop-exit uniformity **is** modelled: `loopHasNonUniformExit` flags a loop whose
exit is non-uniform — a `breakc`/`continuec` with a varying condition, or an
unconditional `break`/`continue` guarded by a varying `if`/`switch` (nested loops
skipped, as their breaks belong to the inner loop). Per the WGSL uniformity rules
such a break taints both the loop body **and every statement after the loop** (the
break edges carry non-uniformity to the merge), so the lowerer folds it into a
running per-range flow flag: a requires-uniform op inside or below such a loop
picks up the opt-out directive. This is what qualifies `system/shadowdepth`,
whose top-level `textureSample` follows a loop with a varying-guarded `break` —
top-level in the emitted WGSL, but non-uniform per the spec, and rejected by Dawn
without the directive.

Representative implicit-LOD and derivative cases are browser-gated with the
directive enabled, while uniform control-flow cases verify that the directive
is not emitted unnecessarily.

## Verification contract

Every compatibility change requires the package suite and a representative
`engine-webgpu` browser gate on a real WebGPU device with zero WGSL warnings.
Format-level qualification cannot detect every WGSL scoping or validator
failure, so browser validation remains part of the compiler contract.

The browser gate proves the emitted WGSL is *valid and runs*; it does not by
itself prove the translation is *semantically equivalent to D3D*. Semantic
decisions (out-of-bounds behavior, source-modifier typing, minimum-precision,
division-by-zero, atomics) are therefore taken from the Direct3D 11 functional
specification and independently cross-referenced against
[vkd3d-shader](https://gitlab.winehq.org/wine/vkd3d), Wine's DXBC→SPIR-V/GLSL
translator, which is the closest independent implementation of the same
input. vkd3d is used strictly as a **behavioral reference for verification** —
no code is derived from it; this compiler is implemented independently from the
D3D specification. (The reference checkout is kept quarantined outside every
package, never bundled or published.)
