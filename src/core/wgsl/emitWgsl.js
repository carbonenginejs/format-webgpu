import { lowerDxbcToIr } from "../ir/lowerDxbcToIr.js";
import { lowerFragmentProgram } from "./lowerFragmentProgram.js";
import { lowerVertexProgram } from "./lowerVertexProgram.js";

const COMPONENTS = [ "x", "y", "z", "w" ];

function attribute(field, invariantPosition = false)
{
    if (field.attribute.kind !== "builtin")
    {
        const interpolate = field.interpolation ? ` @interpolate(${field.interpolation})` : "";
        return `@location(${field.attribute.index})${interpolate}`;
    }
    const invariant = invariantPosition && field.attribute.name === "position" ? "@invariant " : "";
    return `${invariant}@builtin(${field.attribute.name})`;
}

function access(base, field, components)
{
    const natural = COMPONENTS.slice(0, field.components.length);
    const suffix = components.length === natural.length
        && components.every((component, index) => component === natural[index])
        ? ""
        : `.${components.join("")}`;
    return `${base}.${field.name}${suffix}`;
}

function f32Literal(value)
{
    const number = value.float32;
    if (!Number.isFinite(number)) return `bitcast<f32>(0x${(value.uint32 >>> 0).toString(16).padStart(8, "0")}u)`;
    const text = String(number);
    return /[.eE]/u.test(text) ? text : `${text}.0`;
}

function emitImmediateConstantBuffer(lines, rows)
{
    const vectors = rows.map((row) => `vec4<f32>(${row.map(f32Literal).join(", ")})`);
    lines.push(`const icb = array<vec4<f32>, ${rows.length}>(${vectors.join(", ")});`, "");
}

function emitConstTables(lines, tables)
{
    for (const table of tables)
    {
        const vectors = table.rows.map((row) => `vec4<f32>(${row.map(f32Literal).join(", ")})`);
        lines.push(`const ${table.symbol} = array<vec4<f32>, ${table.rows.length}>(${vectors.join(", ")});`, "");
    }
}

function emitStruct(lines, name, fields, invariantPosition = false)
{
    lines.push(`struct ${name}`, "{");
    for (const field of fields)
    {
        lines.push(`    ${attribute(field, invariantPosition)} ${field.name}: ${field.type},`);
    }
    lines.push("};", "");
}

function deepFreeze(value)
{
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
}

/**
 * Builds deterministic WGSL and a DXBC-offset source map for the supported IR.
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView|object} input DXBC or CJS IR.
 * @param {object} [options] Source/provenance options.
 * @returns {object} Frozen WGSL shader descriptor.
 */
