import type { IFileSerializer, DefinitionsExportBundle, TestResultsExportBundle } from './types.js';

/** Full fidelity by construction -- the bundle types themselves are the contract, so this
 * serializer is just a pretty-printer. */
export class JsonExportSerializer implements IFileSerializer {
  readonly formatId = 'NATIVE_JSON';
  readonly contentType = 'application/json';
  readonly fileExtension = 'json';

  serializeDefinitions(bundle: DefinitionsExportBundle): string {
    return JSON.stringify(bundle, null, 2);
  }

  serializeTestResults(bundle: TestResultsExportBundle): string {
    return JSON.stringify(bundle, null, 2);
  }
}
