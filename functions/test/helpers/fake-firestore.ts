export interface FakeReference {
  path: string;
  id: string;
}

class FakeSnapshot {
  public constructor(private readonly value: Record<string, unknown> | undefined) {}
  public get exists(): boolean {
    return this.value !== undefined;
  }
  public data(): Record<string, unknown> | undefined {
    return this.value === undefined ? undefined : { ...this.value };
  }
  public get(field: string): unknown {
    return this.value?.[field];
  }
}

class FakeDocumentReference implements FakeReference {
  public readonly id: string;
  public constructor(
    private readonly firestore: FakeFirestore,
    public readonly path: string,
  ) {
    this.id = path.split("/").at(-1) ?? "";
  }
  public get(): Promise<FakeSnapshot> {
    return Promise.resolve(new FakeSnapshot(this.firestore.read(this.path)));
  }
  public update(values: Record<string, unknown>): Promise<void> {
    this.firestore.update(this.path, values);
    return Promise.resolve();
  }
  public collection(name: string): FakeCollectionReference {
    return new FakeCollectionReference(this.firestore, `${this.path}/${name}`);
  }
}

class FakeCollectionReference {
  public constructor(
    private readonly firestore: FakeFirestore,
    public readonly path: string,
  ) {}
  public doc(id: string): FakeDocumentReference {
    return new FakeDocumentReference(this.firestore, `${this.path}/${id}`);
  }
}

type Write = () => void;

class FakeTransaction {
  private readonly writes: Write[] = [];
  public constructor(private readonly firestore: FakeFirestore) {}
  public get(reference: FakeReference): Promise<FakeSnapshot> {
    return Promise.resolve(new FakeSnapshot(this.firestore.read(reference.path)));
  }
  public create(reference: FakeReference, value: Record<string, unknown>): void {
    this.writes.push(() => {
      if (this.firestore.read(reference.path) !== undefined) throw new Error("already exists");
      this.firestore.write(reference.path, value);
    });
  }
  public set(
    reference: FakeReference,
    value: Record<string, unknown>,
    options?: { merge?: boolean },
  ): void {
    this.writes.push(() => {
      if (options?.merge) this.firestore.update(reference.path, value);
      else this.firestore.write(reference.path, value);
    });
  }
  public update(reference: FakeReference, value: Record<string, unknown>): void {
    this.writes.push(() => this.firestore.update(reference.path, value));
  }
  public delete(reference: FakeReference): void {
    this.writes.push(() => this.firestore.values.delete(reference.path));
  }
  public commit(): void {
    this.writes.forEach((write) => write());
  }
}

export class FakeFirestore {
  public readonly values = new Map<string, Record<string, unknown>>();
  private lock: Promise<void> = Promise.resolve();

  public collection(name: string): FakeCollectionReference {
    return new FakeCollectionReference(this, name);
  }

  public batch(): {
    delete: (reference: FakeReference) => void;
    commit: () => Promise<void>;
  } {
    const paths: string[] = [];
    return {
      delete: (reference) => paths.push(reference.path),
      commit: () => {
        paths.forEach((path) => this.values.delete(path));
        return Promise.resolve();
      },
    };
  }

  public seed(path: string, value: Record<string, unknown>): void {
    this.write(path, value);
  }

  public read(path: string): Record<string, unknown> | undefined {
    const value = this.values.get(path);
    return value === undefined ? undefined : { ...value };
  }

  public write(path: string, value: Record<string, unknown>): void {
    const materialized: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      const methodName =
        typeof fieldValue === "object" && fieldValue !== null && "methodName" in fieldValue
          ? fieldValue.methodName
          : undefined;
      if (methodName === "FieldValue.delete") continue;
      materialized[key] =
        methodName === "FieldValue.serverTimestamp" ? Timestamp.now() : fieldValue;
    }
    this.values.set(path, materialized);
  }

  public update(path: string, value: Record<string, unknown>): void {
    const next = { ...(this.values.get(path) ?? {}) };
    for (const [key, fieldValue] of Object.entries(value)) {
      const methodName =
        typeof fieldValue === "object" && fieldValue !== null && "methodName" in fieldValue
          ? fieldValue.methodName
          : undefined;
      if (methodName === "FieldValue.delete") {
        delete next[key];
      } else {
        next[key] =
          methodName === "FieldValue.serverTimestamp" ? Timestamp.now() : fieldValue;
      }
    }
    this.values.set(path, next);
  }

  public async runTransaction<T>(callback: (transaction: FakeTransaction) => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release = (): void => undefined;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const transaction = new FakeTransaction(this);
      const result = await callback(transaction);
      transaction.commit();
      return result;
    } finally {
      release();
    }
  }
}
import { Timestamp } from "firebase-admin/firestore";
