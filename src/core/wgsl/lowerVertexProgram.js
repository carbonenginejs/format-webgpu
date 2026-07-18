import { fixedSourceLanes } from "../ir/sourceLanes.js";
import { lowerBindingLayout } from "./lowerBindingLayout.js";

const COMPONENTS = [ "x", "y", "z", "w" ];
const SYSTEM_BUILTINS = Object.freeze({
    SV_POSITION: "position"
});
const SUPPORTED_OPCODES = new Set([
    "add", "and", "dp3", "dp4", "exp", "iadd", "ld_structured", "log", "lt",
    "mad", "mov", "movc", "mul", "rsq", "sincos", "ret"
]);

function componentsFromMask(mask)
{
    return COMPONENTS.filter((_, index) => (mask & (1 << index)) !== 0);
}

function scalarTypeName(type)
{
    return ({ float32: "f32", int32: "i32", uint32: "u32", bool: "bool", bitpattern32: "u32" })[type] || null;
}

function fieldType(scalarType, count)
{
    const scalar = scalarTypeName(scalarType);
    if (!scalar) throw new Error(`WGSL vertex interface cannot use unresolved scalar type ${scalarType}`);
    return count === 1 ? scalar : `vec${count}<${scalar}>`;
}

function interfaceFields(program, direction)
{
    return (program.signatures?.[direction] || []).map((signature, index) =>
    {
        const components = componentsFromMask(signature.mask);
        if (!components.length) throw new Error(`WGSL ${direction} signature ${index} has an empty mask`);
        if (!components.every((component, componentIndex) => component === COMPONENTS[componentIndex]))
        {
            throw new Error(`WGSL ${direction} signature register ${signature.registerIndex} has a non-prefix mask`);
        }
        const semantic = String(signature.semanticName || "").toUpperCase();
        const builtin = direction === "output" ? SYSTEM_BUILTINS[semantic] || null : null;
        if (semantic.startsWith("SV_") && !builtin)
        {
            throw new Error(`WGSL vertex ${direction} system semantic ${semantic} is not supported`);
        }
        return {
            kind: "interface-field",
            id: `${direction}:r${signature.registerIndex}`,
            direction,
            registerIndex: signature.registerIndex,
            semanticName: signature.semanticName,
            semanticIndex: signature.semanticIndex,
            components,
            scalarType: signature.componentTypeName,
            type: fieldType(signature.componentTypeName, components.length),
            name: builtin || `${direction}${signature.registerIndex}`,
            attribute: builtin
                ? { kind: "builtin", name: builtin }
                : { kind: "location", index: signature.registerIndex }
        };
    });
}

function packedComponent(mask, component)
{
    const index = Array.from(mask).indexOf(component);
    if (index < 0) throw new Error(`WGSL value mask ${mask} does not contain component ${component}`);
    return COMPONENTS[index];
}

function valueType(program, write)
{
    const value = program.values.find((entry) => entry.id === write.valueId);
    const types = Array.from(write.mask).map((component) => value?.componentTypes?.[component]);
    if (!types.length || types.some((type) => !scalarTypeName(type)) || new Set(types).size !== 1)
    {
        throw new Error(`WGSL vertex value ${write.valueId} has an unresolved or mixed result type`);
    }
    const scalarType = types[0];
    return {
        scalarType,
        wgslType: fieldType(scalarType, types.length)
    };
}

function liveInputRegisters(program)
{
    const values = new Map(program.values.map((value) => [ value.id, value ]));
    const reachableBlocks = new Set(program.controlFlow.reachableBlockIds);
    const reachableInstructions = new Set(program.blocks
        .filter((block) => reachableBlocks.has(block.id))
        .flatMap((block) => block.instructionIndices));
    const registers = new Set();
    for (const instruction of program.instructions)
    {
        if (!reachableInstructions.has(instruction.index)) continue;
        for (const ref of instruction.dataflow.reads.flatMap((read) => read.refs))
        {
            const value = values.get(ref.valueId);
            if (value?.origin === "undefined-register")
            {
                throw new Error(`WGSL vertex instruction ${instruction.index} reads undefined ${value.register}.${ref.component}`);
            }
            const match = value?.origin === "program-input" && /^input\[(\d+)\]$/.exec(value.register);
            if (match) registers.add(Number(match[1]));
        }
    }
    return registers;
}

