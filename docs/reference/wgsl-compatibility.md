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

A two-armed selection merge's inputs were matched to arms strictly by
`incoming.blockId === trueBlockId/falseBlockId`. But a phi records the block
that *defines* the value, not the CFG edge into the join: when an arm tail only
carries a register through (an intermediate `selection-merge` block, or a value
threaded down a chain) the phi's incoming names the upstream definition block,
which is not the arm-tail predecessor, so the match failed and the shape was
rejected. Now each input is matched by direct blockId first, and — because a
two-armed join has exactly two edges and the phi exactly two inputs — the
remaining input is assigned to the remaining arm by elimination when the other
arm matched directly. This is the selection analogue of the loop-exit reaching
resolution already used for break edges.

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

### Source modifiers (`neg`/`abs`/`absneg`) → exact per-consumer-type lowering

DXBC source-modifier semantics depend on the consuming instruction's type, and
each case is exactly representable in WGSL:

- float consumers: IEEE negate/abs (`-(x)`, `abs(x)`, `-(abs(x))`);
- signed-integer consumers: `neg` is two's-complement negation (`-(x)` on
  `i32`);
- unsigned-integer consumers: `neg` is two's-complement negation, emitted as
  the wrapping `(0u - x)` (WGSL has no unary minus on `u32`); `abs` fails
  closed (undefined on integer sources);
- bit-preserving movers (`mov`/`movc` with unknown or conflicting lane types):
  the modifier applies FLOAT semantics to the raw lane bits, and IEEE
  negate/abs/absneg are pure sign-bit operations, so they lower to
  `^ 0x80000000u` / `& 0x7fffffffu` / `| 0x80000000u` on the `u32` storage
  (with `bitcast` in/out for `i32`-stored lanes).

Previously the modifier was applied as a type-blind `-(x)`/`abs(x)`, which was
invalid WGSL on `u32` lanes (caught by the browser gate) and a silent
miscompile on integer-stored mover lanes (two's-complement where the contract
is a sign-bit flip). The corpus-wide rebuild confirmed every previously
qualified package is byte-identical under the typed lowering: no already
qualified shader used the changed paths. Both stages; per-lane (mixed-type
`movc`) reads share the same storage-typed rules.

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
module-scope `const icb = array<vec4<f32>, N>(vec4<f32>(...), ...)` with each
lane a round-tripping f32 decimal literal (non-finite lanes fall back to
`bitcast<f32>(0x..u)`), and `immediate_constant_buffer` operands lower as
`icb[<index>].<comp>` reusing the dynamic constant-buffer index machinery
(pure-relative and base+relative indices both supported), with int/uint
consumers bitcast exactly like uniform cbuffers.

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
dynamic indices follow WGSL's in-bounds guarantee (as with the icb) rather
than D3D's out-of-bounds register semantics; no corpus shader indexes out of
bounds.

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
the exact float clamp on the raw lanes, keeping the storage type. Saturate on
genuinely integer arithmetic results still fails closed.

### Vertex-stage texture sampling → explicit LOD/gradient only

The vertex binding restriction now admits texture and sampler bindings, and the
vertex stage lowers `sample_l` (`textureSampleLevel`) and `sample_d`
(`textureSampleGrad`). Implicit-LOD `sample`/`sample_b` stay fragment-only —
WGSL forbids implicit derivatives in a vertex entry point.

### Typed uint buffer UAVs + `atomic_iadd` → guarded storage atomics

A `dcl_unordered_access_view_typed` buffer with a uniform uint return type
lowers to `var<storage, read_write> uN: array<atomic<u32>>` (fragment stage
only — WebGPU vertex-stage storage buffers are read-only), and `atomic_iadd`
becomes a bounds-guarded statement:
`if (i < arrayLength(&uN)) { atomicAdd(&uN[i], v); }`. The guard reproduces
D3D's defined behavior — out-of-bounds typed-UAV atomics are dropped — where
an unguarded WGSL access would clamp onto a live element. The result-returning
form (`imm_atomic_iadd`), other atomic opcodes, and non-uint or non-buffer
UAV shapes fail closed. The same engine contract as typed SRV buffers applies:
the buffer binds as storage, elements are raw 4-byte u32 words, and no DXGI
view-format conversion is reproduced.

### `float_16` minimum precision → full-precision f32

D3D minimum precision is a floor, not a format: an implementation that computes
`min16float` operands at full 32-bit precision is conforming, and the registers
are 32-bit regardless of the hint. Operands tagged `float_16` therefore lower
exactly as ordinary f32 lanes — the hint is dropped, which changes nothing
observable versus a conforming D3D driver running at full precision. The other
minimum-precision kinds (`float_2_8`, `sint_16`, `uint_16`) stay fail-closed
until a shader needs them.

*Confirmed against vkd3d-shader:* its SPIR-V backend (`spirv.c`) never reads the
decoded `min_precision` field — arithmetic lowers at full 32-bit width, the same
promotion. Its GLSL backend fails closed, but only on min-precision *I/O
signature elements* (a separate axis: varying declarations, not operands), which
this compiler does not promote either.

### Typed `Buffer` SRVs → read-only storage buffers

WGSL has no texel-buffer type, so a `dcl_resource` with dimension `buffer`
lowers to `var<storage, read> tN: array<vec4<f32>>` (float4 elements) or
`array<vec4<u32>>` (uint4 elements), and `ld` on it becomes a guarded element
fetch: `select(vec4<T>(), tN[i], i < arrayLength(&tN))` — reproducing D3D's
defined out-of-bounds-returns-zero exactly instead of inheriting WGSL's
clamped-index behavior. Both stages support the load (this is also the first
vertex-stage `ld`; texture `ld` remains fragment-only).

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
- **Non-immediate mip levels in `resinfo`/`ld`**; both are bounded to the
  resource shapes listed below.
