import { test } from "node:test";
import assert from "node:assert/strict";

import CjsFormatWebgpu from "../src/index.js";
import { lowerComputeProgram } from "../src/core/wgsl/lowerComputeProgram.js";

function register(typeName, registerIndex, {
    componentCount = 4,
    mask = "",
    swizzle = "",
    selected = ""
} = {})
{
    return {
        typeName,
        componentCount,
        mask,
        swizzle,
        selected,
        modifierName: "none",
        minPrecisionName: "default",
        nonUniform: false,
        registerIndex,
        indices: Number.isInteger(registerIndex)
            ? [ { values: [ registerIndex ], relative: null } ]
            : [],
        immediateValues: []
    };
}

function immediate(bits)
{
    return {
        ...register("immediate32", null, { componentCount: bits.length }),
        immediateValues: bits.map((uint32) => ({ uint32, float32: 0 }))
    };
}

function replicated(value)
{
    return immediate([ value, value, value, value ]);
}

function declaration(offset, opcodeName, data, operand = null)
{
    return {
        offset,
        opcode: 0,
        opcodeName,
        isDeclaration: true,
        declaration: data,
        operands: operand ? [ operand ] : []
    };
}

function instruction(offset, opcodeName, operands, values = {})
{
    return {
        offset,
        opcode: 0,
        opcodeName,
        isDeclaration: false,
        operands,
        ...values
    };
}

function typedReturn(typeName)
{
    const value = { sint: 3, uint: 4, float: 5 }[typeName];
    return {
        returnTypes: [ value, value, value, value ],
        returnTypeNames: [ typeName, typeName, typeName, typeName ]
    };
}

function load(offset, destinationLane)
{
    return instruction(offset, "ld", [
        register("temp", 0, { mask: destinationLane }),
        replicated(1),
        register("resource", 0, { swizzle: "xyzw" })
    ], {
        extensions: [
            {
                typeName: "resource_dimension",
                resourceDimensionName: "buffer",
                structureStride: 0
            },
            {
                typeName: "resource_return_type",
                resourceReturnTypes: [ 3, 3, 3, 3 ]
            }
        ]
    });
}

function store(offset, address, source)
{
    return instruction(offset, "store_uav_typed", [
        register("uav", 0, { mask: "xyzw" }),
        replicated(address),
        source
    ]);
}

function computeFixture(instructions)
{
    return {
        program: {
            programType: 5,
            programTypeName: "compute",
            majorVersion: 5,
            minorVersion: 0
        },
        signatures: { input: [], output: [], patch: [] },
        instructions: [
            declaration(2, "dcl_global_flags", {
                globalFlags: 1 << 11,
                refactoringAllowed: true
            }),
            declaration(3, "dcl_resource", {
                resourceDimensionName: "buffer",
                sampleCount: 0,
                returnType: typedReturn("sint"),
                registerIndex: 0
            }, register("resource", 0, { componentCount: 0 })),
            declaration(7, "dcl_unordered_access_view_typed", {
                resourceDimensionName: "buffer",
                globallyCoherent: false,
                returnType: typedReturn("uint"),
                registerIndex: 0
            }, register("uav", 0, { componentCount: 0 })),
            declaration(11, "dcl_temps", { tempCount: 1 }),
            declaration(13, "dcl_thread_group", {
                threadGroupX: 1,
                threadGroupY: 1,
                threadGroupZ: 1
            }),
            ...instructions
        ]
    };
}

function setDrawParametersFixture()
{
    return computeFixture([
        load(17, "x"),
        instruction(29, "imul", [
            register("null", null, { componentCount: 0 }),
            register("temp", 0, { mask: "x" }),
            register("temp", 0, { selected: "x" }),
            immediate([ 6 ])
        ]),
        store(37, 0, register("temp", 0, { swizzle: "xxxx" })),
        store(47, 1, replicated(1)),
        store(60, 2, replicated(0)),
        store(73, 3, replicated(0)),
        instruction(86, "ret", [])
    ]);
}