function sourceRead(instruction, operandIndex)
{
    return instruction.dataflow.reads.find((entry) => entry.operandIndex === operandIndex) || null;
}

function vectorCode(parts, scalarType)
{
    if (parts.length === 1) return parts[0];
    return `vec${parts.length}<${scalarTypeName(scalarType)}>(${parts.join(", ")})`;
}

function reinterpretCode(code, fromType, toType, count, context)
{
    const from = scalarTypeName(fromType);
    const to = scalarTypeName(toType);
    if (!from || !to) throw new Error(`WGSL vertex cannot resolve ${context} type ${fromType} to ${toType}`);
    if (from === to) return code;
    if (![ "f32", "i32", "u32" ].includes(from) || ![ "f32", "i32", "u32" ].includes(to))
    {
        throw new Error(`WGSL vertex cannot reinterpret ${context} from ${fromType} to ${toType}`);
    }
    return `bitcast<${fieldType(toType, count)}>(${code})`;
}

function valueReference(program, ref, inputs)
{
    const value = program.values.find((entry) => entry.id === ref.valueId);
    if (!value) throw new Error(`WGSL vertex references missing value ${ref.valueId}`);
    if (value.origin === "undefined-register") throw new Error(`WGSL vertex reads undefined ${value.register}.${ref.component}`);
    if (value.origin === "program-input")
    {
        const registerIndex = Number(/^input\[(\d+)\]$/.exec(value.register)?.[1]);
        const field = inputs.find((entry) => entry.registerIndex === registerIndex);
        if (!field) throw new Error(`WGSL vertex has no live input field for ${value.register}`);
        const packed = packedComponent(field.components.join(""), ref.component);
        const code = field.components.length === 1 ? `input.${field.name}` : `input.${field.name}.${packed}`;
        return reinterpretCode(code, field.scalarType, value.componentTypes?.[ref.component], 1, `${value.register}.${ref.component}`);
    }
    const packed = packedComponent(value.writeMask, ref.component);
    return value.writeMask.length === 1 ? value.id : `${value.id}.${packed}`;
}

function sourceComponents(operand, destinationMask, count, activeComponents = null)
{
    const selected = operand.selected || "";
    if (selected) return Array.from({ length: count }, () => selected);
    const swizzle = operand.swizzle || "xyzw";
    const positions = activeComponents || (count > destinationMask.length
        ? COMPONENTS.slice(0, count)
        : Array.from(destinationMask).slice(0, count));
    return positions.map((component) => swizzle[COMPONENTS.indexOf(component)] || swizzle[0]);
}

function immediateParts(operand, destinationMask, count, expectedType, activeComponents = null)
{
    const values = operand.immediateValues || [];
    const components = sourceComponents(operand, destinationMask, count, activeComponents);
    return components.map((component, index) =>
    {
        const sourceIndex = values.length === 1 ? 0 : COMPONENTS.indexOf(component);
        const bits = values[sourceIndex]?.uint32 ?? values[index]?.uint32;
        if (!Number.isInteger(bits)) throw new Error("WGSL vertex immediate has no raw uint32 bits");
        const hex = `0x${(bits >>> 0).toString(16).padStart(8, "0")}u`;
        if (expectedType === "float32") return `bitcast<f32>(${hex})`;
        if (expectedType === "int32") return `bitcast<i32>(${hex})`;
        return hex;
    });
}

function bindingForOperand(bindings, resourceKind, operand)
{
    const rangeId = operand.resourceReference?.rangeId;
    if (Number.isInteger(rangeId))
    {
        const matches = bindings.filter((entry) => entry.resourceKind === resourceKind && entry.rangeId === rangeId);
        if (matches.length > 1) throw new Error(`WGSL vertex ${resourceKind} range ${rangeId} is ambiguous`);
        return matches[0] || null;
    }
    return bindings.find((entry) =>
        entry.resourceKind === resourceKind && entry.registerIndex === operand.registerIndex) || null;
}