export function buildWgsl(input, options = {})
{
    if (options.precisionPolicy !== undefined)
    {
        throw new TypeError("WGSL precisionPolicy is not supported; precise controls require exact lowering");
    }
    const ir = input?.format === "CJS_SHADER_IR" ? input : lowerDxbcToIr(input, options);
    const program = ir.stage === "vertex" ? lowerVertexProgram(ir, options) : lowerFragmentProgram(ir, options);
    const lines = [];
    const sourceMap = [];
    const prefix = program.stage === "vertex" ? "Vertex" : "Fragment";
    if (program.requiresDerivativeUniformityOptOut)
    {
        // This shader computes a screen-space derivative / implicit-LOD sample
        // inside non-uniform control flow, which WGSL forbids by default. The
        // DXBC source relied on D3D11's permissive behavior; this module-level
        // filter reproduces it (a standard WGSL opt-out) rather than rejecting
        // the shader. Neighbor lanes that skip the branch yield undefined
        // derivatives there, exactly as under D3D11.
        lines.push("diagnostic(off, derivative_uniformity);", "");
    }
    const hasInputs = program.interface.inputs.length > 0;
    if (hasInputs) emitStruct(lines, `${prefix}Input`, program.interface.inputs);
    emitStruct(lines, `${prefix}Output`, program.interface.outputs, program.stage === "vertex");
    if (program.immediateConstantBuffer?.length) emitImmediateConstantBuffer(lines, program.immediateConstantBuffer);
    if (program.constTables?.length) emitConstTables(lines, program.constTables);
    for (const binding of program.bindings || [])
    {
        lines.push(`@group(${binding.group}) @binding(${binding.binding}) ${binding.declaration} ${binding.generatedSymbol}: ${binding.type};`);
    }
    if (program.bindings?.length) lines.push("");
    const parameters = hasInputs ? `input: ${prefix}Input` : "";
    lines.push(`@${program.stage}`, `fn ${program.entryPoint}(${parameters}) -> ${prefix}Output`, "{", `    var output: ${prefix}Output;`);

    const inputById = new Map(program.interface.inputs.map((field) => [ field.id, field ]));
    const outputById = new Map(program.interface.outputs.map((field) => [ field.id, field ]));

    function emitStatement(statement, depth)
    {
        const indent = "    ".repeat(depth);
        const line = lines.length + 1;
        if (statement.kind === "assignment")
        {
            const targetField = outputById.get(statement.target.fieldId);
            if (statement.expression.fieldId)
            {
                const sourceField = inputById.get(statement.expression.fieldId);
                lines.push(`${indent}${access("output", targetField, statement.target.components)} = ${access("input", sourceField, statement.expression.components)};`);
            }
            else
            {
                lines.push(`${indent}${access("output", targetField, statement.target.components)} = ${statement.expression.code};`);
            }
        }
        else if (statement.kind === "let")
        {
            lines.push(`${indent}let ${statement.name}: ${statement.type} = ${statement.expression.code};`);
        }
        else if (statement.kind === "var")
        {
            lines.push(statement.expression
                ? `${indent}var ${statement.name}: ${statement.type} = ${statement.expression.code};`
                : `${indent}var ${statement.name}: ${statement.type};`);
        }
        else if (statement.kind === "value-assignment")
        {
            lines.push(`${indent}${statement.name} = ${statement.expression.code};`);
        }
        else if (statement.kind === "return")
        {
            lines.push(`${indent}return output;`);
        }
        else if (statement.kind === "discard")
        {
            lines.push(`${indent}discard;`);
        }
        else if (statement.kind === "call")
        {
            lines.push(`${indent}${statement.expression.code};`);
        }
        else if (statement.kind === "if")
        {
            lines.push(`${indent}if (${statement.condition.code})`, `${indent}{`);
            sourceMap.push({ line, instructionIndex: statement.instructionIndex, dxbcOffset: statement.dxbcOffset });
            for (const child of statement.statements) emitStatement(child, depth + 1);
            lines.push(`${indent}}`);
            if (statement.elseStatements?.length)
            {
                lines.push(`${indent}else`, `${indent}{`);
                for (const child of statement.elseStatements) emitStatement(child, depth + 1);
                lines.push(`${indent}}`);
            }
            return;
        }
        else if (statement.kind === "break")
        {
            lines.push(`${indent}break;`);
        }
        else if (statement.kind === "continue")
        {
            lines.push(`${indent}continue;`);
        }
        else if (statement.kind === "loop")
        {
            lines.push(`${indent}loop`, `${indent}{`);
            sourceMap.push({ line, instructionIndex: statement.instructionIndex, dxbcOffset: statement.dxbcOffset });
            for (const child of statement.statements) emitStatement(child, depth + 1);
            if (statement.continuing?.length)
            {
                lines.push(`${indent}    continuing`, `${indent}    {`);
                for (const child of statement.continuing) emitStatement(child, depth + 2);
                lines.push(`${indent}    }`);
            }
            lines.push(`${indent}}`);
            return;
        }
        else if (statement.kind === "switch")
        {
            lines.push(`${indent}switch (${statement.selector.code})`, `${indent}{`);
            sourceMap.push({ line, instructionIndex: statement.instructionIndex, dxbcOffset: statement.dxbcOffset });
            for (const clause of statement.clauses)
            {
                const selectors = clause.selectors.map((value) => `${value}u`);
                if (clause.isDefault) selectors.push("default");
                const label = selectors.length === 1 && clause.isDefault ? "default" : `case ${selectors.join(", ")}`;
                lines.push(`${indent}    ${label}:`, `${indent}    {`);
                for (const child of clause.statements) emitStatement(child, depth + 2);
                lines.push(`${indent}    }`);
            }
            if (!statement.clauses.some((clause) => clause.isDefault))
            {
                lines.push(`${indent}    default:`, `${indent}    {`, `${indent}    }`);
            }
            lines.push(`${indent}}`);
            return;
        }
        if (Number.isInteger(statement.instructionIndex) && Number.isInteger(statement.dxbcOffset))
        {
            sourceMap.push({ line, instructionIndex: statement.instructionIndex, dxbcOffset: statement.dxbcOffset });
        }
    }

    for (const statement of program.statements) emitStatement(statement, 1);
    lines.push("}", "");

    return deepFreeze({
        kind: "wgsl-shader",
        format: "CJS_WGSL_SHADER",
        formatVersion: 1,
        source: program.source,
        stage: program.stage,
        entryPoint: program.entryPoint,
        code: lines.join("\n"),
        sourceMap,
        program
    });
}
