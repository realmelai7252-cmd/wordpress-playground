import {
	type Path,
	type RequestedRangeLock,
	type WholeFileLockOp,
	type FileLockManager,
} from './file-lock-manager';

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
		const nativeResult = this.nativeLockManager.lockWholeFile(path, op);
		if (!nativeResult) {
			return false;
		}

		const wasmResult = this.wasmLockManager.lockWholeFile(path, op);
		if (!wasmResult) {
			// Rollback the native lock if the wasm lock fails.
			this.nativeLockManager.lockWholeFile(path, {
				...op,
				type: 'unlock',
			});
			return false;
		}

		return true;
	}

	lockFileByteRange(
		path: Path,
		requestedLock: RequestedRangeLock,
		waitForLock: boolean
	): boolean {
		const nativeResult = this.nativeLockManager.lockFileByteRange(
			path,
			requestedLock,
			waitForLock
		);
		if (!nativeResult) {
			return false;
		}

		const wasmResult = this.wasmLockManager.lockFileByteRange(
			path,
			requestedLock,
			waitForLock
		);
		if (!wasmResult) {
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

		return true;
	}

	findFirstConflictingByteRangeLock(
		path: Path,
		desiredLock: RequestedRangeLock
	): Omit<RequestedRangeLock, 'fd'> | undefined {
		// Check native lock manager first, then wasm lock manager.
		// Return the first conflict found from either.
		const nativeConflict =
			this.nativeLockManager.findFirstConflictingByteRangeLock(
				path,
				desiredLock
			);
		if (nativeConflict) {
			return nativeConflict;
		}

		return this.wasmLockManager.findFirstConflictingByteRangeLock(
			path,
			desiredLock
		);
	}

	// TODO: Consider try/catch for both release methods. OTOH, if one throws, it is catastrophic.
	releaseLocksForProcess(pid: number): void {
		// Release locks on both managers.
		this.nativeLockManager.releaseLocksForProcess(pid);
		this.wasmLockManager.releaseLocksForProcess(pid);
	}

	releaseLocksOnFdClose(pid: number, fd: number, path: Path): void {
		// Release locks on both managers.
		this.nativeLockManager.releaseLocksOnFdClose(pid, fd, path);
		this.wasmLockManager.releaseLocksOnFdClose(pid, fd, path);
	}
}
