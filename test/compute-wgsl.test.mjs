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