function cbufferParts(operand, destinationMask, count, bindings, expectedScalarType, activeComponents = null)
{
    const binding = bindingForOperand(bindings, "uniform-buffer", operand);
    if (!binding) throw new Error(`WGSL vertex cannot resolve cb${operand.registerIndex}`);
    if (operand.indices?.some((entry) => entry.relative)) throw new Error("WGSL vertex does not support relative cbuffer indexing");
    const vectorIndex = operand.indices?.at(-1)?.values?.[0];
    if (!Number.isInteger(vectorIndex)) throw new Error("WGSL vertex cbuffer operand has no immediate vector index");
    const parts = sourceComponents(operand, destinationMask, count, activeComponents)
        .map((component) => `${binding.generatedSymbol}[${vectorIndex}].${component}`);
    if (expectedScalarType === "float32") return parts;
    if (![ "int32", "uint32", "bitpattern32" ].includes(expectedScalarType))
    {
        throw new Error(`WGSL vertex cannot reinterpret cbuffer lanes as ${expectedScalarType}`);
    }
    const target = scalarTypeName(expectedScalarType);
    return parts.map((part) => `bitcast<${target}>(${part})`);
}

function applyModifier(parts, operand)
{
    const modifier = operand.modifierName || "none";
    if (modifier === "none") return parts;
    if (modifier === "neg") return parts.map((part) => `-(${part})`);
    if (modifier === "abs") return parts.map((part) => `abs(${part})`);
    if (modifier === "absneg") return parts.map((part) => `-(abs(${part}))`);
    throw new Error(`WGSL vertex operand modifier ${modifier} is not supported`);
}

function expectedType(instruction, operandIndex)
{
    return instruction.typeInfo.operandTypes.find((entry) => entry.operandIndex === operandIndex)?.expectedType || "unknown";
}

function valueStorageType(program, ref)
{
    const value = program.values.find((entry) => entry.id === ref.valueId);
    return value?.componentTypes?.[ref.component] || "unknown";
}

function bitcastKey(entry)
{
    if (entry.kind === "read-bitcast")
    {
        return [ entry.kind, entry.operandIndex, entry.componentIndex, entry.valueId, entry.component,
            entry.from, entry.to ].join(":");
    }
    return [ entry.kind, entry.operandIndex, entry.valueId, entry.component, entry.from, entry.to ].join(":");
}

function validateRegisterBitcasts(program, instruction)
{
    const required = [];
    for (const read of instruction.dataflow.reads)
    {
        const expected = expectedType(instruction, read.operandIndex);
        if (expected === "unknown") continue;
        read.refs.forEach((ref, componentIndex) =>
        {
            const storage = valueStorageType(program, ref);
            if (storage !== "unknown" && storage !== expected)
            {
                required.push({
                    kind: "read-bitcast",
                    operandIndex: read.operandIndex,
                    componentIndex,
                    valueId: ref.valueId,
                    component: ref.component,
                    from: storage,
                    to: expected
                });
            }
        });
    }
    const intrinsicResult = instruction.typeInfo.resultType;
    if (intrinsicResult !== "unknown")
    {
        for (const write of instruction.dataflow.writes)
        {
            for (const component of write.mask)
            {
                const storage = valueStorageType(program, { valueId: write.valueId, component });
                if (storage !== "unknown" && storage !== intrinsicResult)
                {
                    required.push({
                        kind: "result-bitcast",
                        operandIndex: write.operandIndex,
                        valueId: write.valueId,
                        component,
                        from: intrinsicResult,
                        to: storage
                    });
                }
            }
        }
    }
    const actual = instruction.typeInfo.bitcasts.filter((entry) =>
        entry.kind === "read-bitcast" || entry.kind === "result-bitcast");
    const requiredKeys = required.map(bitcastKey).sort();
    const actualKeys = actual.map(bitcastKey).sort();
    if (new Set(actualKeys).size !== actualKeys.length
        || requiredKeys.length !== actualKeys.length
        || requiredKeys.some((entry, index) => entry !== actualKeys[index]))
    {
        throw new Error(`WGSL vertex instruction ${instruction.index} has inconsistent register bitcast metadata`);
    }
}

