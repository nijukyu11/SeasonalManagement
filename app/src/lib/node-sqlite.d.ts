declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(location: string);
    prepare(sql: string): {
      run(...values: unknown[]): unknown;
      all(...values: unknown[]): Record<string, unknown>[];
    };
    close(): void;
  }
}
