import { test } from "node:test";
import assert from "node:assert/strict";

import CjsFormatWebgpu from "../src/index.js";
import { lowerBindingLayout } from "../src/core/wgsl/lowerBindingLayout.js";

function range(minor, registerSpace = 0)
{
    return minor === 1 ? {
        bindingModel: "sm5.1-range",
        rangeId: 0,
        lowerBound: 0,
        upperBound: 0,
        unbounded: false,
        registerCount: 1,
        registerSpace
    } : null;
}

function declaration(offset, opcodeName, operandType, data, minor)
{
    const bindingRange = range(minor);
    return {
        offset,
        opcode: 0,
        opcodeName,
        isDeclaration: true,
        declaration: {
            ...data,
            registerIndex: 0,
            ...(bindingRange ? { bindingRange } : {})
        },
        operands: [ { typeName: operandType } ]
    };
}

function copyblitPixelBindings(minor)
{
    return {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: minor },
        instructions: [
            declaration(3, "dcl_sampler", "sampler", { samplerModeName: "default" }, minor),
            declaration(7, "dcl_resource", "resource", {
                resourceDimensionName: "texture2d",
                returnType: { returnTypeNames: [ "float", "float", "float", "float" ] }
            }, minor),
            declaration(12, "dcl_constant_buffer", "constant_buffer", {
                accessPattern: "immediate_indexed",
                sizeInVec4: 3
            }, minor),
            { offset: 20, opcode: 62, opcodeName: "ret", isDeclaration: false, operands: [] }
        ]
    };
}

function portableLayout(layout)
{
    return layout.map(({ rangeId, ...entry }) => entry);
}

function constantBuffers(stageName, entries)
{
    const vertex = stageName === "vertex";
    return {
        program: {
            programType: vertex ? 1 : 0,
            programTypeName: vertex ? "vertex" : "pixel",
            majorVersion: 5,
            minorVersion: 0
        },
        instructions: [
            ...entries.map(([ registerIndex, sizeInVec4 ], index) => ({
                offset: 2 + index * 3,
                opcode: 0,
                opcodeName: "dcl_constant_buffer",
                isDeclaration: true,
                declaration: { registerIndex, accessPattern: "immediate_indexed", sizeInVec4 },
                operands: [ { typeName: "constant_buffer", registerIndex } ]
            })),
            { offset: 20, opcode: 62, opcodeName: "ret", isDeclaration: false, operands: [] }
        ]
    };
}

function vertexConstantBuffers(entries)
{
    return constantBuffers("vertex", entries);
}

function pixelConstantBuffers(entries)
{
    return constantBuffers("pixel", entries);
}

function structuredVertexBinding(minor, stride = 48)
{
    return {
        program: { programType: 1, programTypeName: "vertex", majorVersion: 5, minorVersion: minor },
        instructions: [
            declaration(3, "dcl_resource_structured", "resource", { structureStride: stride }, minor),
            { offset: 20, opcode: 62, opcodeName: "ret", isDeclaration: false, operands: [] }
        ]
    };
}

function emitted(stage, bindings)
{
    return {
        format: "CJS_WGSL_SHADER",
        formatVersion: 1,
        stage,
        code: `@${stage} fn main() {}`,
        entryPoint: "main",
        sourceMap: [],
        program: {
            format: "CJS_TYPED_SHADER",
            formatVersion: 1,
            bindings
        }
    };
}

test("binding lowering freezes the copyblit cb0/t0/s0 WebGPU layout", () =>
{
    const ir = CjsFormatWebgpu.buildShaderIr(copyblitPixelBindings(0));
    const layout = lowerBindingLayout(ir);

    assert.deepEqual(layout.map((entry) => [
        entry.generatedSymbol,
        entry.group,
        entry.binding,
        entry.registerSpace,
        entry.registerIndex
    ]), [
        [ "cb0", 0, 0, 0, 0 ],
        [ "t0", 0, 1, 0, 0 ],
        [ "s0", 0, 2, 0, 0 ]
    ]);
    assert.deepEqual(layout[0].buffer, {
        type: "uniform",
        hasDynamicOffset: false,
        minBindingSize: 48
    });
    assert.equal(layout[0].type, "array<vec4<f32>, 3>");
    assert.deepEqual(layout[1].texture, {
        sampleType: "float",
        viewDimension: "2d",
        multisampled: false
    });
    assert.deepEqual(layout[2].sampler, { type: "filtering" });
    assert.equal(Object.isFrozen(layout[0].buffer), true);
});