function operandExpression(program, instruction, operandIndex, destinationMask, count, inputs, bindings)
{
    const operand = instruction.operands[operandIndex];
    if (!operand) throw new Error(`WGSL vertex instruction ${instruction.index} has no operand ${operandIndex}`);
    if ((operand.minPrecisionName || "default") !== "default")
    {
        throw new Error(`WGSL vertex instruction ${instruction.index} uses minimum precision`);
    }
    const type = expectedType(instruction, operandIndex);
    const read = sourceRead(instruction, operandIndex);
    const activeComponents = fixedSourceLanes(instruction, operandIndex);
    let parts;
    if (read)
    {
        if (read.refs.length < count && !(read.refs.length === 1 && operand.selected))
        {
            throw new Error(`WGSL vertex instruction ${instruction.index} has too few source lanes`);
        }
        const refs = read.refs.length === 1 && operand.selected
            ? Array.from({ length: count }, () => read.refs[0])
            : read.refs.slice(0, count);
        const replicatedSelected = read.refs.length === 1 && Boolean(operand.selected);
        parts = refs.map((ref, componentIndex) =>
        {
            let part = valueReference(program, ref, inputs);
            const sourceComponentIndex = replicatedSelected ? 0 : componentIndex;
            const bitcast = instruction.typeInfo.bitcasts.find((entry) => entry.kind === "read-bitcast"
                && entry.operandIndex === operandIndex && entry.componentIndex === sourceComponentIndex
                && entry.valueId === ref.valueId && entry.component === ref.component);
            if (bitcast)
            {
                part = reinterpretCode(part, bitcast.from, bitcast.to, 1, `instruction ${instruction.index} read`);
            }
            return part;
        });
    }
    else if (operand.typeName === "immediate32")
    {
        parts = immediateParts(operand, destinationMask, count, type, activeComponents);
    }
    else if (operand.typeName === "constant_buffer")
    {
        parts = cbufferParts(operand, destinationMask, count, bindings, type, activeComponents);
    }
    else
    {
        throw new Error(`WGSL vertex instruction ${instruction.index} cannot lower ${operand.typeName} operand ${operandIndex}`);
    }
    return vectorCode(applyModifier(parts, operand), type);
}

function floatBound(count, value)
{
    return count === 1 ? value : `vec${count}<f32>(${value})`;
}

function zeroMask(count)
{
    return count === 1 ? "0u" : `vec${count}<u32>(0u)`;
}

function fullMask(count)
{
    return count === 1 ? "0xffffffffu" : `vec${count}<u32>(0xffffffffu)`;
}

function splatScalar(code, count)
{
    return count === 1 ? code : `vec${count}<f32>(${code})`;
}

