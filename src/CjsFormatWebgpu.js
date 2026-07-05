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

/**
 * CarbonEngineJS-facing WebGPU format profile.
 *
 * This package currently defines the public API shape and schema/class
 * registration boundary. WebGPU output is intentionally reserved for the
 * implementation pass so callers can depend on the same surface early.
 */
export class CjsFormatWebgpu
{

    #emit = DEFAULT_VALUES.emit;
    #schema = DEFAULT_VALUES.schema;
    #classes = {};

    /**
     * Create a reusable format profile.
     *
     * @param {object} [options] Default format values.
     */
    constructor(options = {})
    {
        this.SetValues(options);
    }

    /**
     * Set format values for this reusable profile.
     *
     * @param {object} [options] Values to merge into the profile.
     * @returns {CjsFormatWebgpu} This format profile.
     */
    SetValues(options = {})
    {
        const values = normalizeValues(this.GetValues(), options, CLASS_KEYS, FORMAT_NAME);
        this.#emit = values.emit;
        this.#schema = values.schema;
        this.#classes = values.classes;
        return this;
    }

    /**
     * Get this profile's current values, optionally with per-call overrides.
     *
     * @param {object} [options] Optional values to merge into a copy.
     * @returns {object} A copy of the effective values.
     */
    GetValues(options = {})
    {
        return normalizeValues({
            emit: this.#emit,
            schema: this.#schema,
            classes: this.#classes
        }, options, CLASS_KEYS, FORMAT_NAME);
    }

    /**
     * Set multiple node-class constructors for this profile.
     *
     * @param {object} [classes] Map of node class keys to constructors.
     * @returns {CjsFormatWebgpu} This format profile.
     */
    SetClasses(classes = {})
    {
        return this.SetValues({ classes });
    }

    /**
     * Set one node-class constructor for this profile.
     *
     * @param {string} type Node class key.
     * @param {Function|null|undefined} Class Constructor to use, or nullish to delete.
     * @returns {CjsFormatWebgpu} This format profile.
     */
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

    /**
     * Get a configured node-class constructor.
     *
     * @param {string} type Node class key.
     * @returns {Function|undefined} The registered constructor, if any.
     */
    GetClass(type)
    {
        validateClassKey(CLASS_KEYS, type, FORMAT_NAME);
        return this.#classes[type];
    }

    /**
     * Whether this format profile has a constructor registered for a node key.
     *
     * @param {string} type Node class key.
     * @returns {boolean} True when a constructor is registered.
     */
    HasClass(type)
    {
        return !!this.GetClass(type);
    }

    /**
     * Read WebGPU data with this profile's values.
     *
     * @param {unknown} input WebGPU format input.
     * @param {object} [options] Per-call value overrides.
     * @returns {object} Format output once implemented.
     */
    Read(input, options = {})
    {
        return CjsFormatWebgpu.read(input, this.GetValues(options));
    }

    /**
     * Inspect WebGPU data with this profile's values.
     *
     * @param {unknown} input WebGPU format input.
     * @param {object} [options] Per-call value overrides.
     * @returns {object} Plain summary data once implemented.
     */
    Inspect(input, options = {})
    {
        return CjsFormatWebgpu.inspect(input, this.GetValues(options));
    }

    /**
     * Convert format output to JSON-compatible data.
     *
     * @param {any} value Format output to convert.
     * @returns {any} Plain JSON-compatible data.
     */
    ToJSON(value)
    {
        return toJsonValue(value);
    }

    /**
     * Static one-shot read. Static methods use camelCase by convention.
     *
     * @param {unknown} input WebGPU format input.
     * @param {object} [options] Format values.
     * @returns {object} Format output once implemented.
     */
    static read(input, options = {})
    {
        normalizeValues(DEFAULT_VALUES, options, CLASS_KEYS, FORMAT_NAME);
        void input;
        throw notImplemented(FORMAT_NAME, "read");
    }

    /**
     * Static one-shot inspection.
     *
     * @param {unknown} input WebGPU format input.
     * @param {object} [options] Format values.
     * @returns {object} Plain summary data once implemented.
     */
    static inspect(input, options = {})
    {
        normalizeValues(DEFAULT_VALUES, options, CLASS_KEYS, FORMAT_NAME);
        void input;
        throw notImplemented(FORMAT_NAME, "inspect");
    }

    /**
     * Static JSON-compatible conversion.
     *
     * @param {any} value Format output to convert.
     * @returns {any} Plain JSON-compatible data.
     */
    static toJSON(value)
    {
        return toJsonValue(value);
    }

    static OUTPUT_JSON = OUTPUT_JSON;
    static OUTPUT_RAW = OUTPUT_RAW;
    static CLASS_KEYS = CLASS_KEYS;

}

export default CjsFormatWebgpu;