test("DX11 registers and DX12 class-local ranges produce the same portable layout", () =>
{
    const dx11 = lowerBindingLayout(CjsFormatWebgpu.buildShaderIr(copyblitPixelBindings(0)));
    const dx12 = lowerBindingLayout(CjsFormatWebgpu.buildShaderIr(copyblitPixelBindings(1)));

    assert.deepEqual(portableLayout(dx12), portableLayout(dx11));
    assert.deepEqual(dx12.map((entry) => entry.rangeId), [ 0, 0, 0 ]);
});

test("binding symbols preserve register-space identity without changing space-zero names", () =>
{
    const decoded = copyblitPixelBindings(1);
    for (const instruction of decoded.instructions.filter((entry) => entry.isDeclaration))
    {
        instruction.declaration.bindingRange.registerSpace = 1;
    }
    const layout = lowerBindingLayout(CjsFormatWebgpu.buildShaderIr(decoded));

    assert.deepEqual(layout.map((entry) => entry.generatedSymbol), [ "cb0_space1", "t0_space1", "s0_space1" ]);
    assert.deepEqual(layout.map((entry) => entry.registerSpace), [ 1, 1, 1 ]);
});

test("binding lowering supports cube and 3d sampled dimensions and rejects unknown ones", () =>
{
    const cube = copyblitPixelBindings(0);
    cube.instructions[1].declaration.resourceDimensionName = "texturecube";
    const cubeBinding = lowerBindingLayout(CjsFormatWebgpu.buildShaderIr(cube))
        .find((entry) => entry.resourceKind === "sampled-resource");
    assert.equal(cubeBinding.type, "texture_cube<f32>");
    assert.equal(cubeBinding.texture.viewDimension, "cube");

    const tex3d = copyblitPixelBindings(0);
    tex3d.instructions[1].declaration.resourceDimensionName = "texture3d";
    const tex3dBinding = lowerBindingLayout(CjsFormatWebgpu.buildShaderIr(tex3d))
        .find((entry) => entry.resourceKind === "sampled-resource");
    assert.equal(tex3dBinding.type, "texture_3d<f32>");
    assert.equal(tex3dBinding.texture.viewDimension, "3d");

    const unknown = copyblitPixelBindings(0);
    unknown.instructions[1].declaration.resourceDimensionName = "texturecubearray";
    assert.throws(() => lowerBindingLayout(CjsFormatWebgpu.buildShaderIr(unknown)),
        /unsupported dimension texturecubearray/i);
});

test("structured SRV lowering preserves the t-register identity as a read-only storage buffer", () =>
{
    const dx11Ir = CjsFormatWebgpu.buildShaderIr(structuredVertexBinding(0));
    const dx12Ir = CjsFormatWebgpu.buildShaderIr(structuredVertexBinding(1));
    const dx11 = lowerBindingLayout(dx11Ir);
    const dx12 = lowerBindingLayout(dx12Ir);

    assert.deepEqual(portableLayout(dx12), portableLayout(dx11));
    assert.deepEqual(dx11[0], {
        kind: "wgsl-binding",
        id: "sampled-resource:space0:range0",
        identity: "sampled-resource:0:0",
        scopeIdentity: "sampled-resource:0:0@vertex",
        resourceKind: "sampled-resource",
        generatedSymbol: "t0",
        registerSpace: 0,
        registerIndex: 0,
        rangeId: null,
        group: 0,
        binding: 0,
        visibility: "vertex",
        declarationOffset: 3,
        declaration: "var<storage, read>",
        type: "array<u32>",
        structureStride: 48,
        buffer: { type: "read-only-storage", hasDynamicOffset: false, minBindingSize: 48 }
    });

    const plan = CjsFormatWebgpu.buildWgslBindingPlan([ dx11Ir ]);
    assert.equal(plan.bindings[0].structureStride, 48);
    assert.deepEqual(lowerBindingLayout(dx11Ir, plan), [ {
        ...dx11[0],
        scopeIdentity: "sampled-resource:0:0@vertex"
    } ]);
});