- **Unknown texture dimensions** (`texturecubearray`, MSAA kinds, …) in
  sampled layouts.
- **Mutable relative `indexable_temp` registers** (any shape outside the
  constant-table form above), and subroutine control flow
  (`call`/`callc`/`label`/`interface_call`) — front-end rejections.
- **Compute, geometry, hull, and domain stage kinds** — structurally valid
  stages the packager cannot lower: WGSL has no geometry/hull/domain stage,
  and compute lowering plus its compute-pipeline browser gate are not built.
  These fail closed per stage kind instead of being misreported as malformed
  records.
- **Sampler modes other than `default`**, non-`linear` fragment input
  interpolation, minimum-precision kinds other than `float_16` (which
  promotes; see Adapted), and vertex system semantics
  outside `SV_Position`/`SV_VertexID`/`SV_InstanceID` (fragment:
  `SV_Position`/`SV_IsFrontFace`, output `SV_Target`).

## Supported mappings

### `sample_d` gradient sampling and integer/rounding opcodes

`sample_d` lowers to `textureSampleGrad(t, s, coord, ddx, ddy)` (2/3-component
gradients by dimension). Added `imax/imin/umax/umin` (WGSL overloaded
`max`/`min`), `ishl`/`ishr` (`<< u32(...)` / `>> u32(...)` — DXBC shift counts
cast to the WGSL-required u32), `ineg` (signed negation), `round_ne`
(`round`, ties to even), `round_pi` (`ceil`), and the previously handler-only
`ult`/`uge` to the applicable stage support sets.

## Bounded / temporary

- **`resinfo`** — 2D and 3D textures, immediate mip, components x/y
  (dimensions), z (depth, 3D only), and w (`textureNumLevels`); z rejected
  for 2D. Widen per dimension when a shader needs it.
- **`ld`** — 2D textures (fragment only; address layout xy=texel/z=mip, u32
  coordinates) and typed buffers (both stages; scalar u32 element index).
- **`ld_structured`** — fixed immediate DWORD byte offsets, one scalar
  address, fixed (non-relative) resource operands.
- **`f16tof32`/`f32tof16`** — per-lane `unpack2x16float`/`pack2x16float`;
  `f32tof16` keeps only the low 16 bits (DXBC contract).
- **`udiv` (both stages)** — quotient and remainder lower to WGSL `u32`
  division and remainder only when every divisor lane is an immediate non-zero
  value; both destinations may be written by one instruction (with independent
  masks). Dynamic or zero divisors fail closed because DXBC and WGSL define
  divide-by-zero results differently. *Confirmed against vkd3d-shader:* its
  `vsir_program_lower_udiv` comments that "division by zero is well-defined for
  … UDIV, and returns UINT_MAX", and it emits a `MOVC` selecting `0xffffffff`
  for both quotient and remainder when the divisor is zero — exactly the D3D
  semantic WGSL does not provide. (A dynamic divisor could be supported later by
  emitting the same `select(0xffffffffu, a / max(b,1u), b != 0u)` guard;
  fail-closed is correct until then.)
- **Loop merges** — scalar phis with exactly one entry and one backedge
  incoming; multi-exit loops (several `break` sites feeding distinct post-loop
  merges) are not validated beyond the single-`breakc` shape.
- **Loop-exit (break-join) and header-backedge merges — cross-plan reaching
  values.** A loop exited only through `break` edges yields phis at the after-
  `endloop` join; a header phi likewise takes a value back along the latch edge.
  In both cases the per-edge value is resolved by `reachingRef` — a walk up the
  dominator chain from the edge's predecessor to the nearest block whose
  `outputValues` actually define the register. This is necessary because a break
  predecessor (or latch block) commonly only *inherits* the register: it appears
  in neither its own `outputValues` nor the phi's recorded `incoming` (which
  names the register's *definition* block, not the CFG edge). The resolved value
  is accepted when it is (a) an instruction result / program input that dominates
  the edge; (b) this loop's own header phi (a `var` before the loop / a no-op
  self-latch); or (c) any other **live** merge phi — an enclosing selection/
  switch/loop plan declares it as a `var` and `hoistEscapingValues` lifts that
  declaration to function scope, so the cross-plan read resolves. A non-live phi
  is never declared and fails closed.
- **Switch merges** — break-terminated clauses; at most ONE pass-through
  incoming (a clause that keeps the prior value); a shared-join planner exists
  for `if { switch } endif` joins (fail-closed and not exercised by current
  package tests).
- **Selection merges** — scalar phis; two-armed regions identify arm tails by
  edge kind; guaranteed-output tracking intersects arms.
- **`gather4`** — front-end lanes reserved, WGSL emission not yet built.

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
lanes yield undefined derivatives). The directive reproduces exactly that — the
hardware still computes the implicit derivative in place, so there is no gradient
recomputation. Converting to `textureSampleGrad` with a gradient computed in
uniform control flow (hoisting) would substitute a *different* gradient than the
one D3D11 used, i.e. be less faithful. The directive is emitted only when the
analysis actually detects a non-uniform derivative/sample, and it is visible in
the WGSL (with an explanatory comment) plus flagged on the typed program, so the
reliance on the opt-out is never silent.

Soundness of the trigger: constant-buffer and immediate operands are not SSA
values, so the only varying SEEDS are interpolated fragment inputs (`input[N]`,
incl. `SV_Position`) and per-pixel producers (texture sampling/loading,
derivatives). A value is varying only if it genuinely derives from one of those
— **no false positives**, so the directive is added only where truly needed.

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
