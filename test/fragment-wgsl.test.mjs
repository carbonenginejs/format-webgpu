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

function globalFlagsDeclaration(refactoringAllowed = true)
{
    return {
        offset: 0,
        opcode: 0,
        opcodeName: "dcl_global_flags",
        isDeclaration: true,
        declaration: {
            globalFlags: refactoringAllowed ? 1 << 11 : 0,
            refactoringAllowed
        },
        operands: []
    };
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
            globalFlagsDeclaration(),
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
            { ...instruction(16, "if", [ register("temp", 0, { selected: "x" }) ]), testBoolean: "nonzero" },
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

function inputlessFragmentFixture()
{
    const color = immediate([ 0x3f800000, 0, 0x3f000000, 0x3f800000 ]);
    return {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: 0 },
        signatures: {
            input: [ signature("TEXCOORD", 0, 3) ],
            output: [ signature("SV_Target", 0, 15) ]
        },
        instructions: [
            globalFlagsDeclaration(),
            {
                offset: 2,
                opcode: 0,
                opcodeName: "dcl_input_ps",
                isDeclaration: true,
                declaration: { registerIndex: 0, interpolationModeName: "linear" },
                operands: [ register("input", 0) ]
            },
            instruction(5, "mov", [ register("output", 0, { mask: "xyzw" }), color ]),
            instruction(10, "ret", [])
        ]
    };
}

function roundingFragmentFixture(minor = 0)
{
    const values = immediate([ 0x3fc00000, 0xbfc00000, 0x3fc00000, 0xbfc00000 ]);
    return {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: minor },
        signatures: { input: [], output: [ signature("SV_Target", 0, 15) ] },
        instructions: [
            globalFlagsDeclaration(),
            instruction(2, "frc", [ register("output", 0, { mask: "xy" }), values ]),
            instruction(6, "round_ni", [ register("output", 0, { mask: "zw" }), values ]),
            instruction(10, "ret", [])
        ]
    };
}

function integerDiscardFragmentFixture(minor = 0, { projection = "nonzero", explicitFlow = false } = {})
{
    const zero = immediate([ 0 ]);
    const color = immediate([ 0x3f800000, 0, 0x3f000000, 0x3f800000 ]);
    const instructions = [
        globalFlagsDeclaration(),
        {
            offset: 2,
            opcode: 0,
            opcodeName: "dcl_input_ps",
            isDeclaration: true,
            declaration: { registerIndex: 0, interpolationModeName: "linear" },
            operands: [ register("input", 0) ]
        },
        instruction(5, "lt", [
            register("temp", 0, { mask: "x" }),
            register("input", 0, { selected: "x" }),
            register("input", 0, { selected: "y" })
        ]),
        instruction(9, "lt", [
            register("temp", 0, { mask: "y" }),
            register("input", 0, { selected: "y" }),
            register("input", 0, { selected: "x" })
        ]),
        instruction(13, "iadd", [
            register("temp", 0, { mask: "z" }),
            register("temp", 0, { selected: "x", modifierName: "neg" }),
            register("temp", 0, { selected: "y" })
        ]),
        instruction(17, "itof", [
            register("temp", 0, { mask: "w" }),
            register("temp", 0, { selected: "z" })
        ]),
        instruction(21, "lt", [
            register("temp", 1, { mask: "x" }),
            register("temp", 0, { selected: "w" }),
            zero
        ])
    ];
    if (explicitFlow)
    {
        instructions.push(
            { ...instruction(25, "if", [ register("temp", 1, { selected: "x" }) ]), testBoolean: "nonzero" },
            { ...instruction(28, "discard", [ immediate([ 0xffffffff ]) ]), testBoolean: "nonzero" },
            instruction(29, "endif", []),
            instruction(30, "mov", [ register("output", 0, { mask: "xyzw" }), color ]),
            instruction(35, "ret", [])
        );
    }
    else
    {
        instructions.push(
            { ...instruction(25, "discard", [ register("temp", 1, { selected: "x" }) ]), testBoolean: projection },
            instruction(28, "mov", [ register("output", 0, { mask: "xyzw" }), color ]),
            instruction(33, "ret", [])
        );
    }
    return {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: minor },
        signatures: {
            input: [ signature("TEXCOORD", 0, 3) ],
            output: [ signature("SV_Target", 0, 15) ]
        },
        instructions
    };
}

