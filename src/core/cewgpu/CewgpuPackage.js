import { CjsBinaryReader, cjsNormalizeBytes } from "./binary.js";
import { validateCewgpuChunkTag } from "./tags.js";
import { sha256Bytes } from "../sha256.js";
import {
    hydrateEffectReflectionForPermutation
} from "../effectReflectionPackage.js";

const CEWGPU_MAGIC = "CWGP";
const CEWGPU_FORMAT = "CEWGPU";
const CEWGPU_VERSION = 1;
const textDecoder = new TextDecoder("utf-8", { fatal: false });
const jsonTextDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Reader for CarbonEngineJS CEWGPU shader packages.
 */
export class CewgpuPackage
{
    /**
   * Creates an empty package reader.
   */
    constructor()
    {
        this.version = 0;
        this.chunks = [];
        this.chunkMap = new Map();
        this.jsonCache = new Map();
        this.reflectionBlobIndex = null;
        this.readError = null;
        this.sourcePath = "";
    }

    /**
   * Reads a CEWGPU package from bytes.
   *
   * @param {ArrayBuffer|ArrayBufferView|Uint8Array} source CEWGPU bytes.
   * @param {object} [options] Read options.
   * @param {string} [options.sourcePath] Source path for diagnostics.
   * @returns {boolean} True when the package was decoded.
   */
    Read(source, options = {})
    {
        this.version = 0;
        this.chunks = [];
        this.chunkMap = new Map();
        this.jsonCache = new Map();
        this.reflectionBlobIndex = null;
        this.readError = null;
        this.sourcePath = options.sourcePath || "";

        try
        {
            const bytes = cjsNormalizeBytes(source);
            const stream = new CjsBinaryReader(bytes, { source: this.sourcePath || "CEWGPU" });
            const magic = decodeAscii(stream.readRaw(CEWGPU_MAGIC.length));
            if (magic !== CEWGPU_MAGIC)
            {
                throw new Error(`Invalid CEWGPU magic "${magic}"`);
            }

            this.version = stream.readUint32();
            if (this.version !== CEWGPU_VERSION)
            {
                throw new Error(`Unsupported CEWGPU version ${this.version}`);
            }

            const chunkCount = stream.readUint32();
            for (let index = 0; index < chunkCount; index += 1)
            {
                const tag = decodeAscii(stream.readRaw(4));
                validateCewgpuChunkTag(tag);
                if (this.chunkMap.has(tag))
                {
                    throw new Error(`CEWGPU package contains duplicate chunk tag ${tag}`);
                }
                const size = stream.readUint32();
                const offset = stream.offset;
                const chunkBytes = stream.readRaw(size);
                const chunk = {
                    tag,
                    size,
                    offset,
                    bytes: chunkBytes
                };
                this.chunks.push(chunk);
                this.chunkMap.set(tag, chunk);
            }

            if (stream.remaining !== 0)
            {
                throw new Error(`CEWGPU package has ${stream.remaining} trailing bytes`);
            }

            return true;
        }
        catch (error)
        {
            this.readError = error;
            this.chunks = [];
            this.chunkMap = new Map();
            this.jsonCache = new Map();
            this.reflectionBlobIndex = null;
            return false;
        }
    }

    /**
   * Reports whether the package decoded successfully.
   *
   * @returns {boolean} True when no read error is present.
   */
    IsGood()
    {
        return !this.readError && this.version === CEWGPU_VERSION;
    }

    /**
   * Gets a chunk by four-character tag.
   *
   * @param {string} tag Chunk tag.
   * @returns {{tag:string,size:number,offset:number,bytes:Uint8Array}|null} Chunk record.
   */
    GetChunk(tag)
    {
        return this.chunkMap.get(tag) || null;
    }

    /**
   * Decodes a text chunk.
   *
   * @param {string} tag Chunk tag.
   * @returns {string|null} Decoded text, or null when absent.
   */
    GetText(tag)
    {
        const chunk = this.GetChunk(tag);
        return chunk ? textDecoder.decode(chunk.bytes) : null;
    }

    /**
   * Decodes a JSON chunk.
   *
   * @param {string} tag Chunk tag.
   * @returns {object|null} Parsed JSON, or null when absent.
   */
    GetJson(tag)
    {
        return cloneJson(getCachedJson(this, tag));
    }

    /**
   * Gets translator summary metadata from the `INFO` chunk.
   *
   * @returns {object|null} Info JSON.
   */
    get info()
    {
        return this.GetJson("INFO");
    }

    /**
   * Gets caller-provided metadata from the `META` chunk.
   *
   * @returns {object|null} Metadata JSON.
   */
    get metadata()
    {
        return this.GetJson("META");
    }

    /**
   * Gets the complete source permutation graph when present.
   *
   * @returns {object|null} Parsed permutation graph.
   */
    get permutationGraph()
    {
        return this.GetJson("PGRF");
    }

    /**
     * Gets complete source effect reflection when present.
     *
     * @returns {object|null} Parsed reflection document.
     */
    get reflection()
    {
        return this.GetJson("RFLX");
    }

    /**
     * Gets the raw reflection blob store when present.
     *
     * @returns {Uint8Array|null} RBLB bytes.
     */
    get reflectionBlobBytes()
    {
        return this.GetChunk("RBLB")?.bytes ?? null;
    }

