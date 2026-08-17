declare module 'imapflow' {
  import { EventEmitter } from 'events';

  export interface ImapFlowOptions {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string };
    logger?: false | object;
    tls?: { rejectUnauthorized?: boolean; ca?: string | string[] | Buffer | Buffer[] };
    socketTimeout?: number;
  }

  export interface MailboxLockObject {
    path: string;
    release(): void;
  }

  export interface ListResponse {
    path: string;
    name: string;
    specialUse?: string;
    flags: Set<string>;
    delimiter: string;
  }

  export interface StatusObject {
    path: string;
    messages?: number;
    unseen?: number;
    uidNext?: number;
  }

  export interface FetchMessageObject {
    uid: number;
    seq: number;
    flags?: Set<string>;
    envelope?: {
      date?: Date;
      subject?: string;
      messageId?: string;
      inReplyTo?: string;
      from?: { name?: string; address?: string }[];
      to?: { name?: string; address?: string }[];
      cc?: { name?: string; address?: string }[];
    };
    bodyStructure?: any;
    source?: Buffer;
    size?: number;
  }

  export class ImapFlow extends EventEmitter {
    constructor(options: ImapFlowOptions);
    usable: boolean;
    connect(): Promise<void>;
    logout(): Promise<void>;
    close(): void;
    list(): Promise<ListResponse[]>;
    status(path: string, query: { messages?: boolean; unseen?: boolean; uidNext?: boolean }): Promise<StatusObject>;
    getMailboxLock(path: string): Promise<MailboxLockObject>;
    fetch(
      range: string | number[] | { seq?: string; uid?: string },
      query: { uid?: boolean; flags?: boolean; envelope?: boolean; bodyStructure?: boolean; source?: boolean; size?: boolean },
      options?: { uid?: boolean }
    ): AsyncIterable<FetchMessageObject>;
    fetchOne(
      range: string | number,
      query: { uid?: boolean; flags?: boolean; envelope?: boolean; source?: boolean },
      options?: { uid?: boolean }
    ): Promise<FetchMessageObject | false>;
    messageFlagsAdd(range: string | number[], flags: string[], options?: { uid?: boolean }): Promise<boolean>;
    messageFlagsRemove(range: string | number[], flags: string[], options?: { uid?: boolean }): Promise<boolean>;
    messageMove(range: string | number[], destination: string, options?: { uid?: boolean }): Promise<any>;
    messageDelete(range: string | number[], options?: { uid?: boolean }): Promise<boolean>;
    append(path: string, content: Buffer | string, flags?: string[], idate?: Date): Promise<any>;
    mailboxOpen(path: string): Promise<any>;
    getQuota(path?: string): Promise<false | {
      path?: string;
      storage?: { used?: number; usage?: number; limit?: number };
      messages?: { used?: number; usage?: number; limit?: number };
    }>;
  }
}
