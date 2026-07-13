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

test("binding lowering rejects unsupported resource layouts explicitly", () =>
{
    const decoded = copyblitPixelBindings(0);
    decoded.instructions[1].declaration.resourceDimensionName = "texture3d";
    const ir = CjsFormatWebgpu.buildShaderIr(decoded);
    assert.throws(() => lowerBindingLayout(ir), /unsupported dimension texture3d/i);
});
