import { fixedSourceLanes } from "../ir/sourceLanes.js";
import { hoistEscapingValues } from "./hoistEscapingValues.js";
import { lowerBindingLayout } from "./lowerBindingLayout.js";
import { requireRefactoringAllowed, validatePreciseInstruction } from "./precisionControls.js";
import { buildSelectionPlans, cloneWritten, terminatesAllPaths } from "./selectionPlans.js";

const COMPONENTS = [ "x", "y", "z", "w" ];
const SUPPORTED_OPCODES = new Set([
    "add", "and", "deriv_rtx", "deriv_rty", "deriv_rtx_coarse",
    "deriv_rty_coarse", "deriv_rtx_fine", "deriv_rty_fine", "discard", "div",
    "dp2", "dp3", "dp4", "eq", "exp", "f16tof32", "f32tof16", "frc", "ftoi",
    "ftou", "ge", "iadd",
    "ieq", "ige", "ilt", "imad", "imul", "ine", "if",
    "itof", "ld", "ld_structured", "log", "lt", "mad", "max", "min", "mov", "movc", "mul", "ne",
    "or", "resinfo", "round_ni", "round_z", "rsq", "sample", "sample_b",
    "sample_l", "sincos", "sqrt", "ushr", "utof", "xor", "endif", "ret"
]);
const NUMERIC_CONVERSIONS = Object.freeze({
    itof: [ "int32", "float32" ],
    utof: [ "uint32", "float32" ],
    ftoi: [ "float32", "int32" ],
    ftou: [ "float32", "uint32" ]
});

const INPUT_BUILTINS = Object.freeze({
    SV_POSITION: { name: "position" },
    SV_ISFRONTFACE: { name: "front_facing", scalarType: "bool" }
});
const DERIVATIVES = Object.freeze({
    deriv_rtx: "dpdx", deriv_rty: "dpdy",
    deriv_rtx_coarse: "dpdxCoarse", deriv_rty_coarse: "dpdyCoarse",
    deriv_rtx_fine: "dpdxFine", deriv_rty_fine: "dpdyFine"
});

function componentsFromMask(mask)
{
    return COMPONENTS.filter((_, index) => (mask & (1 << index)) !== 0);
}

function scalarTypeName(type)
{
    return ({ float32: "f32", int32: "i32", uint32: "u32", bool: "bool", bitpattern32: "u32" })[type] || null;
}

function isDeadUntypedWrite(program, instruction, write, readValueIds)
{
    const destination = instruction.operands[write.operandIndex];
    if (destination?.typeName !== "temp" || readValueIds.has(write.valueId)) return false;
    const value = program.values.find((entry) => entry.id === write.valueId);
    return Array.from(write.mask).some((component) => !scalarTypeName(value?.componentTypes?.[component]));
}

function mixedImmediateTypes(program, write)
{
    const value = program.values.find((entry) => entry.id === write.valueId);
    if (!value || write.mask.length < 2) return null;
    const types = Array.from(write.mask).map((component) => value.componentTypes?.[component]);
    if (types.some((type) => !scalarTypeName(type)) || new Set(types).size === 1) return null;
    return types;
}


function valueType(program, write)
{
    const value = program.values.find((entry) => entry.id === write.valueId);
    const types = Array.from(write.mask).map((component) => value?.componentTypes?.[component]);
    if (!types.length || types.some((type) => !scalarTypeName(type)) || new Set(types).size !== 1)
    {
        throw new Error(`WGSL fragment value ${write.valueId} has an unresolved or mixed result type`);
    }
    const scalarType = types[0];
    return {
        scalarType,
        wgslType: types.length === 1 ? scalarTypeName(scalarType) : `vec${types.length}<${scalarTypeName(scalarType)}>`
    };
}

function fieldType(scalarType, count)
{
    const scalar = scalarTypeName(scalarType);
    if (!scalar) throw new Error(`WGSL fragment interface cannot use ${scalarType}`);
    return count === 1 ? scalar : `vec${count}<${scalar}>`;
}

function packedComponent(mask, component)
{
    const index = Array.from(mask).indexOf(component);
    if (index < 0) throw new Error(`WGSL value mask ${mask} does not contain component ${component}`);
    return COMPONENTS[index];
}

function interfaceField(signature, direction)
{
    const components = componentsFromMask(signature.mask);
    if (!components.length || !components.every((component, index) => component === COMPONENTS[index]))
    {
        throw new Error(`WGSL fragment ${direction} register ${signature.registerIndex} requires a prefix signature mask`);
    }
    const semantic = String(signature.semanticName || "").toUpperCase();
    if (direction === "output" && semantic !== "SV_TARGET")
    {
        throw new Error(`WGSL fragment output semantic ${semantic} is not supported`);
    }
    const builtin = direction === "input" ? INPUT_BUILTINS[semantic] || null : null;
    if (direction === "input" && semantic.startsWith("SV_") && !builtin)
    {
        throw new Error(`WGSL fragment live system input ${semantic} is not supported`);
    }
    const scalarType = builtin?.scalarType || signature.componentTypeName;
    return {
        kind: "interface-field",
        id: `${direction}:r${signature.registerIndex}`,
        direction,
        registerIndex: signature.registerIndex,
        semanticName: signature.semanticName,
        semanticIndex: signature.semanticIndex,
        components,
        scalarType,
        type: builtin?.scalarType ? builtin.scalarType : fieldType(signature.componentTypeName, components.length),
        name: builtin?.name || `${direction}${signature.registerIndex}`,
        attribute: builtin
            ? { kind: "builtin", name: builtin.name }
            : { kind: "location", index: direction === "output" ? signature.semanticIndex : signature.registerIndex }
    };
}

function liveInputRegisters(program)
{
    const values = new Map(program.values.map((value) => [ value.id, value ]));
    const registers = new Set();
    for (const instruction of program.instructions)
    {
        for (const ref of instruction.dataflow.reads.flatMap((read) => read.refs))
        {
            const value = values.get(ref.valueId);
            if (value?.origin === "undefined-register")
            {
                throw new Error(`WGSL fragment instruction ${instruction.index} reads undefined ${value.register}.${ref.component}`);
            }
            const match = value?.origin === "program-input" && /^input\[(\d+)\]$/.exec(value.register);
            if (match) registers.add(Number(match[1]));
        }
    }
    return registers;
}

function validateInterpolation(program, input)
{
    if (input.attribute.kind === "builtin") return;
    const declaration = program.declarations.find((entry) =>
        entry.opcodeName === "dcl_input_ps" && entry.data?.registerIndex === input.registerIndex);
    const mode = declaration?.data?.interpolationModeName;
    if (mode && mode !== "linear")
    {
        throw new Error(`WGSL fragment input r${input.registerIndex} has unsupported interpolation ${mode}`);
    }
}