function bitpatternInputFragmentFixture()
{
    const color = immediate([ 0x3f800000, 0, 0x3f000000, 0x3f800000 ]);
    return {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: 0 },
        signatures: {
            input: [ signature("TEXCOORD", 0, 1) ],
            output: [ signature("SV_Target", 0, 15) ]
        },
        instructions: [
            globalFlagsDeclaration(),
            {
                offset: 2,
                opcode: 0,
                opcodeName: "dcl_input_ps",
                isDeclaration: true,
                declaration: { registerIndex: 0, interpolationModeName: "linear" },
                operands: [ register("input", 0) ]
            },
            instruction(5, "mov", [ register("temp", 0, { mask: "x" }), register("input", 0, { selected: "x" }) ]),
            { ...instruction(9, "discard", [ register("temp", 0, { selected: "x" }) ]), testBoolean: "nonzero" },
            instruction(12, "mov", [ register("output", 0, { mask: "xyzw" }), color ]),
            instruction(17, "ret", [])
        ]
    };
}

function bitpatternOutputFragmentFixture()
{
    const color = immediate([ 0, 0x3f800000, 0x3f000000, 0x3f800000 ]);
    return {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: 0 },
        signatures: {
            input: [ signature("TEXCOORD", 0, 3) ],
            output: [ signature("SV_Target", 0, 15) ]
        },
        instructions: [
            globalFlagsDeclaration(),
            {
                offset: 2,
                opcode: 0,
                opcodeName: "dcl_input_ps",
                isDeclaration: true,
                declaration: { registerIndex: 0, interpolationModeName: "linear" },
                operands: [ register("input", 0) ]
            },
            instruction(5, "lt", [
                register("output", 0, { mask: "x" }),
                register("input", 0, { selected: "x" }),
                register("input", 0, { selected: "y" })
            ]),
            instruction(9, "mov", [ register("output", 0, { mask: "yzw" }), color ]),
            instruction(14, "ret", [])
        ]
    };
}

function outputReadFragmentFixture(bitpattern = false)
{
    const first = bitpattern
        ? instruction(5, "lt", [
            register("output", 0, { mask: "x" }),
            register("input", 0, { selected: "x" }),
            register("input", 0, { selected: "y" })
        ])
        : instruction(5, "mov", [
            register("output", 0, { mask: "x" }),
            register("input", 0, { selected: "x" })
        ]);
    return {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: 0 },
        signatures: {
            input: [ signature("TEXCOORD", 0, 3) ],
            output: [ signature("SV_Target", 0, 15) ]
        },
        instructions: [
            globalFlagsDeclaration(),
            {
                offset: 2,
                opcode: 0,
                opcodeName: "dcl_input_ps",
                isDeclaration: true,
                declaration: { registerIndex: 0, interpolationModeName: "linear" },
                operands: [ register("input", 0) ]
            },
            first,
            instruction(9, "add", [
                register("output", 0, { mask: "y" }),
                register("output", 0, { selected: "x" }),
                register("input", 0, { selected: "y" })
            ]),
            instruction(13, "mov", [ register("output", 0, { mask: "zw" }), immediate([ 0, 0 ]) ]),
            instruction(17, "ret", [])
        ]
    };
}

