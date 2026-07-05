import { CLASS_KEYS } from "./core/schema.js";
import {
    DEFAULT_VALUES,
    OUTPUT_JSON,
    OUTPUT_RAW,
    normalizeValues,
    notImplemented,
    toJsonValue,
    validateClass,
    validateClassKey
} from "./core/helpers.js";

const FORMAT_NAME = "CjsFormatWebgpu";

export class CjsFormatWebgpu
{

    #emit = DEFAULT_VALUES.emit;
    #schema = DEFAULT_VALUES.schema;
    #classes = {};

    constructor(options = {})
    {
        this.SetValues(options);
    }

    SetValues(options = {})
    {
        const values = normalizeValues(this.GetValues(), options, CLASS_KEYS, FORMAT_NAME);
        this.#emit = values.emit;
        this.#schema = values.schema;
        this.#classes = values.classes;
        return this;
    }

    GetValues(options = {})
    {
        return normalizeValues({
            emit: this.#emit,
            schema: this.#schema,
            classes: this.#classes
        }, options, CLASS_KEYS, FORMAT_NAME);
    }

    SetClasses(classes = {})
    {
        return this.SetValues({ classes });
    }

    SetClass(type, Class)
    {
        validateClassKey(CLASS_KEYS, type, FORMAT_NAME);
        if (Class === null || Class === undefined)
        {
            delete this.#classes[type];
            return this;
        }

        validateClass(CLASS_KEYS, type, Class, FORMAT_NAME);
        this.#classes = { ...this.#classes, [type]: Class };
        return this;
    }

    GetClass(type)
    {
        validateClassKey(CLASS_KEYS, type, FORMAT_NAME);
        return this.#classes[type];
    }

    HasClass(type)
    {
        return !!this.GetClass(type);
    }

    Read(input, options = {})
    {
        return CjsFormatWebgpu.read(input, this.GetValues(options));
    }

    Inspect(input, options = {})
    {
        return CjsFormatWebgpu.inspect(input, this.GetValues(options));
    }

    ToJSON(value)
    {
        return toJsonValue(value);
    }

    static read(input, options = {})
    {
        normalizeValues(DEFAULT_VALUES, options, CLASS_KEYS, FORMAT_NAME);
        void input;
        throw notImplemented(FORMAT_NAME, "read");
    }

    static inspect(input, options = {})
    {
        normalizeValues(DEFAULT_VALUES, options, CLASS_KEYS, FORMAT_NAME);
        void input;
        throw notImplemented(FORMAT_NAME, "inspect");
    }

    static toJSON(value)
    {
        return toJsonValue(value);
    }

    static OUTPUT_JSON = OUTPUT_JSON;
    static OUTPUT_RAW = OUTPUT_RAW;
    static CLASS_KEYS = CLASS_KEYS;

}

export default CjsFormatWebgpu;
