/**
 * CKB Debugger WASM Wrapper
 * 
 * Provides a TypeScript interface for running the CKB standalone debugger compiled to WASM.
 * Supports both WASI and native execution modes with proper error handling.
 * 
 * Usage:
 * ```typescript
 * const debugger = new CkbDebuggerWasi({
 *   wasmPath: './path/to/ckb-debugger.wasm',
 *   captureOutput: true
 * });
 * 
 * // Run a transaction file
 * const result = await debugger.runTransaction('tx.json', 'input.0.lock');
 * 
 * // Run with binary replacement
 * const result = await debugger.runBinary('./my-script', 'input.0.lock');
 * 
 * // Run with specific script hash
 * const result = await debugger.runWithScriptHash('tx.json', '0x...hash...', 'lock');
 * ```
 */

import * as fs from 'node:fs';
import * as wasi from 'node:wasi';
import * as path from 'node:path';

export interface CkbDebuggerResult {
    exitCode: number;
    output?: string;
    error?: string;
}

export interface CkbDebuggerOptions {
    wasmPath?: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    captureOutput?: boolean;
}

export class CkbDebuggerWasi {
    private wasmPath: string;
    private workingDirectory: string;
    private env: Record<string, string>;
    private captureOutput: boolean;
    private wasm: WebAssembly.Module | null = null;

    constructor(options: CkbDebuggerOptions = {}) {
        this.wasmPath = options.wasmPath || './ckb-debugger.wasm';
        this.workingDirectory = options.workingDirectory || process.cwd();
        this.env = options.env || {};
        this.captureOutput = options.captureOutput || false;
    }

    async initialize(): Promise<void> {
        if (!this.wasm) {
            if (!fs.existsSync(this.wasmPath)) {
                throw new Error(`WASM file not found: ${this.wasmPath}`);
            }
            this.wasm = await WebAssembly.compile(fs.readFileSync(this.wasmPath));
        }
    }

    async run(args: string[] = [], preopens: Record<string, string> = {}): Promise<CkbDebuggerResult> {
        await this.initialize();

        return new Promise((resolve, reject) => {
            try {
                let output = '';
                let error = '';

                // Configure WASI options
                const wasiOptions: any = {
                    version: 'preview1',
                    args: ['ckb-debugger', ...args],
                    env: this.env,
                    preopens: {
                        '/': this.workingDirectory,
                        ...preopens
                    }
                };

                // Add custom stdout/stderr if capturing output
                if (this.captureOutput) {
                    wasiOptions.stdout = {
                        write: (data: Uint8Array) => {
                            output += new TextDecoder().decode(data);
                            return data.length;
                        }
                    };
                    wasiOptions.stderr = {
                        write: (data: Uint8Array) => {
                            error += new TextDecoder().decode(data);
                            return data.length;
                        }
                    };
                }

                const wasihost = new wasi.WASI(wasiOptions);

                // Instantiate the WebAssembly module
                WebAssembly.instantiate(this.wasm!, wasihost.getImportObject() as WebAssembly.Imports)
                    .then(instance => {
                        try {
                            wasihost.start(instance);
                            resolve({
                                exitCode: 0,
                                output: this.captureOutput ? output : undefined,
                                error: this.captureOutput ? error : undefined
                            });
                        } catch (e: any) {
                            // WASI programs exit with a specific exception
                            if (e.code === 'WASI_EXIT') {
                                resolve({
                                    exitCode: e.exitCode || 0,
                                    output: this.captureOutput ? output : undefined,
                                    error: this.captureOutput ? error : undefined
                                });
                            } else {
                                reject(new Error(`WASI execution failed: ${e.message}`));
                            }
                        }
                    })
                    .catch(reject);
            } catch (e: any) {
                reject(new Error(`Failed to run debugger: ${e.message}`));
            }
        });
    }

    // Convenience methods for common operations
    async help(): Promise<CkbDebuggerResult> {
        return this.run(['--help']);
    }

    async runTransaction(
        txFile: string, 
        script: string = 'input.0.lock', 
        maxCycles: string = '1000000000'
    ): Promise<CkbDebuggerResult> {
        const txPath = path.resolve(this.workingDirectory, txFile);
        if (!fs.existsSync(txPath)) {
            throw new Error(`Transaction file not found: ${txPath}`);
        }

        return this.run([
            '--tx-file', txFile,
            '--script', script,
            '--max-cycles', maxCycles
        ]);
    }

    async runBinary(
        binFile: string, 
        script: string = 'input.0.lock',
        maxCycles: string = '1000000000'
    ): Promise<CkbDebuggerResult> {
        const binPath = path.resolve(this.workingDirectory, binFile);
        if (!fs.existsSync(binPath)) {
            throw new Error(`Binary file not found: ${binPath}`);
        }

        return this.run([
            '--bin', binFile,
            '--script', script,
            '--max-cycles', maxCycles
        ], {
            [binFile]: binFile
        });
    }

    async runWithMode(mode: string, args: string[] = []): Promise<CkbDebuggerResult> {
        const validModes = ['decode-instruction', 'fast', 'full', 'gdb', 'instruction-decode', 'probe'];
        if (!validModes.includes(mode)) {
            throw new Error(`Invalid mode: ${mode}. Valid modes are: ${validModes.join(', ')}`);
        }

        return this.run(['--mode', mode, ...args]);
    }

    async runFast(
        txFile: string,
        script: string = 'input.0.lock',
        maxCycles: string = '1000000000'
    ): Promise<CkbDebuggerResult> {
        return this.run([
            '--mode', 'fast',
            '--tx-file', txFile,
            '--script', script,
            '--max-cycles', maxCycles
        ]);
    }

    async runWithCoverage(
        txFile: string,
        coverageOutput: string,
        script: string = 'input.0.lock'
    ): Promise<CkbDebuggerResult> {
        return this.run([
            '--tx-file', txFile,
            '--script', script,
            '--enable-coverage',
            '--coverage-output', coverageOutput
        ]);
    }

    async runWithStepLog(
        txFile: string,
        script: string = 'input.0.lock'
    ): Promise<CkbDebuggerResult> {
        return this.run([
            '--tx-file', txFile,
            '--script', script,
            '--enable-steplog'
        ]);
    }

    async runGdbMode(
        txFile: string,
        gdbListen: string = '127.0.0.1:9999',
        script: string = 'input.0.lock'
    ): Promise<CkbDebuggerResult> {
        return this.run([
            '--mode', 'gdb',
            '--tx-file', txFile,
            '--script', script,
            '--gdb-listen', gdbListen
        ]);
    }

    async decodeInstruction(instruction: string): Promise<CkbDebuggerResult> {
        return this.run(['--mode', 'decode-instruction', instruction]);
    }

    async runWithScriptHash(
        txFile: string,
        scriptHash: string,
        scriptGroupType: 'lock' | 'type' = 'lock',
        maxCycles: string = '1000000000'
    ): Promise<CkbDebuggerResult> {
        return this.run([
            '--tx-file', txFile,
            '--script-hash', scriptHash,
            '--script-group-type', scriptGroupType,
            '--max-cycles', maxCycles
        ]);
    }

    async runWithProfile(
        txFile: string,
        pprofOutput: string,
        script: string = 'input.0.lock'
    ): Promise<CkbDebuggerResult> {
        return this.run([
            '--tx-file', txFile,
            '--script', script,
            '--pprof', pprofOutput
        ]);
    }
}