function setSortArgsFixture()
{
    return computeFixture([
        load(17, "x"),
        instruction(29, "umax", [
            register("temp", 0, { mask: "y" }),
            register("temp", 0, { selected: "x" }),
            immediate([ 1 ])
        ]),
        instruction(36, "iadd", [
            register("temp", 0, { mask: "y" }),
            register("temp", 0, { selected: "y" }),
            immediate([ 0xffffffff ])
        ]),
        instruction(43, "ushr", [
            register("temp", 0, { mask: "y" }),
            register("temp", 0, { selected: "y" }),
            immediate([ 9 ])
        ]),
        instruction(50, "iadd", [
            register("temp", 0, { mask: "y" }),
            register("temp", 0, { selected: "y" }),
            immediate([ 1 ])
        ]),
        store(57, 0, register("temp", 0, { swizzle: "yyyy" })),
        store(67, 1, replicated(1)),
        store(80, 2, replicated(1)),
        store(93, 3, register("temp", 0, { swizzle: "xxxx" })),
        instruction(103, "ret", [])
    ]);
}

function lower(fixture, source)
{
    const ir = CjsFormatWebgpu.buildShaderIr(fixture, { source });
    return { ir, typed: lowerComputeProgram(ir) };
}

function skinDestination(registerIndex, mask)
{
    return register("temp", registerIndex, { mask });
}

function skinTemp(registerIndex, selector)
{
    return register("temp", registerIndex, selector.length === 1
        ? { selected: selector }
        : { swizzle: selector });
}

function skinConstantBuffer(rowIndex, selector)
{
    const operand = register("constant_buffer", 3, selector.length === 1
        ? { selected: selector }
        : { swizzle: selector });
    operand.indices = [
        { values: [ 3 ], relative: null },
        { values: [ rowIndex ], relative: null }
    ];
    return operand;
}

function skinThreadId(selector)
{
    return register("input_thread_id", null, selector.length === 1
        ? { selected: selector }
        : { swizzle: selector });
}

function skinResource(registerIndex, swizzle)
{
    return register("resource", registerIndex, { swizzle });
}

function skinLoad(offset, destinationRegister, destinationMask,
    addressRegister, addressLane, byteOffset, resourceIndex, swizzle)
{
    const structureStride = resourceIndex === 0 ? 48 : 4;
    return instruction(offset, "ld_structured", [
        skinDestination(destinationRegister, destinationMask),
        skinTemp(addressRegister, addressLane),
        immediate([ byteOffset ]),
        skinResource(resourceIndex, swizzle)
    ], {
        extensions: [
            {
                type: 2,
                typeName: "resource_dimension",
                resourceDimension: 12,
                resourceDimensionName: "structured_buffer",
                structureStride
            },
            {
                type: 3,
                typeName: "resource_return_type",
                resourceReturnTypes: [ 6, 6, 6, 6 ]
            }
        ]
    });
}

function skinOp(offset, opcodeName, destinationRegister, destinationMask, ...sources)
{
    return instruction(offset, opcodeName, [
        skinDestination(destinationRegister, destinationMask),
        ...sources
    ]);
}