function structuredLoadExpression(program, instruction, write, type, inputs, bindings)
{
    const count = write.mask.length;
    if (instruction.operands.length !== 4)
    {
        throw new Error(`WGSL vertex structured load ${instruction.index} requires four operands`);
    }
    const addressOperand = instruction.operands[1];
    if (!COMPONENTS.includes(addressOperand?.selected) || (addressOperand.modifierName || "none") !== "none")
    {
        throw new Error(`WGSL vertex structured load ${instruction.index} requires one unmodified scalar address`);
    }
    const address = operandExpression(program, instruction, 1, write.mask, 1, inputs, bindings);
    const byteOffsetOperand = instruction.operands[2];
    const byteOffset = byteOffsetOperand?.immediateValues?.[0]?.uint32;
    if (byteOffsetOperand?.typeName !== "immediate32" || byteOffsetOperand.immediateValues?.length !== 1
        || (byteOffsetOperand.modifierName || "none") !== "none"
        || !Number.isInteger(byteOffset))
    {
        throw new Error(`WGSL vertex structured load ${instruction.index} requires an immediate byte offset`);
    }
    const resource = instruction.operands[3];
    if (resource?.typeName !== "resource" || resource.indices?.some((entry) => entry.relative)
        || (resource.modifierName || "none") !== "none"
        || (resource.minPrecisionName || "default") !== "default")
    {
        throw new Error(`WGSL vertex structured load ${instruction.index} requires one fixed resource`);
    }
    const binding = bindingForOperand(bindings, "sampled-resource", resource);
    if (!binding?.buffer || !Number.isInteger(binding.structureStride))
    {
        throw new Error(`WGSL vertex structured load ${instruction.index} has no structured buffer binding`);
    }
    const strideWords = binding.structureStride / 4;
    const firstWord = byteOffset / 4;
    if (byteOffset % 4 !== 0)
    {
        throw new Error(`WGSL vertex structured load ${instruction.index} has a non-DWORD byte offset`);
    }
    const swizzle = sourceComponents(resource, write.mask, count);
    const selected = swizzle.map((component) =>
    {
        const index = COMPONENTS.indexOf(component);
        const word = firstWord + index;
        if (index < 0 || word >= strideWords)
        {
            throw new Error(`WGSL vertex structured load ${instruction.index} exceeds its ${binding.structureStride}-byte stride`);
        }
        return `${binding.generatedSymbol}[((${address}) * ${strideWords}u) + ${word}u]`;
    });
    const parts = selected.map((part) => reinterpretCode(part, "uint32", type.scalarType, 1,
        `structured load ${instruction.index}`));
    return vectorCode(parts, type.scalarType);
}

function expressionFor(program, instruction, write, type, inputs, bindings)
{
    const mask = write.mask;
    const count = mask.length;
    const source = (index, forcedCount = count) =>
        operandExpression(program, instruction, index, mask, forcedCount, inputs, bindings);
    const op = instruction.opcodeName;
    if ([ "add", "iadd", "mul" ].includes(op))
    {
        const operator = op === "mul" ? "*" : "+";
        return `(${source(1)} ${operator} ${source(2)})`;
    }
    if (op === "mad") return `((${source(1)} * ${source(2)}) + ${source(3)})`;
    if (op === "and") return `(${source(1)} & ${source(2)})`;
    if (op === "lt") return `select(${zeroMask(count)}, ${fullMask(count)}, ${source(1)} < ${source(2)})`;
    if (op === "mov") return source(1);
    if (op === "movc") return `select(${source(3)}, ${source(2)}, ${source(1)} != ${zeroMask(count)})`;
    if (op === "exp") return `exp2(${source(1)})`;
    if (op === "log") return `log2(${source(1)})`;
    if (op === "rsq") return `inverseSqrt(${source(1)})`;
    if (op === "sincos")
    {
        const fn = write.operandIndex === 0 ? "sin" : write.operandIndex === 1 ? "cos" : null;
        if (!fn) throw new Error(`WGSL vertex sincos instruction ${instruction.index} has an unexpected destination operand`);
        return `${fn}(${source(2)})`;
    }
    if (op === "ld_structured") return structuredLoadExpression(program, instruction, write, type, inputs, bindings);
    if (op === "dp3") return splatScalar(`dot(${source(1, 3)}, ${source(2, 3)})`, count);
    if (op === "dp4") return splatScalar(`dot(${source(1, 4)}, ${source(2, 4)})`, count);
    throw new Error(`WGSL vertex opcode ${op} at instruction ${instruction.index} is not supported`);
}

function applyResultBitcast(program, instruction, write, expression, type)
{
    const components = Array.from(write.mask);
    const records = instruction.typeInfo.bitcasts.filter((entry) => entry.kind === "result-bitcast"
        && entry.operandIndex === write.operandIndex && entry.valueId === write.valueId);
    if (!records.length) return expression;
    const intrinsicType = instruction.typeInfo.resultType;
    if (records.length !== components.length || records.some((entry) =>
        entry.from !== intrinsicType || entry.to !== type.scalarType)
        || components.some((component) => !records.some((entry) => entry.component === component)))
    {
        throw new Error(`WGSL vertex instruction ${instruction.index} has unsupported result bitcasts`);
    }
    return reinterpretCode(expression, intrinsicType, type.scalarType, components.length,
        `instruction ${instruction.index} result`);
}

