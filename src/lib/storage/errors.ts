// Storage-layer errors, in their own module so both backends (index.ts and
// the lazily required s3.ts) can import them without an import cycle.

/** `get()` of a key that holds no object. The message never carries the
 *  key (storage keys are admin-only detail); read `.key` when logging. */
export class StorageObjectNotFoundError extends Error {
  public readonly key: string;
  constructor(key: string) {
    super('The stored file is missing');
    this.name = 'StorageObjectNotFoundError';
    this.key = key;
  }
}

/** `signedUrl()` on a backend that has no URL a browser can open. */
export class StorageUrlUnavailableError extends Error {
  constructor(providerId: string) {
    super(
      `The ${providerId} storage backend cannot hand out a browser URL; ` +
        'serve the bytes through an authenticated route that streams get().',
    );
    this.name = 'StorageUrlUnavailableError';
  }
}
