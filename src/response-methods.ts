import { ResponseValidationError, UnexpectedResponseError } from "./errors.ts";
import type { InferOutput, StandardSchemaV1 } from "./standard-schema.ts";
import type { DefaultOperationApi, MatchResult, OperationContext, StatusHandlers } from "./types.ts";

export function defaultOperationApi(operation: OperationContext): DefaultOperationApi {
  return {
    async json<Schema extends StandardSchemaV1>(schema: Schema): Promise<InferOutput<Schema>> {
      const response = await operation.response();
      const result = await schema["~standard"].validate(await response.json());
      if (result.issues !== undefined) {
        throw new ResponseValidationError(operation.request, response, result.issues);
      }
      return result.value as InferOutput<Schema>;
    },
    async text() { return (await operation.response()).text(); },
    async blob() { return (await operation.response()).blob(); },
    async arrayBuffer() { return (await operation.response()).arrayBuffer(); },
    async match<Handlers extends StatusHandlers<{}>>(handlers: Handlers): Promise<MatchResult<Handlers>> {
      const response = await operation.execute();
      const handler = handlers[response.status];
      if (handler === undefined) throw new UnexpectedResponseError(operation.request, response);
      return (await handler(operation.api(response))) as MatchResult<Handlers>;
    },
  };
}
