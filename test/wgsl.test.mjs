import { test } from "node:test";
import assert from "node:assert/strict";

import CjsFormatWebgpu from "../src/index.js";

function register(typeName, registerIndex, mask = "", swizzle = "")
{
    return {
        typeName,
        componentCount: 4,
        mask,
        swizzle,
        selected: "",
        modifierName: "none",
        minPrecisionName: "default",
        registerIndex,
        indices: [ { values: [ registerIndex ], relative: null } ]
    };
}

function signature(semanticName, registerIndex, mask, readWriteMask)
{
    return {
        semanticName,
        semanticIndex: 0,
        systemValueType: semanticName === "SV_Position" ? 1 : 0,
        componentType: 3,
        componentTypeName: "float32",
        registerIndex,
        mask,
        readWriteMask,
        stream: 0,
        minPrecision: 0
    };
}

function copyblitVertex(minor = 0, includeTexcoordMove = true)
{
    const instructions = [ {
        offset: 16,
        opcode: 54,
        opcodeName: "mov",
        isDeclaration: false,
        operands: [ register("output", 0, "xyzw"), register("input", 0, "", "xyzw") ]
    } ];
    if (includeTexcoordMove)
    {
        instructions.push({
            offset: 21,
            opcode: 54,
            opcodeName: "mov",
            isDeclaration: false,
            operands: [ register("output", 1, "xy"), register("input", 1, "", "xyxx") ]
        });
    }
    instructions.push({ offset: 26, opcode: 62, opcodeName: "ret", isDeclaration: false, operands: [] });
    return {
        program: { programType: 1, programTypeName: "vertex", majorVersion: 5, minorVersion: minor },
        signatures: {
            input: [
                signature("POSITION", 0, 15, 15),
                signature("TEXCOORD", 1, 3, 3)
            ],
            output: [
                signature("SV_Position", 0, 15, 0),
                signature("TEXCOORD", 1, 3, 12)
            ]
        },
        instructions
    };
}

const EXPECTED_WGSL = `struct VertexInput
{
    @location(0) input0: vec4<f32>,
    @location(1) input1: vec2<f32>,
};

struct VertexOutput
{
    @builtin(position) position: vec4<f32>,
    @location(1) output1: vec2<f32>,
};

@vertex
fn main(input: VertexInput) -> VertexOutput
{
    var output: VertexOutput;
    output.position = input.input0;
    output.output1 = input.input1;
    return output;
}
`;

test("BuildWgsl emits deterministic mov-only copyblit vertex WGSL", () =>
{
    const ir = CjsFormatWebgpu.buildShaderIr(copyblitVertex(), { source: "synthetic-copyblit-vs" });
    const shader = CjsFormatWebgpu.buildWgsl(ir);

    assert.equal(shader.kind, "wgsl-shader");
    assert.equal(shader.stage, "vertex");
    assert.equal(shader.entryPoint, "main");
    assert.equal(shader.code, EXPECTED_WGSL);
    assert.deepEqual(shader.sourceMap, [
        { line: 17, instructionIndex: 0, dxbcOffset: 16 },
        { line: 18, instructionIndex: 1, dxbcOffset: 21 },
        { line: 19, instructionIndex: 2, dxbcOffset: 26 }
    ]);
    assert.equal(shader.program.statements[1].expression.components.join(""), "xy");
    assert.equal(Object.isFrozen(shader), true);
    assert.deepEqual(CjsFormatWebgpu.buildWgsl(ir), shader);
});

test("DX11 and DX12 copyblit vertex descriptions emit identical WGSL", () =>
{
    assert.equal(
        CjsFormatWebgpu.buildWgsl(copyblitVertex(0)).code,
        CjsFormatWebgpu.buildWgsl(copyblitVertex(1)).code
    );
});

test("BuildWgsl requires every signature-declared output lane", () =>
{
    assert.throws(
        () => CjsFormatWebgpu.buildWgsl(copyblitVertex(0, false)),
        /output TEXCOORD0 leaves xy unwritten/i
    );
});

test("BuildWgsl rejects unsupported reachable vertex operations", () =>
{
    const decoded = copyblitVertex();
    decoded.instructions[0] = {
        ...decoded.instructions[0],
        opcode: 0,
        opcodeName: "add",
        operands: [
            register("output", 0, "xyzw"),
            register("input", 0, "", "xyzw"),
            register("input", 0, "", "xyzw")
        ]
    };
    assert.throws(() => CjsFormatWebgpu.buildWgsl(decoded), /opcode add.*not supported/i);
});

test("generated WGSL descriptors round-trip through a CEWGPU WGSL chunk", () =>
{
    const shader = CjsFormatWebgpu.buildWgsl(copyblitVertex());
    const bytes = CjsFormatWebgpu.build([ [ "WGSL", {
        format: "CJS_WGSL_SET",
        formatVersion: 1,
        shaders: [ { key: "Main.pass0.vertex", stage: shader.stage, entryPoint: shader.entryPoint, code: shader.code } ]
    } ] ]);
    const pkg = CjsFormatWebgpu.read(bytes);

    assert.equal(pkg.shaders.length, 1);
    assert.equal(pkg.shaders[0].entryPoint, "main");
    assert.equal(pkg.shaders[0].code, EXPECTED_WGSL);
});