function skinVerticesFixture()
{
    const cbDeclaration = register("constant_buffer", 3, { swizzle: "xyzw" });
    cbDeclaration.indices = [
        { values: [ 3 ], relative: null },
        { values: [ 3 ], relative: null }
    ];
    return {
        program: {
            programType: 5,
            programTypeName: "compute",
            majorVersion: 5,
            minorVersion: 0
        },
        signatures: { input: [], output: [], patch: [] },
        instructions: [
            declaration(2, "dcl_global_flags", {
                globalFlags: 1 << 11,
                refactoringAllowed: true
            }),
            declaration(3, "dcl_constant_buffer", {
                accessPattern: "immediate_indexed",
                registerIndex: 3,
                sizeInVec4: 3
            }, cbDeclaration),
            declaration(7, "dcl_resource_structured", {
                structureStride: 48,
                registerIndex: 0
            }, register("resource", 0, { componentCount: 0 })),
            declaration(11, "dcl_resource_structured", {
                structureStride: 4,
                registerIndex: 1
            }, register("resource", 1, { componentCount: 0 })),
            declaration(15, "dcl_unordered_access_view_structured", {
                globallyCoherent: false,
                structureStride: 4,
                registerIndex: 0
            }, register("uav", 0, { componentCount: 0 })),
            declaration(19, "dcl_input", {
                registerIndex: null,
                operandType: 32,
                operandTypeName: "input_thread_id"
            }, register("input_thread_id", null, { mask: "x" })),
            declaration(21, "dcl_temps", { tempCount: 10 }),
            declaration(23, "dcl_thread_group", {
                threadGroupX: 64,
                threadGroupY: 1,
                threadGroupZ: 1
            }),
            skinOp(27, "ult", 0, "x",
                skinThreadId("x"), skinConstantBuffer(0, "x")),
            instruction(34, "if", [ skinTemp(0, "x") ], { testBoolean: "nonzero" }),
            skinOp(37, "imad", 0, "xy",
                skinThreadId("xxxx"),
                skinConstantBuffer(0, "yyyy"),
                skinConstantBuffer(0, "zwzz")),
            skinLoad(47, 1, "x", 0, "x", 0, 1, "xxxx"),
            skinOp(58, "iadd", 0, "xz", skinTemp(0, "xxxx"), immediate([ 1, 0, 2, 0 ])),
            skinLoad(68, 1, "y", 0, "x", 0, 1, "xxxx"),
            skinLoad(79, 1, "z", 0, "z", 0, 1, "xxxx"),
            skinLoad(90, 0, "x", 0, "y", 0, 1, "xxxx"),
            skinOp(101, "ine", 0, "y", skinConstantBuffer(1, "x"), immediate([ 0xffffffff ])),
            instruction(109, "if", [ skinTemp(0, "y") ], { testBoolean: "nonzero" }),
            skinOp(112, "and", 0, "y", skinTemp(0, "x"), immediate([ 255 ])),
            skinOp(119, "ubfe", 0, "zw",
                immediate([ 0, 0, 8, 8 ]),
                immediate([ 0, 0, 8, 16 ]),
                skinTemp(0, "xxxx")),
            skinOp(134, "ushr", 2, "x", skinTemp(0, "x"), immediate([ 24 ])),
            skinOp(141, "imad", 2, "y",
                skinThreadId("x"), skinConstantBuffer(0, "y"), skinConstantBuffer(1, "x")),
            skinLoad(151, 2, "y", 2, "y", 0, 1, "xxxx"),
            skinOp(162, "and", 2, "z", skinTemp(2, "y"), immediate([ 255 ])),
            skinOp(169, "ubfe", 3, "xy",
                immediate([ 8, 8, 0, 0 ]),
                immediate([ 8, 16, 0, 0 ]),
                skinTemp(2, "yyyy")),
            skinOp(184, "ushr", 2, "y", skinTemp(2, "y"), immediate([ 24 ])),
            skinOp(191, "utof", 4, "yz", skinTemp(3, "xxyx")),
            skinOp(196, "utof", 4, "xw", skinTemp(2, "zzzy")),
            skinOp(201, "mul", 3, "xyzw",
                skinTemp(4, "xyzw"), immediate([ 998277249, 998277249, 998277249, 998277249 ])),
            skinOp(211, "iadd", 0, "y", skinTemp(0, "y"), skinConstantBuffer(1, "y")),
            skinLoad(219, 4, "xyzw", 0, "y", 0, 0, "xyzw"),
            skinLoad(230, 5, "xyzw", 0, "y", 16, 0, "xyzw"),
            skinLoad(241, 6, "xyzw", 0, "y", 32, 0, "xyzw"),
            skinOp(252, "iadd", 0, "yz", skinTemp(0, "zzwz"), skinConstantBuffer(1, "yyyy")),
            skinLoad(260, 7, "xyzw", 0, "y", 0, 0, "xyzw"),
            skinLoad(271, 8, "xyzw", 0, "y", 16, 0, "xyzw"),
            skinLoad(282, 9, "xyzw", 0, "y", 32, 0, "xyzw"),
            skinOp(293, "mul", 7, "xyzw", skinTemp(3, "yyyy"), skinTemp(7, "xyzw")),
            skinOp(300, "mul", 8, "xyzw", skinTemp(3, "yyyy"), skinTemp(8, "xyzw")),
            skinOp(307, "mul", 9, "xyzw", skinTemp(3, "yyyy"), skinTemp(9, "xyzw")),
            skinOp(314, "mad", 4, "xyzw",
                skinTemp(4, "xyzw"), skinTemp(3, "xxxx"), skinTemp(7, "xyzw")),
            skinOp(323, "mad", 5, "xyzw",
                skinTemp(5, "xyzw"), skinTemp(3, "xxxx"), skinTemp(8, "xyzw")),
            skinOp(332, "mad", 6, "xyzw",
                skinTemp(6, "xyzw"), skinTemp(3, "xxxx"), skinTemp(9, "xyzw")),
            skinLoad(341, 7, "xyzw", 0, "z", 0, 0, "xyzw"),
            skinLoad(352, 8, "xyzw", 0, "z", 16, 0, "xyzw"),
            skinLoad(363, 9, "xyzw", 0, "z", 32, 0, "xyzw"),
            skinOp(374, "mad", 4, "xyzw",
                skinTemp(7, "xyzw"), skinTemp(3, "zzzz"), skinTemp(4, "xyzw")),
            skinOp(383, "mad", 5, "xyzw",
                skinTemp(8, "xyzw"), skinTemp(3, "zzzz"), skinTemp(5, "xyzw")),
            skinOp(392, "mad", 6, "xyzw",
                skinTemp(9, "xyzw"), skinTemp(3, "zzzz"), skinTemp(6, "xyzw")),
            skinOp(401, "iadd", 0, "y", skinTemp(2, "x"), skinConstantBuffer(1, "y")),
            skinLoad(409, 2, "xyzw", 0, "y", 0, 0, "xyzw"),
            skinLoad(420, 7, "xyzw", 0, "y", 16, 0, "xyzw"),
            skinLoad(431, 8, "xyzw", 0, "y", 32, 0, "xyzw"),
            skinOp(442, "mad", 2, "xyzw",
                skinTemp(2, "xyzw"), skinTemp(3, "wwww"), skinTemp(4, "xyzw")),
            skinOp(451, "mad", 4, "xyzw",
                skinTemp(7, "xyzw"), skinTemp(3, "wwww"), skinTemp(5, "xyzw")),
            skinOp(460, "mad", 3, "xyzw",
                skinTemp(8, "xyzw"), skinTemp(3, "wwww"), skinTemp(6, "xyzw")),
            instruction(469, "else", []),
            skinOp(470, "and", 0, "x", skinTemp(0, "x"), immediate([ 255 ])),
            skinOp(477, "iadd", 0, "x", skinTemp(0, "x"), skinConstantBuffer(1, "y")),
            skinLoad(485, 2, "xyzw", 0, "x", 0, 0, "xyzw"),
            skinLoad(496, 4, "xyzw", 0, "x", 16, 0, "xyzw"),
            skinLoad(507, 3, "xyzw", 0, "x", 32, 0, "xyzw"),
            instruction(518, "endif", []),
            skinOp(519, "mov", 1, "w", immediate([ 1065353216 ])),
            skinOp(524, "dp4", 0, "x", skinTemp(1, "xyzw"), skinTemp(2, "xyzw")),
            skinOp(531, "dp4", 0, "y", skinTemp(1, "xyzw"), skinTemp(4, "xyzw")),
            skinOp(538, "dp4", 0, "z", skinTemp(1, "xyzw"), skinTemp(3, "xyzw")),
            skinOp(545, "imad", 0, "w",
                skinThreadId("x"), immediate([ 3 ]), skinConstantBuffer(2, "x")),
            instruction(554, "store_structured", [
                register("uav", 0, { mask: "x" }),
                skinTemp(0, "w"),
                immediate([ 0 ]),
                skinTemp(0, "x")
            ]),
            skinOp(563, "iadd", 1, "xy", skinTemp(0, "wwww"), immediate([ 1, 2, 0, 0 ])),
            instruction(573, "store_structured", [
                register("uav", 0, { mask: "x" }),
                skinTemp(1, "x"),
                immediate([ 0 ]),
                skinTemp(0, "y")
            ]),
            instruction(582, "store_structured", [
                register("uav", 0, { mask: "x" }),
                skinTemp(1, "y"),
                immediate([ 0 ]),
                skinTemp(0, "z")
            ]),
            instruction(591, "endif", []),
            instruction(592, "ret", [])
        ]
    };
}

