export const OUTPUT_JSON = "json";
export const OUTPUT_RAW = "raw";

export const DEFAULT_VALUES = Object.freeze({
    emit: OUTPUT_JSON,
    schema: null,
    classes: Object.freeze({})
});

const OPTION_KEYS = new Set([ "emit", "schema", "classes" ]);

function hasOwn(value, key)
{
    return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeEmit(emit, readerName)
{
    if (emit === undefined || emit === OUTPUT_JSON) return OUTPUT_JSON;
    if (emit === OUTPUT_RAW) return OUTPUT_RAW;
    throw new Error(`${readerName} unknown emit value "${emit}"`);
}

function assertKnownOptions(options, readerName)
{
    for (const key of Object.keys(options))
    {
        if (!OPTION_KEYS.has(key))
        {
            throw new TypeError(`${readerName} unknown option "${key}"`);
        }
    }
}

function classMap(values)
{
    return values && values.classes ? values.classes : {};
}

function cloneValues(values)
{
    return {
        emit: values.emit,
        schema: values.schema ?? null,
        classes: { ...classMap(values) }
    };
}

export function validateClassKey(classKeys, key, readerName)
{
    if (!classKeys.includes(key))
    {
        throw new Error(`${readerName} unknown class type "${String(key)}"`);
    }
}

export function validateClass(classKeys, type, Class, readerName)
{
    validateClassKey(classKeys, type, readerName);
    if (typeof Class !== "function")
    {
        throw new TypeError(`${readerName} class "${type}" must be a constructor`);
    }
}

function mergeClasses(values, classes, classKeys, readerName)
{
    if (!classes || typeof classes !== "object")
    {
        throw new TypeError(`${readerName} classes option must be an object`);
    }

    const next = { ...values.classes };
    for (const [ type, Class ] of Object.entries(classes))
    {
        validateClass(classKeys, type, Class, readerName);
        next[type] = Class;
    }
    values.classes = next;
}

export function normalizeValues(base, options, classKeys, readerName)
{
    if (!options || typeof options !== "object")
    {
        throw new TypeError(`${readerName} options must be an object`);
    }

    assertKnownOptions(options, readerName);

    const values = cloneValues(base);
    if (hasOwn(options, "emit")) values.emit = normalizeEmit(options.emit, readerName);
    if (hasOwn(options, "schema")) values.schema = options.schema ?? null;
    if (hasOwn(options, "classes")) mergeClasses(values, options.classes, classKeys, readerName);
    return values;
}

export function notImplemented(readerName, methodName)
{
    return new Error(`${readerName}.${methodName} is not implemented yet`);
}

export function toJsonValue(value, seen = new WeakSet())
{
    if (value === null || typeof value !== "object") return value;
    if (ArrayBuffer.isView(value)) return Array.from(value, item => toJsonValue(item, seen));
    if (Array.isArray(value)) return value.map(item => toJsonValue(item, seen));

    if (seen.has(value))
    {
        throw new TypeError("Reader.toJSON cannot convert circular data");
    }

    if (typeof value.toJSON === "function")
    {
        seen.add(value);
        const json = toJsonValue(value.toJSON(), seen);
        seen.delete(value);
        return json;
    }

    seen.add(value);
    const out = {};
    for (const key of Object.keys(value))
    {
        out[key] = toJsonValue(value[key], seen);
    }
    seen.delete(value);
    return out;
}
