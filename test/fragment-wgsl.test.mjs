import { test } from "node:test";
import assert from "node:assert/strict";

import CjsFormatWebgpu from "../src/index.js";

function register(typeName, registerIndex, { mask = "", swizzle = "", selected = "", modifierName = "none" } = {})
{
    return {
        typeName,
        componentCount: [ "resource", "sampler" ].includes(typeName) ? 0 : 4,
        mask,
        swizzle,
        selected,
        modifierName,
        minPrecisionName: "default",
        registerIndex,
        indices: Number.isInteger(registerIndex) ? [ { values: [ registerIndex ], relative: null } ] : []
    };
}

function immediate(bits)
{
    return {
        ...register("immediate32", null, { swizzle: "xyzw" }),
        immediateValues: bits.map((uint32) => ({ uint32, float32: 0 }))
    };
}

function signature(semanticName, registerIndex, mask)
{
    return {
        semanticName,
        semanticIndex: 0,
        systemValueType: semanticName.startsWith("SV_") ? 1 : 0,
        componentType: 3,
        componentTypeName: "float32",
        registerIndex,
        mask,
        readWriteMask: mask,
        stream: 0,
        minPrecision: 0
    };
}

function declaration(offset, opcodeName, operandType, data)
{
    return {
        offset,
        opcode: 0,
        opcodeName,
        isDeclaration: true,
        declaration: { registerIndex: 0, ...data },
        operands: [ register(operandType, 0) ]
    };
}

function instruction(offset, opcodeName, operands)
{
    return { offset, opcode: 0, opcodeName, isDeclaration: false, operands };
}

function fragmentFixture(minor = 0)
{
    const zeroOne = immediate([ 0, 0, 0x3f800000, 0x3f800000 ]);
    return {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: minor },
        signatures: {
            input: [ signature("SV_Position", 0, 15), signature("TEXCOORD", 1, 3) ],
            output: [ signature("SV_Target", 0, 15) ]
        },
        instructions: [
            declaration(2, "dcl_constant_buffer", "constant_buffer", { accessPattern: "immediate_indexed", sizeInVec4: 3 }),
            declaration(5, "dcl_sampler", "sampler", { samplerModeName: "default" }),
            declaration(7, "dcl_resource", "resource", {
                resourceDimensionName: "texture2d",
                returnType: { returnTypeNames: [ "float", "float", "float", "float" ] }
            }),
            {
                offset: 9,
                opcode: 0,
                opcodeName: "dcl_input_ps",
                isDeclaration: true,
                declaration: { registerIndex: 1, interpolationModeName: "linear" },
                operands: [ register("input", 1) ]
            },
            instruction(12, "lt", [
                register("temp", 0, { mask: "x" }),
                register("input", 1, { selected: "x" }),
                register("input", 1, { selected: "x" })
            ]),
            instruction(16, "if", [ register("temp", 0, { selected: "x" }) ]),
            instruction(18, "sample", [
                register("temp", 1, { mask: "yz" }),
                register("input", 1, { swizzle: "xyxx" }),
                register("resource", 0, { swizzle: "zxyw" }),
                register("sampler", 0)
            ]),
            instruction(23, "dp2", [
                register("temp", 2, { mask: "x" }),
                register("temp", 1, { swizzle: "yzyy" }),
                register("temp", 1, { swizzle: "yzyy" })
            ]),
            instruction(27, "mov", [ register("output", 0, { mask: "x" }), register("temp", 2, { selected: "x" }) ]),
            instruction(30, "mov", [ register("output", 0, { mask: "y" }), register("temp", 1, { selected: "z" }) ]),
            instruction(33, "mov", [ register("output", 0, { mask: "zw" }), zeroOne ]),
            instruction(37, "ret", []),
            instruction(38, "endif", []),
            instruction(39, "sample", [
                register("temp", 3, { mask: "xyzw" }),
                register("input", 1, { swizzle: "xyxx" }),
                register("resource", 0, { swizzle: "xyzw" }),
                register("sampler", 0)
            ]),
            instruction(44, "mov", [ register("output", 0, { mask: "xy" }), register("temp", 3, { swizzle: "xyxx" }) ]),
            instruction(47, "mov", [ register("output", 0, { mask: "zw" }), zeroOne ]),
            instruction(51, "ret", [])
        ]
    };
}