function skinVerticesIr()
{
    return CjsFormatWebgpu.buildShaderIr(skinVerticesFixture(), {
        source: "synthetic-skinvertices-compute"
    });
}

test("compute lowering emits the bounded SkinVertices structured-buffer profile", () =>
{
    const ir = skinVerticesIr();
    const typed = lowerComputeProgram(ir);
    assert.equal(typed.stage, "compute");
    assert.deepEqual(typed.threadGroupSize, [ 64, 1, 1 ]);
    assert.deepEqual(typed.builtinInputs, [ {
        builtin: "global_invocation_id",
        name: "dispatch_thread_id",
        type: "vec3<u32>"
    } ]);
    assert.deepEqual(typed.bindings.map((binding) => ({
        symbol: binding.generatedSymbol,
        type: binding.type,
        stride: binding.structureStride ?? null,
        bufferType: binding.buffer.type,
        minBindingSize: binding.buffer.minBindingSize
    })), [
        { symbol: "cb3", type: "array<vec4<f32>, 3>", stride: null, bufferType: "uniform", minBindingSize: 48 },
        { symbol: "t0", type: "array<u32>", stride: 48, bufferType: "read-only-storage", minBindingSize: 48 },
        { symbol: "t1", type: "array<u32>", stride: 4, bufferType: "read-only-storage", minBindingSize: 4 },
        { symbol: "u0", type: "array<u32>", stride: 4, bufferType: "storage", minBindingSize: 4 }
    ]);

    assert.deepEqual(typed.statements.slice(0, 10).map((statement) => statement.kind),
        Array(10).fill("var"));
    const outer = typed.statements[11];
    assert.equal(outer.kind, "if");
    assert.match(typed.statements[10].expression.code, /dispatch_thread_id\.x/u);
    const serialized = JSON.stringify(outer);
    assert.match(serialized, /arrayLength\(&t0\) \/ 12u/u);
    assert.match(serialized, /arrayLength\(&t1\) \/ 1u/u);
    assert.equal((serialized.match(/arrayLength\(&u0\)/gu) || []).length, 3);

    const shader = CjsFormatWebgpu.buildWgsl(ir);
    assert.match(shader.code,
        /fn main\(@builtin\(global_invocation_id\) dispatch_thread_id: vec3<u32>\)/u);
    assert.match(shader.code, /@compute @workgroup_size\(64, 1, 1\)/u);
    assert.equal((shader.code.match(/< arrayLength\(&u0\)/gu) || []).length, 3);
    for (const dxbcOffset of [ 554, 573, 582 ])
    {
        assert.ok(shader.sourceMap.some((entry) => entry.dxbcOffset === dxbcOffset));
    }
});

