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

function vertexConstantBuffers(entries)
{
    return {
        program: { programType: 1, programTypeName: "vertex", majorVersion: 5, minorVersion: 0 },
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

test("binding lowering rejects unsupported resource layouts explicitly", () =>
{
    const decoded = copyblitPixelBindings(0);
    decoded.instructions[1].declaration.resourceDimensionName = "texture3d";
    const ir = CjsFormatWebgpu.buildShaderIr(decoded);
    assert.throws(() => lowerBindingLayout(ir), /unsupported dimension texture3d/i);
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
    assert.deepEqual(lowerBindingLayout(dx11Ir, plan), dx11);
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

    assert.deepEqual(plan.bindings.map((entry) => [ entry.identity, entry.group, entry.binding ]), [
        [ "uniform-buffer:0:0", 0, 0 ],
        [ "uniform-buffer:0:1", 0, 1 ],
        [ "uniform-buffer:0:3", 0, 2 ],
        [ "sampled-resource:0:0", 0, 3 ],
        [ "sampler:0:0", 0, 4 ]
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
});

test("pass-global binding planning rejects incompatible declarations for one identity", () =>
{
    const first = CjsFormatWebgpu.buildShaderIr(vertexConstantBuffers([ [ 1, 4 ] ]));
    const second = CjsFormatWebgpu.buildShaderIr(vertexConstantBuffers([ [ 1, 5 ] ]));

    assert.throws(
        () => CjsFormatWebgpu.buildWgslBindingPlan([ first, second ]),
        /incompatible stage declarations/u
    );
});

test("pass-global binding planning requires explicit confirmation before sharing a cross-stage identity", () =>
{
    const first = CjsFormatWebgpu.buildShaderIr(vertexConstantBuffers([ [ 1, 4 ] ]));
    const second = CjsFormatWebgpu.buildShaderIr(vertexConstantBuffers([ [ 1, 4 ] ]));

    assert.throws(
        () => CjsFormatWebgpu.buildWgslBindingPlan([ first, second ]),
        /without an explicit shared identity/u
    );
    const plan = CjsFormatWebgpu.buildWgslBindingPlan([ first, second ], {
        sharedIdentities: [ "uniform-buffer:0:1" ]
    });
    assert.deepEqual(plan.sharedIdentities, [ "uniform-buffer:0:1" ]);
    assert.deepEqual(plan.bindings.map((entry) => [ entry.identity, entry.binding ]), [
        [ "uniform-buffer:0:1", 0 ]
    ]);
});
