import { escObjKey, escStr, getEntries, getSchemaObjectComment, indent, parseRef, tsArrayOf, tsIntersectionOf, tsOmit, tsOneOf, tsOptionalProperty, tsReadonly, tsTupleOf, tsUnionOf, } from "../utils.js";
export default function transformSchemaObject(schemaObject, options) {
    const result = defaultSchemaObjectTransform(schemaObject, options);
    if (typeof options.ctx.postTransform === "function") {
        const postResult = options.ctx.postTransform(result, options);
        if (postResult)
            return postResult;
    }
    return result;
}
export function defaultSchemaObjectTransform(schemaObject, { path, ctx }) {
    let { indentLv } = ctx;
    if (!schemaObject || typeof schemaObject !== "object")
        return schemaObject;
    if (Array.isArray(schemaObject)) {
        const finalType = tsTupleOf(...schemaObject);
        return ctx.immutableTypes ? tsReadonly(finalType) : finalType;
    }
    if ("$ref" in schemaObject) {
        return schemaObject.$ref;
    }
    if (typeof ctx.transform === "function") {
        const result = ctx.transform(schemaObject, { path, ctx });
        if (result)
            return result;
    }
    if (schemaObject.const) {
        return transformSchemaObject(schemaObject.const, {
            path,
            ctx: { ...ctx, immutableTypes: false, indentLv: indentLv + 1 },
        });
    }
    if (schemaObject.enum) {
        let items = schemaObject.enum;
        if ("type" in schemaObject) {
            if (schemaObject.type === "string" || (Array.isArray(schemaObject.type) && schemaObject.type.includes("string")))
                items = items.map((t) => escStr(t || ""));
        }
        else {
            items = items.map((t) => escStr(t || ""));
        }
        return tsUnionOf(...items, ...(schemaObject.nullable ||
            ("type" in schemaObject && Array.isArray(schemaObject.type) && schemaObject.type.includes("null"))
            ? ["null"]
            : []));
    }
    if ("oneOf" in schemaObject && !schemaObject.oneOf.some((t) => "$ref" in t && ctx.discriminators[t.$ref])) {
        const maybeTypes = schemaObject.oneOf.map((item) => transformSchemaObject(item, { path, ctx }));
        if (maybeTypes.some((t) => t.includes("{")))
            return tsOneOf(...maybeTypes);
        return tsUnionOf(...maybeTypes);
    }
    if ("type" in schemaObject) {
        if (Array.isArray(schemaObject.type)) {
            return tsOneOf(...schemaObject.type.map((t) => transformSchemaObject({ ...schemaObject, type: t }, { path, ctx })));
        }
        if (schemaObject.type === "null")
            return schemaObject.type;
        if (schemaObject.type === "string" || schemaObject.type === "boolean") {
            return schemaObject.nullable ? tsUnionOf(schemaObject.type, "null") : schemaObject.type;
        }
        if (schemaObject.type === "number" || schemaObject.type === "integer") {
            return schemaObject.nullable ? tsUnionOf("number", "null") : "number";
        }
        if (schemaObject.type === "array") {
            indentLv++;
            let itemType = schemaObject.items
                ? transformSchemaObject(schemaObject.items, { path, ctx: { ...ctx, indentLv } })
                : "unknown";
            const minItems = typeof schemaObject.minItems === "number" && schemaObject.minItems >= 0 ? schemaObject.minItems : 0;
            const maxItems = typeof schemaObject.maxItems === "number" && schemaObject.maxItems >= 0 && minItems <= schemaObject.maxItems
                ? schemaObject.maxItems
                : undefined;
            const estimateCodeSize = typeof maxItems !== "number" ? minItems : (maxItems * (maxItems + 1) - minItems * (minItems - 1)) / 2;
            if (ctx.supportArrayLength && (minItems !== 0 || maxItems !== undefined) && estimateCodeSize < 30) {
                if (typeof schemaObject.maxItems !== "number") {
                    itemType = tsTupleOf(...Array.from({ length: minItems }).map(() => itemType), `...${tsArrayOf(itemType)}`);
                    return ctx.immutableTypes || schemaObject.readOnly ? tsReadonly(itemType) : itemType;
                }
                else {
                    return tsUnionOf(...Array.from({ length: (maxItems || 0) - minItems + 1 })
                        .map((_, i) => i + minItems)
                        .map((n) => {
                        const t = tsTupleOf(...Array.from({ length: n }).map(() => itemType));
                        return ctx.immutableTypes || schemaObject.readOnly ? tsReadonly(t) : t;
                    }));
                }
            }
            itemType = tsArrayOf(itemType);
            if (schemaObject.nullable)
                itemType = tsUnionOf(itemType, "null");
            return ctx.immutableTypes || schemaObject.readOnly ? tsReadonly(itemType) : itemType;
        }
    }
    const coreType = [];
    if (("properties" in schemaObject && schemaObject.properties && Object.keys(schemaObject.properties).length) ||
        ("additionalProperties" in schemaObject && schemaObject.additionalProperties)) {
        indentLv++;
        for (const [k, v] of getEntries(schemaObject.properties || {}, ctx.alphabetize)) {
            const c = getSchemaObjectComment(v, indentLv);
            if (c)
                coreType.push(indent(c, indentLv));
            let key = escObjKey(k);
            let isOptional = !Array.isArray(schemaObject.required) || !schemaObject.required.includes(k);
            if (isOptional && ctx.defaultNonNullable && "default" in v)
                isOptional = false;
            if (isOptional)
                key = tsOptionalProperty(key);
            if (ctx.immutableTypes || schemaObject.readOnly)
                key = tsReadonly(key);
            coreType.push(indent(`${key}: ${transformSchemaObject(v, { path, ctx: { ...ctx, indentLv } })};`, indentLv));
        }
        if (schemaObject.additionalProperties || ctx.additionalProperties) {
            let addlType = "unknown";
            if (typeof schemaObject.additionalProperties === "object") {
                if (!Object.keys(schemaObject.additionalProperties).length) {
                    addlType = "unknown";
                }
                else {
                    addlType = transformSchemaObject(schemaObject.additionalProperties, {
                        path,
                        ctx: { ...ctx, indentLv },
                    });
                }
            }
            coreType.push(indent(`[key: string]: ${tsUnionOf(addlType ? addlType : "unknown", "undefined")};`, indentLv));
        }
        indentLv--;
    }
    for (const k of ["oneOf", "allOf", "anyOf"]) {
        if (!(k in schemaObject))
            continue;
        const discriminatorRef = schemaObject[k].find((t) => "$ref" in t && ctx.discriminators[t.$ref]);
        if (discriminatorRef) {
            const discriminator = ctx.discriminators[discriminatorRef.$ref];
            let value = parseRef(path).path.pop();
            if (discriminator.mapping) {
                const matchedValue = Object.entries(discriminator.mapping).find(([_, v]) => v === value);
                if (matchedValue)
                    value = matchedValue[0];
            }
            coreType.unshift(indent(`${discriminator.propertyName}: ${escStr(value)};`, indentLv + 1));
            break;
        }
    }
    let finalType = coreType.length ? `{\n${coreType.join("\n")}\n${indent("}", indentLv)}` : "";
    function collectCompositions(items) {
        const output = [];
        for (const item of items) {
            const itemType = transformSchemaObject(item, { path, ctx: { ...ctx, indentLv } });
            if ("$ref" in item && ctx.discriminators[item.$ref]) {
                output.push(tsOmit(itemType, [ctx.discriminators[item.$ref].propertyName]));
                continue;
            }
            output.push(itemType);
        }
        return output;
    }
    if ("oneOf" in schemaObject && Array.isArray(schemaObject.oneOf)) {
        const oneOfType = tsOneOf(...collectCompositions(schemaObject.oneOf));
        finalType = finalType ? tsIntersectionOf(finalType, oneOfType) : oneOfType;
    }
    else {
        if ("allOf" in schemaObject && Array.isArray(schemaObject.allOf))
            finalType = tsIntersectionOf(...(finalType ? [finalType] : []), ...collectCompositions(schemaObject.allOf));
        if ("anyOf" in schemaObject && Array.isArray(schemaObject.anyOf)) {
            const anyOfTypes = tsUnionOf(...collectCompositions(schemaObject.anyOf));
            finalType = finalType ? tsIntersectionOf(finalType, anyOfTypes) : anyOfTypes;
        }
    }
    if (schemaObject.nullable)
        finalType = tsUnionOf(finalType || "Record<string, unknown>", "null");
    return finalType || "Record<string, never>";
}
//# sourceMappingURL=schema-object.js.map