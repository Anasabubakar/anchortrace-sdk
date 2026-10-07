/** Input that cannot be interpreted (malformed JSON shape, invalid evidence). Maps to CLI exit code 2. */
export class InputError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "InputError";
    this.issues = issues;
  }
}
