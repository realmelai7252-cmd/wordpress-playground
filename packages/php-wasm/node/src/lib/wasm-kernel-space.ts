// TODO: Document the thinking for the "kernel space" term
import type { FileLockManager } from '@php-wasm/universal';

export type WasmKernelSpace = {
	readonly fileLockManager: FileLockManager | undefined;
};