test("SkinVertices compute profile fails closed on declaration, body, and metadata tampering", () =>
{
    const mutate = (callback) =>
    {
        const ir = structuredClone(skinVerticesIr());
        callback(ir);
        return ir;
    };

    assert.throws(() => lowerComputeProgram(mutate((ir) =>
    {
        ir.declarations.at(-1).data.threadGroupX = 63;
    })), /dcl_thread_group 64,1,1/u);
    assert.throws(() => lowerComputeProgram(mutate((ir) =>
    {
        ir.declarations[5].operands[0].mask = "y";
    })), /exactly input_thread_id\.x/u);
    assert.throws(() => lowerComputeProgram(mutate((ir) =>
    {
        ir.declarations[2].data.structureStride = 44;
    })), /resource0 stride 48/u);
    assert.throws(() => lowerComputeProgram(mutate((ir) =>
    {
        ir.declarations[4].data.globallyCoherent = true;
    })), /uav0 stride 4/u);

    for (const callback of [
        (ir) => { ir.instructions[0].opcodeName = "uge"; },
        (ir) => { ir.instructions[9].operands[0].selected = "x"; },
        (ir) => { ir.instructions[11].operands[1].immediateValues[2].uint32 = 7; },
        (ir) => { ir.instructions[11].operands[2].immediateValues[3].uint32 = 8; },
        (ir) => { ir.instructions[3].operands[2].immediateValues[0].uint32 = 4; },
        (ir) =>
        {
            ir.instructions[3].operands[3].registerIndex = 0;
            ir.instructions[3].operands[3].indices[0].values[0] = 0;
        },
        (ir) => { ir.instructions[3].operands[3].swizzle = "xyzw"; },
        (ir) => { ir.instructions[60].operands[0].mask = "xy"; },
        (ir) => { ir.instructions[60].operands[2].immediateValues[0].uint32 = 4; },
        (ir) =>
        {
            [ ir.instructions[60], ir.instructions[63] ] =
                [ ir.instructions[63], ir.instructions[60] ];
        }
    ])
    {
        assert.throws(() => lowerComputeProgram(mutate(callback)),
            /exact bounded body opcode and operand sequence/u);
    }

    assert.throws(() => lowerComputeProgram(mutate((ir) =>
    {
        ir.instructions[3].extensions[0].structureStride = 8;
    })), /inconsistent envelope metadata/u);
    assert.throws(() => lowerComputeProgram(mutate((ir) =>
    {
        ir.instructions[3].extensions[1].resourceReturnTypes[0] = 5;
    })), /inconsistent envelope metadata/u);
    assert.throws(() => lowerComputeProgram(mutate((ir) =>
    {
        ir.instructions[11].typeInfo.rule = "integer";
    })), /CFG, SSA, or type metadata is inconsistent/u);
    assert.throws(() => lowerComputeProgram(mutate((ir) =>
    {
        const undefinedValue = ir.values.find((value) => value.origin === "undefined-register");
        assert.ok(undefinedValue);
        ir.instructions[2].dataflow.reads[0].refs[0].valueId = undefinedValue.id;
    })), /CFG, SSA, or type metadata is inconsistent/u);
    assert.throws(() => lowerComputeProgram(mutate((ir) =>
    {
        ir.controlFlow.regions[0].endInstruction -= 1;
    })), /CFG, SSA, or type metadata is inconsistent/u);
});

