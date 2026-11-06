export type RetryRequest = { requestId: string; taskIds: string[]; reason: string; status: "pending" | "accepted" | "completed" | "rejected";
  bindings: Record<string, string>; message?: string };
export type RetryInput = { requestId?: string; taskIds: string[]; reason?: string };
export type RetryAdmission = { commit(): void; release(): void };
export type RetryAdmit = (requests: RetryRequest[]) => Promise<RetryAdmission>;

export interface RetryController {
  setAdmission(admit: RetryAdmit): Promise<void>;
  stopAccepting(): Promise<void>;
  close(): Promise<void>;
}

/** The application commits the mailbox before committing a queue reservation. */
export interface RetryControlService {
  claim(directory: string, requestId: string, bindings: () => Promise<Record<string, string>>): Promise<void>;
  start(directory: string, warn: (error: unknown) => void): Promise<RetryController>;
}
