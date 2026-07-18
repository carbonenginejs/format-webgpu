import { test } from "node:test";
import assert from "node:assert/strict";

import CjsFormatWebgpu from "../src/index.js";

function emitted(stage, bindings = [])
{
    return {
        kind: "wgsl-shader",
        format: "CJS_WGSL_SHADER",
        formatVersion: 1,
        source: "synthetic",
        stage,
        entryPoint: "main",
        code: `@${stage} fn main() {}`,
        sourceMap: [ { line: 1, instructionIndex: 0, dxbcOffset: 2 } ],
        program: {
            format: "CJS_TYPED_SHADER",
            formatVersion: 1,
            bindings
        }
    };
}

function binding(resourceKind, generatedSymbol, bindingIndex, extra = {})
{
    return {
        resourceKind,
        generatedSymbol,
        registerSpace: extra.registerSpace ?? 0,
        registerIndex: extra.registerIndex ?? 0,
        group: 0,
        binding: bindingIndex,
        type: extra.type || "sampler",
        ...(Number.isInteger(extra.structureStride) ? { structureStride: extra.structureStride } : {}),
        ...(extra.buffer ? { buffer: extra.buffer } : {}),
        ...(extra.texture ? { texture: extra.texture } : {}),
        ...(extra.sampler ? { sampler: extra.sampler } : {})
    };
}

const COPYBLIT_BINDINGS = [
    binding("uniform-buffer", "cb0", 0, {
        type: "array<vec4<f32>, 3>",
        buffer: { type: "uniform", hasDynamicOffset: false, minBindingSize: 48 }
    }),
    binding("sampled-resource", "t0", 1, {
        type: "texture_2d<f32>",
        texture: { sampleType: "float", viewDimension: "2d", multisampled: false }
    }),
    binding("sampler", "s0", 2, { sampler: { type: "filtering" } })
];

test("BuildWgslSet freezes deterministic copyblit shaders and layouts", () =>
{
    const vertex = { key: "Main.pass0.vertex", shader: emitted("vertex") };
    const pixel = { key: "Main.pass0.pixel", shader: emitted("fragment", COPYBLIT_BINDINGS) };
    const set = CjsFormatWebgpu.buildWgslSet([ vertex, pixel ]);

    assert.equal(set.format, "CJS_WGSL_SET");
    assert.deepEqual(set.shaders.map((entry) => [ entry.key, entry.stage, entry.stageType ]), [
        [ "Main.pass0.vertex", "vertex", 0 ],
        [ "Main.pass0.pixel", "fragment", 1 ]
    ]);
    assert.deepEqual(set.layouts[0].bindGroups[0].bindings.map((entry) => [
        entry.generatedSymbol,
        entry.binding,
        entry.visibility
    ]), [
        [ "cb0", 0, [ "fragment" ] ],
        [ "t0", 1, [ "fragment" ] ],
        [ "s0", 2, [ "fragment" ] ]
    ]);
    assert.equal(set.layouts[0].bindGroups[0].bindings[0].buffer.minBindingSize, 48);
    assert.equal(Object.isFrozen(set.layouts[0].bindGroups[0].bindings[0].buffer), true);
    assert.deepEqual(CjsFormatWebgpu.buildWgslSet([ pixel, vertex ]), set);

    const bytes = CjsFormatWebgpu.build([ [ "WGSL", set ] ]);
    const roundTrip = CjsFormatWebgpu.read(bytes);
    assert.deepEqual(roundTrip.shaders, set.shaders);
    assert.deepEqual(roundTrip.layouts, set.layouts);
});

test("BuildWgslSet unions compatible cross-stage visibility", () =>
{
    const shared = binding("uniform-buffer", "cb0", 0, {
        type: "array<vec4<f32>, 1>",
        buffer: { type: "uniform", hasDynamicOffset: false, minBindingSize: 16 }
    });
    const set = CjsFormatWebgpu.buildWgslSet([
        { key: "Main.pass0.vertex", shader: emitted("vertex", [ shared ]) },
        { key: "Main.pass0.pixel", shader: emitted("fragment", [ shared ]) }
    ]);
    assert.deepEqual(set.layouts[0].bindGroups[0].bindings[0].visibility, [ "vertex", "fragment" ]);
});

test("BuildWgslSet accepts a structured SRV as a sampled-resource read-only buffer", () =>
{
    const structured = binding("sampled-resource", "t0", 0, {
        type: "array<u32>",
        structureStride: 48,
        buffer: { type: "read-only-storage", hasDynamicOffset: false, minBindingSize: 48 }
    });
    const set = CjsFormatWebgpu.buildWgslSet([
        { key: "Shadow.pass0.vertex", shader: emitted("vertex", [ structured ]) }
    ]);

    const result = set.layouts[0].bindGroups[0].bindings[0];
    assert.equal(result.resourceKind, "sampled-resource");
    assert.equal(result.structureStride, 48);
    assert.deepEqual(result.buffer, structured.buffer);
    assert.equal(Object.isFrozen(result.buffer), true);
});

test("BuildWgslSet rejects binding conflicts and ambiguous generated symbols", () =>
{
    const shared = binding("sampler", "s0", 0, { sampler: { type: "filtering" } });
    const moved = { ...shared, binding: 1 };
    assert.throws(() => CjsFormatWebgpu.buildWgslSet([
        { key: "Main.pass0.vertex", shader: emitted("vertex", [ shared ]) },
        { key: "Main.pass0.pixel", shader: emitted("fragment", [ moved ]) }
    ]), /conflicting layouts/i);

    const other = binding("sampled-resource", "t0", 0, {
        type: "texture_2d<f32>",
        texture: { sampleType: "float", viewDimension: "2d", multisampled: false }
    });
    assert.throws(() => CjsFormatWebgpu.buildWgslSet([
        { key: "Main.pass0.pixel", shader: emitted("fragment", [ shared, other ]) }
    ]), /assigns 0:0 to both/i);

    const secondSpace = { ...shared, registerSpace: 1 };
    assert.throws(() => CjsFormatWebgpu.buildWgslSet([
        { key: "Main.pass0.pixel", shader: emitted("fragment", [ shared, secondSpace ]) }
    ]), /uses s0 for multiple D3D identities/i);
});

test("BuildWgslSet rejects malformed, duplicate, and stage-mismatched entries", () =>
{
    const vertex = emitted("vertex");
    assert.throws(() => CjsFormatWebgpu.buildWgslSet([]), /non-empty/i);
    assert.throws(() => CjsFormatWebgpu.buildWgslSet([ { key: "bad", shader: vertex } ]), /malformed key/i);
    assert.throws(() => CjsFormatWebgpu.buildWgslSet([
        { key: "Main.pass0.pixel", shader: vertex }
    ]), /does not match shader stage/i);
    assert.throws(() => CjsFormatWebgpu.buildWgslSet([
        { key: "Main.pass0.vertex", shader: vertex },
        { key: "Main.pass0.vertex", shader: vertex }
    ]), /duplicate shader key/i);
});
