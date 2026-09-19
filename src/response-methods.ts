import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FetchResponse, ResponseMethods } from "./types.ts";

export type InferOutput<Schema extends StandardSchemaV1> =
  StandardSchemaV1.InferOutput<Schema>;

export class SchemaValidationError extends Error {
  readonly issues: readonly StandardSchemaV1.Issue[];

  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    super("Response failed schema validation");
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

// Built-ins use the same per-operation factories as extension methods.
export const defaultResponseMethods = {
  json: (fetchResponse: FetchResponse) =>
    async <Schema extends StandardSchemaV1>(schema: Schema): Promise<InferOutput<Schema>> => {
      const response = await fetchResponse();
      const result = await schema["~standard"].validate(await response.json());
      if (result.issues) throw new SchemaValidationError(result.issues);
      return result.value as InferOutput<Schema>;
    },
  text: (fetchResponse: FetchResponse) => async (): Promise<string> =>
    (await fetchResponse()).text(),
  blob: (fetchResponse: FetchResponse) => async (): Promise<Blob> =>
    (await fetchResponse()).blob(),
  arrayBuffer: (fetchResponse: FetchResponse) => async (): Promise<ArrayBuffer> =>
    (await fetchResponse()).arrayBuffer(),
  response: (fetchResponse: FetchResponse) => (): Promise<Response> =>
    fetchResponse(),
} satisfies ResponseMethods;

export type DefaultResponseMethods = typeof defaultResponseMethods;
