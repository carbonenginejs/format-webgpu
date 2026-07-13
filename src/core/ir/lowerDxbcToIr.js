import CjsFormatDxbc from "@carbonenginejs/format-dxbc";
import { analyzeRegisterValues } from "./analyzeRegisterValues.js";
import { buildControlFlow } from "./buildControlFlow.js";
import { resolveRegisterFlow } from "./resolveRegisterFlow.js";
import { inferValueTypes, SCALAR_TYPES } from "./inferValueTypes.js";

export const SHADER_IR_FORMAT = "CJS_SHADER_IR";
export const SHADER_IR_VERSION = 1;

const BINDING_KINDS = Object.freeze({
    dcl_constant_buffer: "uniform-buffer",
    dcl_sampler: "sampler",
    dcl_resource: "sampled-resource",
    dcl_resource_raw: "sampled-resource",
    dcl_resource_structured: "sampled-resource",
    dcl_unordered_access_view_typed: "storage-resource",
    dcl_unordered_access_view_raw: "storage-resource",
    dcl_unordered_access_view_structured: "storage-resource"
});

const BLOCK_BEFORE = new Set([ "loop", "else", "endif", "endloop", "case", "default", "endswitch" ]);
const BLOCK_AFTER = new Set([
    "if", "loop", "switch", "break", "breakc", "continue", "continuec",
    "ret", "retc", "discard", "else", "endif", "endloop", "case", "default", "endswitch"
]);

function clonePlain(value)
{
    if (value === null || value === undefined) return value ?? null;
    if (ArrayBuffer.isView(value)) return Array.from(value);
    if (Array.isArray(value)) return value.map(clonePlain);
    if (typeof value === "object")
    {
        const out = {};
        for (const [ key, entry ] of Object.entries(value)) out[key] = clonePlain(entry);
        return out;
    }
    return value;
}

function readDecoded(input, options)
{
    if (input instanceof Uint8Array || input instanceof ArrayBuffer || ArrayBuffer.isView(input))
    {
        const raw = CjsFormatDxbc.read(input, {
            emit: CjsFormatDxbc.OUTPUT_RAW,
            source: options.source || "memory",
            decodeInstructions: true
        });
        return {
            program: raw.program,
            instructions: raw.decoder?.instructions || [],
            signatures: {
                input: raw.inputSignature?.elements || [],
                output: raw.outputSignature?.elements || [],
                patch: raw.patchSignature?.elements || []
            }
        };
    }
    if (input?.program && input?.decoder)
    {
        return {
            program: input.program,
            instructions: input.decoder.instructions || [],
            signatures: {
                input: input.inputSignature?.elements || input.signatures?.input || [],
                output: input.outputSignature?.elements || input.signatures?.output || [],
                patch: input.patchSignature?.elements || input.signatures?.patch || []
            }
        };
    }
    if (input?.program && Array.isArray(input.instructions))
    {
        return { program: input.program, instructions: input.instructions, signatures: input.signatures || {} };
    }
    throw new TypeError("CjsFormatWebgpu.BuildShaderIr: expected DXBC bytes or decoded program/instructions");
}

function normalizedRange(declaration)
{
    if (declaration.bindingRange) return clonePlain(declaration.bindingRange);
    const registerIndex = declaration.registerIndex ?? null;
    return {
        bindingModel: "sm5.0-register",
        rangeId: null,
        lowerBound: registerIndex,
        upperBound: registerIndex,
        unbounded: false,
        registerCount: registerIndex === null ? 0 : 1,
        registerSpace: 0
    };
}

function buildBinding(instruction)
{
    const resourceKind = BINDING_KINDS[instruction.opcodeName];
    if (!resourceKind) return null;
    const declaration = instruction.declaration || {};
    const range = normalizedRange(declaration);
    return {
        kind: "binding",
        id: `${resourceKind}:space${range.registerSpace}:range${range.rangeId ?? range.lowerBound}`,
        resourceKind,
        operandType: instruction.operands?.[0]?.typeName || null,
        declarationOffset: instruction.offset,
        registerIndex: declaration.registerIndex ?? range.lowerBound,
        range,
        accessPattern: declaration.accessPattern || null,
        resourceDimension: declaration.resourceDimensionName || null,
        structureStride: declaration.structureStride ?? null,
        returnType: clonePlain(declaration.returnType || null)
    };
}