test("SkinVertices compute profile validates raw structured binding fingerprints", () =>
{
    const ir = skinVerticesIr();
    const typed = lowerComputeProgram(ir);
    const plan = {
        format: "CJS_WGSL_BINDING_PLAN",
        formatVersion: 2,
        bindings: typed.bindings.map((binding) => ({
            identity: binding.identity,
            scopeIdentity: binding.scopeIdentity,
            stages: [ "compute" ],
            resourceKind: binding.resourceKind,
            generatedSymbol: binding.generatedSymbol,
            registerSpace: binding.registerSpace,
            registerIndex: binding.registerIndex,
            type: binding.type,
            structureStride: binding.structureStride ?? null,
            buffer: binding.buffer,
            texture: binding.texture ?? null,
            sampler: binding.sampler ?? null,
            group: binding.group,
            binding: binding.binding
        }))
    };
    assert.deepEqual(lowerComputeProgram(ir, { bindingPlan: plan }).bindings
        .map((binding) => binding.binding), [ 0, 1, 2, 3 ]);

    const wrongPlan = structuredClone(plan);
    wrongPlan.bindings[3].type = "array<atomic<u32>>";
    assert.throws(() => lowerComputeProgram(ir, { bindingPlan: wrongPlan }),
        /invalid entry|does not match/u);

    const wrongStride = structuredClone(ir);
    wrongStride.bindings.find((binding) =>
        binding.resourceKind === "storage-resource").structureStride = 8;
    assert.throws(() => lowerComputeProgram(wrongStride), /binding layout does not match/u);

    const typedMetadata = structuredClone(ir);
    typedMetadata.bindings.find((binding) =>
        binding.resourceKind === "storage-resource").returnType = {
        returnTypeNames: [ "uint", "uint", "uint", "uint" ]
    };
    assert.throws(() => lowerComputeProgram(typedMetadata), /unexpected typed-resource metadata/u);
});

