import type {
	FileLockManager,
	WholeFileLockOp,
	RequestedRangeLock,
	Pid,
	Fd,
	Path,
} from '@php-wasm/universal';
import { MAX_ADDRESSABLE_FILE_OFFSET } from '@php-wasm/universal';
import { constants, fcntlSync, flockSync } from 'fs-ext-extra-prebuilt';
import { logger } from '@php-wasm/logger';

export class FileLockManagerForPosix implements FileLockManager {
	// TODO: Move path of whole file lock into leaf. It is never used for lookup.
	wholeFileLockMap = new Map<Path, Map<Pid, Map<Fd, WholeFileLockOp>>>();
	rangeLockedFds = new Map<Pid, Map<Path, Set<Fd>>>();

	lockWholeFile(path: string, op: WholeFileLockOp): boolean {
		logger.debug(
			`[POSIX] lockWholeFile: path=${path}, type=${op.type}, pid=${op.pid}, fd=${op.fd}`
		);

		const opType =
			op.type === 'unlock'
				? 'un'
				: op.waitForLock
					? op.type === 'exclusive'
						? 'ex'
						: 'sh'
					: op.type === 'exclusive'
						? 'exnb'
						: 'shnb';

		try {
			flockSync(op.fd, opType);
			logger.debug(`[POSIX] lockWholeFile: flock(${opType}) succeeded`);

			// Remember lock so we can release them
			// when the process exits or the file descriptor is closed.
			if (op.type === 'unlock') {
				this.wholeFileLockMap.get(path)?.get(op.pid)?.delete(op.fd);
			} else {
				if (!this.wholeFileLockMap.has(path)) {
					this.wholeFileLockMap.set(path, new Map());
				}
				if (!this.wholeFileLockMap.get(path)!.has(op.pid)) {
					this.wholeFileLockMap.get(path)!.set(op.pid, new Map());
				}
				this.wholeFileLockMap.get(path)!.get(op.pid)!.set(op.fd, op);
			}

			return true;
		} catch (e) {
			logger.debug(
				`[POSIX] lockWholeFile: flock(${opType}) failed: ${e}`
			);
			// TODO: Catch and report errors unrelated to flock() denials.
			return false;
		}
	}

	lockFileByteRange(
		path: string,
		op: RequestedRangeLock,
		waitForLock: boolean
	): boolean {
		logger.debug(
			`[POSIX] lockFileByteRange: path=${path}, type=${op.type}, ` +
				`pid=${op.pid}, fd=${op.fd}, range=${op.start}-${op.end}, wait=${waitForLock}`
		);

		if (op.start === op.end) {
			/*
			 * Treat a range with zero length as covering the entire remaining range.
			 * POSIX Ref: https://pubs.opengroup.org/onlinepubs/9799919799/functions/fcntl.html
			 *   "A lock shall be set to extend to the largest possible value of the file offset
			 *    for that file by setting l_len to 0."
			 */
			op = {
				...op,
				end: MAX_ADDRESSABLE_FILE_OFFSET,
			};
			logger.debug(
				`[POSIX] lockFileByteRange: expanded zero-length range to 0-${MAX_ADDRESSABLE_FILE_OFFSET}`
			);
		}

		const fcntlCmd = waitForLock ? 'setlkw' : 'setlk';
		const fcntlOp =
			op.type === 'unlocked'
				? constants.F_UNLCK
				: op.type === 'exclusive'
					? constants.F_WRLCK
					: constants.F_RDLCK;

		try {
			// TODO: Fix this API to take bigint for start and end. Possible optionally.
			fcntlSync(
				op.fd,
				fcntlCmd,
				fcntlOp,
				Number(op.start),
				Number(op.end - op.start)
			);
			logger.debug(
				`[POSIX] lockFileByteRange: fcntl(${fcntlCmd}, ${fcntlOp}) succeeded`
			);

			// Remember that we have seen range locks for this PID and FD.
			// It should be enough to release all locks with a single fcntl() call
			// to unlock the entire file range when the FD is closed or the process exits.
			if (!this.rangeLockedFds.has(op.pid)) {
				this.rangeLockedFds.set(op.pid, new Map());
			}
			const pidMap = this.rangeLockedFds.get(op.pid)!;
			if (!pidMap.has(path)) {
				pidMap.set(path, new Set());
			}
			pidMap.get(path)!.add(op.fd);

			return true;
		} catch (e) {
			logger.debug(
				`[POSIX] lockFileByteRange: fcntl(${fcntlCmd}, ${fcntlOp}) failed: ${e}`
			);
			// TODO: Catch and report errors unrelated to fcntl() denials.
			return false;
		}
	}

