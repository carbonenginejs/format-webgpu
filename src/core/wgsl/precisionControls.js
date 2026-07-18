const COMPONENT_MASK = /^x?y?z?w?$/u;
const REFACTORING_ALLOWED = 1 << 11;

function fail(stage, instruction, message)
{
    throw new Error(`WGSL ${stage} instruction ${instruction.index} precise ${instruction.opcodeName} ${message}`);
}

/**
 * Requires the DXBC shader to opt into refactoring. Without the global flag,
 * DXBC defines every operation as precise, which portable WGSL cannot promise.
 *
 * @param {object} program CJS shader IR.
 * @param {string} stage Diagnostic stage label.
 */
export function requireRefactoringAllowed(program, stage)
{
    const declarations = program.declarations.filter((entry) => entry.opcodeName === "dcl_global_flags");
    if (declarations.length !== 1)
    {
        throw new Error(`WGSL ${stage} shader requires exactly one dcl_global_flags declaration`);
    }
    const data = declarations[0].data;
    if (!Number.isInteger(data?.globalFlags) || data.globalFlags < 0
        || typeof data.refactoringAllowed !== "boolean"
        || data.refactoringAllowed !== ((data.globalFlags & REFACTORING_ALLOWED) !== 0))
    {
        throw new Error(`WGSL ${stage} shader has inconsistent dcl_global_flags metadata`);
    }
    if (!data.refactoringAllowed)
    {
        throw new Error(`WGSL ${stage} shader disables refactoring globally; exact lowering is not representable in WGSL`);
    }
}

/**
 * Accepts precise only where the restriction is provably vacuous for the
 * emitted WGSL. Floating arithmetic remains unsupported because WGSL permits
 * fusion and reassociation.
 *
 * @param {object} instruction Typed CJS shader IR instruction.
 * @param {string} stage Diagnostic stage label.
 */
export function validatePreciseInstruction(instruction, stage)
{
    const mask = instruction.preciseMask;
    if (typeof mask !== "string" || !COMPONENT_MASK.test(mask))
    {
        fail(stage, instruction, `has malformed component mask ${String(mask)}`);
    }
    if (!mask) return;
    const writes = instruction.dataflow?.writes || [];
    if (writes.length !== 1 || writes[0].operandIndex !== 0
        || Array.from(mask).some((component) => !writes[0].mask.includes(component)))
    {
        fail(stage, instruction, `mask ${mask} requires one destination write containing every precise lane`);
    }
    if (instruction.saturate || instruction.operands.some((operand) => (operand.modifierName || "none") !== "none"))
    {
        fail(stage, instruction, `mask ${mask} requires unsaturated, unmodified operands`);
    }

    const typeInfo = instruction.typeInfo;
    const exactRule = { iadd: "signed-integer", ld_structured: "structured-load", mov: "move" }[
        instruction.opcodeName
    ];
    const expectedOperandCount = { iadd: 3, ld_structured: 4, mov: 2 }[instruction.opcodeName];
    const signedIntegerOperands = instruction.opcodeName !== "iadd"
        || (typeInfo?.resultType === "int32" && Array.isArray(typeInfo.operandTypes)
            && typeInfo.operandTypes.length === 3
            && typeInfo.operandTypes.every((entry) => entry.expectedType === "int32"));
    if (!exactRule || instruction.operands.length !== expectedOperandCount
        || typeInfo?.rule !== exactRule || typeInfo.conversion || !signedIntegerOperands)
    {
        fail(stage, instruction, `mask ${mask} requires no-refactoring controls unavailable in WGSL`);
    }
}
