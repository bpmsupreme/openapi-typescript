/// <reference types="node" />
/// <reference types="node" />
import type { Fetch, GlobalContext, Subschema } from "./types";
import { Readable } from "node:stream";
import { URL } from "node:url";
type SchemaMap = {
    [id: string]: Subschema;
};
export declare const VIRTUAL_JSON_URL = "file:///_json";
export declare function resolveSchema(filename: string): URL;
export interface LoadOptions extends GlobalContext {
    hint?: Subschema["hint"];
    auth?: string;
    rootURL: URL;
    schemas: SchemaMap;
    urlCache: Set<string>;
    httpHeaders?: Record<string, any>;
    httpMethod?: string;
    fetch: Fetch;
}
export default function load(schema: URL | Subschema | Readable, options: LoadOptions): Promise<{
    [url: string]: Subschema;
}>;
export declare function getHint(path: (string | number)[], startFrom?: Subschema["hint"]): Subschema["hint"] | undefined;
export {};