function scalarMergeFixture()
{
    const constants = immediate([ 0x3f800000, 0x3f800000, 0x3f800000, 0x3f800000 ]);
    return {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: 1 },
        signatures: {
            input: [ signature("TEXCOORD", 0, 3) ],
            output: [ signature("SV_Target", 0, 15) ]
        },
        instructions: [
            {
                offset: 2,
                opcode: 0,
                opcodeName: "dcl_input_ps",
                isDeclaration: true,
                declaration: { registerIndex: 0, interpolationModeName: "linear" },
                operands: [ register("input", 0) ]
            },
            instruction(5, "mov", [ register("temp", 0, { mask: "x" }), register("input", 0, { selected: "x" }) ]),
            instruction(9, "lt", [
                register("temp", 1, { mask: "x" }),
                register("input", 0, { selected: "x" }),
                register("input", 0, { selected: "y" })
            ]),
            { ...instruction(13, "if", [ register("temp", 1, { selected: "x" }) ]), testBoolean: "nonzero" },
            instruction(16, "mov", [ register("temp", 0, { mask: "x" }), register("input", 0, { selected: "y" }) ]),
            instruction(20, "endif", []),
            instruction(21, "mov", [ register("output", 0, { mask: "x" }), register("temp", 0, { selected: "x" }) ]),
            instruction(25, "mov", [ register("output", 0, { mask: "yzw" }), constants ]),
            instruction(30, "ret", [])
        ]
    };
}

function undefinedMergeChainFixture(secondTestBoolean = "zero")
{
    const constants = immediate([ 0x3f800000, 0x3f800000, 0x3f800000, 0x3f800000 ]);
    return {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: 1 },
        signatures: {
            input: [ signature("TEXCOORD", 0, 3) ],
            output: [ signature("SV_Target", 0, 15) ]
        },
        instructions: [
            {
                offset: 2,
                opcode: 0,
                opcodeName: "dcl_input_ps",
                isDeclaration: true,
                declaration: { registerIndex: 0, interpolationModeName: "linear" },
                operands: [ register("input", 0) ]
            },
            instruction(5, "lt", [
                register("temp", 1, { mask: "x" }),
                register("input", 0, { selected: "x" }),
                register("input", 0, { selected: "y" })
            ]),
            { ...instruction(9, "if", [ register("temp", 1, { selected: "x" }) ]), testBoolean: "nonzero" },
            instruction(12, "mov", [ register("temp", 0, { mask: "x" }), register("input", 0, { selected: "x" }) ]),
            instruction(16, "endif", []),
            { ...instruction(17, "if", [ register("temp", 1, { selected: "x" }) ]), testBoolean: secondTestBoolean },
            instruction(20, "mov", [ register("temp", 0, { mask: "x" }), register("input", 0, { selected: "y" }) ]),
            instruction(24, "endif", []),
            instruction(25, "mov", [ register("output", 0, { mask: "x" }), register("temp", 0, { selected: "x" }) ]),
            instruction(29, "mov", [ register("output", 0, { mask: "yzw" }), constants ]),
            instruction(34, "ret", [])
        ]
    };
}

