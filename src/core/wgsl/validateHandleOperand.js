export function validateFixedHandleOperand(instruction, operandIndex, expectedType, stage)
{
    const operand = instruction.operands[operandIndex];
    const hasRelativeIdentity = operand?.indices?.some((entry) => entry?.relative)
        || operand?.resourceReference?.absoluteIndex?.relative;
    if (operand?.typeName !== expectedType
        || (operand.modifierName ?? "none") !== "none"
        || (operand.minPrecisionName ?? "default") !== "default"
        || hasRelativeIdentity)
    {
        throw new Error(`WGSL ${stage} instruction ${instruction.index} requires a fixed, unmodified, default-precision ${expectedType} handle at operand ${operandIndex}`);
    }
    return operand;
}

export function validateFixedHandleBinding(operand, binding, stage)
{
    const absoluteIndex = operand?.resourceReference?.absoluteIndex;
    if (!binding || absoluteIndex === undefined) return binding;
    if (absoluteIndex?.relative
        || absoluteIndex?.values?.length !== 1
        || absoluteIndex.values[0] !== binding.registerIndex)
    {
        throw new Error(`WGSL ${stage} handle has an out-of-range fixed handle identity`);
    }
    return binding;
}