test("structured SRV lowering rejects non-DWORD strides", () =>
{
    const ir = CjsFormatWebgpu.buildShaderIr(structuredVertexBinding(0, 6));
    assert.throws(() => lowerBindingLayout(ir), /positive DWORD-aligned stride/u);
});

test("pass-global binding planning assigns one dense union across vertex and pixel stages", () =>
{
    const vertex = CjsFormatWebgpu.buildShaderIr(vertexConstantBuffers([ [ 1, 4 ], [ 3, 2 ] ]));
    const pixel = CjsFormatWebgpu.buildShaderIr(copyblitPixelBindings(0));
    const plan = CjsFormatWebgpu.buildWgslBindingPlan([ vertex, pixel ]);

    assert.equal(plan.formatVersion, 2);
    assert.deepEqual(plan.bindings.map((entry) => [
        entry.identity, entry.scopeIdentity, entry.stages, entry.group, entry.binding
    ]), [
        [ "uniform-buffer:0:0", "uniform-buffer:0:0@fragment", [ "fragment" ], 0, 0 ],
        [ "uniform-buffer:0:1", "uniform-buffer:0:1@vertex", [ "vertex" ], 0, 1 ],
        [ "uniform-buffer:0:3", "uniform-buffer:0:3@vertex", [ "vertex" ], 0, 2 ],
        [ "sampled-resource:0:0", "sampled-resource:0:0@fragment", [ "fragment" ], 0, 3 ],
        [ "sampler:0:0", "sampler:0:0@fragment", [ "fragment" ], 0, 4 ]
    ]);
    assert.deepEqual(
        lowerBindingLayout(vertex, plan).map((entry) => [ entry.generatedSymbol, entry.binding ]),
        [ [ "cb1", 1 ], [ "cb3", 2 ] ]
    );
    assert.deepEqual(
        lowerBindingLayout(pixel, plan).map((entry) => [ entry.generatedSymbol, entry.binding ]),
        [ [ "cb0", 0 ], [ "t0", 3 ], [ "s0", 4 ] ]
    );
    assert.equal(Object.isFrozen(plan.bindings), true);
    assert.deepEqual(new CjsFormatWebgpu().BuildWgslBindingPlan([ vertex, pixel ]), plan);
    assert.deepEqual(CjsFormatWebgpu.buildWgslBindingPlan([ pixel, vertex ]), plan);
});

test("pass-global binding planning scopes incompatible t0 declarations by stage", () =>
{
    const vertex = CjsFormatWebgpu.buildShaderIr(structuredVertexBinding(0));
    const pixel = CjsFormatWebgpu.buildShaderIr(copyblitPixelBindings(0));
    const plan = CjsFormatWebgpu.buildWgslBindingPlan([ vertex, pixel ]);

    assert.deepEqual(plan.bindings.map((entry) => [ entry.scopeIdentity, entry.binding ]), [
        [ "uniform-buffer:0:0@fragment", 0 ],
        [ "sampled-resource:0:0@vertex", 1 ],
        [ "sampled-resource:0:0@fragment", 2 ],
        [ "sampler:0:0@fragment", 3 ]
    ]);
    assert.equal(lowerBindingLayout(vertex, plan)[0].binding, 1);
    assert.equal(lowerBindingLayout(pixel, plan).find((entry) => entry.generatedSymbol === "t0").binding, 2);
    assert.throws(
        () => CjsFormatWebgpu.buildWgslBindingPlan([ vertex, pixel ], {
            sharedIdentities: [ "sampled-resource:0:0" ]
        }),
        /shared identity .* incompatible stage declarations/u
    );
});