test("BuildWgsl emits the bounded fragment interface, bindings, and positional sample lanes", () =>
{
    const shader = CjsFormatWebgpu.buildWgsl(fragmentFixture(), { source: "synthetic-copyblit-ps" });

    assert.equal(shader.stage, "fragment");
    assert.match(shader.code, /@location\(1\) input1: vec2<f32>/);
    assert.doesNotMatch(shader.code, /SV_Position|input0/);
    assert.match(shader.code, /@binding\(0\) var<uniform> cb0: array<vec4<f32>, 3>/);
    assert.match(shader.code, /@binding\(1\) var t0: texture_2d<f32>/);
    assert.match(shader.code, /@binding\(2\) var s0: sampler/);
    assert.match(shader.code, /textureSample\(t0, s0, vec2<f32>\([^\n]+\)\)\.xy/);
    assert.doesNotMatch(shader.code, /textureSample\([^\n]+\)\.zx/);
    assert.match(shader.code, /dot\(vec2<f32>\([^\n]+\), vec2<f32>\([^\n]+\)\)/);
    assert.match(shader.code, /bitcast<f32>\(0x3f800000u\)/);
    assert.equal(shader.program.bindings[0].buffer.minBindingSize, 48);
    assert.equal(shader.sourceMap.some((entry) => entry.dxbcOffset === 38), false);
});

test("fragment lowering maps a live SV_Position input to the WebGPU position builtin", () =>
{
    const decoded = fragmentFixture();
    decoded.instructions.find((entry) => entry.offset === 12).operands[1] = register("input", 0, { selected: "x" });
    const shader = CjsFormatWebgpu.buildWgsl(decoded);

    assert.match(shader.code, /@builtin\(position\) position: vec4<f32>/);
    assert.match(shader.code, /input\.position\.x/);
    assert.doesNotMatch(shader.code, /@location\(0\) input0/);
});

test("fragment lowering emits an explicit texture bias for sample_b", () =>
{
    const decoded = fragmentFixture();
    const sample = decoded.instructions.find((entry) => entry.offset === 18);
    sample.opcodeName = "sample_b";
    sample.operands.push(immediate([ 0x3dcccccd ]));
    const shader = CjsFormatWebgpu.buildWgsl(decoded);

    assert.match(shader.code, /textureSampleBias\(t0, s0, vec2<f32>\([^\n]+\), bitcast<f32>\(0x3dcccccdu\)\)\.xy/);
});

test("fragment lowering clamps saturated float results componentwise", () =>
{
    const decoded = fragmentFixture();
    decoded.instructions.find((entry) => entry.offset === 18).saturate = true;
    const shader = CjsFormatWebgpu.buildWgsl(decoded);

    assert.match(shader.code, /clamp\(textureSample\([^\n]+\)\.xy, vec2<f32>\(0\.0\), vec2<f32>\(1\.0\)\)/);
});