	findFirstConflictingByteRangeLock(
		path: string,
		op: RequestedRangeLock
	): ReturnType<FileLockManager['findFirstConflictingByteRangeLock']> {
		logger.debug(
			`[POSIX] findFirstConflictingByteRangeLock: path=${path}, type=${op.type}, ` +
				`pid=${op.pid}, range=${op.start}-${op.end}`
		);

		if (op.type === 'unlocked') {
			logger.debug(
				`[POSIX] findFirstConflictingByteRangeLock: unlock request, no conflict possible`
			);
			return undefined;
		}

		// With fs-ext's current fcntl() implementation,
		// we cannot query existing locks properly with F_GETLK.
		// It only returns whether the F_GETLK command failed or not,
		// and AFAIK, an F_GETLK can succeed whether there is a conflicting lock or not.
		// We can fix this in our fs-ext fork,
		// but for now, let just try to lock the requested range.
		const obtainedLock = this.lockFileByteRange(path, op, false);
		if (obtainedLock) {
			this.lockFileByteRange(path, { ...op, type: 'unlocked' }, true);
			logger.debug(
				`[POSIX] findFirstConflictingByteRangeLock: no conflict (test lock succeeded)`
			);
			return undefined;
		}

		logger.debug(
			`[POSIX] findFirstConflictingByteRangeLock: conflict detected (test lock failed)`
		);
		// Since we cannot obtain a lock, assume there is a conflicting lock.
		// Since we query what lock conflicts
		// until our fs-ext fork fixes that, let's report that the entire range is locked.
		return {
			type: 'exclusive',
			start: 0n,
			end: 0xffffffff_ffffffffn,
			pid: -1,
		};
	}

	releaseLocksForProcess(targetPid: number): void {
		logger.debug(`[POSIX] releaseLocksForProcess: pid=${targetPid}`);

		for (const [path, pidMap] of this.wholeFileLockMap.entries()) {
			const fdMap = pidMap.get(targetPid);
			if (!fdMap) {
				continue;
			}

			for (const op of fdMap.values()) {
				logger.debug(
					`[POSIX] releaseLocksForProcess: releasing whole-file lock on ${path}, fd=${op.fd}`
				);
				// TODO: Log any errors.
				// TODO: Does a failure here justify throwing an error (and conceding total brokenness)?
				this.lockWholeFile(path, { ...op, type: 'unlock' });
			}

			pidMap.delete(targetPid);
		}

		for (const [path, fdSet] of this.rangeLockedFds.get(targetPid) ?? []) {
			for (const fd of fdSet) {
				logger.debug(
					`[POSIX] releaseLocksForProcess: releasing range locks on ${path}, fd=${fd}`
				);
				/*
				 * fcntl() lets us request to unlock the entire byte range for this process,
				 * so we do that instead of tracking and unlocking specific ranges.
				 * NOTE: Actually, the native OS is not aware of the php-wasm process ID,
				 * but since we track which FDs are associated with each process,
				 * we can simply unlock for all FDs associated with the php-wasm process.
				 */
				this.lockFileByteRange(
					path,
					{
						pid: targetPid,
						fd,
						type: 'unlocked',
						start: 0n,
						end: MAX_ADDRESSABLE_FILE_OFFSET,
					},
					false
				);
			}
		}
		this.rangeLockedFds.delete(targetPid);
	}

	releaseLocksOnFdClose(
		targetPid: number,
		targetFd: number,
		targetPath: string
	): void {
		logger.debug(
			`[POSIX] releaseLocksOnFdClose: pid=${targetPid}, fd=${targetFd}, path=${targetPath}`
		);

		// Do nothing because the native OS is responsible for releasing
		// whole-file locks when the FD is closed.

		this.wholeFileLockMap.get(targetPath)?.get(targetPid)?.delete(targetFd);

		// TODO: Once we implement proper ranged fcntl()-based locks,
		// release all locks for the given PID and path when the FD is closed.
		// fcntl()-based locks are released whenever any file descriptor for the
		// target file is closed, regardless of which FD was used to obtain the lock.

		this.rangeLockedFds.get(targetPid)?.delete(targetPath);
	}
}