test("pass-global binding planning shares compatible declarations only when confirmed", () =>
{
    const vertex = CjsFormatWebgpu.buildShaderIr(vertexConstantBuffers([ [ 1, 4 ] ]));
    const pixel = CjsFormatWebgpu.buildShaderIr(pixelConstantBuffers([ [ 1, 4 ] ]));
    const local = CjsFormatWebgpu.buildWgslBindingPlan([ vertex, pixel ]);

    assert.deepEqual(local.bindings.map((entry) => [ entry.scopeIdentity, entry.stages, entry.binding ]), [
        [ "uniform-buffer:0:1@vertex", [ "vertex" ], 0 ],
        [ "uniform-buffer:0:1@fragment", [ "fragment" ], 1 ]
    ]);
    assert.deepEqual(CjsFormatWebgpu.buildWgslBindingPlan([ pixel, vertex ]), local);

    const plan = CjsFormatWebgpu.buildWgslBindingPlan([ vertex, pixel ], {
        sharedIdentities: [ "uniform-buffer:0:1" ]
    });
    assert.deepEqual(plan.sharedIdentities, [ "uniform-buffer:0:1" ]);
    assert.deepEqual(plan.bindings.map((entry) => [ entry.identity, entry.scopeIdentity, entry.stages, entry.binding ]), [
        [ "uniform-buffer:0:1", "uniform-buffer:0:1", [ "vertex", "fragment" ], 0 ]
    ]);
    assert.equal(lowerBindingLayout(vertex, plan)[0].scopeIdentity, "uniform-buffer:0:1");
    assert.equal(lowerBindingLayout(pixel, plan)[0].scopeIdentity, "uniform-buffer:0:1");
});

test("pass-global binding planning rejects ambiguous stages and invalid sharing requests", () =>
{
    const vertex = CjsFormatWebgpu.buildShaderIr(vertexConstantBuffers([ [ 1, 4 ] ]));

    assert.throws(
        () => CjsFormatWebgpu.buildWgslBindingPlan([ vertex, vertex ]),
        /multiple vertex programs/u
    );
    assert.throws(
        () => CjsFormatWebgpu.buildWgslBindingPlan([ vertex ], {
            sharedIdentities: [ "uniform-buffer:0:1" ]
        }),
        /does not occur in multiple stages/u
    );
    assert.throws(
        () => CjsFormatWebgpu.buildWgslBindingPlan([ vertex ], {
            sharedIdentities: [ "sampler:0:9" ]
        }),
        /does not occur in the pass/u
    );
    assert.throws(
        () => CjsFormatWebgpu.buildWgslBindingPlan([ vertex ], {
            sharedIdentities: [ "uniform-buffer:0:1", "uniform-buffer:0:1" ]
        }),
        /unique D3D resource identities/u
    );
    assert.throws(
        () => CjsFormatWebgpu.buildWgslBindingPlan([ vertex ], { sharedIdentities: null }),
        /unique D3D resource identities/u
    );
});