function sourceRead(instruction, operandIndex)
{
    return instruction.dataflow.reads.find((entry) =>
        entry.kind !== "index-read" && entry.operandIndex === operandIndex) || null;
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
    if (!from || !to) throw new Error(`WGSL fragment cannot resolve ${context} type ${fromType} to ${toType}`);
    if (from === to) return code;
    if (![ "f32", "i32", "u32" ].includes(from) || ![ "f32", "i32", "u32" ].includes(to))
    {
        throw new Error(`WGSL fragment cannot reinterpret ${context} from ${fromType} to ${toType}`);
    }
    return `bitcast<${fieldType(toType, count)}>(${code})`;
}

function valueReference(program, ref, inputs)
{
    const value = program.values.find((entry) => entry.id === ref.valueId);
    if (!value) throw new Error(`WGSL fragment references missing value ${ref.valueId}`);
    if (value.origin === "undefined-register") throw new Error(`WGSL fragment reads undefined ${value.register}.${ref.component}`);
    if (value.origin === "program-input")
    {
        const registerIndex = Number(/^input\[(\d+)\]$/.exec(value.register)?.[1]);
        const field = inputs.find((entry) => entry.registerIndex === registerIndex);
        if (!field) throw new Error(`WGSL fragment has no live input field for ${value.register}`);
        const packed = packedComponent(field.components.join(""), ref.component);
        const code = field.components.length === 1 ? `input.${field.name}` : `input.${field.name}.${packed}`;
        const target = value.componentTypes?.[ref.component];
        if (field.scalarType === "bool")
        {
            if (target === "bool") return code;
            if (target === "uint32" || target === "bitpattern32") return `select(0u, 0xffffffffu, ${code})`;
            if (target === "int32") return `select(0i, -1i, ${code})`;
            throw new Error(`WGSL fragment cannot consume boolean ${value.register}.${ref.component} as ${target}`);
        }
        return reinterpretCode(code, field.scalarType, target, 1, `${value.register}.${ref.component}`);
    }
    if (value.origin === "instruction-write" && value.writeMask.length > 1)
    {
        const componentTypes = Array.from(value.writeMask).map((component) => value.componentTypes?.[component]);
        if (new Set(componentTypes).size > 1) return `${value.id}_${ref.component}`;
    }
    const packed = packedComponent(value.writeMask, ref.component);
    return value.writeMask.length === 1 ? value.id : `${value.id}.${packed}`;
}

function rawSelectedComponents(operand, destinationMask, count, activeComponents = null)
{
    const selected = operand.selected || "";
    if (selected) return Array.from({ length: count }, () => selected);
    const swizzle = operand.swizzle || "xyzw";
    const mask = activeComponents || Array.from(destinationMask);
    return mask.slice(0, count).map((component) => swizzle[COMPONENTS.indexOf(component)] || swizzle[0]);
}

