import { lowerBindingLayout } from "./lowerBindingLayout.js";

const COMPONENTS = [ "x", "y", "z", "w" ];
const SUPPORTED_OPCODES = new Set([
    "add", "and", "div", "dp2", "dp3", "exp", "ge", "log", "lt", "mad",
    "max", "mov", "movc", "mul", "rsq", "sample", "sample_b", "sqrt",
    "if", "endif", "ret"
]);

function componentsFromMask(mask)
{
    return COMPONENTS.filter((_, index) => (mask & (1 << index)) !== 0);
}

function scalarTypeName(type)
{
    return ({ float32: "f32", int32: "i32", uint32: "u32", bool: "bool", bitpattern32: "u32" })[type] || null;
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
    const builtin = direction === "input" && semantic === "SV_POSITION" ? "position" : null;
    if (direction === "input" && semantic.startsWith("SV_") && !builtin)
    {
        throw new Error(`WGSL fragment live system input ${semantic} is not supported`);
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
    return instruction.dataflow.reads.find((entry) => entry.operandIndex === operandIndex) || null;
}

function vectorCode(parts, scalarType)
{
    if (parts.length === 1) return parts[0];
    return `vec${parts.length}<${scalarTypeName(scalarType)}>(${parts.join(", ")})`;
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
        return field.components.length === 1 ? `input.${field.name}` : `input.${field.name}.${packed}`;
    }
    const packed = packedComponent(value.writeMask, ref.component);
    return value.writeMask.length === 1 ? value.id : `${value.id}.${packed}`;
}

function rawSelectedComponents(operand, destinationMask, count)
{
    const selected = operand.selected || "";
    if (selected) return Array.from({ length: count }, () => selected);
    const swizzle = operand.swizzle || "xyzw";
    const mask = Array.from(destinationMask);
    return mask.slice(0, count).map((component) => swizzle[COMPONENTS.indexOf(component)] || swizzle[0]);
}