test("binding-plan consumption rejects malformed scopes, coverage, sharing, and slots", () =>
{
    const vertex = CjsFormatWebgpu.buildShaderIr(vertexConstantBuffers([ [ 1, 4 ] ]));
    const pixel = CjsFormatWebgpu.buildShaderIr(pixelConstantBuffers([ [ 1, 4 ] ]));
    const local = structuredClone(CjsFormatWebgpu.buildWgslBindingPlan([ vertex, pixel ]));

    const malformed = structuredClone(local);
    malformed.bindings[0].scopeIdentity = "uniform-buffer:0:1@fragment";
    assert.throws(() => lowerBindingLayout(vertex, malformed), /invalid scope identity/u);

    const overlapping = structuredClone(local);
    overlapping.bindings[1].scopeIdentity = "uniform-buffer:0:1@vertex";
    overlapping.bindings[1].stages = [ "vertex" ];
    assert.throws(() => lowerBindingLayout(vertex, overlapping), /duplicate scope identity|overlapping vertex identity/u);

    const duplicateSlot = structuredClone(local);
    duplicateSlot.bindings[1].binding = duplicateSlot.bindings[0].binding;
    assert.throws(() => lowerBindingLayout(vertex, duplicateSlot), /assigns 0:0 to multiple scope identities/u);

    const shared = structuredClone(CjsFormatWebgpu.buildWgslBindingPlan([ vertex, pixel ], {
        sharedIdentities: [ "uniform-buffer:0:1" ]
    }));
    delete shared.sharedIdentities;
    assert.throws(() => lowerBindingLayout(vertex, shared), /shares unconfirmed identity/u);

    const unsharedBase = structuredClone(local);
    unsharedBase.bindings[0].scopeIdentity = "uniform-buffer:0:1";
    assert.throws(() => lowerBindingLayout(vertex, unsharedBase), /unshared base identity/u);

    const malformedShared = structuredClone(local);
    malformedShared.sharedIdentities = null;
    assert.throws(() => lowerBindingLayout(vertex, malformedShared), /invalid shared identities/u);

    const legacy = structuredClone(CjsFormatWebgpu.buildWgslBindingPlan([ vertex ]));
    legacy.formatVersion = 1;
    legacy.bindings.forEach((entry) =>
    {
        entry.scopeIdentity = "arbitrary-v2-scope";
        delete entry.stages;
    });
    const legacyVertexBinding = lowerBindingLayout(vertex, legacy)[0];
    assert.equal(legacyVertexBinding.scopeIdentity, "uniform-buffer:0:1@vertex");
    const legacySet = CjsFormatWebgpu.buildWgslSet([
        { key: "Main.pass0.vertex", shader: emitted("vertex", [ legacyVertexBinding ]) }
    ]);
    assert.equal(
        legacySet.layouts[0].bindGroups[0].bindings[0].scopeIdentity,
        "uniform-buffer:0:1@vertex"
    );

    const legacyShared = structuredClone(CjsFormatWebgpu.buildWgslBindingPlan([ vertex, pixel ], {
        sharedIdentities: [ "uniform-buffer:0:1" ]
    }));
    legacyShared.formatVersion = 1;
    legacyShared.bindings.forEach((entry) =>
    {
        delete entry.scopeIdentity;
        delete entry.stages;
    });
    const legacySharedVertex = lowerBindingLayout(vertex, legacyShared)[0];
    const legacySharedPixel = lowerBindingLayout(pixel, legacyShared)[0];
    assert.equal(legacySharedVertex.scopeIdentity, "uniform-buffer:0:1");
    assert.equal(legacySharedPixel.scopeIdentity, "uniform-buffer:0:1");
    const legacySharedSet = CjsFormatWebgpu.buildWgslSet([
        { key: "Main.pass0.vertex", shader: emitted("vertex", [ legacySharedVertex ]) },
        { key: "Main.pass0.pixel", shader: emitted("fragment", [ legacySharedPixel ]) }
    ]);
    assert.deepEqual(
        legacySharedSet.layouts[0].bindGroups[0].bindings[0].visibility,
        [ "vertex", "fragment" ]
    );
});

test("binding lowering rejects negative registers and future IR versions", () =>
{
    const negative = structuredClone(CjsFormatWebgpu.buildShaderIr(vertexConstantBuffers([ [ 1, 4 ] ])));
    negative.bindings[0].range.lowerBound = -1;
    assert.throws(() => lowerBindingLayout(negative), /unresolved register identity/u);

    const future = structuredClone(CjsFormatWebgpu.buildShaderIr(vertexConstantBuffers([ [ 1, 4 ] ])));
    future.formatVersion = 2;
    assert.throws(() => lowerBindingLayout(future), /CJS_SHADER_IR version 1/u);
    assert.throws(() => CjsFormatWebgpu.buildWgslBindingPlan([ future ]), /CJS_SHADER_IR version 1/u);
});
