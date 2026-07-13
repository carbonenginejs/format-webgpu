import { CjsBinaryReader, cjsNormalizeBytes } from "./binary.js";

const CEWGPU_MAGIC = "CWGP";
const CEWGPU_FORMAT = "CEWGPU";
const CEWGPU_VERSION = 1;
const textDecoder = new TextDecoder("utf-8", { fatal: false });

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
        const text = this.GetText(tag);
        return text === null ? null : JSON.parse(text);
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
        const text = this.analysis;
        if (text === null) return null;
        try
        {
            return JSON.parse(text);
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
        const text = this.wgsl;
        if (text === null) return null;
        try
        {
            return JSON.parse(text);
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
 * Decodes an ASCII four-character code.
 *
 * @param {Uint8Array} bytes Four-byte tag payload.
 * @returns {string} ASCII string.
 */
function decodeAscii(bytes)
{
    return String.fromCharCode(...bytes);
}
