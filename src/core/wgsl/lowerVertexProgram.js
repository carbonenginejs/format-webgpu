const COMPONENTS = [ "x", "y", "z", "w" ];
const SYSTEM_BUILTINS = Object.freeze({
    SV_POSITION: "position"
});

function componentsFromMask(mask)
{
    return COMPONENTS.filter((_, index) => (mask & (1 << index)) !== 0);
}

function wgslScalar(type)
{
    const types = {
        float32: "f32",
        int32: "i32",
        uint32: "u32",
        bool: "bool",
        bitpattern32: "u32"
    };
    return types[type] || null;
}

function fieldType(scalarType, count)
{
    const scalar = wgslScalar(scalarType);
    if (!scalar) throw new Error(`WGSL interface cannot use unresolved scalar type ${scalarType}`);
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
        const scalarType = signature.componentTypeName;
        return {
            kind: "interface-field",
            id: `${direction}:r${signature.registerIndex}`,
            direction,
            registerIndex: signature.registerIndex,
            semanticName: signature.semanticName,
            semanticIndex: signature.semanticIndex,
            components,
            scalarType,
            type: fieldType(scalarType, components.length),
            name: builtin || `${direction}${signature.registerIndex}`,
            attribute: builtin
                ? { kind: "builtin", name: builtin }
                : { kind: "location", index: signature.registerIndex }
        };
    });
}

function packedComponents(field, registerComponents)
{
    return registerComponents.map((component) =>
    {
        const index = field.components.indexOf(component);
        if (index < 0)
        {
            throw new Error(`WGSL interface ${field.id} does not contain register component ${component}`);
        }
        return COMPONENTS[index];
    });
}

function expressionType(program, write)
{
    const value = program.values.find((entry) => entry.id === write.valueId);
    const types = Array.from(write.mask).map((component) => value?.componentTypes?.[component]);
    if (!types.length || types.some((type) => !type || type === "unknown"))
    {
        throw new Error(`WGSL instruction ${write.valueId} has an unresolved output type`);
    }
    if (new Set(types).size !== 1)
    {
        throw new Error(`WGSL instruction ${write.valueId} mixes scalar output types`);
    }
    return fieldType(types[0], types.length);
}

function lowerMove(program, instruction, inputs, outputs)
{
    const write = instruction.dataflow.writes[0];
    const read = instruction.dataflow.reads[0];
    const destination = instruction.operands[write?.operandIndex ?? -1];
    const source = instruction.operands[read?.operandIndex ?? -1];
    if (!write || !read || destination?.typeName !== "output" || source?.typeName !== "input")
    {
        throw new Error(`WGSL vertex mov at instruction ${instruction.index} must copy input to output`);
    }
    if (instruction.saturate || instruction.typeInfo.bitcasts.length
        || instruction.operands.some((operand) => (operand.modifierName || "none") !== "none"
            || (operand.minPrecisionName || "default") !== "default"))
    {
        throw new Error(`WGSL vertex mov at instruction ${instruction.index} uses an unsupported modifier, precision, saturation, or bitcast`);
    }
    const output = outputs.find((field) => field.registerIndex === destination.registerIndex);
    const input = inputs.find((field) => field.registerIndex === source.registerIndex);
    if (!output || !input)
    {
        throw new Error(`WGSL vertex mov at instruction ${instruction.index} references an undeclared interface register`);
    }
    const targetComponents = Array.from(write.mask);
    if (targetComponents.length !== read.components.length)
    {
        throw new Error(`WGSL vertex mov at instruction ${instruction.index} has mismatched source/destination lanes`);
    }
    return {
        kind: "assignment",
        instructionIndex: instruction.index,
        dxbcOffset: instruction.dxbcOffset,
        target: {
            kind: "interface-reference",
            fieldId: output.id,
            components: packedComponents(output, targetComponents),
            type: expressionType(program, write)
        },
        expression: {
            kind: "interface-reference",
            fieldId: input.id,
            components: packedComponents(input, read.components),
            type: expressionType(program, write)
        }
    };
}

function deepFreeze(value)
{
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
}

/**
 * Lowers the first supported vertex slice into typed interface assignments.
 * This pass deliberately rejects unsupported reachable instructions.
 *
 * @param {object} program Frozen CJS shader IR.
 * @returns {object} Frozen typed vertex program.
 */
export function lowerVertexProgram(program)
{
    if (program?.format !== "CJS_SHADER_IR") throw new TypeError("WGSL lowering expects CJS_SHADER_IR input");
    if (program.stage !== "vertex") throw new Error(`WGSL lowering does not yet support ${program.stage} stages`);
    const inputs = interfaceFields(program, "input");
    const outputs = interfaceFields(program, "output");
    if (program.bindings.length) throw new Error("WGSL mov-only vertex slice does not support resource bindings");
    for (const fields of [ inputs, outputs ])
    {
        if (new Set(fields.map((field) => field.registerIndex)).size !== fields.length)
        {
            throw new Error("WGSL mov-only vertex slice does not support packed signature registers");
        }
    }
    const reachable = new Set(program.controlFlow.reachableBlockIds);
    const reachableBlocks = program.blocks.filter((block) => reachable.has(block.id));
    if (reachableBlocks.length !== 1) throw new Error("WGSL mov-only vertex slice requires one reachable basic block");
    const reachableInstructions = reachableBlocks
        .flatMap((block) => block.instructionIndices)
        .sort((a, b) => a - b)
        .map((index) => program.instructions[index]);
    const statements = [];
    const written = new Map(outputs.map((field) => [ field.id, new Set() ]));
    let returned = false;

    for (const instruction of reachableInstructions)
    {
        if (instruction.opcodeName === "mov")
        {
            if (returned) throw new Error(`WGSL vertex has reachable instructions after return at ${instruction.index}`);
            const statement = lowerMove(program, instruction, inputs, outputs);
            statements.push(statement);
            const field = outputs.find((entry) => entry.id === statement.target.fieldId);
            statement.target.components.forEach((component) =>
            {
                const packedIndex = COMPONENTS.indexOf(component);
                written.get(field.id).add(field.components[packedIndex]);
            });
        }
        else if (instruction.opcodeName === "ret")
        {
            if (returned) throw new Error("WGSL vertex has multiple reachable returns");
            statements.push({ kind: "return", instructionIndex: instruction.index, dxbcOffset: instruction.dxbcOffset });
            returned = true;
        }
        else
        {
            throw new Error(`WGSL vertex opcode ${instruction.opcodeName} at instruction ${instruction.index} is not supported`);
        }
    }
    if (!returned) throw new Error("WGSL vertex has no reachable return");
    for (const field of outputs)
    {
        const missing = field.components.filter((component) => !written.get(field.id).has(component));
        if (missing.length) throw new Error(`WGSL vertex output ${field.semanticName}${field.semanticIndex} leaves ${missing.join("")} unwritten`);
    }

    return deepFreeze({
        kind: "typed-shader-program",
        format: "CJS_TYPED_SHADER",
        formatVersion: 1,
        source: program.source,
        stage: "vertex",
        entryPoint: "main",
        interface: { inputs, outputs },
        statements
    });
}
