import {
	type Path,
	type RequestedRangeLock,
	type WholeFileLockOp,
	type FileLockManager,
} from './file-lock-manager';
import { logger } from '@php-wasm/logger';

// TODO: Add unit tests for this class.
// TODO: Find a clearer name for this class.
export class FileLockManagerComposite implements FileLockManager {
	nativeLockManager: FileLockManager;
	wasmLockManager: FileLockManager;

	constructor(
		nativeLockManager: FileLockManager,
		wasmLockManager: FileLockManager
	) {
		this.nativeLockManager = nativeLockManager;
		this.wasmLockManager = wasmLockManager;
	}

	lockWholeFile(path: Path, op: WholeFileLockOp): boolean {
		// TODO: Consider adding printf-style logger.trace() for more granular logging like this.
		console.debug(
			`[Composite] lockWholeFile: path=${path}, type=${op.type}, pid=${op.pid}, fd=${op.fd}`
		);

		const nativeResult = this.nativeLockManager.lockWholeFile(path, op);
		if (!nativeResult) {
			logger.debug(
				`[Composite] lockWholeFile: native lock failed, returning false`
			);
			return false;
		}
		logger.debug(`[Composite] lockWholeFile: native lock succeeded`);

		const wasmResult = this.wasmLockManager.lockWholeFile(path, op);
		if (!wasmResult) {
			logger.debug(
				`[Composite] lockWholeFile: wasm lock failed, rolling back native lock`
			);
			// Rollback the native lock if the wasm lock fails.
			this.nativeLockManager.lockWholeFile(path, {
				...op,
				type: 'unlock',
			});
			return false;
		}
		logger.debug(`[Composite] lockWholeFile: wasm lock succeeded`);

		return true;
	}

	lockFileByteRange(
		path: Path,
		requestedLock: RequestedRangeLock,
		waitForLock: boolean
	): boolean {
		console.debug(
			`[Composite] lockFileByteRange: path=${path}, type=${requestedLock.type}, ` +
				`pid=${requestedLock.pid}, fd=${requestedLock.fd}, ` +
				`range=${requestedLock.start}-${requestedLock.end}, wait=${waitForLock}`
		);

		const nativeResult = this.nativeLockManager.lockFileByteRange(
			path,
			requestedLock,
			waitForLock
		);
		if (!nativeResult) {
			console.debug(
				`[Composite] lockFileByteRange: native lock failed, returning false`
			);
			return false;
		}
		console.debug(`[Composite] lockFileByteRange: native lock succeeded`);

		const wasmResult = this.wasmLockManager.lockFileByteRange(
			path,
			requestedLock,
			waitForLock
		);
		if (!wasmResult) {
			console.debug(
				`[Composite] lockFileByteRange: wasm lock failed, rolling back native lock`
			);
			// Rollback the native lock if the wasm lock fails.
			this.nativeLockManager.lockFileByteRange(
				path,
				{
					...requestedLock,
					type: 'unlocked',
				},
				false
			);
			return false;
		}
		console.debug(`[Composite] lockFileByteRange: wasm lock succeeded`);

		return true;
	}

	findFirstConflictingByteRangeLock(
		path: Path,
		desiredLock: RequestedRangeLock
	): Omit<RequestedRangeLock, 'fd'> | undefined {
		logger.debug(
			`[Composite] findFirstConflictingByteRangeLock: path=${path}, type=${desiredLock.type}, ` +
				`pid=${desiredLock.pid}, range=${desiredLock.start}-${desiredLock.end}`
		);

		// Check native lock manager first, then wasm lock manager.
		// Return the first conflict found from either.
		const nativeConflict =
			this.nativeLockManager.findFirstConflictingByteRangeLock(
				path,
				desiredLock
			);
		if (nativeConflict) {
			logger.debug(
				`[Composite] findFirstConflictingByteRangeLock: found native conflict`
			);
			return nativeConflict;
		}

		const wasmConflict =
			this.wasmLockManager.findFirstConflictingByteRangeLock(
				path,
				desiredLock
			);
		if (wasmConflict) {
			logger.debug(
				`[Composite] findFirstConflictingByteRangeLock: found wasm conflict`
			);
		} else {
			logger.debug(
				`[Composite] findFirstConflictingByteRangeLock: no conflict found`
			);
		}
		return wasmConflict;
	}

	// TODO: Consider try/catch for both release methods. OTOH, if one throws, it is catastrophic.
	releaseLocksForProcess(pid: number): void {
		logger.debug(`[Composite] releaseLocksForProcess: pid=${pid}`);
		// Release locks on both managers.
		this.nativeLockManager.releaseLocksForProcess(pid);
		this.wasmLockManager.releaseLocksForProcess(pid);
	}

	releaseLocksOnFdClose(pid: number, fd: number, path: Path): void {
		logger.debug(
			`[Composite] releaseLocksOnFdClose: pid=${pid}, fd=${fd}, path=${path}`
		);
		// Release locks on both managers.
		this.nativeLockManager.releaseLocksOnFdClose(pid, fd, path);
		this.wasmLockManager.releaseLocksOnFdClose(pid, fd, path);
	}
}