function controlKind(opcodeName)
{
    if ([ "if", "else", "endif" ].includes(opcodeName)) return "selection";
    if ([ "loop", "endloop", "break", "breakc", "continue", "continuec" ].includes(opcodeName)) return "loop";
    if ([ "switch", "case", "default", "endswitch" ].includes(opcodeName)) return "switch";
    if ([ "ret", "retc", "discard", "abort" ].includes(opcodeName)) return "termination";
    return null;
}

function buildInstruction(instruction, index)
{
    return {
        kind: "instruction",
        index,
        dxbcOffset: instruction.offset,
        opcode: instruction.opcode,
        opcodeName: instruction.opcodeName,
        controlKind: controlKind(instruction.opcodeName),
        testBoolean: instruction.testBoolean || null,
        saturate: !!instruction.saturate,
        preciseMask: instruction.preciseMask || "",
        operands: clonePlain(instruction.operands || [])
    };
}

function buildBlocks(instructions)
{
    if (instructions.length === 0) return [];
    const leaders = new Set([ 0 ]);
    for (let index = 0; index < instructions.length; index += 1)
    {
        if (BLOCK_BEFORE.has(instructions[index].opcodeName)) leaders.add(index);
        if (BLOCK_AFTER.has(instructions[index].opcodeName) && index + 1 < instructions.length) leaders.add(index + 1);
    }

    const starts = Array.from(leaders).sort((a, b) => a - b);
    return starts.map((start, blockIndex) =>
    {
        const end = (starts[blockIndex + 1] ?? instructions.length) - 1;
        const last = instructions[end];
        return {
            kind: "basic-block",
            id: `block${blockIndex}`,
            index: blockIndex,
            startInstruction: start,
            endInstruction: end,
            startDxbcOffset: instructions[start].dxbcOffset,
            endDxbcOffset: last.dxbcOffset,
            instructionIndices: Array.from({ length: end - start + 1 }, (_, offset) => start + offset),
            terminator: last.controlKind ? last.opcodeName : null
        };
    });
}

