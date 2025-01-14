import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { URL } from "node:url";
import yaml from "js-yaml";
import { parseRef, error, makeTSIndex, walk, isRemoteURL, isFilepath } from "./utils.js";
export const VIRTUAL_JSON_URL = `file:///_json`;
function parseYAML(schema) {
    try {
        return yaml.load(schema);
    }
    catch (err) {
        error(`YAML: ${err.toString()}`);
        process.exit(1);
    }
}
function parseJSON(schema) {
    try {
        return JSON.parse(schema);
    }
    catch (err) {
        error(`JSON: ${err.toString()}`);
        process.exit(1);
    }
}
export function resolveSchema(filename) {
    if (isRemoteURL(filename))
        return new URL(filename.startsWith("//") ? `https:${filename}` : filename);
    const localPath = path.isAbsolute(filename)
        ? new URL(`file://${filename}`)
        : new URL(filename, `file://${process.cwd()}/`);
    if (!fs.existsSync(localPath)) {
        error(`Could not locate ${filename}`);
        process.exit(1);
    }
    else if (fs.statSync(localPath).isDirectory()) {
        error(`${localPath} is a directory not a file`);
        process.exit(1);
    }
    return localPath;
}
function parseHttpHeaders(httpHeaders) {
    const finalHeaders = {};
    for (const [k, v] of Object.entries(httpHeaders)) {
        if (typeof v === "string") {
            finalHeaders[k] = v;
        }
        else {
            try {
                const stringVal = JSON.stringify(v);
                finalHeaders[k] = stringVal;
            }
            catch (err) {
                error(`Cannot parse key: ${k} into JSON format. Continuing with the next HTTP header that is specified`);
            }
        }
    }
    return finalHeaders;
}
export default async function load(schema, options) {
    let schemaID = ".";
    if (schema instanceof URL) {
        const hint = options.hint || "OpenAPI3";
        if (schema.href !== options.rootURL.href)
            schemaID = relativePath(options.rootURL, schema);
        if (options.urlCache.has(schemaID))
            return options.schemas;
        options.urlCache.add(schemaID);
        const ext = path.extname(schema.pathname).toLowerCase();
        if (schema.protocol.startsWith("http")) {
            const headers = { "User-Agent": "openapi-typescript" };
            if (options.auth)
                headers.Authorization = options.auth;
            if (options.httpHeaders) {
                const parsedHeaders = parseHttpHeaders(options.httpHeaders);
                for (const [k, v] of Object.entries(parsedHeaders)) {
                    headers[k] = v;
                }
            }
            const res = await options.fetch(schema, {
                method: options.httpMethod || "GET",
                headers,
            });
            const contentType = res.headers.get("content-type");
            if (ext === ".json" || (contentType && contentType.includes("json"))) {
                options.schemas[schemaID] = {
                    hint,
                    schema: parseJSON(await res.text()),
                };
            }
            else if (ext === ".yaml" || ext === ".yml" || (contentType && contentType.includes("yaml"))) {
                options.schemas[schemaID] = {
                    hint,
                    schema: parseYAML(await res.text()),
                };
            }
        }
        else {
            const contents = fs.readFileSync(schema, "utf8");
            if (ext === ".yaml" || ext === ".yml")
                options.schemas[schemaID] = {
                    hint,
                    schema: parseYAML(contents),
                };
            else if (ext === ".json")
                options.schemas[schemaID] = {
                    hint,
                    schema: parseJSON(contents),
                };
        }
    }
    else if (schema instanceof Readable) {
        const readable = schema;
        const contents = await new Promise((resolve) => {
            readable.resume();
            readable.setEncoding("utf8");
            let content = "";
            readable.on("data", (chunk) => {
                content += chunk;
            });
            readable.on("end", () => {
                resolve(content.trim());
            });
        });
        options.schemas[schemaID] = {
            hint: "OpenAPI3",
            schema: contents.charAt(0) === "{" ? parseJSON(contents) : parseYAML(contents),
        };
    }
    else if (typeof schema === "object") {
        options.schemas[schemaID] = {
            hint: "OpenAPI3",
            schema: schema,
        };
    }
    else {
        error(`Invalid schema`);
        process.exit(1);
    }
    const currentSchema = options.schemas[schemaID].schema;
    if (options.schemas[schemaID].hint === "OpenAPI3") {
        if ("components" in currentSchema && currentSchema.components && "examples" in currentSchema.components)
            delete currentSchema.components.examples;
    }
    const refPromises = [];
    walk(currentSchema, (rawNode, nodePath) => {
        for (const k of ["allOf", "anyOf", "oneOf"]) {
            if (Array.isArray(rawNode[k])) {
                rawNode[k] = rawNode[k].filter((o) => {
                    if (!("$ref" in o) || typeof o.$ref !== "string")
                        return true;
                    const ref = parseRef(o.$ref);
                    return !ref.path.some((i) => i.startsWith("x-"));
                });
            }
        }
        if (!("$ref" in rawNode) || typeof rawNode.$ref !== "string")
            return;
        const node = rawNode;
        const ref = parseRef(node.$ref);
        if (ref.filename === ".")
            return;
        if (ref.path.some((i) => i.startsWith("x-"))) {
            delete node.$ref;
            return;
        }
        const hint = getHint([...nodePath, ...ref.path], options.hint);
        if (schema instanceof URL) {
            const nextURL = new URL(ref.filename, schema);
            const nextID = relativePath(schema, nextURL);
            if (options.urlCache.has(nextID))
                return;
            refPromises.push(load(nextURL, { ...options, hint }));
            node.$ref = node.$ref.replace(ref.filename, nextID);
            return;
        }
        if (isRemoteURL(ref.filename) || isFilepath(ref.filename)) {
            const nextURL = new URL(ref.filename.startsWith("//") ? `https://${ref.filename}` : ref.filename);
            if (options.urlCache.has(nextURL.href))
                return;
            refPromises.push(load(nextURL, { ...options, hint }));
            node.$ref = node.$ref.replace(ref.filename, nextURL.href);
            return;
        }
        if (options.rootURL.href === VIRTUAL_JSON_URL) {
            error(`Can’t resolve "${ref.filename}" from dynamic JSON. Load this schema from a URL instead.`);
            process.exit(1);
        }
        error(`Can’t resolve "${ref.filename}"`);
        process.exit(1);
    });
    await Promise.all(refPromises);
    if (schemaID === ".") {
        for (const subschemaID of Object.keys(options.schemas)) {
            walk(options.schemas[subschemaID].schema, (rawNode) => {
                if (!("$ref" in rawNode) || typeof rawNode.$ref !== "string")
                    return;
                const node = rawNode;
                const ref = parseRef(node.$ref);
                if (ref.filename === ".") {
                    node.$ref = makeTSIndex(ref.path);
                }
                else {
                    const refURL = new URL(ref.filename, new URL(subschemaID, options.rootURL));
                    node.$ref = makeTSIndex(["external", relativePath(options.rootURL, refURL), ...ref.path]);
                }
            });
        }
    }
    for (const k of Object.keys(options.schemas)) {
        if (JSON.stringify(options.schemas[k].schema).includes('"discriminator"')) {
            walk(options.schemas[k].schema, (rawNode, nodePath) => {
                const node = rawNode;
                if (!node.discriminator)
                    return;
                options.discriminators[schemaID === "." ? makeTSIndex(nodePath) : makeTSIndex(["external", k, ...nodePath])] =
                    node.discriminator;
            });
        }
    }
    return options.schemas;
}
function relativePath(src, dest) {
    const isSameOrigin = dest.protocol.startsWith("http") && src.protocol.startsWith("http") && dest.origin === src.origin;
    const isSameDisk = dest.protocol === "file:" && src.protocol === "file:";
    if (isSameOrigin || isSameDisk) {
        return path.posix.relative(path.posix.dirname(src.pathname), dest.pathname);
    }
    return dest.href;
}
export function getHint(path, startFrom) {
    if (startFrom && startFrom !== "OpenAPI3") {
        switch (startFrom) {
            case "OperationObject":
                return getHintFromOperationObject(path);
            case "RequestBodyObject":
                return getHintFromRequestBodyObject(path);
            case "ResponseObject":
                return getHintFromResponseObject(path);
            default:
                return startFrom;
        }
    }
    switch (path[0]) {
        case "paths":
            return getHintFromPathItemObject(path.slice(2));
        case "components":
            return getHintFromComponentsObject(path.slice(1));
    }
    return undefined;
}
function getHintFromComponentsObject(path) {
    switch (path[0]) {
        case "schemas":
        case "headers":
            return getHintFromSchemaObject(path.slice(2));
        case "parameters":
            return getHintFromParameterObject(path.slice(2));
        case "responses":
            return getHintFromResponseObject(path.slice(2));
        case "requestBodies":
            return getHintFromRequestBodyObject(path.slice(2));
        case "pathItems":
            return getHintFromPathItemObject(path.slice(2));
    }
    return "SchemaObject";
}
function getHintFromMediaTypeObject(path) {
    switch (path[0]) {
        case "schema":
            return getHintFromSchemaObject(path.slice(1));
    }
    return "MediaTypeObject";
}
function getHintFromOperationObject(path) {
    switch (path[0]) {
        case "parameters":
            return getHintFromParameterObject(path.slice(1));
        case "requestBody":
            return getHintFromRequestBodyObject(path.slice(1));
        case "responses":
            return getHintFromResponseObject(path.slice(2));
    }
    return "OperationObject";
}
function getHintFromParameterObject(path) {
    switch (path[0]) {
        case "content":
            return getHintFromMediaTypeObject(path.slice(2));
        case "schema":
            return getHintFromSchemaObject(path.slice(1));
    }
    return "ParameterObject";
}
function getHintFromPathItemObject(path) {
    switch (path[0]) {
        case "parameters":
            return getHintFromParameterObject(path.slice(1));
        default:
            return getHintFromOperationObject(path.slice(1));
    }
}
function getHintFromRequestBodyObject(path) {
    switch (path[0]) {
        case "content":
            return getHintFromMediaTypeObject(path.slice(2));
    }
    return "RequestBodyObject";
}
function getHintFromResponseObject(path) {
    switch (path[0]) {
        case "headers":
            return getHintFromSchemaObject(path.slice(2));
        case "content":
            return getHintFromMediaTypeObject(path.slice(2));
    }
    return "ResponseObject";
}
function getHintFromSchemaObject(path) {
    switch (path[0]) {
        case "allOf":
        case "anyOf":
        case "oneOf":
            return getHintFromSchemaObject(path.slice(2));
    }
    return "SchemaObject";
}
//# sourceMappingURL=load.js.map