function immediateParts(operand, destinationMask, count, expectedType, activeComponents = null)
{
    const values = operand.immediateValues || [];
    const components = rawSelectedComponents(operand, destinationMask, count, activeComponents);
    return components.map((component, index) =>
    {
        const sourceIndex = values.length === 1 ? 0 : COMPONENTS.indexOf(component);
        const bits = values[sourceIndex]?.uint32 ?? values[index]?.uint32;
        if (!Number.isInteger(bits)) throw new Error("WGSL fragment immediate has no raw uint32 bits");
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
        if (matches.length > 1)
        {
            throw new Error(`WGSL fragment ${resourceKind} range ${rangeId} is ambiguous`);
        }
        return matches[0] || null;
    }
    return bindings.find((entry) =>
        entry.resourceKind === resourceKind && entry.registerIndex === operand.registerIndex) || null;
}

function cbufferVectorIndex(program, instruction, operandIndex, operand, inputs)
{
    const indices = operand.indices || [];
    for (let dimension = 0; dimension < indices.length - 1; dimension += 1)
    {
        if (indices[dimension].relative) throw new Error("WGSL fragment does not support dynamic cbuffer register selection");
    }
    const last = indices.at(-1);
    const base = last?.values?.length ? last.values[0] : (last?.relative ? 0 : undefined);
    if (!Number.isInteger(base) || base < 0) throw new Error("WGSL fragment cbuffer operand has no immediate vector index");
    if (!last.relative) return `${base}`;
    const read = instruction.dataflow.reads.find((entry) => entry.kind === "index-read"
        && entry.operandIndex === operandIndex && entry.dimension === indices.length - 1);
    if (!read || read.refs.length !== 1) throw new Error("WGSL fragment dynamic cbuffer index has no resolved register");
    const ref = read.refs[0];
    const storage = valueStorageType(program, ref);
    let indexCode = valueReference(program, ref, inputs);
    if (storage === "uint32" || storage === "bitpattern32") indexCode = `i32(${indexCode})`;
    else if (storage !== "int32") throw new Error(`WGSL fragment dynamic cbuffer index has unsupported type ${storage}`);
    return base === 0 ? indexCode : `${base} + ${indexCode}`;
}

function cbufferParts(program, instruction, operandIndex, operand, destinationMask, count, bindings, expectedType, inputs, activeComponents = null)
{
    const binding = bindingForOperand(bindings, "uniform-buffer", operand);
    if (!binding) throw new Error(`WGSL fragment cannot resolve cb${operand.registerIndex}`);
    const vectorIndex = cbufferVectorIndex(program, instruction, operandIndex, operand, inputs);
    const parts = rawSelectedComponents(operand, destinationMask, count, activeComponents)
        .map((component) => `${binding.generatedSymbol}[${vectorIndex}].${component}`);
    if (expectedType === "float32") return parts;
    if (![ "int32", "uint32", "bitpattern32" ].includes(expectedType))
    {
        throw new Error(`WGSL fragment cannot reinterpret cbuffer lanes as ${expectedType}`);
    }
    const target = scalarTypeName(expectedType);
    return parts.map((part) => `bitcast<${target}>(${part})`);
}

function icbParts(program, instruction, operandIndex, operand, destinationMask, count, expectedType, inputs, activeComponents = null)
{
    if (!program.immediateConstantBuffer?.length)
    {
        throw new Error(`WGSL fragment instruction ${instruction.index} has no immediate constant buffer`);
    }
    const vectorIndex = cbufferVectorIndex(program, instruction, operandIndex, operand, inputs);
    const parts = rawSelectedComponents(operand, destinationMask, count, activeComponents)
        .map((component) => `icb[${vectorIndex}].${component}`);
    if (expectedType === "float32") return parts;
    if (![ "int32", "uint32", "bitpattern32" ].includes(expectedType))
    {
        throw new Error(`WGSL fragment cannot reinterpret icb lanes as ${expectedType}`);
    }
    const target = scalarTypeName(expectedType);
    return parts.map((part) => `bitcast<${target}>(${part})`);
}

function applyModifier(parts, operand)
{
    const modifier = operand.modifierName || "none";
    if (modifier === "none") return parts;
    if (modifier === "neg") return parts.map((part) => `-(${part})`);
    if (modifier === "abs") return parts.map((part) => `abs(${part})`);
    if (modifier === "absneg") return parts.map((part) => `-(abs(${part}))`);
    throw new Error(`WGSL fragment operand modifier ${modifier} is not supported`);
}


function operandLaneExpression(program, instruction, operandIndex, destinationMask, laneIndex, targetType, inputs, bindings)
{
    const operand = instruction.operands[operandIndex];
    if (!operand) throw new Error(`WGSL fragment instruction ${instruction.index} has no operand ${operandIndex}`);
    if ((operand.minPrecisionName || "default") !== "default" || (operand.modifierName || "none") !== "none")
    {
        throw new Error(`WGSL fragment instruction ${instruction.index} lane operand ${operandIndex} uses an unsupported modifier`);
    }
    const read = sourceRead(instruction, operandIndex);
    if (read)
    {
        const replicated = read.refs.length === 1;
        if (!replicated && laneIndex >= read.refs.length)
        {
            throw new Error(`WGSL fragment instruction ${instruction.index} has too few source lanes`);
        }
        const ref = replicated ? read.refs[0] : read.refs[laneIndex];
        const storage = valueStorageType(program, ref);
        return reinterpretCode(valueReference(program, ref, inputs), storage, targetType, 1,
            `instruction ${instruction.index} lane read`);
    }
    const component = destinationMask[laneIndex];
    if (operand.typeName === "immediate32")
    {
        return immediateParts(operand, component, 1, targetType)[0];
    }
    if (operand.typeName === "constant_buffer")
    {
        return cbufferParts(program, instruction, operandIndex, operand, component, 1, bindings, targetType, inputs)[0];
    }
    throw new Error(`WGSL fragment instruction ${instruction.index} cannot lower ${operand.typeName} lane operand ${operandIndex}`);
}

function operandExpression(program, instruction, operandIndex, destinationMask, count, expectedType, inputs, bindings)
{
    const operand = instruction.operands[operandIndex];
    if (!operand) throw new Error(`WGSL fragment instruction ${instruction.index} has no operand ${operandIndex}`);
    if ((operand.minPrecisionName || "default") !== "default")
    {
        throw new Error(`WGSL fragment instruction ${instruction.index} uses minimum precision`);
    }
    const read = sourceRead(instruction, operandIndex);
    const activeComponents = fixedSourceLanes(instruction, operandIndex, program);
    let parts;
    if (read)
    {
        if (read.refs.length < count) throw new Error(`WGSL fragment instruction ${instruction.index} has too few source lanes`);
        parts = read.refs.slice(0, count).map((ref, componentIndex) =>
        {
            let part = valueReference(program, ref, inputs);
            const bitcast = instruction.typeInfo.bitcasts.find((entry) => entry.kind === "read-bitcast"
                && entry.operandIndex === operandIndex && entry.componentIndex === componentIndex
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
        parts = immediateParts(operand, destinationMask, count, expectedType, activeComponents);
    }
    else if (operand.typeName === "constant_buffer")
    {
        parts = cbufferParts(program, instruction, operandIndex, operand, destinationMask, count, bindings, expectedType, inputs, activeComponents);
    }
    else if (operand.typeName === "immediate_constant_buffer")
    {
        parts = icbParts(program, instruction, operandIndex, operand, destinationMask, count, expectedType, inputs, activeComponents);
    }
    else
    {
        throw new Error(`WGSL fragment instruction ${instruction.index} cannot lower ${operand.typeName} operand ${operandIndex}`);
    }
    return vectorCode(applyModifier(parts, operand), expectedType);
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
        if (read.kind === "index-read") continue;
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
        throw new Error(`WGSL fragment instruction ${instruction.index} has inconsistent register bitcast metadata`);
    }
}

function zeroMask(count)
{
    return count === 1 ? "0u" : `vec${count}<u32>(0u)`;
}

function fullMask(count)
{
    return count === 1 ? "0xffffffffu" : `vec${count}<u32>(0xffffffffu)`;
}

function floatBound(count, value)
{
    return count === 1 ? value : `vec${count}<f32>(${value})`;
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
        throw new Error(`WGSL fragment structured load ${instruction.index} requires four operands`);
    }
    const addressOperand = instruction.operands[1];
    if (!COMPONENTS.includes(addressOperand?.selected) || (addressOperand.modifierName || "none") !== "none")
    {
        throw new Error(`WGSL fragment structured load ${instruction.index} requires one unmodified scalar address`);
    }
    const address = operandExpression(program, instruction, 1, write.mask, 1, "uint32", inputs, bindings);
    const byteOffsetOperand = instruction.operands[2];
    const byteOffset = byteOffsetOperand?.immediateValues?.[0]?.uint32;
    if (byteOffsetOperand?.typeName !== "immediate32" || byteOffsetOperand.immediateValues?.length !== 1
        || (byteOffsetOperand.modifierName || "none") !== "none"
        || !Number.isInteger(byteOffset) || byteOffset % 4 !== 0)
    {
        throw new Error(`WGSL fragment structured load ${instruction.index} requires an immediate DWORD byte offset`);
    }
    const resource = instruction.operands[3];
    if (resource?.typeName !== "resource" || resource.indices?.some((entry) => entry.relative)
        || (resource.modifierName || "none") !== "none"
        || (resource.minPrecisionName || "default") !== "default")
    {
        throw new Error(`WGSL fragment structured load ${instruction.index} requires one fixed resource`);
    }
    const binding = bindingForOperand(bindings, "sampled-resource", resource);
    if (!binding?.buffer || !Number.isInteger(binding.structureStride))
    {
        throw new Error(`WGSL fragment structured load ${instruction.index} has no structured buffer binding`);
    }
    const strideWords = binding.structureStride / 4;
    const firstWord = byteOffset / 4;
    const swizzle = rawSelectedComponents(resource, write.mask, count);
    const selected = swizzle.map((component) =>
    {
        const index = COMPONENTS.indexOf(component);
        const word = firstWord + index;
        if (index < 0 || word >= strideWords)
        {
            throw new Error(`WGSL fragment structured load ${instruction.index} exceeds its ${binding.structureStride}-byte stride`);
        }
        return `${binding.generatedSymbol}[((${address}) * ${strideWords}u) + ${word}u]`;
    });
    if (type === null) return selected;
    const parts = selected.map((part) => reinterpretCode(part, "uint32", type.scalarType, 1,
        `structured load ${instruction.index}`));
    return vectorCode(parts, type.scalarType);
}

function expressionFor(program, instruction, write, inputs, bindings)
{
    const mask = write.mask;
    const count = mask.length;
    const source = (index, forcedCount = count) => operandExpression(
        program, instruction, index, mask, forcedCount, expectedType(instruction, index), inputs, bindings);
    const op = instruction.opcodeName;
    if ([ "add", "div", "iadd", "mul" ].includes(op))
    {
        const operator = { add: "+", div: "/", iadd: "+", mul: "*" }[op];
        return `(${source(1)} ${operator} ${source(2)})`;
    }
    if (op === "mad" || op === "imad" || op === "umad") return `((${source(1)} * ${source(2)}) + ${source(3)})`;
    if (op === "f16tof32" || op === "f32tof16")
    {
        const src = source(1);
        const lane = (index) => (count === 1 ? `(${src})` : `(${src})[${index}]`);
        const parts = Array.from({ length: count }, (_, index) => (op === "f16tof32"
            ? `unpack2x16float(${lane(index)}).x`
            : `(pack2x16float(vec2<f32>(${lane(index)}, 0.0)) & 0xffffu)`));
        return vectorCode(parts, op === "f16tof32" ? "float32" : "uint32");
    }
    if (op === "imul" || op === "umul")
    {
        if (write.operandIndex !== 1)
        {
            throw new Error(`WGSL fragment instruction ${instruction.index} does not support the ${op} high result`);
        }
        return `(${source(2)} * ${source(3)})`;
    }
    if (op === "max") return `max(${source(1)}, ${source(2)})`;
    if (op === "min") return `min(${source(1)}, ${source(2)})`;
    if (op === "and") return `(${source(1)} & ${source(2)})`;
    if (op === "or") return `(${source(1)} | ${source(2)})`;
    if (op === "xor") return `(${source(1)} ^ ${source(2)})`;
    if (op === "ushr") return `(${source(1)} >> ${source(2)})`;
    if ([ "lt", "ge", "eq", "ne", "ilt", "ige", "ieq", "ine", "ult", "uge" ].includes(op))
    {
        const operator = { lt: "<", ge: ">=", eq: "==", ne: "!=", ilt: "<", ige: ">=", ieq: "==", ine: "!=", ult: "<", uge: ">=" }[op];
        return `select(${zeroMask(count)}, ${fullMask(count)}, ${source(1)} ${operator} ${source(2)})`;
    }
    if (op === "mov") return source(1);
    if (op === "movc") return `select(${source(3)}, ${source(2)}, ${source(1)} != ${zeroMask(count)})`;
    if (op === "exp") return `exp2(${source(1)})`;
    if (op === "frc") return `fract(${source(1)})`;
    if (op === "log") return `log2(${source(1)})`;
    if (op === "round_ni") return `floor(${source(1)})`;
    if (op === "round_z") return `trunc(${source(1)})`;
    if (DERIVATIVES[op]) return `${DERIVATIVES[op]}(${source(1)})`;
    if (op === "rsq") return `inverseSqrt(${source(1)})`;
    if (op === "sqrt") return `sqrt(${source(1)})`;
    if (NUMERIC_CONVERSIONS[op])
    {
        const conversion = instruction.typeInfo.conversion;
        const [ from, to ] = NUMERIC_CONVERSIONS[op];
        if (conversion?.from !== from || conversion?.to !== to)
        {
            throw new Error(`WGSL fragment instruction ${instruction.index} has invalid ${op} conversion metadata`);
        }
        return `${fieldType(to, count)}(${source(1)})`;
    }
    if (op === "dp2") return splatScalar(`dot(${source(1, 2)}, ${source(2, 2)})`, count);
    if (op === "dp3") return splatScalar(`dot(${source(1, 3)}, ${source(2, 3)})`, count);
    if (op === "dp4") return splatScalar(`dot(${source(1, 4)}, ${source(2, 4)})`, count);
    if (op === "sincos")
    {
        const fn = write.operandIndex === 0 ? "sin" : write.operandIndex === 1 ? "cos" : null;
        if (!fn) throw new Error(`WGSL fragment sincos instruction ${instruction.index} has an unexpected destination operand`);
        return `${fn}(${source(2)})`;
    }
    if (op === "resinfo")
    {
        const resource = instruction.operands[2];
        const textureBinding = bindingForOperand(bindings, "sampled-resource", resource);
        if (!textureBinding) throw new Error(`WGSL fragment instruction ${instruction.index} has an unresolved resinfo resource`);
        if (textureBinding.texture?.viewDimension !== "2d")
        {
            throw new Error(`WGSL fragment resinfo instruction ${instruction.index} supports only 2d textures`);
        }
        const mipOperand = instruction.operands[1];
        const mipBits = mipOperand?.immediateValues?.[0]?.uint32;
        if (mipOperand?.typeName !== "immediate32" || !Number.isInteger(mipBits))
        {
            throw new Error(`WGSL fragment resinfo instruction ${instruction.index} requires an immediate mip level`);
        }
        const modifier = instruction.resinfoReturnTypeName || "float";
        const dims = `textureDimensions(${textureBinding.generatedSymbol}, ${mipBits})`;
        const parts = rawSelectedComponents(resource, mask, count).map((component) =>
        {
            let value;
            if (component === "x") value = `${dims}.x`;
            else if (component === "y") value = `${dims}.y`;
            else if (component === "w") value = `textureNumLevels(${textureBinding.generatedSymbol})`;
            else throw new Error(`WGSL fragment resinfo instruction ${instruction.index} cannot report component ${component} for a 2d texture`);
            if (modifier === "uint") return value;
            return modifier === "rcpfloat" ? `(1.0 / f32(${value}))` : `f32(${value})`;
        });
        return vectorCode(parts, modifier === "uint" ? "uint32" : "float32");
    }
    if (op === "ld_structured") return structuredLoadExpression(program, instruction, write, valueType(program, write), inputs, bindings);
    if (op === "ld")
    {
        const resource = instruction.operands[2];
        const textureBinding = bindingForOperand(bindings, "sampled-resource", resource);
        if (!textureBinding) throw new Error(`WGSL fragment instruction ${instruction.index} has an unresolved load resource`);
        if (textureBinding.texture?.viewDimension !== "2d")
        {
            throw new Error(`WGSL fragment load instruction ${instruction.index} supports only 2d textures`);
        }
        const address = source(1, 3);
        const loaded = `textureLoad(${textureBinding.generatedSymbol}, ${address}.xy, ${address}.z)`;
        const components = rawSelectedComponents(resource, mask, count);
        return count === 4 && components.join("") === "xyzw" ? loaded : `${loaded}.${components.join("")}`;
    }
    if (op === "sample" || op === "sample_b" || op === "sample_l")
    {
        const resource = instruction.operands[2];
        const sampler = instruction.operands[3];
        const textureBinding = bindingForOperand(bindings, "sampled-resource", resource);
        const samplerBinding = bindingForOperand(bindings, "sampler", sampler);
        if (!textureBinding || !samplerBinding) throw new Error(`WGSL fragment instruction ${instruction.index} has unresolved sample bindings`);
        const viewDimension = textureBinding.texture?.viewDimension;
        let coord;
        let arrayArg = "";
        if (viewDimension === "2d-array")
        {
            const coord3 = source(1, 3);
            coord = `${coord3}.xy`;
            arrayArg = `, i32(${coord3}.z)`;
        }
        else
        {
            coord = source(1, viewDimension === "2d" ? 2 : 3);
        }
        const tex = `${textureBinding.generatedSymbol}, ${samplerBinding.generatedSymbol}`;
        const sampled = op === "sample_b"
            ? `textureSampleBias(${tex}, ${coord}${arrayArg}, ${source(4, 1)})`
            : op === "sample_l"
                ? `textureSampleLevel(${tex}, ${coord}${arrayArg}, ${source(4, 1)})`
                : `textureSample(${tex}, ${coord}${arrayArg})`;
        const components = rawSelectedComponents(resource, mask, count);
        return count === 4 && components.join("") === "xyzw" ? sampled : `${sampled}.${components.join("")}`;
    }
    throw new Error(`WGSL fragment opcode ${op} at instruction ${instruction.index} is not supported`);
}

function applyResultBitcast(instruction, write, expression, type)
{
    const bitcasts = instruction.typeInfo.bitcasts.filter((entry) => entry.kind === "result-bitcast"
        && entry.operandIndex === write.operandIndex && entry.valueId === write.valueId);
    if (!bitcasts.length) return expression;
    const components = Array.from(write.mask);
    const intrinsicType = instruction.typeInfo.resultType;
    if (bitcasts.length !== components.length || bitcasts.some((entry) =>
        entry.from !== intrinsicType || entry.to !== type.scalarType)
        || components.some((component) => !bitcasts.some((entry) => entry.component === component)))
    {
        throw new Error(`WGSL fragment instruction ${instruction.index} has unsupported partial result bitcasts`);
    }
    return reinterpretCode(expression, intrinsicType, type.scalarType, components.length,
        `instruction ${instruction.index} result`);
}

function lowerInstruction(program, instruction, inputs, outputs, bindings, written, readValueIds)
{
    if (!SUPPORTED_OPCODES.has(instruction.opcodeName))
    {
        throw new Error(`WGSL fragment opcode ${instruction.opcodeName} at instruction ${instruction.index} is not supported`);
    }
    validatePreciseInstruction(instruction, "fragment");
    if (instruction.operands.some((operand) => (operand.minPrecisionName || "default") !== "default"))
    {
        throw new Error(`WGSL fragment instruction ${instruction.index} uses minimum precision`);
    }
    validateRegisterBitcasts(program, instruction);
    if (instruction.opcodeName === "ret")
    {
        for (const field of outputs)
        {
            const missing = field.components.filter((component) => !written.get(field.id).has(component));
            if (missing.length) throw new Error(`WGSL fragment output ${field.semanticName}${field.semanticIndex} leaves ${missing.join("")} unwritten before return`);
        }
        return { kind: "return", instructionIndex: instruction.index, dxbcOffset: instruction.dxbcOffset };
    }
    if (instruction.opcodeName === "discard")
    {
        const projection = instruction.testBoolean;
        const operand = instruction.operands[0];
        const read = sourceRead(instruction, 0);
        if (![ "zero", "nonzero" ].includes(projection))
        {
            throw new Error(`WGSL fragment discard instruction ${instruction.index} has no supported condition projection`);
        }
        const scalarShape = operand?.typeName === "immediate32"
            ? operand.immediateValues?.length === 1
            : COMPONENTS.includes(operand?.selected);
        if (instruction.operands.length !== 1 || !operand || !scalarShape || (read && read.refs.length !== 1))
        {
            throw new Error(`WGSL fragment discard instruction ${instruction.index} requires one scalar condition`);
        }
        if ((operand.modifierName || "none") !== "none")
        {
            throw new Error(`WGSL fragment discard instruction ${instruction.index} cannot modify its condition`);
        }
        if (instruction.saturate)
        {
            throw new Error(`WGSL fragment discard instruction ${instruction.index} cannot saturate its condition`);
        }
        const condition = operandExpression(program, instruction, 0, "x", 1, "uint32", inputs, bindings);
        return {
            kind: "if",
            instructionIndex: instruction.index,
            dxbcOffset: instruction.dxbcOffset,
            condition: { code: `${condition} ${projection === "zero" ? "==" : "!="} 0u`, type: "bool" },
            statements: [ { kind: "discard" } ]
        };
    }
    const writes = instruction.dataflow.writes;
    if (!writes.length) throw new Error(`WGSL fragment instruction ${instruction.index} has no result write`);
    const lowerWrite = (write) =>
    {
    if (isDeadUntypedWrite(program, instruction, write, readValueIds)) return [];
    const destination = instruction.operands[write.operandIndex];
        const mixedTypes = mixedImmediateTypes(program, write);
        if (mixedTypes)
        {
            if (instruction.opcodeName === "ld_structured" && destination?.typeName === "temp" && !instruction.saturate)
            {
                const words = structuredLoadExpression(program, instruction, write, null, inputs, bindings);
                return Array.from(write.mask).map((component, laneIndex) => ({
                    kind: "let",
                    instructionIndex: instruction.index,
                    dxbcOffset: instruction.dxbcOffset,
                    name: `${write.valueId}_${component}`,
                    type: scalarTypeName(mixedTypes[laneIndex]),
                    expression: {
                        code: reinterpretCode(words[laneIndex], "uint32", mixedTypes[laneIndex], 1, `structured load ${instruction.index}`),
                        type: scalarTypeName(mixedTypes[laneIndex])
                    }
                }));
            }
            const intrinsic = instruction.typeInfo.resultType;
            if (destination?.typeName === "temp" && scalarTypeName(intrinsic) && instruction.opcodeName !== "mov")
            {
                let packedCode = expressionFor(program, instruction, write, inputs, bindings);
                if (instruction.saturate)
                {
                    if (intrinsic !== "float32")
                    {
                        throw new Error(`WGSL fragment instruction ${instruction.index} saturates a non-float result`);
                    }
                    packedCode = `clamp(${packedCode}, ${floatBound(write.mask.length, "0.0")}, ${floatBound(write.mask.length, "1.0")})`;
                }
                const packedName = `${write.valueId}_p`;
                const packedType = fieldType(intrinsic, write.mask.length);
                const statements = [ {
                    kind: "let",
                    instructionIndex: instruction.index,
                    dxbcOffset: instruction.dxbcOffset,
                    name: packedName,
                    type: packedType,
                    expression: { code: packedCode, type: packedType }
                } ];
                Array.from(write.mask).forEach((component, laneIndex) =>
                {
                    const laneType = mixedTypes[laneIndex];
                    const access = write.mask.length === 1 ? packedName : `${packedName}.${COMPONENTS[laneIndex]}`;
                    statements.push({
                        kind: "let",
                        name: `${write.valueId}_${component}`,
                        type: scalarTypeName(laneType),
                        expression: {
                            code: reinterpretCode(access, intrinsic, laneType, 1, `mixed write ${instruction.index}`),
                            type: scalarTypeName(laneType)
                        }
                    });
                });
                return statements;
            }
            if (instruction.opcodeName === "movc" && destination?.typeName === "temp" && !instruction.saturate)
            {
                return Array.from(write.mask).map((component, laneIndex) =>
                {
                    const laneType = mixedTypes[laneIndex];
                    const condition = operandLaneExpression(program, instruction, 1, write.mask, laneIndex, "uint32", inputs, bindings);
                    const whenTrue = operandLaneExpression(program, instruction, 2, write.mask, laneIndex, laneType, inputs, bindings);
                    const whenFalse = operandLaneExpression(program, instruction, 3, write.mask, laneIndex, laneType, inputs, bindings);
                    return {
                        kind: "let",
                        instructionIndex: instruction.index,
                        dxbcOffset: instruction.dxbcOffset,
                        name: `${write.valueId}_${component}`,
                        type: scalarTypeName(laneType),
                        expression: {
                            code: `select(${whenFalse}, ${whenTrue}, ${condition} != 0u)`,
                            type: scalarTypeName(laneType)
                        }
                    };
                });
            }
            const immediateSource = instruction.operands[1];
            if (instruction.opcodeName !== "mov" || instruction.saturate
                || destination?.typeName !== "temp" || immediateSource?.typeName !== "immediate32")
            {
                throw new Error(`WGSL fragment value ${write.valueId} has an unresolved or mixed result type`);
            }
            return Array.from(write.mask).map((component, laneIndex) => ({
                kind: "let",
                instructionIndex: instruction.index,
                dxbcOffset: instruction.dxbcOffset,
                name: `${write.valueId}_${component}`,
                type: scalarTypeName(mixedTypes[laneIndex]),
                expression: {
                    code: immediateParts(immediateSource, component, 1, mixedTypes[laneIndex])[0],
                    type: scalarTypeName(mixedTypes[laneIndex])
                }
            }));
        }
    const type = valueType(program, write);
    let expression = expressionFor(program, instruction, write, inputs, bindings);
    if (instruction.saturate)
    {
        if (instruction.typeInfo.resultType !== "float32")
        {
            throw new Error(`WGSL fragment instruction ${instruction.index} saturates a non-float result`);
        }
        expression = `clamp(${expression}, ${floatBound(write.mask.length, "0.0")}, ${floatBound(write.mask.length, "1.0")})`;
    }
    expression = applyResultBitcast(instruction, write, expression, type);
    if (destination.typeName === "output")
    {
        const field = outputs.find((entry) => entry.registerIndex === destination.registerIndex);
        if (!field) throw new Error(`WGSL fragment instruction ${instruction.index} references undeclared output r${destination.registerIndex}`);
        const components = Array.from(write.mask).map((component) => packedComponent(field.components.join(""), component));
        Array.from(write.mask).forEach((component) => written.get(field.id).add(component));
        const outputType = fieldType(field.scalarType, write.mask.length);
        const assignmentExpression = reinterpretCode(
            expression,
            type.scalarType,
            field.scalarType,
            write.mask.length,
            `output ${field.semanticName}${field.semanticIndex}`
        );
        const assignment = {
            kind: "assignment",
            instructionIndex: instruction.index,
            dxbcOffset: instruction.dxbcOffset,
            target: { fieldId: field.id, components, type: outputType },
            expression: { code: assignmentExpression, type: outputType }
        };
        if (!readValueIds.has(write.valueId)) return assignment;
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
                instructionIndex: undefined,
                dxbcOffset: undefined,
                expression: {
                    code: reinterpretCode(write.valueId, type.scalarType, field.scalarType, write.mask.length,
                        `output ${field.semanticName}${field.semanticIndex}`),
                    type: outputType
                }
            }
        ];
    }
    if (destination.typeName !== "temp")
    {
        throw new Error(`WGSL fragment instruction ${instruction.index} writes unsupported ${destination.typeName}`);
    }
    return {
        kind: "let",
        instructionIndex: instruction.index,
        dxbcOffset: instruction.dxbcOffset,
        name: write.valueId,
        type: type.wgslType,
        expression: { code: expression, type: type.wgslType }
    };
    };
    const statements = writes.flatMap((write) =>
    {
        const lowered = lowerWrite(write);
        return Array.isArray(lowered) ? lowered : [ lowered ];
    });
    return statements.length === 1 ? statements[0] : statements;
}