test("fragment lowering preserves absolute and negated-absolute source modifiers", () =>
{
    const decoded = fragmentFixture();
    decoded.instructions.find((entry) => entry.offset === 23).operands[1].modifierName = "absneg";
    const shader = CjsFormatWebgpu.buildWgsl(decoded);

    assert.match(shader.code, /dot\(vec2<f32>\(-\(abs\([^\n]+\)\), -\(abs\([^\n]+\)\)\)/);
});

test("fragment lowering checks output coverage on each return path", () =>
{
    const decoded = fragmentFixture();
    decoded.instructions.find((entry) => entry.offset === 33).operands[0].mask = "z";
    assert.throws(() => CjsFormatWebgpu.buildWgsl(decoded), /leaves w unwritten before return/i);
});

test("fragment lowering rejects live undefined reads and accepts bounded SM5.1 control metadata", () =>
{
    const undefinedRead = fragmentFixture();
    undefinedRead.instructions.find((entry) => entry.offset === 12).operands[1] = register("temp", 9, { selected: "x" });
    assert.throws(() => CjsFormatWebgpu.buildWgsl(undefinedRead), /reads undefined temp\[9\]\.x/i);

    const dx12 = fragmentFixture(1);
    dx12.instructions.find((entry) => entry.offset === 16).testBoolean = "zero";
    const cbDeclaration = dx12.instructions.find((entry) => entry.opcodeName === "dcl_constant_buffer").declaration;
    cbDeclaration.registerIndex = 2;
    cbDeclaration.bindingRange = {
        bindingModel: "sm5.1-range",
        rangeId: 3,
        lowerBound: 2,
        upperBound: 2,
        unbounded: false,
        registerCount: 1,
        registerSpace: 0
    };
    const cb = register("constant_buffer", 3, { swizzle: "xyzw" });
    cb.resourceReference = { bindingModel: "sm5.1-range", rangeId: 3 };
    cb.indices = [
        { values: [ 0 ], relative: null },
        { values: [ 0 ], relative: null },
        { values: [ 2 ], relative: null }
    ];
    dx12.instructions.find((entry) => entry.offset === 33).operands[1] = cb;
    const shader = CjsFormatWebgpu.buildWgsl(dx12);
    assert.match(shader.code, /if \([^\n]+ == 0u\)/);
    assert.match(shader.code, /cb2\[2\]/);
});

test("SM5.1 scalar merge lowering emits one mutable phi without synthetic source mappings", () =>
{
    const ir = CjsFormatWebgpu.buildShaderIr(scalarMergeFixture());
    const merge = ir.values.find((value) => value.origin === "control-flow-merge");
    const shader = CjsFormatWebgpu.buildWgsl(ir);

    assert(merge);
    assert.match(shader.code, new RegExp(`var ${merge.id}: f32 = value\\d+(?:\\.[xyzw])?;`));
    assert.match(shader.code, new RegExp(`${merge.id} = value\\d+(?:\\.[xyzw])?;`));
    assert.equal(shader.sourceMap.some((entry) => entry.instructionIndex === null), false);
    assert.equal(shader.sourceMap.some((entry) => entry.dxbcOffset === 20), false);
});

const mergeCorruptions = [
    [ "cycles", (ir, merge) => { merge.incoming[0].valueId = merge.id; }, /merge graph contains a cycle/i ],
    [ "non-float types", (ir, merge) => { merge.componentTypes[merge.writeMask] = "uint32"; }, /not a scalar float predecessor phi/i ],
    [ "unknown predecessor edges", (ir, merge) => { merge.incoming[0].blockId = "block999"; }, /unsupported incoming edges/i ],
    [ "false-edge dominance violations", (ir, merge) => { merge.incoming[0].valueId = merge.incoming[1].valueId; }, /false input does not dominate/i ],
    [ "observable undefined carriers", (ir, merge) => {
        const exemplar = ir.values.find((value) => value.origin === "undefined-register");
        assert(exemplar);
        const undefinedValue = {
            ...structuredClone(exemplar),
            id: `value${ir.values.length}`,
            register: merge.register,
            writeMask: merge.writeMask,
            componentTypes: { ...merge.componentTypes }
        };
        ir.values.push(undefinedValue);
        merge.incoming[0].valueId = undefinedValue.id;
    }, /observable undefined/i ]
];

for (const [ name, mutate, pattern ] of mergeCorruptions)
{
    test(`SM5.1 scalar merge validation rejects ${name}`, () =>
    {
        const ir = structuredClone(CjsFormatWebgpu.buildShaderIr(scalarMergeFixture()));
        const merge = ir.values.find((value) => value.origin === "control-flow-merge");
        assert(merge);
        mutate(ir, merge);
        assert.throws(() => CjsFormatWebgpu.buildWgsl(ir), pattern);
    });
}

test("SM5.1 undefined carriers require a correlated complementary overwrite", () =>
{
    const complementary = CjsFormatWebgpu.buildWgsl(undefinedMergeChainFixture("zero"));
    assert.match(complementary.code, /var value\d+: f32 = 0\.0;/);
    assert.throws(
        () => CjsFormatWebgpu.buildWgsl(undefinedMergeChainFixture("nonzero")),
        /observable undefined path/i
    );
});