test("compute lowering scalarizes setdrawparameters typed buffers with guarded zero/drop semantics", () =>
{
    const { ir, typed } = lower(setDrawParametersFixture(), "synthetic-setdrawparameters");
    assert.equal(typed.format, "CJS_TYPED_SHADER");
    assert.equal(typed.stage, "compute");
    assert.equal(typed.entryPoint, "main");
    assert.deepEqual(typed.threadGroupSize, [ 1, 1, 1 ]);
    assert.equal("interface" in typed, false);
    const shader = CjsFormatWebgpu.buildWgsl(ir);
    assert.equal(shader.stage, "compute");
    assert.deepEqual(shader.threadGroupSize, [ 1, 1, 1 ]);
    assert.match(shader.code, /@compute @workgroup_size\(1, 1, 1\)\nfn main\(\)\n\{/u);
    assert.doesNotMatch(shader.code, /(?:Compute|Vertex|Fragment)(?:Input|Output)/u);
    assert.match(shader.code, /\n    return;\n\}\n$/u);
    assert.deepEqual(typed.bindings.map((binding) => ({
        symbol: binding.generatedSymbol,
        declaration: binding.declaration,
        type: binding.type,
        visibility: binding.visibility,
        buffer: binding.buffer
    })), [
        {
            symbol: "t0",
            declaration: "var<storage, read>",
            type: "array<i32>",
            visibility: "compute",
            buffer: { type: "read-only-storage", hasDynamicOffset: false, minBindingSize: 4 }
        },
        {
            symbol: "u0",
            declaration: "var<storage, read_write>",
            type: "array<atomic<u32>>",
            visibility: "compute",
            buffer: { type: "storage", hasDynamicOffset: false, minBindingSize: 4 }
        }
    ]);

    assert.equal(typed.statements[0].kind, "let");
    assert.match(
        typed.statements[0].expression.code,
        /select\(0i, t0\[min\(0x00000001u, arrayLength\(&t0\) - 1u\)\], 0x00000001u < arrayLength\(&t0\)\)/u);
    assert.match(typed.statements[1].expression.code, /bitcast<u32>\(\(value3 \* bitcast<i32>\(0x00000006u\)\)\)/u);
    for (const statement of typed.statements.slice(2, 6))
    {
        assert.equal(statement.kind, "if");
        assert.match(statement.condition.code, /0x0000000[0-3]u < arrayLength\(&u0\)/u);
        assert.match(statement.statements[0].expression.code, /^atomicStore\(&u0\[/u);
    }
    assert.equal(typed.statements.at(-1).kind, "return");

    const storeType = ir.instructions[2].typeInfo;
    assert.equal(storeType.rule, "typed-uav-store");
    assert.equal(storeType.operandTypes[1].expectedType, "uint32");
    assert.equal(storeType.operandTypes[2].expectedType, "uint32");
    assert.ok(storeType.bitcasts.some((entry) =>
        entry.kind === "read-bitcast"
        && entry.from === "bitpattern32"
        && entry.to === "uint32"));
});

test("compute lowering preserves setSortArgs signed/unsigned reinterpretation metadata", () =>
{
    const { ir, typed } = lower(setSortArgsFixture(), "synthetic-setsortargs");
    assert.deepEqual(typed.statements.map((statement) => statement.kind), [
        "let", "let", "let", "let", "let",
        "if", "if", "if", "if", "return"
    ]);
    assert.match(typed.statements[0].expression.code, /^bitcast<u32>\(select\(0i,/u);
    assert.equal(typed.statements[1].expression.code, "max(value3, 0x00000001u)");
    assert.match(typed.statements[2].expression.code, /bitcast<u32>\(\(bitcast<i32>\(value4\) \+ bitcast<i32>\(0xffffffffu\)\)\)/u);
    assert.equal(typed.statements[3].expression.code, "(value5 >> 0x00000009u)");
    assert.match(typed.statements[4].expression.code, /bitcast<u32>\(\(bitcast<i32>\(value6\) \+ bitcast<i32>\(0x00000001u\)\)\)/u);
    assert.equal(typed.statements[5].statements[0].expression.code, "atomicStore(&u0[0x00000000u], value7)");
    assert.equal(typed.statements[8].statements[0].expression.code, "atomicStore(&u0[0x00000003u], value3)");

    const stores = ir.instructions.filter((instruction) => instruction.opcodeName === "store_uav_typed");
    assert.ok(stores.every((instruction) =>
        instruction.typeInfo.rule === "typed-uav-store"
        && instruction.typeInfo.operandTypes[1].expectedType === "uint32"
        && instruction.typeInfo.operandTypes[2].expectedType === "uint32"));
});

test("compute lowering fails closed on declaration, operand, SSA, and type-metadata tampering", () =>
{
    const base = CjsFormatWebgpu.buildShaderIr(
        setSortArgsFixture(), { source: "synthetic-compute-tamper" });

    const badGroup = structuredClone(base);
    badGroup.declarations.find((entry) => entry.opcodeName === "dcl_thread_group")
        .data.threadGroupX = 2;
    assert.throws(() => lowerComputeProgram(badGroup), /dcl_thread_group 1,1,1/u);

    const badAddress = structuredClone(base);
    badAddress.instructions[5].operands[1].immediateValues[3].uint32 = 7;
    assert.throws(() => lowerComputeProgram(badAddress), /four replicated immediate lanes/u);

    const nonScalarLoadFixture = setDrawParametersFixture();
    nonScalarLoadFixture.instructions[5].operands[0].mask = "y";
    nonScalarLoadFixture.instructions[6].operands[2].selected = "y";
    const nonScalarLoad = CjsFormatWebgpu.buildShaderIr(
        nonScalarLoadFixture, { source: "synthetic-compute-non-scalar-load" });
    assert.throws(() => lowerComputeProgram(nonScalarLoad), /requires the x destination lane/u);

    const undeclaredTempFixture = setDrawParametersFixture();
    for (const entry of undeclaredTempFixture.instructions)
    {
        for (const operand of entry.operands || [])
        {
            if (operand.typeName !== "temp") continue;
            operand.registerIndex = 1;
            operand.indices[0].values[0] = 1;
        }
    }
    const undeclaredTemp = CjsFormatWebgpu.buildShaderIr(
        undeclaredTempFixture, { source: "synthetic-compute-undeclared-temp" });
    assert.throws(() => lowerComputeProgram(undeclaredTemp), /temp\[0\]/u);

    const badReplication = structuredClone(base);
    badReplication.instructions[5].operands[2].swizzle = "xyzw";
    assert.throws(() => lowerComputeProgram(badReplication), /four replicated source lanes/u);

    const staleRead = structuredClone(base);
    staleRead.instructions[4].dataflow.reads[0].refs[0] = {
        ...staleRead.instructions[4].dataflow.reads[0].refs[0],
        valueId: "value4"
    };
    assert.throws(() => lowerComputeProgram(staleRead), /inconsistent bitcast metadata|stale or mismatched SSA reads/u);

    const missingBitcast = structuredClone(base);
    missingBitcast.instructions[2].typeInfo.bitcasts = [];
    assert.throws(() => lowerComputeProgram(missingBitcast), /inconsistent bitcast metadata/u);

    const badBinding = structuredClone(base);
    badBinding.bindings.find((entry) => entry.resourceKind === "storage-resource")
        .returnType.returnTypeNames[0] = "sint";
    assert.throws(() => lowerComputeProgram(badBinding), /unsupported typed-buffer declaration/u);

    const coherent = structuredClone(base);
    coherent.declarations.find((entry) =>
        entry.opcodeName === "dcl_unordered_access_view_typed").data.globallyCoherent = true;
    assert.throws(() => lowerComputeProgram(coherent), /unsupported typed-buffer declaration/u);

    const precise = structuredClone(base);
    precise.instructions[1].preciseMask = "y";
    assert.throws(() => lowerComputeProgram(precise), /unsupported control, modifier, or extension metadata/u);
});

test("typed UAV store inference follows the declared component class", () =>
{
    for (const [ typeName, expectedType ] of [
        [ "uint", "uint32" ],
        [ "sint", "int32" ],
        [ "float", "float32" ]
    ])
    {
        const fixture = setDrawParametersFixture();
        fixture.instructions[2].declaration.returnType = typedReturn(typeName);
        const ir = CjsFormatWebgpu.buildShaderIr(
            fixture, { source: `synthetic-compute-${typeName}-store` });
        const stores = ir.instructions.filter((instruction) =>
            instruction.opcodeName === "store_uav_typed");
        assert.ok(stores.every((instruction) =>
            instruction.typeInfo.operandTypes[2].expectedType === expectedType));
    }
});

test("compute lowering validates exact compute-only binding-plan coverage", () =>
{
    const { ir, typed } = lower(setDrawParametersFixture(), "synthetic-compute-plan");
    const plan = {
        format: "CJS_WGSL_BINDING_PLAN",
        formatVersion: 2,
        bindings: typed.bindings.map((binding) => ({
            identity: binding.identity,
            scopeIdentity: binding.scopeIdentity,
            stages: [ "compute" ],
            resourceKind: binding.resourceKind,
            generatedSymbol: binding.generatedSymbol,
            registerSpace: binding.registerSpace,
            registerIndex: binding.registerIndex,
            type: binding.type,
            buffer: binding.buffer,
            group: binding.group,
            binding: binding.binding
        }))
    };
    const planned = lowerComputeProgram(ir, { bindingPlan: plan });
    assert.deepEqual(planned.bindings.map((binding) => binding.binding), [ 0, 1 ]);

    const overlapping = structuredClone(plan);
    overlapping.bindings[1].binding = 0;
    assert.throws(() => lowerComputeProgram(ir, { bindingPlan: overlapping }), /invalid entry/u);

    const wrongStage = structuredClone(plan);
    wrongStage.bindings[0].stages = [ "fragment" ];
    assert.throws(() => lowerComputeProgram(ir, { bindingPlan: wrongStage }), /invalid entry/u);
});
