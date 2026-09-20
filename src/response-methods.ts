import { ResponseValidationError, UnexpectedResponseError } from "./errors.ts";
import type { InferOutput, StandardSchemaV1 } from "./standard-schema.ts";
import type { DefaultOperationApi, OperationContext } from "./types.ts";

export function defaultOperationApi(operation: OperationContext): DefaultOperationApi {
  async function successfulResponse(): Promise<Response> {
    const response = await operation.response();
    if (!response.ok) throw new UnexpectedResponseError(operation.request, response);
    return response;
  }

  return {
    async json<Schema extends StandardSchemaV1>(schema: Schema): Promise<InferOutput<Schema>> {
      const response = await successfulResponse();
      const result = await schema["~standard"].validate(await response.json());
      if (result.issues !== undefined) {
        throw new ResponseValidationError(operation.request, response, result.issues);
      }
      return result.value as InferOutput<Schema>;
    },
    async text() { return (await successfulResponse()).text(); },
    async blob() { return (await successfulResponse()).blob(); },
    async arrayBuffer() { return (await successfulResponse()).arrayBuffer(); },
  };
}
