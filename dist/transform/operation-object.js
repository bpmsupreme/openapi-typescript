import { escObjKey, getEntries, getSchemaObjectComment, indent, makeTSIndex, parseTSIndex, tsIntersectionOf, tsNonNullable, tsOptionalProperty, tsPick, tsReadonly, } from "../utils.js";
import transformParameterObject from "./parameter-object.js";
import transformRequestBodyObject from "./request-body-object.js";
import transformResponseObject from "./response-object.js";
import transformSchemaObject from "./schema-object.js";
export default function transformOperationObject(operationObject, { path, ctx, wrapObject = true }) {
    let { indentLv } = ctx;
    const output = wrapObject ? ["{"] : [];
    indentLv++;
    const c = getSchemaObjectComment(operationObject, indentLv);
    if (c)
        output.push(indent(c, indentLv));
    {
        if (operationObject.parameters) {
            const parameterOutput = [];
            let allParamsOptional = false;
            indentLv++;
            for (const paramIn of ["query", "header", "path", "cookie"]) {
                let inlineParamsOptional = false;
                const inlineOutput = [];
                const refs = {};
                indentLv++;
                for (const p of operationObject.parameters) {
                    if ("in" in p) {
                        if (p.in !== paramIn)
                            continue;
                        let key = escObjKey(p.name);
                        if (paramIn !== "path" && !p.required) {
                            key = tsOptionalProperty(key);
                        }
                        else {
                            inlineParamsOptional = false;
                            allParamsOptional = false;
                        }
                        const c = getSchemaObjectComment(p, indentLv);
                        if (c)
                            parameterOutput.push(indent(c, indentLv));
                        const parameterType = transformParameterObject(p, {
                            path: `${path}/parameters/${p.name}`,
                            ctx: { ...ctx, indentLv },
                        });
                        inlineOutput.push(indent(`${key}: ${parameterType};`, indentLv));
                    }
                    else if (p.$ref && paramIn == 'query') {
                        const parts = parseTSIndex(p.$ref);
                        const paramI = parts.indexOf("parameters");
                        const partsParamIn = parts.find((p) => p === "query" || p === "header" || p === "path" || p === "cookie");
                        if (paramI === -1 || (partsParamIn && partsParamIn !== paramIn))
                            continue;
                        const key = parts.pop();
                        const index = makeTSIndex(parts);
                        if (!refs[index])
                            refs[index] = [key];
                        else
                            refs[index].push(key);
                    }
                }
                indentLv--;
                if (!inlineOutput.length && !Object.keys(refs).length)
                    continue;
                const paramType = tsIntersectionOf(...(inlineOutput.length ? [`{\n${inlineOutput.join("\n")}\n${indent("}", indentLv)}`] : []), ...Object.entries(refs).map(([root, keys]) => paramIn === "path" ? tsPick(root, keys) : tsPick(tsNonNullable(root), keys)));
                let key = paramIn;
                if (inlineParamsOptional)
                    key = tsOptionalProperty(key);
                if (ctx.immutableTypes)
                    key = tsReadonly(key);
                parameterOutput.push(indent(`${key}: ${paramType};`, indentLv));
            }
            indentLv--;
            if (parameterOutput.length) {
                output.push(indent(allParamsOptional ? `parameters?: {` : `parameters: {`, indentLv));
                output.push(parameterOutput.join("\n"));
                output.push(indent("};", indentLv));
            }
        }
    }
    {
        if (operationObject.requestBody) {
            const c = getSchemaObjectComment(operationObject.requestBody, indentLv);
            if (c)
                output.push(indent(c, indentLv));
            let key = "requestBody";
            if (ctx.immutableTypes)
                key = tsReadonly(key);
            if ("$ref" in operationObject.requestBody) {
                output.push(indent(`${key}: ${transformSchemaObject(operationObject.requestBody, { path, ctx })};`, indentLv));
            }
            else {
                if (!operationObject.requestBody.required)
                    key = tsOptionalProperty(key);
                const requestBody = transformRequestBodyObject(operationObject.requestBody, {
                    path: `${path}/requestBody`,
                    ctx: { ...ctx, indentLv },
                });
                output.push(indent(`${key}: ${requestBody};`, indentLv));
            }
        }
    }
    {
        if (operationObject.responses) {
            output.push(indent(`responses: {`, indentLv));
            indentLv++;
            for (const [responseCode, responseObject] of getEntries(operationObject.responses, ctx.alphabetize)) {
                const key = escObjKey(responseCode);
                const c = getSchemaObjectComment(responseObject, indentLv);
                if (c)
                    output.push(indent(c, indentLv));
                if ("$ref" in responseObject) {
                    output.push(indent(`${key}: ${transformSchemaObject(responseObject, {
                        path: `${path}/responses/${responseCode}`,
                        ctx,
                    })};`, indentLv));
                }
                else {
                    const responseType = transformResponseObject(responseObject, {
                        path: `${path}/responses/${responseCode}`,
                        ctx: { ...ctx, indentLv },
                    });
                    output.push(indent(`${key}: ${responseType};`, indentLv));
                }
            }
            indentLv--;
            output.push(indent(`};`, indentLv));
        }
    }
    indentLv--;
    if (wrapObject) {
        output.push(indent("}", indentLv));
    }
    return output.join("\n");
}
//# sourceMappingURL=operation-object.js.map