function deepFreeze(value)
{
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
}


function containsOutputAssignment(statements)
{
    return statements.some((statement) => statement.kind === "assignment"
        || (statement.kind === "if" && (containsOutputAssignment(statement.statements)
            || (statement.elseStatements ? containsOutputAssignment(statement.elseStatements) : false)))
        || (statement.kind === "switch" && statement.clauses.some((clause) => containsOutputAssignment(clause.statements)))
        || (statement.kind === "loop" && containsOutputAssignment(statement.statements)));
}

/**
 * Lowers the bounded copyblit-style fragment slice with structured no-else
 * selections and scalar component merges.
 *
 * @param {object} program Frozen CJS shader IR.
 * @param {object} [options] Binding-plan and lowering options.
 * @returns {object} Frozen typed fragment program.
 */
export function lowerFragmentProgram(program, options = {})
{
    if (program?.format !== "CJS_SHADER_IR") throw new TypeError("WGSL fragment lowering expects CJS_SHADER_IR input");
    if (program.stage !== "pixel") throw new Error(`WGSL fragment lowering cannot lower ${program.stage}`);
    if (program.shaderModel.major !== 5 || ![ 0, 1 ].includes(program.shaderModel.minor))
    {
        throw new Error("WGSL fragment body slice currently supports only SM5.0/SM5.1");
    }
    requireRefactoringAllowed(program, "fragment");
    const liveRegisters = liveInputRegisters(program);
    const inputs = program.signatures.input
        .filter((entry) => liveRegisters.has(entry.registerIndex))
        .map((entry) => interfaceField(entry, "input"));
    const outputs = program.signatures.output.map((entry) => interfaceField(entry, "output"));
    if (!outputs.length) throw new Error("WGSL fragment body slice requires output signatures");
    inputs.forEach((input) => validateInterpolation(program, input));
    const bindings = lowerBindingLayout(program, options.bindingPlan);
    const plans = buildSelectionPlans(program, "fragment");
    const written = new Map(outputs.map((field) => [ field.id, new Set() ]));
    const readValueIds = new Set([
        ...program.instructions.flatMap((instruction) =>
            instruction.dataflow.reads.flatMap((read) => read.refs.map((ref) => ref.valueId))),
        ...program.values.flatMap((value) => (value.incoming || []).map((incoming) => incoming.valueId))
    ]);

    function lowerRange(start, end, rangeWritten, inLoop = false)
    {
        const statements = [];
        for (let index = start; index < end; index += 1)
        {
            const plan = plans.get(index);
            if (!plan)
            {
                const marker = program.instructions[index].opcodeName;
                if (marker === "break" || marker === "breakc")
                {
                    if (!inLoop) throw new Error(`WGSL fragment has an unmatched ${marker} at instruction ${index}`);
                    const breakInstruction = program.instructions[index];
                    if (marker === "break")
                    {
                        statements.push({ kind: "break", instructionIndex: breakInstruction.index, dxbcOffset: breakInstruction.dxbcOffset });
                        continue;
                    }
                    validatePreciseInstruction(breakInstruction, "fragment");
                    validateRegisterBitcasts(program, breakInstruction);
                    const conditionOperand = breakInstruction.operands[0];
                    const conditionRead = sourceRead(breakInstruction, 0);
                    if (breakInstruction.saturate || (conditionOperand?.modifierName || "none") !== "none"
                        || !COMPONENTS.includes(conditionOperand?.selected) || conditionRead?.refs.length !== 1
                        || ![ "zero", "nonzero" ].includes(breakInstruction.testBoolean))
                    {
                        throw new Error(`WGSL fragment breakc instruction ${breakInstruction.index} requires one unmodified scalar condition`);
                    }
                    const condition = operandExpression(program, breakInstruction, 0, "x", 1, "uint32", inputs, bindings);
                    statements.push({
                        kind: "if",
                        instructionIndex: breakInstruction.index,
                        dxbcOffset: breakInstruction.dxbcOffset,
                        condition: { code: `${condition} ${breakInstruction.testBoolean === "zero" ? "==" : "!="} 0u`, type: "bool" },
                        statements: [ { kind: "break" } ]
                    });
                    continue;
                }
                if ([ "endif", "else", "case", "default", "endswitch", "endloop" ].includes(marker))
                {
                    throw new Error(`WGSL fragment has an unmatched ${marker} at instruction ${index}`);
                }
                const lowered = lowerInstruction(
                    program, program.instructions[index], inputs, outputs, bindings, rangeWritten, readValueIds);
                statements.push(...(Array.isArray(lowered) ? lowered : [ lowered ]));
                continue;
            }
            if (plan.kind === "loop")
            {
                const loopInstruction = program.instructions[index];
                if (loopInstruction.opcodeName !== "loop"
                    || program.instructions[plan.region.endInstruction].opcodeName !== "endloop")
                {
                    throw new Error("WGSL fragment loop boundaries are malformed");
                }
                for (const merge of plan.merges)
                {
                    statements.push({ kind: "var", name: merge.id, type: merge.type,
                        expression: { code: valueReference(program, merge.entryIncoming, inputs), type: merge.type } });
                }
                const bodyWritten = cloneWritten(rangeWritten);
                const body = lowerRange(index + 1, plan.region.endInstruction, bodyWritten, true);
                if (body.at(-1)?.kind === "return")
                {
                    throw new Error(`WGSL fragment loop at ${index} terminates before latch assignments`);
                }
                for (const merge of plan.merges)
                {
                    body.push({ kind: "value-assignment", name: merge.id, type: merge.type,
                        expression: { code: valueReference(program, merge.backedgeIncoming, inputs), type: merge.type } });
                }
                statements.push({ kind: "loop", instructionIndex: loopInstruction.index, dxbcOffset: loopInstruction.dxbcOffset, statements: body });
                index = plan.region.endInstruction;
                continue;
            }
            if (plan.kind === "switch")
            {
                const switchInstruction = program.instructions[index];
                if (switchInstruction.opcodeName !== "switch"
                    || program.instructions[plan.region.endInstruction].opcodeName !== "endswitch")
                {
                    throw new Error("WGSL fragment switch boundaries are malformed");
                }
                validatePreciseInstruction(switchInstruction, "fragment");
                validateRegisterBitcasts(program, switchInstruction);
                const selectorOperand = switchInstruction.operands[0];
                const selectorRead = sourceRead(switchInstruction, 0);
                if (switchInstruction.saturate || (selectorOperand?.modifierName || "none") !== "none"
                    || !COMPONENTS.includes(selectorOperand?.selected) || selectorRead?.refs.length !== 1)
                {
                    throw new Error(`WGSL fragment switch instruction ${switchInstruction.index} requires one unmodified scalar selector`);
                }
                for (const merge of plan.merges)
                {
                    statements.push({ kind: "var", name: merge.id, type: merge.type, expression: { code: merge.zeroCode, type: merge.type } });
                }
                const selector = operandExpression(program, switchInstruction, 0, "x", 1, "uint32", inputs, bindings);
                const clauses = [];
                const clauseResults = [];
                for (let clauseIndex = 0; clauseIndex < plan.clauses.length; clauseIndex += 1)
                {
                    const clause = plan.clauses[clauseIndex];
                    const clauseWritten = cloneWritten(rangeWritten);
                    const body = lowerRange(clause.bodyStart, clause.bodyEnd, clauseWritten);
                    if ((plan.merges.length || plan.outerMerges?.length) && containsOutputAssignment(body))
                    {
                        throw new Error(`WGSL fragment switch at ${index} writes output before a live merge`);
                    }
                    if (body.at(-1)?.kind === "return" && (plan.merges.length || plan.outerMerges?.length))
                    {
                        throw new Error(`WGSL fragment switch at ${index} terminates before merge assignments`);
                    }
                    for (const merge of [ ...plan.merges, ...(plan.outerMerges || []) ])
                    {
                        body.push({
                            kind: "value-assignment",
                            name: merge.id,
                            type: merge.type,
                            expression: { code: valueReference(program, merge.perClause[clauseIndex], inputs), type: merge.type }
                        });
                    }
                    clauses.push({ selectors: clause.selectors, isDefault: clause.isDefault, statements: body });
                    clauseResults.push({ clauseWritten, returns: body.at(-1)?.kind === "return" });
                }
                statements.push({
                    kind: "switch",
                    instructionIndex: switchInstruction.index,
                    dxbcOffset: switchInstruction.dxbcOffset,
                    selector: { code: selector, type: "u32" },
                    clauses
                });
                if (plan.region.defaultInstruction !== null)
                {
                    const continuing = clauseResults.filter((entry) => !entry.returns);
                    for (const [ fieldId, target ] of rangeWritten)
                    {
                        if (!continuing.length) break;
                        const sets = continuing.map((entry) => entry.clauseWritten.get(fieldId) || new Set());
                        for (const component of sets[0])
                        {
                            if (sets.every((set) => set.has(component))) target.add(component);
                        }
                    }
                }
                if (terminatesAllPaths(statements))
                {
                    return statements;
                }
                index = plan.region.endInstruction;
                continue;
            }
            const ifInstruction = program.instructions[index];
            const endInstruction = program.instructions[plan.region.endInstruction];
            if (ifInstruction.opcodeName !== "if" || endInstruction.opcodeName !== "endif"
                || (plan.hasElse && program.instructions[plan.region.elseInstruction].opcodeName !== "else"))
            {
                throw new Error("WGSL fragment selection boundaries are malformed");
            }
            validatePreciseInstruction(ifInstruction, "fragment");
            validateRegisterBitcasts(program, ifInstruction);
            const conditionOperand = ifInstruction.operands[0];
            const conditionRead = sourceRead(ifInstruction, 0);
            if (ifInstruction.saturate || (conditionOperand?.modifierName || "none") !== "none"
                || !COMPONENTS.includes(conditionOperand?.selected) || conditionRead?.refs.length !== 1)
            {
                throw new Error(`WGSL fragment if instruction ${ifInstruction.index} requires one unmodified scalar condition`);
            }
            for (const merge of plan.merges)
            {
                const expression = plan.hasElse
                    ? merge.zeroCode
                    : (merge.falseCode || valueReference(program, merge.falseIncoming, inputs));
                statements.push({ kind: "var", name: merge.id, type: merge.type, expression: { code: expression, type: merge.type } });
            }
            const condition = operandExpression(program, ifInstruction, 0, "x", 1, "uint32", inputs, bindings);
            const comparison = ifInstruction.testBoolean === "zero" ? "==" : "!=";
            const trueBodyEnd = plan.hasElse ? plan.region.elseInstruction : plan.region.endInstruction;
            const trueWritten = cloneWritten(rangeWritten);
            const trueStatements = lowerRange(index + 1, trueBodyEnd, trueWritten, inLoop);
            if (plan.merges.length && containsOutputAssignment(trueStatements))
            {
                throw new Error(`WGSL fragment selection at ${index} writes output before a live merge`);
            }
            if (trueStatements.at(-1)?.kind === "return" && plan.merges.length)
            {
                throw new Error(`WGSL fragment selection at ${index} terminates before merge assignments`);
            }
            for (const merge of plan.merges)
            {
                if (merge.viaSwitch) continue;
                trueStatements.push({
                    kind: "value-assignment",
                    name: merge.id,
                    type: merge.type,
                    expression: { code: valueReference(program, merge.trueIncoming, inputs), type: merge.type }
                });
            }
            let falseStatements = null;
            let falseWritten = null;
            if (plan.hasElse)
            {
                falseWritten = cloneWritten(rangeWritten);
                falseStatements = lowerRange(plan.region.elseInstruction + 1, plan.region.endInstruction, falseWritten, inLoop);
                if (plan.merges.length && containsOutputAssignment(falseStatements))
                {
                    throw new Error(`WGSL fragment selection at ${index} writes output before a live merge`);
                }
                if (falseStatements.at(-1)?.kind === "return" && plan.merges.length)
                {
                    throw new Error(`WGSL fragment selection at ${index} terminates before merge assignments`);
                }
                for (const merge of plan.merges)
                {
                    falseStatements.push({
                        kind: "value-assignment",
                        name: merge.id,
                        type: merge.type,
                        expression: { code: merge.falseCode || valueReference(program, merge.falseIncoming, inputs), type: merge.type }
                    });
                }
            }
            statements.push({
                kind: "if",
                instructionIndex: ifInstruction.index,
                dxbcOffset: ifInstruction.dxbcOffset,
                condition: { code: `${condition} ${comparison} 0u`, type: "bool" },
                statements: trueStatements,
                ...(falseStatements ? { elseStatements: falseStatements } : {})
            });
            if (plan.hasElse)
            {
                const trueReturns = trueStatements.at(-1)?.kind === "return";
                const falseReturns = falseStatements.at(-1)?.kind === "return";
                for (const [ fieldId, target ] of rangeWritten)
                {
                    const fromTrue = trueWritten.get(fieldId) || new Set();
                    const fromFalse = falseWritten.get(fieldId) || new Set();
                    if (trueReturns && !falseReturns) for (const component of fromFalse) target.add(component);
                    else if (falseReturns && !trueReturns) for (const component of fromTrue) target.add(component);
                    else if (!trueReturns && !falseReturns)
                    {
                        for (const component of fromTrue) if (fromFalse.has(component)) target.add(component);
                    }
                }
            }
            if (terminatesAllPaths(statements))
            {
                return statements;
            }
            index = plan.region.endInstruction;
        }
        return statements;
    }

    const lowered = lowerRange(0, program.instructions.length, written);
    if (!terminatesAllPaths(lowered)) throw new Error("WGSL fragment path must end in return");
    const statements = hoistEscapingValues(lowered);
    return deepFreeze({
        kind: "typed-shader-program",
        format: "CJS_TYPED_SHADER",
        formatVersion: 1,
        source: program.source,
        stage: "fragment",
        entryPoint: "main",
        interface: { inputs, outputs },
        bindings,
        immediateConstantBuffer: program.immediateConstantBuffer || null,
        statements
    });
}