function lowerInstruction(program, instruction, inputs, outputs, bindings, written, readValueIds)
{
    if (!SUPPORTED_OPCODES.has(instruction.opcodeName))
    {
        throw new Error(`WGSL vertex opcode ${instruction.opcodeName} at instruction ${instruction.index} is not supported`);
    }
    if (instruction.preciseMask)
    {
        throw new Error(`WGSL vertex instruction ${instruction.index} uses precise controls ${instruction.preciseMask}`);
    }
    if (instruction.operands.some((operand) => (operand.minPrecisionName || "default") !== "default"))
    {
        throw new Error(`WGSL vertex instruction ${instruction.index} uses minimum precision`);
    }
    validateRegisterBitcasts(program, instruction);
    if (instruction.opcodeName === "ld_structured" && instruction.saturate)
    {
        throw new Error(`WGSL vertex structured load ${instruction.index} cannot saturate its result`);
    }
    if (instruction.opcodeName === "ret")
    {
        for (const field of outputs)
        {
            const missing = field.components.filter((component) => !written.get(field.id).has(component));
            if (missing.length) throw new Error(`WGSL vertex output ${field.semanticName}${field.semanticIndex} leaves ${missing.join("")} unwritten before return`);
        }
        return { kind: "return", instructionIndex: instruction.index, dxbcOffset: instruction.dxbcOffset };
    }
    const writes = instruction.dataflow.writes;
    if (!writes.length) throw new Error(`WGSL vertex instruction ${instruction.index} has no result write`);
    if (instruction.opcodeName === "sincos")
    {
        const destinationOperands = writes.map((write) => write.operandIndex);
        if (writes.length > 2 || new Set(destinationOperands).size !== writes.length
            || destinationOperands.some((operandIndex) => ![ 0, 1 ].includes(operandIndex)))
        {
            throw new Error(`WGSL vertex sincos instruction ${instruction.index} has unsupported result writes`);
        }
        if (writes.length === 2 && writes[0].mask !== writes[1].mask)
        {
            throw new Error(`WGSL vertex sincos instruction ${instruction.index} requires matching destination masks`);
        }
    }
    else if (writes.length !== 1)
    {
        throw new Error(`WGSL vertex instruction ${instruction.index} has unsupported multiple result writes`);
    }

    function lowerWrite(write)
    {
        const destination = instruction.operands[write.operandIndex];
        const type = valueType(program, write);
        let expression = expressionFor(program, instruction, write, type, inputs, bindings);
        if (instruction.saturate)
        {
            if (instruction.typeInfo.resultType !== "float32") throw new Error(`WGSL vertex instruction ${instruction.index} saturates a non-float result`);
            expression = `clamp(${expression}, ${floatBound(write.mask.length, "0.0")}, ${floatBound(write.mask.length, "1.0")})`;
        }
        expression = applyResultBitcast(program, instruction, write, expression, type);
        if (destination.typeName === "output")
        {
            const field = outputs.find((entry) => entry.registerIndex === destination.registerIndex);
            if (!field) throw new Error(`WGSL vertex instruction ${instruction.index} references undeclared output r${destination.registerIndex}`);
            const components = Array.from(write.mask).map((component) => packedComponent(field.components.join(""), component));
            const outputType = fieldType(field.scalarType, write.mask.length);
            const assignmentExpression = reinterpretCode(expression, type.scalarType, field.scalarType, write.mask.length,
                `output r${destination.registerIndex}`);
            Array.from(write.mask).forEach((component) => written.get(field.id).add(component));
            const assignment = {
                kind: "assignment",
                target: { fieldId: field.id, components, type: outputType },
                expression: { code: assignmentExpression, type: outputType }
            };
            if (!readValueIds.has(write.valueId))
            {
                return { ...assignment, instructionIndex: instruction.index, dxbcOffset: instruction.dxbcOffset };
            }
            return [
                {
                    kind: "let",
                    instructionIndex: instruction.index,
                    dxbcOffset: instruction.dxbcOffset,
                    name: write.valueId,
                    type: type.wgslType,
                    expression: { code: expression, type: type.wgslType }
                },
                {
                    ...assignment,
                    expression: {
                        code: reinterpretCode(write.valueId, type.scalarType, field.scalarType, write.mask.length,
                            `output r${destination.registerIndex}`),
                        type: outputType
                    }
                }
            ];
        }
        if (destination.typeName !== "temp")
        {
            throw new Error(`WGSL vertex instruction ${instruction.index} writes unsupported ${destination.typeName}`);
        }
        return {
            kind: "let",
            instructionIndex: instruction.index,
            dxbcOffset: instruction.dxbcOffset,
            name: write.valueId,
            type: type.wgslType,
            expression: { code: expression, type: type.wgslType }
        };
    }

    const statements = writes.flatMap((write) => lowerWrite(write));
    return statements.length === 1 ? statements[0] : statements;
}

