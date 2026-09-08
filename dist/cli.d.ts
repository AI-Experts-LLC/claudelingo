#!/usr/bin/env node
interface Args {
    command: string;
    rest: string[];
    flags: Record<string, string | boolean>;
}
export declare function parseArgs(argv: string[]): Args;
export declare function main(argv?: string[]): Promise<void>;
export {};