function immediateParts(operand, destinationMask, count, expectedType)
{
    const values = operand.immediateValues || [];
    const components = rawSelectedComponents(operand, destinationMask, count);
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

function cbufferParts(operand, destinationMask, count, bindings)
{
    const binding = bindingForOperand(bindings, "uniform-buffer", operand);
    if (!binding) throw new Error(`WGSL fragment cannot resolve cb${operand.registerIndex}`);
    if (operand.indices?.some((entry) => entry.relative)) throw new Error("WGSL fragment does not support relative cbuffer indexing");
    const vectorIndex = operand.indices?.at(-1)?.values?.[0];
    if (!Number.isInteger(vectorIndex)) throw new Error("WGSL fragment cbuffer operand has no immediate vector index");
    return rawSelectedComponents(operand, destinationMask, count)
        .map((component) => `${binding.generatedSymbol}[${vectorIndex}].${component}`);
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

function operandExpression(program, instruction, operandIndex, destinationMask, count, expectedType, inputs, bindings)
{
    const operand = instruction.operands[operandIndex];
    if (!operand) throw new Error(`WGSL fragment instruction ${instruction.index} has no operand ${operandIndex}`);
    if ((operand.minPrecisionName || "default") !== "default")
    {
        throw new Error(`WGSL fragment instruction ${instruction.index} uses minimum precision`);
    }
    const read = sourceRead(instruction, operandIndex);
    let parts;
    if (read)
    {
        if (read.refs.length < count) throw new Error(`WGSL fragment instruction ${instruction.index} has too few source lanes`);
        parts = read.refs.slice(0, count).map((ref) => valueReference(program, ref, inputs));
    }
    else if (operand.typeName === "immediate32")
    {
        parts = immediateParts(operand, destinationMask, count, expectedType);
    }
    else if (operand.typeName === "constant_buffer")
    {
        parts = cbufferParts(operand, destinationMask, count, bindings);
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

function expressionFor(program, instruction, write, inputs, bindings)
{
    const mask = write.mask;
    const count = mask.length;
    const source = (index, forcedCount = count) => operandExpression(
        program, instruction, index, mask, forcedCount, expectedType(instruction, index), inputs, bindings);
    const op = instruction.opcodeName;
    if ([ "add", "div", "mul" ].includes(op))
    {
        const operator = { add: "+", div: "/", mul: "*" }[op];
        return `(${source(1)} ${operator} ${source(2)})`;
    }
    if (op === "mad") return `((${source(1)} * ${source(2)}) + ${source(3)})`;
    if (op === "max") return `max(${source(1)}, ${source(2)})`;
    if (op === "and") return `(${source(1)} & ${source(2)})`;
    if (op === "lt" || op === "ge")
    {
        const operator = op === "lt" ? "<" : ">=";
        return `select(${zeroMask(count)}, ${fullMask(count)}, ${source(1)} ${operator} ${source(2)})`;
    }
    if (op === "mov") return source(1);
    if (op === "movc") return `select(${source(3)}, ${source(2)}, ${source(1)} != ${zeroMask(count)})`;
    if (op === "exp") return `exp2(${source(1)})`;
    if (op === "log") return `log2(${source(1)})`;
    if (op === "rsq") return `inverseSqrt(${source(1)})`;
    if (op === "sqrt") return `sqrt(${source(1)})`;
    if (op === "dp2") return `dot(${source(1, 2)}, ${source(2, 2)})`;
    if (op === "dp3") return `dot(${source(1, 3)}, ${source(2, 3)})`;
    if (op === "sample" || op === "sample_b")
    {
        const resource = instruction.operands[2];
        const sampler = instruction.operands[3];
        const textureBinding = bindingForOperand(bindings, "sampled-resource", resource);
        const samplerBinding = bindingForOperand(bindings, "sampler", sampler);
        if (!textureBinding || !samplerBinding) throw new Error(`WGSL fragment instruction ${instruction.index} has unresolved sample bindings`);
        const sampled = op === "sample_b"
            ? `textureSampleBias(${textureBinding.generatedSymbol}, ${samplerBinding.generatedSymbol}, ${source(1, 2)}, ${source(4, 1)})`
            : `textureSample(${textureBinding.generatedSymbol}, ${samplerBinding.generatedSymbol}, ${source(1, 2)})`;
        const components = rawSelectedComponents(resource, mask, count);
        return count === 4 && components.join("") === "xyzw" ? sampled : `${sampled}.${components.join("")}`;
    }
    throw new Error(`WGSL fragment opcode ${op} at instruction ${instruction.index} is not supported`);
}

function lowerInstruction(program, instruction, inputs, outputs, bindings, written)
{
    if (!SUPPORTED_OPCODES.has(instruction.opcodeName))
    {
        throw new Error(`WGSL fragment opcode ${instruction.opcodeName} at instruction ${instruction.index} is not supported`);
    }
    if (instruction.preciseMask)
    {
        throw new Error(`WGSL fragment instruction ${instruction.index} uses precise controls ${instruction.preciseMask}`);
    }
    if (instruction.opcodeName === "ret")
    {
        for (const field of outputs)
        {
            const missing = field.components.filter((component) => !written.get(field.id).has(component));
            if (missing.length) throw new Error(`WGSL fragment output ${field.semanticName}${field.semanticIndex} leaves ${missing.join("")} unwritten before return`);
        }
        return { kind: "return", instructionIndex: instruction.index, dxbcOffset: instruction.dxbcOffset };
    }
    const write = instruction.dataflow.writes[0];
    if (!write) throw new Error(`WGSL fragment instruction ${instruction.index} has no result write`);
    const destination = instruction.operands[write.operandIndex];
    const type = valueType(program, write);
    let expression = expressionFor(program, instruction, write, inputs, bindings);
    if (instruction.saturate)
    {
        if (type.scalarType !== "float32")
        {
            throw new Error(`WGSL fragment instruction ${instruction.index} saturates a non-float result`);
        }
        expression = `clamp(${expression}, ${floatBound(write.mask.length, "0.0")}, ${floatBound(write.mask.length, "1.0")})`;
    }
    if (destination.typeName === "output")
    {
        const field = outputs.find((entry) => entry.registerIndex === destination.registerIndex);
        if (!field) throw new Error(`WGSL fragment instruction ${instruction.index} references undeclared output r${destination.registerIndex}`);
        const components = Array.from(write.mask).map((component) => packedComponent(field.components.join(""), component));
        Array.from(write.mask).forEach((component) => written.get(field.id).add(component));
        return {
            kind: "assignment",
            instructionIndex: instruction.index,
            dxbcOffset: instruction.dxbcOffset,
            target: { fieldId: field.id, components, type: type.wgslType },
            expression: { code: expression, type: type.wgslType }
        };
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
}

function deepFreeze(value)
{
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
}

function cloneWritten(written)
{
    return new Map(Array.from(written, ([ key, value ]) => [ key, new Set(value) ]));
}

function blockForInstruction(program, instructionIndex)
{
    return program.blocks.find((block) => instructionIndex >= block.startInstruction && instructionIndex <= block.endInstruction) || null;
}

function zeroForType(type)
{
    return ({ float32: "0.0", int32: "0i", uint32: "0u", bool: "false" })[type] || null;
}

function buildDominators(program)
{
    const reachable = program.blocks.filter((block) => block.reachable !== false);
    const all = new Set(reachable.map((block) => block.id));
    const entry = reachable[0];
    const dominators = new Map(reachable.map((block) => [ block.id, block === entry ? new Set([ block.id ]) : new Set(all) ]));
    let changed = true;
    while (changed)
    {
        changed = false;
        for (const block of reachable.slice(1))
        {
            const predecessors = block.predecessors
                .map((edge) => dominators.get(edge.blockId))
                .filter(Boolean);
            const next = predecessors.length ? new Set(predecessors[0]) : new Set();
            for (const candidate of Array.from(next))
            {
                if (predecessors.some((set) => !set.has(candidate))) next.delete(candidate);
            }
            next.add(block.id);
            const current = dominators.get(block.id);
            if (next.size !== current.size || Array.from(next).some((id) => !current.has(id)))
            {
                dominators.set(block.id, next);
                changed = true;
            }
        }
    }
    return dominators;
}

function liveMergeIds(program, values)
{
    const live = new Set();
    const visiting = new Set();
    function visit(id)
    {
        const value = values.get(id);
        if (value?.origin !== "control-flow-merge" || live.has(id)) return;
        if (visiting.has(id)) throw new Error(`WGSL fragment merge graph contains a cycle at ${id}`);
        visiting.add(id);
        for (const incoming of value.incoming) visit(incoming.valueId);
        visiting.delete(id);
        live.add(id);
    }
    for (const instruction of program.instructions)
    {
        for (const ref of instruction.dataflow.reads.flatMap((read) => read.refs)) visit(ref.valueId);
    }
    return live;
}

function definitionDominates(value, targetBlockId, targetInstruction, dominators)
{
    if (value?.origin === "program-input") return true;
    if (!value?.blockId || !dominators.get(targetBlockId)?.has(value.blockId)) return false;
    return value.blockId !== targetBlockId
        || value.origin !== "instruction-write"
        || value.instructionIndex < targetInstruction;
}

function extendUndefinedPaths(paths, conditionId, nonzero)
{
    const extended = [];
    for (const path of paths)
    {
        const existing = path.get(conditionId);
        if (existing !== undefined && existing !== nonzero) continue;
        const next = new Map(path);
        next.set(conditionId, nonzero);
        extended.push(next);
    }
    return extended;
}

function validateUndefinedMergePaths(program, live, values, plans)
{
    const mergePlans = new Map();
    for (const plan of plans.values())
    {
        for (const merge of plan.merges) mergePlans.set(merge.id, { plan, merge });
    }
    const memo = new Map();
    const visiting = new Set();

    function undefinedPaths(valueId)
    {
        const value = values.get(valueId);
        if (value?.origin === "undefined-register") return [ new Map() ];
        if (value?.origin !== "control-flow-merge" || !live.has(valueId)) return [];
        if (memo.has(valueId)) return memo.get(valueId);
        if (visiting.has(valueId)) throw new Error(`WGSL fragment merge graph contains a cycle at ${valueId}`);
        const entry = mergePlans.get(valueId);
        if (!entry) throw new Error(`WGSL fragment merge ${valueId} has no selection plan`);
        visiting.add(valueId);
        const { plan, merge } = entry;
        const trueRequiresNonzero = plan.testBoolean !== "zero";
        const paths = [
            ...extendUndefinedPaths(undefinedPaths(merge.falseIncoming.valueId), plan.conditionId, !trueRequiresNonzero),
            ...extendUndefinedPaths(undefinedPaths(merge.trueIncoming.valueId), plan.conditionId, trueRequiresNonzero)
        ];
        visiting.delete(valueId);
        memo.set(valueId, paths);
        return paths;
    }

    for (const id of live)
    {
        const directlyRead = program.instructions.some((instruction) => instruction.dataflow.reads
            .some((read) => read.refs.some((ref) => ref.valueId === id)));
        if (directlyRead && undefinedPaths(id).length)
        {
            throw new Error(`WGSL fragment merge ${id} has an observable undefined path`);
        }
    }
}

function buildSelectionPlans(program)
{
    const values = new Map(program.values.map((value) => [ value.id, value ]));
    const live = liveMergeIds(program, values);
    const dominators = buildDominators(program);
    const plans = new Map();
    for (const region of program.controlFlow.regions)
    {
        if (region.kind !== "selection" || region.elseInstruction !== null)
        {
            throw new Error("WGSL fragment body slice supports only no-else selections");
        }
        const header = blockForInstruction(program, region.startInstruction);
        const join = blockForInstruction(program, region.endInstruction);
        if (!header || !join || header.endInstruction !== region.startInstruction || join.startInstruction !== region.endInstruction)
        {
            throw new Error(`WGSL fragment selection at ${region.startInstruction} has malformed block boundaries`);
        }
        const mergeIds = (join.mergeSite?.valueIds || []).filter((id) => live.has(id));
        const truePredecessors = join.predecessors.filter((edge) => edge.blockId !== header.id);
        if (mergeIds.length && (join.predecessors.length !== 2 || truePredecessors.length !== 1))
        {
            throw new Error(`WGSL fragment selection at ${region.startInstruction} has unsupported merge predecessors`);
        }
        const trueBlockId = truePredecessors[0]?.blockId || null;
        const ifInstruction = program.instructions[region.startInstruction];
        const conditionRefs = ifInstruction.dataflow.reads.flatMap((read) => read.refs);
        const conditionId = conditionRefs.length === 1
            ? conditionRefs[0].valueId
            : `selection:${region.startInstruction}`;
        const testBoolean = ifInstruction.testBoolean === "zero" ? "zero" : "nonzero";
        const merges = mergeIds.map((id) =>
        {
            const value = values.get(id);
            const type = value?.componentTypes?.[value.writeMask];
            const wgslType = scalarTypeName(type);
            if (!value || value.origin !== "control-flow-merge" || value.incoming.length !== 2
                || value.writeMask.length !== 1 || type !== "float32" || !wgslType
                || value.incoming.some((incoming) => incoming.kind !== "predecessor"))
            {
                throw new Error(`WGSL fragment merge ${id} is not a scalar float predecessor phi`);
            }
            const falseIncoming = value.incoming.find((incoming) => incoming.blockId === header.id);
            const trueIncoming = value.incoming.find((incoming) => incoming.blockId === trueBlockId);
            if (!falseIncoming || !trueIncoming || [ falseIncoming, trueIncoming ].some((incoming) => mergeIds.includes(incoming.valueId)))
            {
                throw new Error(`WGSL fragment merge ${id} has unsupported incoming edges`);
            }
            const falseValue = values.get(falseIncoming.valueId);
            const trueValue = values.get(trueIncoming.valueId);
            let falseCode;
            let undefinedFallback = false;
            if (falseValue?.origin === "undefined-register")
            {
                falseCode = zeroForType(type);
                undefinedFallback = true;
                if (!falseCode)
                {
                    throw new Error(`WGSL fragment merge ${id} has an observable undefined false input`);
                }
            }
            else if (!definitionDominates(falseValue, header.id, region.startInstruction, dominators))
            {
                throw new Error(`WGSL fragment merge ${id} false input does not dominate its declaration`);
            }
            if (trueValue?.origin === "undefined-register"
                || !definitionDominates(trueValue, trueBlockId, program.blocks.find((block) => block.id === trueBlockId).endInstruction + 1, dominators))
            {
                throw new Error(`WGSL fragment merge ${id} true input does not dominate its edge`);
            }
            return { id, type: wgslType, falseIncoming, trueIncoming, falseCode, undefinedFallback };
        });
        plans.set(region.startInstruction, {
            region,
            header,
            join,
            trueBlockId,
            conditionId,
            testBoolean,
            merges
        });
    }

    validateUndefinedMergePaths(program, live, values, plans);

    for (const id of live)
    {
        const value = values.get(id);
        for (const instruction of program.instructions)
        {
            if (!instruction.dataflow.reads.some((read) => read.refs.some((ref) => ref.valueId === id))) continue;
            const useBlock = blockForInstruction(program, instruction.index);
            if (!dominators.get(useBlock.id)?.has(value.blockId))
            {
                throw new Error(`WGSL fragment merge ${id} does not dominate instruction ${instruction.index}`);
            }
        }
        for (const downstreamId of live)
        {
            const downstream = values.get(downstreamId);
            for (const incoming of downstream.incoming.filter((entry) => entry.valueId === id))
            {
                if (!dominators.get(incoming.blockId)?.has(value.blockId))
                {
                    throw new Error(`WGSL fragment merge ${id} does not dominate downstream edge ${incoming.blockId}`);
                }
            }
        }
    }
    return plans;
}

function containsOutputAssignment(statements)
{
    return statements.some((statement) => statement.kind === "assignment"
        || (statement.kind === "if" && containsOutputAssignment(statement.statements)));
}

/**
 * Lowers the bounded copyblit-style fragment slice with structured no-else
 * selections and scalar component merges.
 *
 * @param {object} program Frozen CJS shader IR.
 * @returns {object} Frozen typed fragment program.
 */
export function lowerFragmentProgram(program)
{
    if (program?.format !== "CJS_SHADER_IR") throw new TypeError("WGSL fragment lowering expects CJS_SHADER_IR input");
    if (program.stage !== "pixel") throw new Error(`WGSL fragment lowering cannot lower ${program.stage}`);
    if (program.shaderModel.major !== 5 || ![ 0, 1 ].includes(program.shaderModel.minor))
    {
        throw new Error("WGSL fragment body slice currently supports only SM5.0/SM5.1");
    }
    const liveRegisters = liveInputRegisters(program);
    const inputs = program.signatures.input
        .filter((entry) => liveRegisters.has(entry.registerIndex))
        .map((entry) => interfaceField(entry, "input"));
    const outputs = program.signatures.output.map((entry) => interfaceField(entry, "output"));
    if (!inputs.length || !outputs.length) throw new Error("WGSL fragment body slice requires live input and output signatures");
    inputs.forEach((input) => validateInterpolation(program, input));
    const bindings = lowerBindingLayout(program);
    const plans = buildSelectionPlans(program);
    const written = new Map(outputs.map((field) => [ field.id, new Set() ]));

    function lowerRange(start, end, rangeWritten)
    {
        const statements = [];
        for (let index = start; index < end; index += 1)
        {
            const plan = plans.get(index);
            if (!plan)
            {
                if (program.instructions[index].opcodeName === "endif")
                {
                    throw new Error(`WGSL fragment has an unmatched endif at instruction ${index}`);
                }
                statements.push(lowerInstruction(program, program.instructions[index], inputs, outputs, bindings, rangeWritten));
                continue;
            }
            const ifInstruction = program.instructions[index];
            const endInstruction = program.instructions[plan.region.endInstruction];
            if (ifInstruction.opcodeName !== "if" || endInstruction.opcodeName !== "endif")
            {
                throw new Error("WGSL fragment selection boundaries are malformed");
            }
            for (const merge of plan.merges)
            {
                const expression = merge.falseCode || valueReference(program, merge.falseIncoming, inputs);
                statements.push({ kind: "var", name: merge.id, type: merge.type, expression: { code: expression, type: merge.type } });
            }
            const condition = operandExpression(program, ifInstruction, 0, "x", 1, "uint32", inputs, bindings);
            const comparison = ifInstruction.testBoolean === "zero" ? "==" : "!=";
            const trueWritten = cloneWritten(rangeWritten);
            const trueStatements = lowerRange(index + 1, plan.region.endInstruction, trueWritten);
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
                trueStatements.push({
                    kind: "value-assignment",
                    name: merge.id,
                    type: merge.type,
                    expression: { code: valueReference(program, merge.trueIncoming, inputs), type: merge.type }
                });
            }
            statements.push({
                kind: "if",
                instructionIndex: ifInstruction.index,
                dxbcOffset: ifInstruction.dxbcOffset,
                condition: { code: `${condition} ${comparison} 0u`, type: "bool" },
                statements: trueStatements
            });
            index = plan.region.endInstruction;
        }
        return statements;
    }

    const statements = lowerRange(0, program.instructions.length, written);
    if (statements.at(-1)?.kind !== "return") throw new Error("WGSL fragment path must end in return");
    return deepFreeze({
        kind: "typed-shader-program",
        format: "CJS_TYPED_SHADER",
        formatVersion: 1,
        source: program.source,
        stage: "fragment",
        entryPoint: "main",
        interface: { inputs, outputs },
        bindings,
        statements
    });
}