    /**
     * Copies one reflected byte payload by blob key or exact reference.
     *
     * A string performs an inventory-key lookup. An object must exactly match
     * the stored blob key, offset, byte length, and digest.
     *
     * @param {string|object} value Blob key or exact RFLX byte-reference object.
     * @returns {Uint8Array|null} Owned payload bytes, or null when unavailable.
     */
    GetReflectionBlob(value)
    {
        const key = typeof value === "string" ? value : value?.blobKey;
        if (!this.reflectionBlobIndex)
        {
            this.reflectionBlobIndex = new Map(
                (getCachedJson(this, "RFLX")?.blobStore?.blobs ?? []).map((entry) => [
                    entry.blobKey,
                    entry
                ])
            );
        }
        const entry = this.reflectionBlobIndex.get(key);
        const bytes = this.reflectionBlobBytes;
        if (!entry || !bytes) return null;
        if (typeof value !== "string"
            && (!value
                || value.offset !== entry.offset
                || value.byteLength !== entry.byteLength
                || value.sha256 !== entry.sha256))
        {
            return null;
        }
        const end = entry.offset + entry.byteLength;
        if (!Number.isSafeInteger(entry.offset) || entry.offset < 0
            || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0
            || end > bytes.byteLength
            || sha256Bytes(bytes.subarray(entry.offset, end)) !== entry.sha256)
        {
            return null;
        }
        return Uint8Array.from(bytes.subarray(entry.offset, end));
    }

    /**
     * Gets fully hydrated portable source reflection for one permutation.
     *
     * The optional index defaults to `META.bodyIndex`. Every reflected byte
     * field is returned as a fresh owned `Uint8Array`.
     *
     * @param {number} [permutationIndex] Exact PGRF permutation index.
     * @returns {object|null} Validated portable reflection, or null when absent.
     */
    GetPortableEffectReflection(
        permutationIndex
    )
    {
        const reflection = getCachedJson(this, "RFLX");
        const permutationGraph = getCachedJson(this, "PGRF");
        if (!reflection || !permutationGraph) return null;
        const selectedIndex = permutationIndex
            ?? getCachedJson(this, "META")?.bodyIndex
            ?? 0;
        return hydrateEffectReflectionForPermutation(
            reflection,
            permutationGraph,
            selectedIndex,
            (reference) => this.GetReflectionBlob(reference)
        );
    }

    /**
   * Gets normalized shader analysis from the `ANLS` chunk.
   *
   * @returns {string|null} Analysis text.
   */
    get analysis()
    {
        return this.GetText("ANLS");
    }

    /**
   * Gets normalized shader analysis metadata when the `ANLS` chunk contains
   * JSON.
   *
   * @returns {object|null} Parsed analysis, or null for raw text.
   */
    get analysisJson()
    {
        try
        {
            return this.GetJson("ANLS");
        }
        catch
        {
            return null;
        }
    }

    /**
   * Gets emitted WGSL when present.
   *
   * @returns {string|null} WGSL text.
   */
    get wgsl()
    {
        return this.GetText("WGSL");
    }

    /**
   * Gets emitted WGSL metadata when the `WGSL` chunk contains JSON.
   *
   * @returns {object|null} Parsed WGSL metadata, or null for raw source.
   */
    get wgslJson()
    {
        try
        {
            return this.GetJson("WGSL");
        }
        catch
        {
            return null;
        }
    }

    /**
   * Returns a JSON-safe package summary.
   *
   * @returns {object} Serializable summary.
   */
    toJSON()
    {
        return {
            format: CEWGPU_FORMAT,
            version: this.version,
            sourcePath: this.sourcePath,
            chunks: this.chunks.map((chunk) => ({
                tag: chunk.tag,
                size: chunk.size,
                offset: chunk.offset
            })),
            readError: this.readError ? {
                name: this.readError.name,
                message: this.readError.message
            } : null
        };
    }
}

/**
 * Decode and cache one private JSON document.
 *
 * @param {CewgpuPackage} pkg Package reader.
 * @param {string} tag Chunk tag.
 * @returns {object|null} Private parsed JSON, or null when absent.
 */
function getCachedJson(pkg, tag)
{
    if (!pkg.jsonCache.has(tag))
    {
        const chunk = pkg.GetChunk(tag);
        pkg.jsonCache.set(
            tag,
            chunk ? JSON.parse(jsonTextDecoder.decode(chunk.bytes)) : null
        );
    }
    return pkg.jsonCache.get(tag);
}

/**
 * Copy JSON-compatible data without reparsing its source chunk.
 *
 * @param {any} value Cached JSON value.
 * @returns {any} Structurally independent JSON value.
 */
function cloneJson(value)
{
    if (Array.isArray(value)) return value.map(cloneJson);
    if (value && typeof value === "object")
    {
        return Object.fromEntries(Object.entries(value).map(([ key, entry ]) => [
            key,
            cloneJson(entry)
        ]));
    }
    return value;
}

/**
 * Decodes an ASCII four-character code.
 *
 * @param {Uint8Array} bytes Four-byte tag payload.
 * @returns {string} ASCII string.
 */
function decodeAscii(bytes)
{
    return String.fromCharCode(...bytes);
}
