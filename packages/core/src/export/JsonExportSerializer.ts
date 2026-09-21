import type { IFileSerializer, DefinitionsExportBundle, ExecutionResultsExportBundle } from './types.js';

/** Full fidelity by construction -- the bundle types themselves are the contract, so this
 * serializer is just a pretty-printer. */
export class JsonExportSerializer implements IFileSerializer {
  readonly formatId = 'NATIVE_JSON';
  readonly contentType = 'application/json';
  readonly fileExtension = 'json';

  serializeDefinitions(bundle: DefinitionsExportBundle): string {
    return JSON.stringify(bundle, null, 2);
  }

  serializeExecutionResults(bundle: ExecutionResultsExportBundle): string {
    return JSON.stringify(bundle, null, 2);
  }
}