function validateProgram(program)
{
    if (!program.stage || !Number.isInteger(program.shaderModel.major))
    {
        throw new Error("Invalid shader IR program identity");
    }
    for (let index = 1; index < program.instructions.length; index += 1)
    {
        if (program.instructions[index].dxbcOffset <= program.instructions[index - 1].dxbcOffset)
        {
            throw new Error("Shader IR instruction offsets must be strictly increasing");
        }
    }
    const covered = program.blocks.flatMap((block) => block.instructionIndices);
    if (covered.length !== program.instructions.length || covered.some((value, index) => value !== index))
    {
        throw new Error("Shader IR basic blocks must cover every executable instruction exactly once");
    }
    const blockIds = new Set(program.blocks.map((block) => block.id));
    for (const block of program.blocks)
    {
        if (block.successors.some((edge) => !blockIds.has(edge.blockId)))
        {
            throw new Error("Shader IR control-flow edge references an unknown block");
        }
        for (const edge of block.successors)
        {
            const successor = program.blocks.find((entry) => entry.id === edge.blockId);
            if (!successor.predecessors.some((entry) => entry.blockId === block.id && entry.kind === edge.kind))
            {
                throw new Error("Shader IR control-flow successor/predecessor edges must be symmetric");
            }
        }
    }
    const bindingIds = new Set();
    for (const binding of program.bindings)
    {
        if (bindingIds.has(binding.id)) throw new Error(`Duplicate shader IR binding ${binding.id}`);
        bindingIds.add(binding.id);
    }
    const valueIds = new Set(program.values.map((value) => value.id));
    const valuesById = new Map(program.values.map((value) => [ value.id, value ]));
    if (valueIds.size !== program.values.length) throw new Error("Shader IR register value ids must be unique");
    for (const block of program.blocks)
    {
        if (block.inputValueIds.some((id) => !valueIds.has(id)))
        {
            throw new Error("Shader IR block input references an unknown value");
        }
        if (block.outputValues.some((output) => !valueIds.has(output.ref.valueId)))
        {
            throw new Error("Shader IR block output references an unknown value");
        }
        if (block.mergeSite?.valueIds?.some((id) =>
            !valueIds.has(id)
            || valuesById.get(id).origin !== "control-flow-merge"
            || valuesById.get(id).blockId !== block.id))
        {
            throw new Error("Shader IR merge site references an invalid merge value");
        }
    }
    for (const instruction of program.instructions)
    {
        if (!instruction.dataflow) throw new Error("Shader IR instruction is missing register dataflow");
        const refs = [
            ...instruction.dataflow.reads.flatMap((read) => read.refs),
            ...instruction.dataflow.writes.flatMap((write) => [
                { valueId: write.valueId },
                ...Object.values(write.previous || {}),
                ...Object.values(write.result || {})
            ])
        ];
        if (refs.some((ref) => !valueIds.has(ref.valueId)))
        {
            throw new Error("Shader IR register dataflow references an unknown value");
        }
    }
    for (const value of program.values)
    {
        if (value.origin === "block-input") throw new Error("Shader IR contains an unresolved block input");
        if (value.origin === "control-flow-merge")
        {
            if (value.incoming.length < 2) throw new Error("Shader IR merge value must have at least two incoming values");
            if (value.incoming.some((incoming) => !valueIds.has(incoming.valueId)))
            {
                throw new Error("Shader IR merge value references an unknown incoming value");
            }
            if (value.incoming.some((incoming) =>
                incoming.component !== value.writeMask
                || valuesById.get(incoming.valueId).register !== value.register))
            {
                throw new Error("Shader IR merge value has an incompatible incoming register component");
            }
        }
        if (!value.componentTypes || Object.values(value.componentTypes).some((type) => !SCALAR_TYPES.includes(type)))
        {
            throw new Error("Shader IR register value has an invalid component type");
        }
    }
    for (const instruction of program.instructions)
    {
        if (!instruction.typeInfo) throw new Error("Shader IR instruction is missing type information");
        if (instruction.typeInfo.bitcasts.some((bitcast) =>
            !SCALAR_TYPES.includes(bitcast.from) || !SCALAR_TYPES.includes(bitcast.to)))
        {
            throw new Error("Shader IR instruction has an invalid bitcast type");
        }
    }
}

function deepFreeze(value)
{
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
}

/**
 * Lowers decoded DXBC framing into the stable front-end shader IR.
 * Type inference and SSA value reconstruction are later passes.
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView|object} input DXBC bytes or decoded result.
 * @param {object} [options] IR provenance options.
 * @returns {object} Frozen, validated shader IR program.
 */
export function lowerDxbcToIr(input, options = {})
{
    const decoded = readDecoded(input, options);
    if (!decoded.program) throw new Error("DXBC input has no shader program");

    const declarationInstructions = decoded.instructions.filter((instruction) => instruction.isDeclaration);
    const executable = decoded.instructions.filter((instruction) => !instruction.isDeclaration);
    const instructions = executable.map(buildInstruction);
    const program = {
        kind: "shader-program",
        format: SHADER_IR_FORMAT,
        formatVersion: SHADER_IR_VERSION,
        source: options.source || decoded.program.source || "memory",
        stage: decoded.program.programTypeName,
        programType: decoded.program.programType,
        shaderModel: {
            major: decoded.program.majorVersion,
            minor: decoded.program.minorVersion
        },
        signatures: {
            input: clonePlain(decoded.signatures?.input || []),
            output: clonePlain(decoded.signatures?.output || []),
            patch: clonePlain(decoded.signatures?.patch || [])
        },
        declarations: declarationInstructions.map((instruction) => ({
            kind: "declaration",
            dxbcOffset: instruction.offset,
            opcodeName: instruction.opcodeName,
            data: clonePlain(instruction.declaration),
            operands: clonePlain(instruction.operands || [])
        })),
        bindings: declarationInstructions.map(buildBinding).filter(Boolean),
        instructions,
        blocks: buildBlocks(instructions)
    };
    buildControlFlow(program);
    analyzeRegisterValues(program);
    resolveRegisterFlow(program);
    inferValueTypes(program);
    validateProgram(program);
    return deepFreeze(program);
}