function threeLaneDotFragmentFixture(selected = false)
{
    return {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: 0 },
        signatures: {
            input: [ signature("TEXCOORD", 0, 7) ],
            output: [ signature("SV_Target", 0, 15) ]
        },
        instructions: [
            globalFlagsDeclaration(),
            {
                offset: 2,
                opcode: 0,
                opcodeName: "dcl_input_ps",
                isDeclaration: true,
                declaration: { registerIndex: 0, interpolationModeName: "linear" },
                operands: [ register("input", 0) ]
            },
            instruction(5, "mov", [
                register("temp", 0, { mask: "xyz" }),
                register("input", 0, { swizzle: "xyzx" })
            ]),
            instruction(9, "dp3", [
                register("temp", 1, { mask: "x" }),
                register("temp", 0, selected ? { selected: "x" } : { swizzle: "xyzw" }),
                register("temp", 0, { swizzle: "xyzw" })
            ]),
            instruction(14, "mov", [
                register("output", 0, { mask: "xyzw" }),
                register("temp", 1, { selected: "x" })
            ]),
            instruction(18, "ret", [])
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
            globalFlagsDeclaration(),
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
            globalFlagsDeclaration(),
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

test("fragment lowering emits a parameterless entry point when declared inputs are dead", () =>
{
    const shader = CjsFormatWebgpu.buildWgsl(inputlessFragmentFixture(), { source: "synthetic-inputless-ps" });

    assert.deepEqual(shader.program.interface.inputs, []);
    assert.equal(shader.code, [
        "struct FragmentOutput",
        "{",
        "    @location(0) output0: vec4<f32>,",
        "};",
        "",
        "@fragment",
        "fn main() -> FragmentOutput",
        "{",
        "    var output: FragmentOutput;",
        "    output.output0 = vec4<f32>(bitcast<f32>(0x3f800000u), bitcast<f32>(0x00000000u), bitcast<f32>(0x3f000000u), bitcast<f32>(0x3f800000u));",
        "    return output;",
        "}",
        ""
    ].join("\n"));
    assert.deepEqual(shader.sourceMap.map(({ line, dxbcOffset }) => ({ line, dxbcOffset })), [
        { line: 10, dxbcOffset: 5 },
        { line: 11, dxbcOffset: 10 }
    ]);

    const noDeclaredInput = inputlessFragmentFixture();
    noDeclaredInput.signatures.input = [];
    noDeclaredInput.instructions.splice(
        noDeclaredInput.instructions.findIndex((entry) => entry.opcodeName === "dcl_input_ps"),
        1
    );
    assert.equal(CjsFormatWebgpu.buildWgsl(noDeclaredInput).code, shader.code);

    const missingOutput = inputlessFragmentFixture();
    missingOutput.signatures.output = [];
    assert.throws(() => CjsFormatWebgpu.buildWgsl(missingOutput), /requires output signatures/i);
});

test("fragment lowering maps DXBC frc and round_ni to component-wise WGSL rounding", () =>
{
    const dx11 = CjsFormatWebgpu.buildWgsl(roundingFragmentFixture(0));
    const dx12 = CjsFormatWebgpu.buildWgsl(roundingFragmentFixture(1));

    assert.equal(dx12.code, dx11.code);
    assert.match(dx11.code, /output\.output0\.xy = fract\(vec2<f32>\(/);
    assert.match(dx11.code, /output\.output0\.zw = floor\(vec2<f32>\(/);
    assert.deepEqual(dx11.sourceMap.map(({ line, dxbcOffset }) => ({ line, dxbcOffset })), [
        { line: 10, dxbcOffset: 2 },
        { line: 11, dxbcOffset: 6 },
        { line: 12, dxbcOffset: 10 }
    ]);
});

test("fragment lowering preserves signed comparison-mask iadd before numeric itof conversion", () =>
{
    const shader = CjsFormatWebgpu.buildWgsl(integerDiscardFragmentFixture());

    assert.match(shader.code, /let (value\d+): i32 = \(-\(bitcast<i32>\(value\d+\)\) \+ bitcast<i32>\(value\d+\)\);/);
    const integerValue = /let (value\d+): i32/.exec(shader.code)?.[1];
    assert(integerValue);
    assert.match(shader.code, new RegExp(`let value\\d+: f32 = f32\\(${integerValue}\\);`));
});

test("fragment lowering materializes full result bitcasts and rejects partial records", () =>
{
    const ir = structuredClone(CjsFormatWebgpu.buildShaderIr(integerDiscardFragmentFixture()));
    const iadd = ir.instructions.find((entry) => entry.opcodeName === "iadd");
    const itof = ir.instructions.find((entry) => entry.opcodeName === "itof");
    const write = iadd.dataflow.writes[0];
    const component = write.mask;
    const value = ir.values.find((entry) => entry.id === write.valueId);
    const read = itof.dataflow.reads.find((entry) => entry.operandIndex === 1);
    value.componentTypes[component] = "bitpattern32";
    iadd.typeInfo.bitcasts.push({
        kind: "result-bitcast",
        operandIndex: write.operandIndex,
        valueId: write.valueId,
        component,
        from: "int32",
        to: "bitpattern32"
    });
    itof.typeInfo.bitcasts.push({
        kind: "read-bitcast",
        operandIndex: 1,
        componentIndex: 0,
        valueId: read.refs[0].valueId,
        component: read.refs[0].component,
        from: "bitpattern32",
        to: "int32"
    });

    const shader = CjsFormatWebgpu.buildWgsl(ir);
    assert.match(shader.code, new RegExp(`let ${write.valueId}: u32 = bitcast<u32>\\(`, "u"));
    assert.match(shader.code, new RegExp(`f32\\(bitcast<i32>\\(${write.valueId}\\)\\)`, "u"));

    const partial = structuredClone(ir);
    partial.instructions.find((entry) => entry.opcodeName === "iadd").typeInfo.bitcasts
        .find((entry) => entry.kind === "result-bitcast").component = "x";
    assert.throws(() => CjsFormatWebgpu.buildWgsl(partial), /inconsistent register bitcast metadata/u);

    for (const mutate of [
        (record) => { record.from = "uint32"; },
        (record) => { record.to = "float32"; }
    ])
    {
        const malformed = structuredClone(ir);
        mutate(malformed.instructions.find((entry) => entry.opcodeName === "iadd").typeInfo.bitcasts
            .find((entry) => entry.kind === "result-bitcast"));
        assert.throws(() => CjsFormatWebgpu.buildWgsl(malformed), /inconsistent register bitcast metadata/u);
    }

    const missingRead = structuredClone(ir);
    const readCasts = missingRead.instructions.find((entry) => entry.opcodeName === "itof").typeInfo.bitcasts;
    readCasts.splice(readCasts.findIndex((entry) => entry.kind === "read-bitcast"), 1);
    assert.throws(() => CjsFormatWebgpu.buildWgsl(missingRead), /inconsistent register bitcast metadata/u);
});

test("fragment lowering reinterprets float-backed cbuffer lanes for integer consumers", () =>
{
    const decoded = integerDiscardFragmentFixture();
    decoded.instructions.unshift(declaration(1, "dcl_constant_buffer", "constant_buffer", {
        accessPattern: "immediate_indexed",
        sizeInVec4: 1
    }));
    const cb = register("constant_buffer", 0, { selected: "x" });
    cb.indices = [
        { values: [ 0 ], relative: null },
        { values: [ 0 ], relative: null }
    ];
    decoded.instructions.find((entry) => entry.opcodeName === "iadd").operands[2] = structuredClone(cb);
    decoded.instructions.find((entry) => entry.opcodeName === "itof").operands[1] = structuredClone(cb);
    decoded.instructions.find((entry) => entry.opcodeName === "discard").operands[0] = structuredClone(cb);

    const shader = CjsFormatWebgpu.buildWgsl(decoded);
    assert.match(shader.code, /\+ bitcast<i32>\(cb0\[0\]\.x\)/u);
    assert.match(shader.code, /f32\(bitcast<i32>\(cb0\[0\]\.x\)\)/u);
    assert.match(shader.code, /if \(bitcast<u32>\(cb0\[0\]\.x\) != 0u\)/u);
});

test("fragment lowering reconciles inferred bitpatterns with physical interface types", () =>
{
    const input = CjsFormatWebgpu.buildWgsl(bitpatternInputFragmentFixture());
    const output = CjsFormatWebgpu.buildWgsl(bitpatternOutputFragmentFixture());

    assert.match(input.code, /let value\d+: u32 = bitcast<u32>\(input\.input0\);/u);
    assert.match(output.code, /output\.output0\.x = bitcast<f32>\(select\(0u, 0xffffffffu,/u);
});

test("fragment lowering materializes float and bitpattern output values before later reads", () =>
{
    const floatShader = CjsFormatWebgpu.buildWgsl(outputReadFragmentFixture(false));
    const bitpatternShader = CjsFormatWebgpu.buildWgsl(outputReadFragmentFixture(true));

    const floatValue = /let (value\d+): f32 = input\.input0\.x;/u.exec(floatShader.code)?.[1];
    assert(floatValue);
    assert.match(floatShader.code, new RegExp(`output\\.output0\\.x = ${floatValue};`, "u"));
    assert.match(floatShader.code, new RegExp(`output\\.output0\\.y = \\(${floatValue} \\+ input\\.input0\\.y\\);`, "u"));

    const bitValue = /let (value\d+): u32 = select\(0u, 0xffffffffu,/u.exec(bitpatternShader.code)?.[1];
    assert(bitValue);
    assert.match(bitpatternShader.code, new RegExp(`output\\.output0\\.x = bitcast<f32>\\(${bitValue}\\);`, "u"));
    assert.match(bitpatternShader.code, new RegExp(`bitcast<f32>\\(${bitValue}\\) \\+ input\\.input0\\.y`, "u"));
});

test("fragment dot products consume exact lanes and replicate selected scalar sources", () =>
{
    const vector = CjsFormatWebgpu.buildWgsl(threeLaneDotFragmentFixture(false));
    const selected = CjsFormatWebgpu.buildWgsl(threeLaneDotFragmentFixture(true));

    assert.match(vector.code, /dot\(vec3<f32>\(value\d+\.x, value\d+\.y, value\d+\.z\),/u);
    assert.match(selected.code, /dot\(vec3<f32>\(value\d+\.x, value\d+\.x, value\d+\.x\),/u);
    assert.doesNotMatch(vector.code, /\.w/u);
});

test("fragment lowering maps direct and explicit tested discards with owned source locations", () =>
{
    const direct = CjsFormatWebgpu.buildWgsl(integerDiscardFragmentFixture(0));
    const explicit = CjsFormatWebgpu.buildWgsl(integerDiscardFragmentFixture(1, { explicitFlow: true }));

    assert.match(direct.code, /if \(value\d+ != 0u\)\n    \{\n        discard;\n    \}/);
    assert.match(explicit.code, /if \(value\d+ != 0u\)\n    \{\n        if \(0xffffffffu != 0u\)\n        \{\n            discard;\n        \}\n    \}/);

    const directDiscardMap = direct.sourceMap.filter((entry) => entry.dxbcOffset === 25);
    const explicitDiscardMap = explicit.sourceMap.filter((entry) => entry.dxbcOffset === 28);
    assert.equal(directDiscardMap.length, 1);
    assert.equal(explicitDiscardMap.length, 1);
    assert.match(direct.code.split("\n")[directDiscardMap[0].line - 1], /if \(value\d+ != 0u\)/);
    assert.match(explicit.code.split("\n")[explicitDiscardMap[0].line - 1], /if \(0xffffffffu != 0u\)/);
});

test("fragment lowering preserves discard_z zero projection", () =>
{
    const shader = CjsFormatWebgpu.buildWgsl(integerDiscardFragmentFixture(0, { projection: "zero" }));
    assert.match(shader.code, /if \(value\d+ == 0u\)\n    \{\n        discard;\n    \}/);
});

test("fragment lowering rejects malformed tested-discard metadata", () =>
{
    const cases = [
        (discard) => { discard.testBoolean = null; },
        (discard) => { discard.testBoolean = "either"; },
        (discard) => { discard.operands[0].modifierName = "neg"; },
        (discard) => { discard.saturate = true; },
        (discard) => { discard.operands[0] = immediate([ 0, 1 ]); }
    ];
    for (const mutate of cases)
    {
        const decoded = integerDiscardFragmentFixture();
        mutate(decoded.instructions.find((entry) => entry.opcodeName === "discard"));
        assert.throws(
            () => CjsFormatWebgpu.buildWgsl(decoded),
            /discard instruction \d+ (has no supported condition projection|cannot modify|cannot saturate|requires one scalar condition)/u
        );
    }
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

test("fragment fixed-width cbuffer sources use intrinsic lanes instead of destination lanes", () =>
{
    const decoded = fragmentFixture();
    const sample = decoded.instructions.find((entry) => entry.offset === 18);
    const coordinates = register("constant_buffer", 0, { swizzle: "xyzw" });
    coordinates.indices = [
        { values: [ 0 ], relative: null },
        { values: [ 0 ], relative: null }
    ];
    sample.operands[1] = coordinates;

    const shader = CjsFormatWebgpu.buildWgsl(decoded);
    assert.match(shader.code, /textureSample\(t0, s0, vec2<f32>\(cb0\[0\]\.x, cb0\[0\]\.y\)\)/u);
    assert.doesNotMatch(shader.code, /textureSample\(t0, s0, vec2<f32>\(cb0\[0\]\.y, cb0\[0\]\.z\)\)/u);
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
    [ "unresolved types", (ir, merge) => { merge.componentTypes[merge.writeMask] = "unknown"; }, /not a scalar float predecessor phi/i ],
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

test("fragment lowering emits a dynamic constant-buffer index", () =>
{
    const uintIndex = {
        semanticName: "TEXCOORD", semanticIndex: 0, systemValueType: 0,
        componentType: 1, componentTypeName: "uint32", registerIndex: 1,
        mask: 1, readWriteMask: 1, stream: 0, minPrecision: 0
    };
    const cbOperand = register("constant_buffer", 3, { swizzle: "xyzw" });
    cbOperand.indices = [
        { values: [ 3 ], relative: null },
        { values: [ 35 ], relative: register("input", 1, { selected: "x" }) }
    ];
    const program = {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: 0 },
        signatures: { input: [ uintIndex ], output: [ signature("SV_Target", 0, 15) ] },
        instructions: [
            globalFlagsDeclaration(),
            {
                offset: 2, opcode: 0, opcodeName: "dcl_constant_buffer", isDeclaration: true,
                declaration: { registerIndex: 3, accessPattern: "dynamic_indexed", sizeInVec4: 64 },
                operands: [ register("constant_buffer", 3) ]
            },
            {
                offset: 6, opcode: 0, opcodeName: "dcl_input_ps", isDeclaration: true,
                declaration: { registerIndex: 1, interpolationModeName: "linear" },
                operands: [ register("input", 1) ]
            },
            instruction(9, "mov", [ register("output", 0, { mask: "xyzw" }), cbOperand ]),
            instruction(13, "ret", [])
        ]
    };
    const shader = CjsFormatWebgpu.buildWgsl(program, { source: "synthetic-fragment-dynamic-cb" });
    assert.match(shader.code, /cb3\[35 \+ i32\(input\.input1\)\]\.x/u);
});

test("fragment lowering emits both sincos destinations and min", () =>
{
    const program = {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: 0 },
        signatures: { input: [ signature("TEXCOORD", 1, 1) ], output: [ signature("SV_Target", 0, 15) ] },
        instructions: [
            globalFlagsDeclaration(),
            {
                offset: 2, opcode: 0, opcodeName: "dcl_input_ps", isDeclaration: true,
                declaration: { registerIndex: 1, interpolationModeName: "linear" },
                operands: [ register("input", 1) ]
            },
            instruction(4, "sincos", [
                register("temp", 2, { mask: "x" }),
                register("temp", 3, { mask: "x" }),
                register("input", 1, { selected: "x" })
            ]),
            instruction(8, "min", [
                register("output", 0, { mask: "xyzw" }),
                register("temp", 2, { swizzle: "xxxx" }),
                register("temp", 3, { swizzle: "xxxx" })
            ]),
            instruction(12, "ret", [])
        ]
    };
    const shader = CjsFormatWebgpu.buildWgsl(program, { source: "synthetic-fragment-sincos" });
    assert.match(shader.code, /sin\(/u);
    assert.match(shader.code, /cos\(/u);
    assert.match(shader.code, /min\(/u);
});

test("fragment lowering samples a cube texture with a three-component coordinate", () =>
{
    const program = {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: 0 },
        signatures: { input: [ signature("TEXCOORD", 1, 7) ], output: [ signature("SV_Target", 0, 15) ] },
        instructions: [
            globalFlagsDeclaration(),
            declaration(2, "dcl_sampler", "sampler", { samplerModeName: "default" }),
            declaration(4, "dcl_resource", "resource", {
                resourceDimensionName: "texturecube",
                returnType: { returnTypeNames: [ "float", "float", "float", "float" ] }
            }),
            {
                offset: 6, opcode: 0, opcodeName: "dcl_input_ps", isDeclaration: true,
                declaration: { registerIndex: 1, interpolationModeName: "linear" },
                operands: [ register("input", 1) ]
            },
            instruction(9, "sample", [
                register("temp", 0, { mask: "xyzw" }),
                register("input", 1, { swizzle: "xyzx" }),
                register("resource", 0, { swizzle: "xyzw" }),
                register("sampler", 0)
            ]),
            instruction(14, "mov", [ register("output", 0, { mask: "xyzw" }), register("temp", 0, { swizzle: "xyzw" }) ]),
            instruction(18, "ret", [])
        ]
    };
    const shader = CjsFormatWebgpu.buildWgsl(program, { source: "synthetic-cube-sample" });
    const cube = shader.program.bindings.find((entry) => entry.resourceKind === "sampled-resource");
    assert.equal(cube.type, "texture_cube<f32>");
    assert.match(shader.code, /textureSample\([^,]+, [^,]+, vec3<f32>\(/u);
});

test("fragment lowering samples a 2d-array texture with a split coordinate and array index", () =>
{
    const program = {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: 0 },
        signatures: { input: [ signature("TEXCOORD", 1, 7) ], output: [ signature("SV_Target", 0, 15) ] },
        instructions: [
            globalFlagsDeclaration(),
            declaration(2, "dcl_sampler", "sampler", { samplerModeName: "default" }),
            declaration(4, "dcl_resource", "resource", {
                resourceDimensionName: "texture2darray",
                returnType: { returnTypeNames: [ "float", "float", "float", "float" ] }
            }),
            {
                offset: 6, opcode: 0, opcodeName: "dcl_input_ps", isDeclaration: true,
                declaration: { registerIndex: 1, interpolationModeName: "linear" },
                operands: [ register("input", 1) ]
            },
            instruction(9, "sample", [
                register("temp", 0, { mask: "xyzw" }),
                register("input", 1, { swizzle: "xyzx" }),
                register("resource", 0, { swizzle: "xyzw" }),
                register("sampler", 0)
            ]),
            instruction(14, "mov", [ register("output", 0, { mask: "xyzw" }), register("temp", 0, { swizzle: "xyzw" }) ]),
            instruction(18, "ret", [])
        ]
    };
    const shader = CjsFormatWebgpu.buildWgsl(program, { source: "synthetic-2d-array-sample" });
    const array = shader.program.bindings.find((entry) => entry.resourceKind === "sampled-resource");
    assert.equal(array.type, "texture_2d_array<f32>");
    assert.match(shader.code, /textureSample\(.*\.xy, i32\(.*\.z\)\)/u);
});

test("fragment lowering emits an if/else selection with a scalar float merge", () =>
{
    const program = {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: 0 },
        signatures: { input: [ signature("TEXCOORD", 1, 3) ], output: [ signature("SV_Target", 0, 15) ] },
        instructions: [
            globalFlagsDeclaration(),
            {
                offset: 2, opcode: 0, opcodeName: "dcl_input_ps", isDeclaration: true,
                declaration: { registerIndex: 1, interpolationModeName: "linear" },
                operands: [ register("input", 1) ]
            },
            instruction(5, "lt", [
                register("temp", 0, { mask: "x" }),
                register("input", 1, { selected: "x" }),
                register("input", 1, { selected: "y" })
            ]),
            { ...instruction(9, "if", [ register("temp", 0, { selected: "x" }) ]), testBoolean: "nonzero" },
            instruction(11, "add", [
                register("temp", 1, { mask: "x" }),
                register("input", 1, { selected: "x" }),
                register("input", 1, { selected: "x" })
            ]),
            instruction(15, "else", []),
            instruction(16, "mul", [
                register("temp", 1, { mask: "x" }),
                register("input", 1, { selected: "y" }),
                register("input", 1, { selected: "y" })
            ]),
            instruction(20, "endif", []),
            instruction(21, "mov", [ register("output", 0, { mask: "xyzw" }), register("temp", 1, { swizzle: "xxxx" }) ]),
            instruction(25, "ret", [])
        ]
    };
    const shader = CjsFormatWebgpu.buildWgsl(program, { source: "synthetic-fragment-else" });
    assert.match(shader.code, /var value\d+: f32 = 0\.0;/u);
    assert.match(shader.code, /\}\n    else\n    \{/u);
    assert.match(shader.code, /let (value\d+): f32 = \(input\.input1\.x \+ input\.input1\.x\);\n        value(\d+) = value\d+;/u);
    const assignments = shader.code.match(/value(\d+) = value\d+;/gu) || [];
    assert.equal(assignments.length, 2);
    assert.equal(assignments[0].split(" ")[0], assignments[1].split(" ")[0]);
});

test("fragment lowering emits resinfo and texel loads for 2d textures", () =>
{
    const program = {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: 0 },
        signatures: { input: [], output: [ signature("SV_Target", 0, 15) ] },
        instructions: [
            globalFlagsDeclaration(),
            declaration(2, "dcl_resource", "resource", {
                resourceDimensionName: "texture2d",
                returnType: { returnTypeNames: [ "float", "float", "float", "float" ] }
            }),
            { ...instruction(4, "resinfo", [
                register("temp", 0, { mask: "xy" }),
                immediate([ 0 ]),
                register("resource", 0, { swizzle: "xyzw" })
            ]), resinfoReturnTypeName: "uint" },
            instruction(8, "mov", [ register("temp", 1, { mask: "zw" }), immediate([ 0, 0, 0, 0 ]) ]),
            instruction(12, "mov", [ register("temp", 1, { mask: "xy" }), register("temp", 0, { swizzle: "xyxx" }) ]),
            instruction(16, "ld", [
                register("output", 0, { mask: "xyzw" }),
                register("temp", 1, { swizzle: "xyzw" }),
                register("resource", 0, { swizzle: "xyzw" })
            ]),
            instruction(21, "ret", [])
        ]
    };
    const shader = CjsFormatWebgpu.buildWgsl(program, { source: "synthetic-resinfo-ld" });
    assert.match(shader.code, /textureDimensions\(t0, 0\)/u);
    assert.match(shader.code, /textureLoad\(t0, .*\.xy, .*\.z\)/u);
});

test("fragment lowering emits a counted loop with carried phis and a conditional break", () =>
{
    const program = {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: 0 },
        signatures: { input: [], output: [ signature("SV_Target", 0, 15) ] },
        instructions: [
            globalFlagsDeclaration(),
            instruction(2, "mov", [ register("temp", 0, { mask: "x" }), immediate([ 0 ]) ]),
            instruction(6, "mov", [ register("temp", 1, { mask: "x" }), immediate([ 0 ]) ]),
            instruction(10, "loop", []),
            instruction(11, "ige", [
                register("temp", 2, { mask: "x" }),
                register("temp", 0, { selected: "x" }),
                immediate([ 4 ])
            ]),
            { ...instruction(15, "breakc", [ register("temp", 2, { selected: "x" }) ]), testBoolean: "nonzero" },
            instruction(17, "iadd", [
                register("temp", 1, { mask: "x" }),
                register("temp", 1, { selected: "x" }),
                register("temp", 0, { selected: "x" })
            ]),
            instruction(21, "iadd", [
                register("temp", 0, { mask: "x" }),
                register("temp", 0, { selected: "x" }),
                immediate([ 1 ])
            ]),
            instruction(25, "endloop", []),
            instruction(26, "itof", [ register("temp", 3, { mask: "x" }), register("temp", 1, { selected: "x" }) ]),
            instruction(30, "mov", [ register("output", 0, { mask: "xyzw" }), register("temp", 3, { swizzle: "xxxx" }) ]),
            instruction(34, "ret", [])
        ]
    };
    const shader = CjsFormatWebgpu.buildWgsl(program, { source: "synthetic-fragment-loop" });
    assert.match(shader.code, /loop\n    \{/u);
    assert.match(shader.code, /break;/u);
    const varCount = (shader.code.match(/var value\d+: i32 =/gu) || []).length;
    assert.equal(varCount, 2);
    const assignments = shader.code.match(/value\d+ = value\d+;/gu) || [];
    assert.ok(assignments.length >= 2);
});

test("fragment lowering splits a mixed-lane movc into per-component selects", () =>
{
    const program = {
        program: { programType: 0, programTypeName: "pixel", majorVersion: 5, minorVersion: 0 },
        signatures: { input: [ signature("TEXCOORD", 1, 3) ], output: [ signature("SV_Target", 0, 15) ] },
        instructions: [
            globalFlagsDeclaration(),
            {
                offset: 2, opcode: 0, opcodeName: "dcl_input_ps", isDeclaration: true,
                declaration: { registerIndex: 1, interpolationModeName: "linear" },
                operands: [ register("input", 1) ]
            },
            instruction(5, "lt", [
                register("temp", 0, { mask: "x" }),
                register("input", 1, { selected: "x" }),
                register("input", 1, { selected: "y" })
            ]),
            instruction(9, "lt", [
                register("temp", 1, { mask: "x" }),
                register("input", 1, { selected: "y" }),
                register("input", 1, { selected: "x" })
            ]),
            instruction(13, "add", [
                register("temp", 1, { mask: "y" }),
                register("input", 1, { selected: "x" }),
                register("input", 1, { selected: "y" })
            ]),
            instruction(17, "movc", [
                register("temp", 2, { mask: "xy" }),
                register("temp", 0, { swizzle: "xxxx" }),
                register("temp", 1, { swizzle: "xyxx" }),
                register("temp", 1, { swizzle: "xyxx" })
            ]),
            instruction(22, "and", [
                register("temp", 3, { mask: "x" }),
                register("temp", 2, { selected: "x" }),
                register("temp", 1, { selected: "x" })
            ]),
            instruction(26, "utof", [ register("temp", 4, { mask: "x" }), register("temp", 3, { selected: "x" }) ]),
            instruction(30, "add", [
                register("temp", 5, { mask: "x" }),
                register("temp", 4, { selected: "x" }),
                register("temp", 2, { selected: "y" })
            ]),
            instruction(34, "mov", [ register("output", 0, { mask: "xyzw" }), register("temp", 5, { swizzle: "xxxx" }) ]),
            instruction(38, "ret", [])
        ]
    };
    const shader = CjsFormatWebgpu.buildWgsl(program, { source: "synthetic-mixed-movc" });
    assert.match(shader.code, /let value\d+_x: u32 = select\(/u);
    assert.match(shader.code, /let value\d+_y: f32 = select\(/u);
});