function deepFreeze(value)
{
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
}

/**
 * Lowers the bounded straight-line vertex slice into typed SSA expressions,
 * interface assignments, and canonical uniform-buffer bindings.
 *
 * @param {object} program Frozen CJS shader IR.
 * @returns {object} Frozen typed vertex program.
 */
export function lowerVertexProgram(program, options = {})
{
    if (program?.format !== "CJS_SHADER_IR") throw new TypeError("WGSL vertex lowering expects CJS_SHADER_IR input");
    if (program.stage !== "vertex") throw new Error(`WGSL vertex lowering cannot lower ${program.stage}`);
    if (program.shaderModel.major !== 5 || ![ 0, 1 ].includes(program.shaderModel.minor))
    {
        throw new Error("WGSL vertex body slice currently supports only SM5.0/SM5.1");
    }
    const liveRegisters = liveInputRegisters(program);
    const inputs = interfaceFields(program, "input").filter((field) => liveRegisters.has(field.registerIndex));
    const outputs = interfaceFields(program, "output");
    for (const fields of [ inputs, outputs ])
    {
        if (new Set(fields.map((field) => field.registerIndex)).size !== fields.length)
        {
            throw new Error("WGSL vertex body slice does not support packed signature registers");
        }
    }
    const bindings = lowerBindingLayout(program, options.bindingPlan);
    if (bindings.some((binding) => binding.resourceKind !== "uniform-buffer"
        && !(binding.resourceKind === "sampled-resource" && binding.buffer?.type === "read-only-storage")))
    {
        throw new Error("WGSL vertex body slice supports only uniform and read-only structured-buffer bindings");
    }
    const reachable = new Set(program.controlFlow.reachableBlockIds);
    const reachableBlocks = program.blocks.filter((block) => reachable.has(block.id));
    if (reachableBlocks.length !== 1) throw new Error("WGSL vertex body slice requires one reachable basic block");
    const reachableInstructions = reachableBlocks
        .flatMap((block) => block.instructionIndices)
        .sort((a, b) => a - b)
        .map((index) => program.instructions[index]);
    const readValueIds = new Set(reachableInstructions.flatMap((instruction) =>
        instruction.dataflow.reads.flatMap((read) => read.refs.map((ref) => ref.valueId))));
    const statements = [];
    const written = new Map(outputs.map((field) => [ field.id, new Set() ]));
    let returned = false;

    for (const instruction of reachableInstructions)
    {
        if (returned) throw new Error(`WGSL vertex has reachable instructions after return at ${instruction.index}`);
        const lowered = lowerInstruction(program, instruction, inputs, outputs, bindings, written, readValueIds);
        statements.push(...(Array.isArray(lowered) ? lowered : [ lowered ]));
        if (instruction.opcodeName === "ret") returned = true;
    }
    if (!returned) throw new Error("WGSL vertex has no reachable return");

    return deepFreeze({
        kind: "typed-shader-program",
        format: "CJS_TYPED_SHADER",
        formatVersion: 1,
        source: program.source,
        stage: "vertex",
        entryPoint: "main",
        interface: { inputs, outputs },
        bindings,
        statements
    });
}
