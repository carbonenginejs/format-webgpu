import { test } from "node:test";
import assert from "node:assert/strict";

import CjsFormatWebgpu from "../src/index.js";

function register(typeName, registerIndex, { mask = "", swizzle = "", selected = "", modifierName = "none" } = {})
{
    return {
        typeName,
        componentCount: 4,
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

function signature(semanticName, semanticIndex, registerIndex, mask, componentTypeName = "float32")
{
    const componentType = { uint32: 1, int32: 2, float32: 3 }[componentTypeName];
    return {
        semanticName,
        semanticIndex,
        systemValueType: semanticName.startsWith("SV_") ? 1 : 0,
        componentType,
        componentTypeName,
        registerIndex,
        mask,
        readWriteMask: mask,
        stream: 0,
        minPrecision: 0
    };
}

function structuredDeclaration(offset, minor, rangeId = null)
{
    const declaration = { registerIndex: 0, structureStride: 48 };
    const operand = register("resource", rangeId ?? 0);
    if (minor === 1)
    {
        declaration.bindingRange = {
            bindingModel: "sm5.1-range",
            rangeId,
            lowerBound: 0,
            upperBound: 0,
            unbounded: false,
            registerCount: 1,
            registerSpace: 0
        };
        operand.resourceReference = { bindingModel: "sm5.1-range", rangeId };
    }
    return {
        offset,
        opcode: 0,
        opcodeName: "dcl_resource_structured",
        isDeclaration: true,
        declaration,
        operands: [ operand ]
    };
}

function structuredResource(minor, swizzle, rangeId = null)
{
    const operand = register("resource", minor === 1 ? rangeId : 0, { swizzle });
    if (minor === 1) operand.resourceReference = { bindingModel: "sm5.1-range", rangeId };
    return operand;
}

function cbufferDeclaration(offset, registerIndex, sizeInVec4, rangeId = null)
{
    const declaration = { registerIndex, accessPattern: "immediate_indexed", sizeInVec4 };
    const operand = register("constant_buffer", rangeId ?? registerIndex);
    if (Number.isInteger(rangeId))
    {
        declaration.bindingRange = {
            bindingModel: "sm5.1-range",
            rangeId,
            lowerBound: registerIndex,
            upperBound: registerIndex,
            unbounded: false,
            registerCount: 1,
            registerSpace: 0
        };
        operand.resourceReference = { bindingModel: "sm5.1-range", rangeId };
    }
    return {
        offset,
        opcode: 0,
        opcodeName: "dcl_constant_buffer",
        isDeclaration: true,
        declaration,
        operands: [ operand ]
    };
}

function cbuffer(registerIndex, vectorIndex, swizzle, rangeId = null)
{
    const operand = register("constant_buffer", rangeId ?? registerIndex, { swizzle });
    operand.indices = Number.isInteger(rangeId)
        ? [
            { values: [ rangeId ], relative: null },
            { values: [ registerIndex ], relative: null },
            { values: [ vectorIndex ], relative: null }
        ]
        : [
            { values: [ registerIndex ], relative: null },
            { values: [ vectorIndex ], relative: null }
        ];
    if (Number.isInteger(rangeId)) operand.resourceReference = { bindingModel: "sm5.1-range", rangeId };
    return operand;
}

function instruction(offset, opcodeName, operands, values = {})
{
    return { offset, opcode: 0, opcodeName, isDeclaration: false, operands, ...values };
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

function arithmeticVertex(minor = 0)
{
    const range1 = minor === 1 ? 5 : null;
    const range3 = minor === 1 ? 7 : null;
    return {
        program: { programType: 1, programTypeName: "vertex", majorVersion: 5, minorVersion: minor },
        signatures: {
            input: [
                signature("POSITION", 0, 0, 15),
                signature("NORMAL", 0, 1, 7)
            ],
            output: [
                signature("SV_Position", 0, 0, 15),
                signature("TEXCOORD", 0, 1, 15)
            ]
        },
        instructions: [
            globalFlagsDeclaration(),
            cbufferDeclaration(2, 1, 4, range1),
            cbufferDeclaration(5, 3, 2, range3),
            instruction(8, "mov", [
                register("temp", 0, { mask: "xyzw" }),
                register("input", 0, { swizzle: "xyzw" })
            ]),
            instruction(12, "dp4", [
                register("temp", 1, { mask: "x" }),
                register("temp", 0, { swizzle: "xyzw" }),
                cbuffer(3, 0, "xyzw", range3)
            ]),
            instruction(17, "dp3", [
                register("temp", 1, { mask: "y" }),
                register("temp", 0, { swizzle: "xyzx" }),
                cbuffer(3, 1, "xyzx", range3)
            ], { saturate: true }),
            instruction(22, "add", [
                register("temp", 1, { mask: "z" }),
                register("temp", 1, { selected: "x" }),
                register("temp", 1, { selected: "y" })
            ]),
            instruction(26, "mul", [
                register("temp", 1, { mask: "w" }),
                register("temp", 1, { selected: "z" }),
                immediate([ 0x40000000 ])
            ]),
            instruction(30, "mad", [
                register("temp", 2, { mask: "xyz" }),
                register("temp", 0, { swizzle: "xyzx" }),
                immediate([ 0x3f800000, 0x3f800000, 0x3f800000, 0x3f800000 ]),
                cbuffer(1, 2, "xyzx", range1)
            ]),
            instruction(36, "rsq", [
                register("temp", 2, { mask: "w" }),
                register("temp", 1, { selected: "w" })
            ]),
            instruction(39, "log", [
                register("temp", 3, { mask: "x" }),
                register("temp", 2, { selected: "w" })
            ]),
            instruction(42, "exp", [
                register("temp", 3, { mask: "y" }),
                register("temp", 3, { selected: "x" })
            ]),
            instruction(45, "mov", [
                register("output", 0, { mask: "xy" }),
                register("temp", 1, { swizzle: "xyxx" })
            ]),
            instruction(49, "mov", [
                register("output", 0, { mask: "zw" }),
                register("temp", 1, { swizzle: "zwxx" })
            ]),
            instruction(53, "mov", [
                register("output", 1, { mask: "xyz" }),
                register("temp", 2, { swizzle: "xyzx" })
            ]),
            instruction(57, "mov", [
                register("output", 1, { mask: "w" }),
                register("temp", 3, { selected: "y" })
            ]),
            instruction(61, "ret", [])
        ]
    };
}

function packedMathVertex(minor = 0)
{
    const zero = immediate([ 0, 0, 0, 0 ]);
    return {
        program: { programType: 1, programTypeName: "vertex", majorVersion: 5, minorVersion: minor },
        signatures: {
            input: [ signature("POSITION", 0, 0, 15) ],
            output: [
                signature("SV_Position", 0, 0, 15),
                signature("TEXCOORD", 0, 1, 15)
            ]
        },
        instructions: [
            globalFlagsDeclaration(),
            instruction(2, "sincos", [
                register("temp", 0, { mask: "xyzw" }),
                register("temp", 1, { mask: "xyzw" }),
                register("input", 0, { swizzle: "xyzw" })
            ]),
            instruction(7, "lt", [
                register("temp", 2, { mask: "xy" }),
                zero,
                register("temp", 1, { swizzle: "ywyy" })
            ]),
            instruction(12, "and", [
                register("temp", 2, { mask: "x" }),
                register("temp", 2, { selected: "y" }),
                register("temp", 2, { selected: "x" })
            ]),
            instruction(16, "movc", [
                register("temp", 3, { mask: "xyz" }),
                register("temp", 2, { swizzle: "xxxx" }),
                register("temp", 0, { swizzle: "xyzx" }),
                register("temp", 0, { swizzle: "xyzx", modifierName: "neg" })
            ]),
            instruction(22, "mov", [
                register("output", 0, { mask: "xyzw" }),
                register("temp", 1, { swizzle: "xyzw" })
            ]),
            instruction(26, "mov", [
                register("output", 1, { mask: "xyz" }),
                register("temp", 3, { swizzle: "xyzx" })
            ]),
            instruction(30, "mov", [
                register("output", 1, { mask: "w" }),
                register("temp", 0, { selected: "w" })
            ]),
            instruction(34, "ret", [])
        ]
    };
}

function structuredSkinningVertex(minor = 0, { precise = false, swizzle = "xzyw", mask = "xyzw" } = {})
{
    const cbRange = minor === 1 ? 7 : null;
    const resourceRange = minor === 1 ? 9 : null;
    const controls = (preciseMask) => precise ? { preciseMask } : {};
    return {
        program: { programType: 1, programTypeName: "vertex", majorVersion: 5, minorVersion: minor },
        signatures: {
            input: [ signature("BLENDINDICES", 0, 1, 15, "uint32") ],
            output: [ signature("SV_Position", 0, 0, 15) ]
        },
        instructions: [
            globalFlagsDeclaration(),
            cbufferDeclaration(2, 3, 27, cbRange),
            structuredDeclaration(6, minor, resourceRange),
            instruction(10, "iadd", [
                register("temp", 0, { mask: "x" }),
                register("input", 1, { selected: "x" }),
                cbuffer(3, 26, "xxxx", cbRange)
            ], controls("x")),
            instruction(16, "ld_structured", [
                register("temp", 1, { mask }),
                register("temp", 0, { selected: "x" }),
                immediate([ 16 ]),
                structuredResource(minor, swizzle, resourceRange)
            ], controls(mask)),
            instruction(22, "mov", [
                register("output", 0, { mask }),
                register("temp", 1, { swizzle: "xyzw" })
            ], controls(mask)),
            ...(mask === "xyzw" ? [] : [
                instruction(26, "mov", [
                    register("output", 0, { mask: Array.from("xyzw").filter((entry) => !mask.includes(entry)).join("") }),
                    immediate([ 0, 0, 0, 0 ])
                ])
            ]),
            instruction(30, "ret", [])
        ]
    };
}

function dualIndexStructuredVertex()
{
    return {
        program: { programType: 1, programTypeName: "vertex", majorVersion: 5, minorVersion: 0 },
        signatures: {
            input: [ signature("BLENDINDICES", 0, 1, 15, "uint32") ],
            output: [ signature("SV_Position", 0, 0, 15) ]
        },
        instructions: [
            globalFlagsDeclaration(),
            cbufferDeclaration(2, 3, 27),
            structuredDeclaration(6, 0),
            instruction(10, "iadd", [
                register("temp", 0, { mask: "xy" }),
                register("input", 1, { swizzle: "xyxx" }),
                cbuffer(3, 26, "xyxx")
            ]),
            instruction(16, "ld_structured", [
                register("temp", 1, { mask: "xyzw" }),
                register("temp", 0, { selected: "x" }),
                immediate([ 0 ]),
                structuredResource(0, "xyzw")
            ]),
            instruction(22, "ld_structured", [
                register("temp", 2, { mask: "xyzw" }),
                register("temp", 0, { selected: "y" }),
                immediate([ 16 ]),
                structuredResource(0, "xyzw")
            ]),
            instruction(28, "add", [
                register("output", 0, { mask: "xyzw" }),
                register("temp", 1, { swizzle: "xyzw" }),
                register("temp", 2, { swizzle: "xyzw" })
            ]),
            instruction(34, "ret", [])
        ]
    };
}

test("vertex lowering emits the bounded arithmetic and uniform-buffer slice", () =>
{
    const shader = CjsFormatWebgpu.buildWgsl(arithmeticVertex(), { source: "synthetic-arithmetic-vs" });

    assert.equal(shader.stage, "vertex");
    assert.deepEqual(shader.program.bindings.map((entry) => ({
        symbol: entry.generatedSymbol,
        registerIndex: entry.registerIndex,
        size: entry.buffer.minBindingSize
    })), [
        { symbol: "cb1", registerIndex: 1, size: 64 },
        { symbol: "cb3", registerIndex: 3, size: 32 }
    ]);
    assert.match(shader.code, /@location\(0\) input0: vec4<f32>/u);
    assert.doesNotMatch(shader.code, /@location\(1\) input1/u);
    assert.match(shader.code, /dot\(vec4<f32>\([^\n]+\), vec4<f32>\(cb3\[0\]\.x, cb3\[0\]\.y, cb3\[0\]\.z, cb3\[0\]\.w\)\)/u);
    assert.match(shader.code, /clamp\(dot\(vec3<f32>\([^\n]+\), vec3<f32>\(cb3\[1\]\.x, cb3\[1\]\.y, cb3\[1\]\.z\)\), 0\.0, 1\.0\)/u);
    assert.match(shader.code, /bitcast<f32>\(0x40000000u\)/u);
    assert.match(shader.code, /inverseSqrt\(/u);
    assert.match(shader.code, /log2\(/u);
    assert.match(shader.code, /exp2\(/u);
    assert.equal(shader.program.statements.at(-1).kind, "return");
});

test("SM5.0 registers and SM5.1 ranges emit the same arithmetic vertex WGSL", () =>
{
    const dx11 = CjsFormatWebgpu.buildWgsl(arithmeticVertex(0));
    const dx12 = CjsFormatWebgpu.buildWgsl(arithmeticVertex(1));

    assert.equal(dx12.code, dx11.code);
    assert.deepEqual(
        dx12.program.bindings.map((entry) => [ entry.generatedSymbol, entry.registerIndex ]),
        [ [ "cb1", 1 ], [ "cb3", 3 ] ]
    );
});

test("packed vertex lowering emits paired sincos results and the complete mask-selection chain", () =>
{
    const shader = CjsFormatWebgpu.buildWgsl(packedMathVertex());
    const sincosStatements = shader.program.statements.filter((entry) => entry.dxbcOffset === 2);
    const sincosMappings = shader.sourceMap.filter((entry) => entry.dxbcOffset === 2);

    assert.equal(sincosStatements.length, 2);
    assert.deepEqual(sincosStatements.map((entry) => entry.kind), [ "let", "let" ]);
    assert.match(sincosStatements[0].expression.code, /^sin\(vec4<f32>\(/u);
    assert.match(sincosStatements[1].expression.code, /^cos\(vec4<f32>\(/u);
    assert.equal(sincosMappings.length, 2);
    assert.match(shader.code, /select\(vec2<u32>\(0u\), vec2<u32>\(0xffffffffu\), [^\n]+ < [^\n]+\)/u);
    assert.match(shader.code, /let value\d+: u32 = \(value\d+\.y & value\d+\.x\);/u);
    assert.match(shader.code, /select\(vec3<f32>\(-\([^\n]+\), -\([^\n]+\), -\([^\n]+\)\), vec3<f32>\([^\n]+\), vec3<u32>\([^\n]+\) != vec3<u32>\(0u\)\)/u);
});

test("SM5.0 and SM5.1 packed vertex math emit identical WGSL", () =>
{
    assert.equal(
        CjsFormatWebgpu.buildWgsl(packedMathVertex(1)).code,
        CjsFormatWebgpu.buildWgsl(packedMathVertex(0)).code
    );
});

test("structured skinning lowers signed indices and typeless SRV words for SM5.0 and SM5.1", () =>
{
    const dx11 = CjsFormatWebgpu.buildWgsl(structuredSkinningVertex(0));
    const dx12 = CjsFormatWebgpu.buildWgsl(structuredSkinningVertex(1));
    const structured = dx11.program.bindings.find((entry) => entry.generatedSymbol === "t0");

    assert.equal(dx12.code, dx11.code);
    assert.equal(structured.declaration, "var<storage, read>");
    assert.equal(structured.type, "array<u32>");
    assert.equal(structured.structureStride, 48);
    assert.deepEqual(structured.buffer, {
        type: "read-only-storage",
        hasDynamicOffset: false,
        minBindingSize: 48
    });
    assert.match(dx11.code, /let (value\d+): u32 = bitcast<u32>\(\(bitcast<i32>\(input\.input1\.x\) \+ bitcast<i32>\(cb3\[26\]\.x\)\)\);/u);
    const index = /let (value\d+): u32 = bitcast<u32>/u.exec(dx11.code)?.[1];
    assert(index);
    assert.match(dx11.code, new RegExp(`bitcast<f32>\\(t0\\[\\(\\(${index}\\) \\* 12u\\) \\+ 4u\\]\\)`, "u"));
    assert.match(dx11.code, new RegExp(`bitcast<f32>\\(t0\\[\\(\\(${index}\\) \\* 12u\\) \\+ 6u\\]\\)`, "u"));
    assert.match(dx11.code, new RegExp(`bitcast<f32>\\(t0\\[\\(\\(${index}\\) \\* 12u\\) \\+ 5u\\]\\)`, "u"));
});

test("structured skinning applies source swizzles before partial destination masks", () =>
{
    const shader = CjsFormatWebgpu.buildWgsl(structuredSkinningVertex(0, { mask: "x", swizzle: "zzzz" }));

    assert.match(shader.code, /let value\d+: f32 = bitcast<f32>\(t0\[\(\(value\d+\) \* 12u\) \+ 6u\]\);/u);
});

test("structured skinning requires complete vector result reinterpretation metadata", () =>
{
    const ir = structuredClone(CjsFormatWebgpu.buildShaderIr(dualIndexStructuredVertex()));
    const iadd = ir.instructions.find((entry) => entry.opcodeName === "iadd");
    const shader = CjsFormatWebgpu.buildWgsl(ir);

    assert.equal(iadd.typeInfo.bitcasts.filter((entry) => entry.kind === "result-bitcast").length, 2);
    assert.match(shader.code, /let value\d+: vec2<u32> = bitcast<vec2<u32>>\(\(vec2<i32>\(/u);

    const missing = structuredClone(ir);
    const records = missing.instructions.find((entry) => entry.opcodeName === "iadd").typeInfo.bitcasts;
    records.splice(records.findIndex((entry) => entry.kind === "result-bitcast"), 1);
    assert.throws(() => CjsFormatWebgpu.buildWgsl(missing), /inconsistent register bitcast metadata/u);
});

test("structured skinning accepts only vacuous precise integer and bit-transport operations", () =>
{
    const decoded = structuredSkinningVertex(0, { precise: true });
    const shader = CjsFormatWebgpu.buildWgsl(decoded);
    assert.match(shader.code, /let value\d+: u32 = bitcast<u32>\(\(bitcast<i32>/u);
    assert.match(shader.code, /var<storage, read> t0: array<u32>/u);

    const partial = structuredClone(CjsFormatWebgpu.buildShaderIr(decoded));
    partial.instructions.find((entry) => entry.opcodeName === "ld_structured").preciseMask = "xz";
    assert.match(CjsFormatWebgpu.buildWgsl(partial).code, /bitcast<f32>\(t0\[/u);

    assert.throws(
        () => CjsFormatWebgpu.buildWgsl(decoded, { precisionPolicy: "relaxed" }),
        /precisionPolicy is not supported/u
    );
});

test("precise floating arithmetic remains a strict WGSL portability boundary", () =>
{
    const decoded = arithmeticVertex();
    decoded.instructions.find((entry) => entry.opcodeName === "dp4").preciseMask = "x";
    assert.throws(
        () => CjsFormatWebgpu.buildWgsl(decoded),
        /precise dp4 mask x requires no-refactoring controls unavailable in WGSL/u
    );
});

test("precise metadata rejects malformed masks, unrelated lanes, and arithmetic modifiers", () =>
{
    const malformed = structuredSkinningVertex(0, { precise: true });
    malformed.instructions.find((entry) => entry.opcodeName === "iadd").preciseMask = "zx";
    assert.throws(() => CjsFormatWebgpu.buildShaderIr(malformed), /invalid precise component mask/u);

    const unrelated = structuredSkinningVertex(0, { precise: true });
    unrelated.instructions.find((entry) => entry.opcodeName === "iadd").preciseMask = "y";
    assert.throws(
        () => CjsFormatWebgpu.buildWgsl(unrelated),
        /requires one destination write containing every precise lane/u
    );

    const modified = structuredSkinningVertex(0, { precise: true });
    modified.instructions.find((entry) => entry.opcodeName === "mov").operands[1].modifierName = "neg";
    assert.throws(
        () => CjsFormatWebgpu.buildWgsl(modified),
        /requires unsaturated, unmodified operands/u
    );

    const direct = structuredClone(CjsFormatWebgpu.buildShaderIr(structuredSkinningVertex()));
    direct.instructions.find((entry) => entry.opcodeName === "mov").preciseMask = null;
    assert.throws(() => CjsFormatWebgpu.buildWgsl(direct), /malformed component mask null/u);
});

test("WGSL lowering requires consistent DXBC refactoring controls", () =>
{
    const absent = structuredSkinningVertex();
    absent.instructions = absent.instructions.filter((entry) => entry.opcodeName !== "dcl_global_flags");
    assert.throws(() => CjsFormatWebgpu.buildWgsl(absent), /requires exactly one dcl_global_flags/u);

    const disabled = structuredSkinningVertex();
    Object.assign(disabled.instructions[0].declaration, { globalFlags: 0, refactoringAllowed: false });
    assert.throws(() => CjsFormatWebgpu.buildWgsl(disabled), /disables refactoring globally/u);

    const duplicate = structuredSkinningVertex();
    duplicate.instructions.push(globalFlagsDeclaration());
    assert.throws(() => CjsFormatWebgpu.buildWgsl(duplicate), /requires exactly one dcl_global_flags/u);

    const inconsistent = structuredSkinningVertex();
    inconsistent.instructions[0].declaration.globalFlags = 0;
    assert.throws(() => CjsFormatWebgpu.buildWgsl(inconsistent), /inconsistent dcl_global_flags metadata/u);
});

test("structured skinning rejects minimum precision on every operand role", () =>
{
    for (const operandIndex of [ 0, 2 ])
    {
        const decoded = structuredSkinningVertex();
        const load = decoded.instructions.find((entry) => entry.opcodeName === "ld_structured");
        load.operands[operandIndex].minPrecisionName = operandIndex === 0 ? "min16_float" : "min16_uint";
        assert.throws(() => CjsFormatWebgpu.buildWgsl(decoded), /uses minimum precision/u);
    }
});

test("packed vertex sincos rejects malformed multi-result metadata", () =>
{
    const ir = structuredClone(CjsFormatWebgpu.buildShaderIr(packedMathVertex()));
    const sincos = ir.instructions.find((entry) => entry.opcodeName === "sincos");
    sincos.dataflow.writes.push({ ...structuredClone(sincos.dataflow.writes[0]), valueId: sincos.dataflow.writes[1].valueId });
    assert.throws(() => CjsFormatWebgpu.buildWgsl(ir), /sincos instruction \d+ has unsupported result writes/u);
});

test("packed vertex sincos rejects independently masked destination lanes", () =>
{
    const ir = structuredClone(CjsFormatWebgpu.buildShaderIr(packedMathVertex()));
    const sincos = ir.instructions.find((entry) => entry.opcodeName === "sincos");
    sincos.dataflow.writes[0].mask = "z";
    sincos.dataflow.writes[1].mask = "x";

    assert.throws(() => CjsFormatWebgpu.buildWgsl(ir), /requires matching destination masks/u);
});

test("BuildWgsl applies an explicit pass-global binding plan", () =>
{
    const ir = CjsFormatWebgpu.buildShaderIr(arithmeticVertex());
    const plan = structuredClone(CjsFormatWebgpu.buildWgslBindingPlan([ ir ]));
    plan.bindings.forEach((entry) => { entry.binding += 3; });
    const shader = CjsFormatWebgpu.buildWgsl(ir, { bindingPlan: plan });

    assert.match(shader.code, /@group\(0\) @binding\(3\) var<uniform> cb1/u);
    assert.match(shader.code, /@group\(0\) @binding\(4\) var<uniform> cb3/u);
});

test("vertex dot products replicate scalar results across multi-lane destinations", () =>
{
    const decoded = arithmeticVertex();
    const dot = decoded.instructions.find((entry) => entry.opcodeName === "dp3");
    dot.operands[0].mask = "yz";
    dot.saturate = false;
    const shader = CjsFormatWebgpu.buildWgsl(decoded);

    assert.match(shader.code, /let value\d+: vec2<f32> = vec2<f32>\(dot\(/u);
});

test("vertex dot products broadcast selected register components", () =>
{
    const decoded = arithmeticVertex();
    const dot = decoded.instructions.find((entry) => entry.opcodeName === "dp3");
    dot.operands[1] = register("temp", 0, { selected: "x" });
    const shader = CjsFormatWebgpu.buildWgsl(decoded);

    assert.match(shader.code, /dot\(vec3<f32>\(value\d+\.x, value\d+\.x, value\d+\.x\)/u);
});

test("unreachable instructions do not add live vertex inputs", () =>
{
    const decoded = arithmeticVertex();
    decoded.instructions.push(instruction(64, "mov", [
        register("temp", 4, { mask: "x" }),
        register("input", 1, { selected: "x" })
    ]));
    const shader = CjsFormatWebgpu.buildWgsl(decoded);

    assert.doesNotMatch(shader.code, /@location\(1\) input1/u);
});

test("vertex lowering materializes output writes that are read later", () =>
{
    const decoded = arithmeticVertex();
    const outputWrite = decoded.instructions.findIndex((entry) =>
        entry.opcodeName === "mov" && entry.operands[0]?.typeName === "output");
    decoded.instructions.splice(outputWrite + 1, 0, instruction(47, "mov", [
        register("temp", 4, { mask: "x" }),
        register("output", 0, { selected: "x" })
    ]));
    const shader = CjsFormatWebgpu.buildWgsl(decoded);
    const assignmentIndex = shader.program.statements.findIndex((entry) =>
        entry.kind === "assignment" && entry.target.fieldId === "output:r0");
    const materialized = shader.program.statements[assignmentIndex - 1];
    const readback = shader.program.statements[assignmentIndex + 1];

    assert.equal(materialized.kind, "let");
    assert.equal(shader.program.statements[assignmentIndex].expression.code, materialized.name);
    assert.equal(readback.kind, "let");
    assert.match(readback.expression.code, new RegExp(`^${materialized.name}\\.x$`, "u"));
    assert.match(shader.code, new RegExp(`let ${materialized.name}: vec2<f32>`, "u"));
});

test("vertex lowering rejects a malformed relative cbuffer index and inconsistent reinterpretation metadata", () =>
{
    const relative = arithmeticVertex();
    relative.instructions.find((entry) => entry.opcodeName === "dp4").operands[2].indices[1].relative = {
        typeName: "temp",
        registerIndex: 9
    };
    assert.throws(() => CjsFormatWebgpu.buildWgsl(relative), /relative index requires one scalar component/u);

    const ir = structuredClone(CjsFormatWebgpu.buildShaderIr(arithmeticVertex()));
    ir.instructions.find((entry) => entry.opcodeName === "mov").typeInfo.bitcasts.push({ kind: "read-bitcast" });
    assert.throws(() => CjsFormatWebgpu.buildWgsl(ir), /inconsistent register bitcast metadata/u);
});

function dynamicCbufferDeclaration(offset, registerIndex, sizeInVec4)
{
    const declaration = cbufferDeclaration(offset, registerIndex, sizeInVec4);
    declaration.declaration.accessPattern = "dynamic_indexed";
    return declaration;
}

function dynamicCbuffer(registerIndex, base, swizzle, relative)
{
    const operand = register("constant_buffer", registerIndex, { swizzle });
    operand.indices = [
        { values: [ registerIndex ], relative: null },
        { values: [ base ], relative }
    ];
    return operand;
}

function dynamicIndexVertex()
{
    return {
        program: { programType: 1, programTypeName: "vertex", majorVersion: 5, minorVersion: 0 },
        signatures: {
            input: [ signature("BLENDINDICES", 0, 1, 1, "uint32") ],
            output: [ signature("SV_Position", 0, 0, 15) ]
        },
        instructions: [
            globalFlagsDeclaration(),
            dynamicCbufferDeclaration(2, 3, 64),
            instruction(6, "mov", [
                register("output", 0, { mask: "xyzw" }),
                dynamicCbuffer(3, 35, "xyzw", register("input", 1, { selected: "x" }))
            ]),
            instruction(10, "ret", [])
        ]
    };
}

test("vertex lowering emits a dynamic constant-buffer index and accepts the dynamic_indexed layout", () =>
{
    const shader = CjsFormatWebgpu.buildWgsl(dynamicIndexVertex(), { source: "synthetic-dynamic-cb" });
    assert.match(shader.code, /cb3\[35 \+ i32\(input\.input1\)\]\.x/u);
    const binding = shader.program.bindings.find((entry) => entry.generatedSymbol === "cb3");
    assert.equal(binding.type, "array<vec4<f32>, 64>");
    assert.equal(binding.buffer.type, "uniform");
});

test("vertex lowering rejects dynamic constant-buffer register selection", () =>
{
    const program = dynamicIndexVertex();
    const operand = program.instructions.find((entry) => entry.opcodeName === "mov").operands[1];
    operand.indices[0].relative = register("input", 1, { selected: "x" });
    assert.throws(() => CjsFormatWebgpu.buildWgsl(program), /dynamic cbuffer register selection/u);
});

test("vertex lowering emits unsigned and signed integer-to-float conversions", () =>
{
    const program = {
        program: { programType: 1, programTypeName: "vertex", majorVersion: 5, minorVersion: 0 },
        signatures: {
            input: [ signature("BLENDINDICES", 0, 1, 1, "uint32") ],
            output: [ signature("SV_Position", 0, 0, 15) ]
        },
        instructions: [
            globalFlagsDeclaration(),
            instruction(2, "utof", [
                register("temp", 0, { mask: "x" }),
                register("input", 1, { selected: "x" })
            ]),
            instruction(6, "mov", [
                register("output", 0, { mask: "xyzw" }),
                register("temp", 0, { swizzle: "xxxx" })
            ]),
            instruction(10, "ret", [])
        ]
    };
    const shader = CjsFormatWebgpu.buildWgsl(program, { source: "synthetic-utof" });
    assert.match(shader.code, /f32\(input\.input1\)/u);
});

test("vertex lowering emits max, min, sqrt, and div", () =>
{
    const program = {
        program: { programType: 1, programTypeName: "vertex", majorVersion: 5, minorVersion: 0 },
        signatures: {
            input: [ signature("POSITION", 0, 0, 15) ],
            output: [ signature("SV_Position", 0, 0, 15) ]
        },
        instructions: [
            globalFlagsDeclaration(),
            instruction(2, "mov", [ register("temp", 0, { mask: "xyzw" }), register("input", 0, { swizzle: "xyzw" }) ]),
            instruction(6, "max", [ register("temp", 1, { mask: "x" }), register("temp", 0, { selected: "x" }), register("temp", 0, { selected: "y" }) ]),
            instruction(10, "min", [ register("temp", 1, { mask: "y" }), register("temp", 0, { selected: "z" }), register("temp", 0, { selected: "w" }) ]),
            instruction(14, "sqrt", [ register("temp", 1, { mask: "z" }), register("temp", 0, { selected: "x" }) ]),
            instruction(18, "div", [ register("temp", 1, { mask: "w" }), register("temp", 0, { selected: "x" }), register("temp", 0, { selected: "y" }) ]),
            instruction(22, "mov", [ register("output", 0, { mask: "xyzw" }), register("temp", 1, { swizzle: "xyzw" }) ]),
            instruction(26, "ret", [])
        ]
    };
    const shader = CjsFormatWebgpu.buildWgsl(program, { source: "synthetic-vertex-alu" });
    assert.match(shader.code, /max\(/u);
    assert.match(shader.code, /min\(/u);
    assert.match(shader.code, /sqrt\(/u);
    assert.match(shader.code, /\/ /u);
});

test("vertex lowering exposes SV_VertexID as the vertex_index builtin", () =>
{
    const program = {
        program: { programType: 1, programTypeName: "vertex", majorVersion: 5, minorVersion: 0 },
        signatures: {
            input: [ signature("SV_VertexID", 0, 0, 1, "uint32") ],
            output: [ signature("SV_Position", 0, 0, 15) ]
        },
        instructions: [
            globalFlagsDeclaration(),
            instruction(2, "utof", [ register("temp", 0, { mask: "x" }), register("input", 0, { selected: "x" }) ]),
            instruction(6, "mov", [ register("output", 0, { mask: "xyzw" }), register("temp", 0, { swizzle: "xxxx" }) ]),
            instruction(10, "ret", [])
        ]
    };
    const shader = CjsFormatWebgpu.buildWgsl(program, { source: "synthetic-vertexid" });
    assert.match(shader.code, /@builtin\(vertex_index\)/u);
    assert.match(shader.code, /f32\(input\.vertex_index\)/u);
});

test("vertex lowering handles a pure-relative constant-buffer index (implicit base 0)", () =>
{
    const cb = register("constant_buffer", 3, { swizzle: "xyzw" });
    cb.indices = [
        { values: [ 3 ], relative: null },
        { values: [], relative: register("input", 1, { selected: "x" }) }
    ];
    const program = {
        program: { programType: 1, programTypeName: "vertex", majorVersion: 5, minorVersion: 0 },
        signatures: {
            input: [ signature("BLENDINDICES", 0, 1, 1, "uint32") ],
            output: [ signature("SV_Position", 0, 0, 15) ]
        },
        instructions: [
            globalFlagsDeclaration(),
            dynamicCbufferDeclaration(2, 3, 64),
            instruction(6, "mov", [ register("output", 0, { mask: "xyzw" }), cb ]),
            instruction(10, "ret", [])
        ]
    };
    const shader = CjsFormatWebgpu.buildWgsl(program, { source: "synthetic-pure-relative-cb" });
    assert.match(shader.code, /cb3\[i32\(input\.input1\)\]\.x/u);
});

test("vertex lowering emits an if/else selection with a scalar float merge", () =>
{
    const program = {
        program: { programType: 1, programTypeName: "vertex", majorVersion: 5, minorVersion: 0 },
        signatures: {
            input: [ signature("POSITION", 0, 0, 3) ],
            output: [ signature("SV_Position", 0, 0, 15) ]
        },
        instructions: [
            globalFlagsDeclaration(),
            instruction(2, "lt", [
                register("temp", 0, { mask: "x" }),
                register("input", 0, { selected: "x" }),
                register("input", 0, { selected: "y" })
            ]),
            { ...instruction(6, "if", [ register("temp", 0, { selected: "x" }) ]), testBoolean: "nonzero" },
            instruction(8, "add", [
                register("temp", 1, { mask: "x" }),
                register("input", 0, { selected: "x" }),
                register("input", 0, { selected: "x" })
            ]),
            instruction(12, "else", []),
            instruction(13, "mul", [
                register("temp", 1, { mask: "x" }),
                register("input", 0, { selected: "y" }),
                register("input", 0, { selected: "y" })
            ]),
            instruction(17, "endif", []),
            instruction(18, "mov", [ register("output", 0, { mask: "xyzw" }), register("temp", 1, { swizzle: "xxxx" }) ]),
            instruction(22, "ret", [])
        ]
    };
    const shader = CjsFormatWebgpu.buildWgsl(program, { source: "synthetic-vertex-else" });
    assert.match(shader.code, /var value\d+: f32 = 0\.0;/u);
    assert.match(shader.code, /\}\n    else\n    \{/u);
    const assignments = shader.code.match(/value(\d+) = value\d+;/gu) || [];
    assert.equal(assignments.length, 2);
    assert.equal(assignments[0].split(" ")[0], assignments[1].split(" ")[0]);
});

test("vertex lowering emits a switch with grouped selectors and an N-way merge", () =>
{
    const selector = (value) => ({
        ...register("immediate32", null, {}),
        immediateValues: [ { uint32: value, float32: 0 } ]
    });
    const program = {
        program: { programType: 1, programTypeName: "vertex", majorVersion: 5, minorVersion: 0 },
        signatures: {
            input: [ signature("POSITION", 0, 0, 3, "uint32") ],
            output: [ signature("SV_Position", 0, 0, 15) ]
        },
        instructions: [
            globalFlagsDeclaration(),
            instruction(2, "switch", [ register("input", 0, { selected: "x" }) ]),
            instruction(4, "case", [ selector(0) ]),
            instruction(6, "case", [ selector(3) ]),
            instruction(8, "utof", [ register("temp", 0, { mask: "x" }), register("input", 0, { selected: "y" }) ]),
            instruction(12, "break", []),
            instruction(13, "default", []),
            instruction(15, "utof", [ register("temp", 1, { mask: "x" }), register("input", 0, { selected: "x" }) ]),
            instruction(19, "add", [ register("temp", 0, { mask: "x" }), register("temp", 1, { selected: "x" }), register("temp", 1, { selected: "x" }) ]),
            instruction(23, "break", []),
            instruction(24, "endswitch", []),
            instruction(25, "mov", [ register("output", 0, { mask: "xyzw" }), register("temp", 0, { swizzle: "xxxx" }) ]),
            instruction(29, "ret", [])
        ]
    };
    const shader = CjsFormatWebgpu.buildWgsl(program, { source: "synthetic-vertex-switch" });
    assert.match(shader.code, /switch \(input\.input0\.x\)/u);
    assert.match(shader.code, /case 0u, 3u:/u);
    assert.match(shader.code, /default:/u);
    assert.match(shader.code, /var value\d+: f32 = 0\.0;/u);
    const assignments = shader.code.match(/value(\d+) = value\d+(?:\.[xyzw])?;/gu) || [];
    assert.equal(assignments.length, 2);
});

test("vertex switch merges accept a pass-through incoming for clauses that keep the prior value", () =>
{
    const selector = (value) => ({
        ...register("immediate32", null, {}),
        immediateValues: [ { uint32: value, float32: 0 } ]
    });
    const program = {
        program: { programType: 1, programTypeName: "vertex", majorVersion: 5, minorVersion: 0 },
        signatures: {
            input: [ signature("POSITION", 0, 0, 3, "uint32") ],
            output: [ signature("SV_Position", 0, 0, 15) ]
        },
        instructions: [
            globalFlagsDeclaration(),
            instruction(2, "utof", [ register("temp", 0, { mask: "x" }), register("input", 0, { selected: "y" }) ]),
            instruction(6, "switch", [ register("input", 0, { selected: "x" }) ]),
            instruction(8, "case", [ selector(1) ]),
            instruction(10, "utof", [ register("temp", 0, { mask: "x" }), register("input", 0, { selected: "x" }) ]),
            instruction(14, "break", []),
            instruction(15, "default", []),
            instruction(17, "break", []),
            instruction(18, "endswitch", []),
            instruction(19, "mov", [ register("output", 0, { mask: "xyzw" }), register("temp", 0, { swizzle: "xxxx" }) ]),
            instruction(23, "ret", [])
        ]
    };
    const shader = CjsFormatWebgpu.buildWgsl(program, { source: "synthetic-switch-passthrough" });
    assert.match(shader.code, /switch \(input\.input0\.x\)/u);
    const assignments = shader.code.match(/value\d+ = value\d+;/gu) || [];
    assert.equal(assignments.length, 2);
});
